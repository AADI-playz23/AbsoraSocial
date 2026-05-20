const { MongoClient } = require('mongodb');
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('@neondatabase/serverless');

// Cloudflare D1 REST API Endpoint
const D1_API = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database`;

// Singleton Clients
let mongoClient = null;
let supabaseClient = null;
let neonPool = null;

async function getMongoClient() {
    if (!mongoClient) {
        mongoClient = new MongoClient(process.env.MONGODB_URI);
        await mongoClient.connect();
    }
    return mongoClient.db('absorasocial');
}

function getSupabaseClient() {
    if (!supabaseClient) {
        supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    }
    return supabaseClient;
}

function getNeonClient() {
    if (!neonPool) {
        neonPool = new Pool({ connectionString: process.env.NEON_DATABASE_URL });
    }
    return neonPool;
}

// Helper to determine the shard based on User ID
function determineShard(userId) {
    const uId = parseInt(userId) || 1;
    const totalShards = 13;
    const shardIndex = (uId % totalShards) + 1; // 1 to 13

    if (shardIndex === 1) return { type: 'mongodb', name: 'Shard 1' };
    if (shardIndex === 2) return { type: 'supabase', name: 'Shard 2' };
    if (shardIndex === 3) return { type: 'neon', name: 'Shard 3' };
    
    // Shards 4 - 13 mapped to D1 indices 1 - 10
    const d1Index = shardIndex - 3;
    return { type: 'd1', name: `Shard ${shardIndex}`, index: d1Index };
}

// Execute D1 Query via Cloudflare API
async function executeD1Query(d1Index, sql, params = []) {
    const dbId = process.env[`D1_DB_${d1Index}_ID`];
    const url = `${D1_API}/${dbId}/query`;
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`
        },
        body: JSON.stringify({ sql, params })
    });
    
    const data = await response.json();
    if (!data.success) throw new Error(data.errors[0]?.message || 'D1 Query Failed');
    return data.result[0].results;
}

/**
 * Universal Database Router
 * Automatically maps incoming SQL-like requests to the correct NoSQL/SQL syntax based on the User's Shard.
 */
class DatabaseRouter {

    static determineShard(userId) {
        return determineShard(userId);
    }

    // ==========================================
    // USER SHARD QUERY METHODS
    // ==========================================
    
    static async getPostCount(userId) {
        const shard = determineShard(userId);

        if (shard.type === 'mongodb') {
            const db = await getMongoClient();
            return await db.collection('posts').countDocuments({ user_id: userId, is_archived: false, expires_at: { $gt: new Date() } });
        }

        if (shard.type === 'supabase') {
            const supabase = getSupabaseClient();
            const { count, error } = await supabase
                .from('posts')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId)
                .eq('is_archived', false)
                .gt('expires_at', new Date().toISOString());
            if (error) throw error;
            return count;
        }

        if (shard.type === 'neon') {
            const pool = getNeonClient();
            const result = await pool.query(
                'SELECT COUNT(*)::int as count FROM posts WHERE user_id = $1 AND is_archived = false AND expires_at > NOW()',
                [userId]
            );
            return result.rows[0].count;
        }

        if (shard.type === 'd1') {
            const results = await executeD1Query(
                shard.index,
                'SELECT COUNT(*) as count FROM posts WHERE user_id = ? AND is_archived = 0 AND expires_at > datetime("now")',
                [userId]
            );
            return results[0]?.count || 0;
        }
    }

    static async getUserPosts(userId, requesterId) {
        const shard = determineShard(userId);
        const limit = 60;

        if (shard.type === 'mongodb') {
            const db = await getMongoClient();
            const query = { user_id: userId, is_archived: false, expires_at: { $gt: new Date() } };
            if (userId !== requesterId) {
                query.is_private = false;
            }
            return await db.collection('posts').find(query).sort({ created_at: -1 }).limit(limit).toArray();
        }

        if (shard.type === 'supabase') {
            const supabase = getSupabaseClient();
            let query = supabase
                .from('posts')
                .select('id, image_url, caption, created_at, is_private')
                .eq('user_id', userId)
                .eq('is_archived', false)
                .gt('expires_at', new Date().toISOString());
            
            if (userId !== requesterId) {
                query = query.eq('is_private', false);
            }
            
            const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);
            if (error) throw error;
            return data;
        }

        if (shard.type === 'neon') {
            const pool = getNeonClient();
            const isOwn = userId === requesterId;
            const query = isOwn
                ? 'SELECT id, image_url, caption, created_at FROM posts WHERE user_id = $1 AND is_archived = false AND expires_at > NOW() ORDER BY created_at DESC LIMIT $2'
                : 'SELECT id, image_url, caption, created_at FROM posts WHERE user_id = $1 AND is_archived = false AND expires_at > NOW() AND is_private = false ORDER BY created_at DESC LIMIT $2';
            
            const result = await pool.query(query, [userId, limit]);
            return result.rows;
        }

        if (shard.type === 'd1') {
            const isOwn = userId === requesterId;
            const query = isOwn
                ? 'SELECT id, image_url, caption, created_at FROM posts WHERE user_id = ? AND is_archived = 0 AND expires_at > datetime("now") ORDER BY created_at DESC LIMIT ?'
                : 'SELECT id, image_url, caption, created_at FROM posts WHERE user_id = ? AND is_archived = 0 AND expires_at > datetime("now") AND is_private = 0 ORDER BY created_at DESC LIMIT ?';
            
            return await executeD1Query(shard.index, query, [userId, limit]);
        }
    }

    static async insertPost(postData) {
        const shard = determineShard(postData.user_id);
        
        // standard default expiry (7 days)
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + 7);
        const dataToInsert = {
            ...postData,
            is_archived: false,
            is_private: postData.is_private || false,
            created_at: new Date(),
            expires_at: expiry
        };

        if (shard.type === 'mongodb') {
            const db = await getMongoClient();
            const result = await db.collection('posts').insertOne(dataToInsert);
            return { id: result.insertedId, ...dataToInsert };
        }
        
        if (shard.type === 'supabase') {
            const supabase = getSupabaseClient();
            const { data, error } = await supabase.from('posts').insert([dataToInsert]).select();
            if (error) throw error;
            return data[0];
        }
        
        if (shard.type === 'neon') {
            const pool = getNeonClient();
            const keys = Object.keys(dataToInsert);
            const values = Object.values(dataToInsert);
            const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
            
            const result = await pool.query(
                `INSERT INTO posts (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
                values
            );
            return result.rows[0];
        }
        
        if (shard.type === 'd1') {
            const keys = Object.keys(dataToInsert);
            const values = Object.values(dataToInsert).map(v => v instanceof Date ? v.toISOString() : v);
            const placeholders = keys.map(() => '?').join(', ');
            
            await executeD1Query(
                shard.index, 
                `INSERT INTO posts (${keys.join(', ')}) VALUES (${placeholders})`, 
                values
            );
            return dataToInsert;
        }
    }

    static async getPost(postId, postOwnerId) {
        const shard = determineShard(postOwnerId);

        if (shard.type === 'mongodb') {
            const db = await getMongoClient();
            return await db.collection('posts').findOne({ id: postId });
        }

        if (shard.type === 'supabase') {
            const supabase = getSupabaseClient();
            const { data, error } = await supabase.from('posts').select('*').eq('id', postId).single();
            if (error) throw error;
            return data;
        }

        if (shard.type === 'neon') {
            const pool = getNeonClient();
            const result = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
            return result.rows[0];
        }

        if (shard.type === 'd1') {
            const results = await executeD1Query(shard.index, 'SELECT * FROM posts WHERE id = ?', [postId]);
            return results[0];
        }
    }

    static async deletePost(postId, postOwnerId) {
        const shard = determineShard(postOwnerId);

        if (shard.type === 'mongodb') {
            const db = await getMongoClient();
            await db.collection('posts').deleteOne({ id: postId });
            await db.collection('comments').deleteMany({ post_id: postId });
            await db.collection('likes').deleteMany({ post_id: postId });
        }

        if (shard.type === 'supabase') {
            const supabase = getSupabaseClient();
            await supabase.from('posts').delete().eq('id', postId);
            await supabase.from('comments').delete().eq('post_id', postId);
            await supabase.from('likes').delete().eq('post_id', postId);
        }

        if (shard.type === 'neon') {
            const pool = getNeonClient();
            await pool.query('DELETE FROM posts WHERE id = $1', [postId]);
            await pool.query('DELETE FROM comments WHERE post_id = $1', [postId]);
            await pool.query('DELETE FROM likes WHERE post_id = $1', [postId]);
        }

        if (shard.type === 'd1') {
            await executeD1Query(shard.index, 'DELETE FROM posts WHERE id = ?', [postId]);
            await executeD1Query(shard.index, 'DELETE FROM comments WHERE post_id = ?', [postId]);
            await executeD1Query(shard.index, 'DELETE FROM likes WHERE post_id = ?', [postId]);
        }
    }

    // ==========================================
    // INTER-SHARD SOCIAL FEATURES
    // ==========================================

    static async getComments(postId, postOwnerId) {
        const shard = determineShard(postOwnerId);

        if (shard.type === 'mongodb') {
            const db = await getMongoClient();
            return await db.collection('comments').find({ post_id: postId }).sort({ created_at: 1 }).toArray();
        }

        if (shard.type === 'supabase') {
            const supabase = getSupabaseClient();
            const { data, error } = await supabase.from('comments').select('*').eq('post_id', postId).order('created_at', { ascending: true });
            if (error) throw error;
            return data;
        }

        if (shard.type === 'neon') {
            const pool = getNeonClient();
            const result = await pool.query('SELECT * FROM comments WHERE post_id = $1 ORDER BY created_at ASC', [postId]);
            return result.rows;
        }

        if (shard.type === 'd1') {
            return await executeD1Query(shard.index, 'SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC', [postId]);
        }
    }

    static async insertComment(postId, postOwnerId, userId, text) {
        const shard = determineShard(postOwnerId);
        const commentData = {
            post_id: postId,
            user_id: userId,
            text,
            created_at: new Date()
        };

        if (shard.type === 'mongodb') {
            const db = await getMongoClient();
            const result = await db.collection('comments').insertOne(commentData);
            return { id: result.insertedId, ...commentData };
        }

        if (shard.type === 'supabase') {
            const supabase = getSupabaseClient();
            const { data, error } = await supabase.from('comments').insert([commentData]).select();
            if (error) throw error;
            return data[0];
        }

        if (shard.type === 'neon') {
            const pool = getNeonClient();
            const result = await pool.query(
                'INSERT INTO comments (post_id, user_id, text) VALUES ($1, $2, $3) RETURNING *',
                [postId, userId, text]
            );
            return result.rows[0];
        }

        if (shard.type === 'd1') {
            const created = new Date().toISOString();
            await executeD1Query(
                shard.index,
                'INSERT INTO comments (post_id, user_id, text, created_at) VALUES (?, ?, ?, ?)',
                [postId, userId, text, created]
            );
            return { post_id: postId, user_id: userId, text, created_at: created };
        }
    }

    static async getLikesCount(postId, postOwnerId) {
        const shard = determineShard(postOwnerId);

        if (shard.type === 'mongodb') {
            const db = await getMongoClient();
            return await db.collection('likes').countDocuments({ post_id: postId });
        }

        if (shard.type === 'supabase') {
            const supabase = getSupabaseClient();
            const { count, error } = await supabase.from('likes').select('*', { count: 'exact', head: true }).eq('post_id', postId);
            if (error) throw error;
            return count;
        }

        if (shard.type === 'neon') {
            const pool = getNeonClient();
            const result = await pool.query('SELECT COUNT(*)::int as count FROM likes WHERE post_id = $1', [postId]);
            return result.rows[0].count;
        }

        if (shard.type === 'd1') {
            const results = await executeD1Query(shard.index, 'SELECT COUNT(*) as count FROM likes WHERE post_id = ?', [postId]);
            return results[0]?.count || 0;
        }
    }

    static async toggleLike(postId, postOwnerId, userId) {
        const shard = determineShard(postOwnerId);

        if (shard.type === 'mongodb') {
            const db = await getMongoClient();
            const existing = await db.collection('likes').findOne({ post_id: postId, user_id: userId });
            if (existing) {
                await db.collection('likes').deleteOne({ post_id: postId, user_id: userId });
                return { liked: false };
            } else {
                await db.collection('likes').insertOne({ post_id: postId, user_id: userId, created_at: new Date() });
                return { liked: true };
            }
        }

        if (shard.type === 'supabase') {
            const supabase = getSupabaseClient();
            const { data: existing } = await supabase.from('likes').select('*').eq('post_id', postId).eq('user_id', userId).maybeSingle();
            if (existing) {
                await supabase.from('likes').delete().eq('post_id', postId).eq('user_id', userId);
                return { liked: false };
            } else {
                await supabase.from('likes').insert([{ post_id: postId, user_id: userId }]);
                return { liked: true };
            }
        }

        if (shard.type === 'neon') {
            const pool = getNeonClient();
            const existing = await pool.query('SELECT * FROM likes WHERE post_id = $1 AND user_id = $2', [postId, userId]);
            if (existing.rows.length) {
                await pool.query('DELETE FROM likes WHERE post_id = $1 AND user_id = $2', [postId, userId]);
                return { liked: false };
            } else {
                await pool.query('INSERT INTO likes (post_id, user_id) VALUES ($1, $2)', [postId, userId]);
                return { liked: true };
            }
        }

        if (shard.type === 'd1') {
            const existing = await executeD1Query(shard.index, 'SELECT * FROM likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
            if (existing.length) {
                await executeD1Query(shard.index, 'DELETE FROM likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
                return { liked: false };
            } else {
                await executeD1Query(shard.index, 'INSERT INTO likes (post_id, user_id, created_at) VALUES (?, ?, ?)', [postId, userId, new Date().toISOString()]);
                return { liked: true };
            }
        }
    }

    // ==========================================
    // MESSAGING SHARDING (By Sender Shard)
    // ==========================================

    static async insertMessage(conversationId, senderId, text, imageUrl, postId) {
        const shard = determineShard(senderId);
        const msgData = {
            conversation_id: conversationId,
            sender_id: senderId,
            text: text || '',
            image_url: imageUrl || '',
            post_id: postId || null,
            is_read: false,
            created_at: new Date()
        };

        if (shard.type === 'mongodb') {
            const db = await getMongoClient();
            const result = await db.collection('messages').insertOne(msgData);
            return { id: result.insertedId, ...msgData };
        }

        if (shard.type === 'supabase') {
            const supabase = getSupabaseClient();
            const { data, error } = await supabase.from('messages').insert([msgData]).select();
            if (error) throw error;
            return data[0];
        }

        if (shard.type === 'neon') {
            const pool = getNeonClient();
            const result = await pool.query(
                'INSERT INTO messages (conversation_id, sender_id, text, image_url, post_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
                [conversationId, senderId, text || '', imageUrl || '', postId || null]
            );
            return result.rows[0];
        }

        if (shard.type === 'd1') {
            const created = new Date().toISOString();
            await executeD1Query(
                shard.index,
                'INSERT INTO messages (conversation_id, sender_id, text, image_url, post_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                [conversationId, senderId, text || '', imageUrl || '', postId || null, created]
            );
            return { conversation_id: conversationId, sender_id: senderId, text, image_url: imageUrl, post_id: postId, created_at: created };
        }
    }

    static async getMemberMessages(conversationId, memberId) {
        const shard = determineShard(memberId);

        if (shard.type === 'mongodb') {
            const db = await getMongoClient();
            return await db.collection('messages').find({ conversation_id: conversationId, sender_id: memberId }).toArray();
        }

        if (shard.type === 'supabase') {
            const supabase = getSupabaseClient();
            const { data, error } = await supabase.from('messages').select('*').eq('conversation_id', conversationId).eq('sender_id', memberId);
            if (error) throw error;
            return data;
        }

        if (shard.type === 'neon') {
            const pool = getNeonClient();
            const result = await pool.query('SELECT * FROM messages WHERE conversation_id = $1 AND sender_id = $2', [conversationId, memberId]);
            return result.rows;
        }

        if (shard.type === 'd1') {
            return await executeD1Query(shard.index, 'SELECT * FROM messages WHERE conversation_id = ? AND sender_id = ?', [conversationId, memberId]);
        }
    }
}

module.exports = DatabaseRouter;
