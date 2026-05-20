const { Pool } = require('@neondatabase/serverless');
const verifyToken = require('./_utils/authHelper');
const DatabaseRouter = require('./_utils/DatabaseRouter');
const WebSocketManager = require('./_utils/WebSocketManager');
const CacheLayer = require('./_utils/CacheLayer');
const RateLimiter = require('./_utils/RateLimiter');

const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL });

function extractHashtags(text) {
  if (!text) return [];
  const m = text.match(/#[a-zA-Z0-9_]+/g);
  return m ? [...new Set(m.map(t => t.slice(1).toLowerCase()))] : [];
}

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 1. IP & User Rate Limiting (Bot & Abuse Protection)
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
  if (await RateLimiter.isRateLimited(ip, 'global', 120, 60)) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  const user = verifyToken(req);
  if (user) {
    const isMutating = req.method !== 'GET';
    const limit = isMutating ? 15 : 60;
    if (await RateLimiter.isRateLimited(user.id, `posts:${isMutating ? 'write' : 'read'}`, limit, 60)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please slow down.' });
    }
  }

  const qp = req.query || {};
  const action = qp.action || '';

  // Helper: Find post owner from the central registry
  const getPostOwner = async (postId) => {
    const client = await pool.connect();
    const result = await client.query('SELECT user_id, user_name, image_url, caption, is_private, is_archived FROM posts WHERE id=$1', [postId]);
    client.release();
    return result.rows[0];
  };

  // ── GET ──
  if (req.method === 'GET') {
    if (action === 'comments') {
      const postId = parseInt(qp.postId);
      if (!postId) return res.status(400).json({ error: 'postId required' });

      try {
        const postInfo = await getPostOwner(postId);
        if (!postInfo) return res.status(404).json({ error: 'Post not found' });

        // Retrieve sharded comments from post owner's database
        const shardedComments = await DatabaseRouter.getComments(postId, postInfo.user_id);
        
        // Enrich comments with global user profile metadata from Neon
        const client = await pool.connect();
        const enrichedComments = [];
        for (const comment of shardedComments) {
          const userRes = await client.query('SELECT name as user_name, username, avatar_url, is_verified FROM users WHERE id=$1', [comment.user_id]);
          const profile = userRes.rows[0] || { user_name: 'Unknown', username: 'unknown', avatar_url: '', is_verified: false };
          enrichedComments.push({
            ...comment,
            ...profile
          });
        }
        client.release();

        return res.status(200).json(enrichedComments);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'single') {
      const postId = parseInt(qp.postId);
      if (!postId) return res.status(400).json({ error: 'postId required' });

      try {
        const postInfo = await getPostOwner(postId);
        if (!postInfo || postInfo.is_archived) return res.status(404).json({ error: 'Not found' });

        // Retrieve full heavy post document from the user's specific database shard
        const post = await DatabaseRouter.getPost(postId, postInfo.user_id);
        if (!post) return res.status(404).json({ error: 'Post shard data not found' });

        const uid = user ? user.id : -1;
        const client = await pool.connect();

        // Enrich post with author metadata
        const authorRes = await client.query('SELECT username, avatar_url, is_verified FROM users WHERE id=$1', [postInfo.user_id]);
        const author = authorRes.rows[0] || { username: 'unknown', avatar_url: '', is_verified: false };

        // Sharded likes & comments count with Redis Cache Shield
        const likeCount = await CacheLayer.getPostLikesCount(postId, async () => {
          return await DatabaseRouter.getLikesCount(postId, postInfo.user_id);
        });
        const commentCount = await CacheLayer.getPostCommentsCount(postId, async () => {
          return (await DatabaseRouter.getComments(postId, postInfo.user_id)).length;
        });

        // Relationship checks on Neon
        const likeCheck = await client.query('SELECT 1 FROM likes WHERE post_id=$1 AND user_id=$2', [postId, uid]);
        const saveCheck = await client.query('SELECT 1 FROM saved_posts WHERE post_id=$1 AND user_id=$2', [postId, uid]);
        
        client.release();

        return res.status(200).json({
          ...post,
          ...author,
          like_count: likeCount,
          comment_count: commentCount,
          is_liked: likeCheck.rows.length > 0,
          is_saved: saveCheck.rows.length > 0
        });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // explore feed or following feed query
    try {
      const cursor = parseInt(qp.cursor) || 0;
      const limit = Math.min(parseInt(qp.limit) || 20, 50);
      const mode = qp.mode || 'all';
      const uid = user ? user.id : -1;

      const client = await pool.connect();
      let query;
      let params;

      if (mode === 'following' && user) {
        query = `
          SELECT id, user_id, user_name, image_url, caption, is_private, created_at, expires_at
          FROM posts
          WHERE expires_at > NOW() AND is_archived=false
            AND (user_id=$1 OR user_id IN (SELECT following_id FROM follows WHERE follower_id=$1))
            AND (is_private=false OR user_id=$1)
            AND user_id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id=$1)
          ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
        params = [uid, limit, cursor];
      } else {
        query = `
          SELECT id, user_id, user_name, image_url, caption, is_private, created_at, expires_at
          FROM posts
          WHERE expires_at > NOW() AND is_archived=false
            AND (is_private=false OR user_id=$1)
            AND user_id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id=$1)
          ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
        params = [uid, limit, cursor];
      }

      const result = await client.query(query, params);
      const posts = result.rows;

      // Enrich feed items with user details, sharded likes, and sharded comments count
      const enrichedPosts = [];
      for (const p of posts) {
        const authorRes = await client.query('SELECT username, avatar_url, is_verified FROM users WHERE id=$1', [p.user_id]);
        const author = authorRes.rows[0] || { username: 'unknown', avatar_url: '', is_verified: false };

        const likeCount = await CacheLayer.getPostLikesCount(p.id, async () => {
          return await DatabaseRouter.getLikesCount(p.id, p.user_id);
        });
        const commentCount = await CacheLayer.getPostCommentsCount(p.id, async () => {
          return (await DatabaseRouter.getComments(p.id, p.user_id)).length;
        });

        const likeCheck = await client.query('SELECT 1 FROM likes WHERE post_id=$1 AND user_id=$2', [p.id, uid]);
        const saveCheck = await client.query('SELECT 1 FROM saved_posts WHERE post_id=$1 AND user_id=$2', [p.id, uid]);

        enrichedPosts.push({
          ...p,
          ...author,
          like_count: likeCount,
          comment_count: commentCount,
          is_liked: likeCheck.rows.length > 0,
          is_saved: saveCheck.rows.length > 0
        });
      }

      client.release();

      return res.status(200).json({
        posts: enrichedPosts,
        nextCursor: enrichedPosts.length === limit ? cursor + limit : null
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST ──
  if (req.method === 'POST') {
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const body = req.body || {};

    if (action === 'like') {
      const pid = parseInt(body.postId);
      if (isNaN(pid)) return res.status(400).json({ error: 'Valid postId required' });
      try {
        const postInfo = await getPostOwner(pid);
        if (!postInfo) return res.status(404).json({ error: 'Post not found' });

        const client = await pool.connect();
        await client.query('INSERT INTO likes (user_id,post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [user.id, pid]);
        
        if (postInfo.user_id !== user.id) {
          await client.query('INSERT INTO notifications (user_id,actor_id,type,post_id) VALUES ($1,$2,\'like\',$3)', [postInfo.user_id, user.id, pid]);
          
          // Real-time notification broadcast specifically to recipient user's sharded provider
          await WebSocketManager.sendToUser(postInfo.user_id, 'notification', {
            type: 'like',
            actor_name: user.name,
            actor_id: user.id,
            post_id: pid
          });
        }
        client.release();

        // Sharded toggle/like sync
        await DatabaseRouter.toggleLike(pid, postInfo.user_id, user.id);
        
        // Atomic increment of likes count in Redis
        await CacheLayer.incrementLikesCount(pid);
        const count = await CacheLayer.getPostLikesCount(pid, async () => {
          return await DatabaseRouter.getLikesCount(pid, postInfo.user_id);
        });

        return res.status(200).json({ liked: true, like_count: count });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'unlike') {
      const pid = parseInt(body.postId);
      if (isNaN(pid)) return res.status(400).json({ error: 'Valid postId required' });
      try {
        const postInfo = await getPostOwner(pid);
        if (!postInfo) return res.status(404).json({ error: 'Post not found' });

        const client = await pool.connect();
        await client.query('DELETE FROM likes WHERE user_id=$1 AND post_id=$2', [user.id, pid]);
        client.release();

        // Sharded toggle/like sync
        await DatabaseRouter.toggleLike(pid, postInfo.user_id, user.id);
        
        // Atomic decrement of likes count in Redis
        await CacheLayer.decrementLikesCount(pid);
        const count = await CacheLayer.getPostLikesCount(pid, async () => {
          return await DatabaseRouter.getLikesCount(pid, postInfo.user_id);
        });

        return res.status(200).json({ liked: false, like_count: count });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'comment') {
      const { postId, text } = body;
      const pid = parseInt(postId);
      if (isNaN(pid) || !text?.trim()) return res.status(400).json({ error: 'Valid postId and text required' });

      try {
        const postInfo = await getPostOwner(pid);
        if (!postInfo) return res.status(404).json({ error: 'Post not found' });

        // Save into sharded database comments collection/table
        const comment = await DatabaseRouter.insertComment(pid, postInfo.user_id, user.id, text.trim());

        // Atomic increment of comments count in Redis
        await CacheLayer.incrementCommentsCount(pid);

        const client = await pool.connect();
        // Insert notification
        if (postInfo.user_id !== user.id) {
          await client.query('INSERT INTO notifications (user_id,actor_id,type,post_id) VALUES ($1,$2,\'comment\',$3)', [postInfo.user_id, user.id, pid]);
          
          // Real-time notification broadcast specifically to recipient user's sharded provider
          await WebSocketManager.sendToUser(postInfo.user_id, 'notification', {
            type: 'comment',
            actor_name: user.name,
            actor_id: user.id,
            post_id: pid
          });
        }

        // Handle mentions
        const mentions = text.match(/@([a-zA-Z0-9._]+)/g);
        if (mentions) {
          for (const m of mentions) {
            const mu = await client.query('SELECT id FROM users WHERE username=$1', [m.slice(1).toLowerCase()]);
            if (mu.rows.length && mu.rows[0].id !== user.id) {
              await client.query('INSERT INTO notifications (user_id,actor_id,type,post_id) VALUES ($1,$2,\'mention\',$3)', [mu.rows[0].id, user.id, postId]);
            }
          }
        }
        client.release();

        return res.status(201).json({
          id: comment.id,
          text: text.trim(),
          created_at: comment.created_at,
          user_id: user.id,
          user_name: user.name,
          username: user.username
        });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'save') {
      try {
        const client = await pool.connect();
        await client.query('INSERT INTO saved_posts (user_id,post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [user.id, parseInt(body.postId)]);
        client.release();
        return res.status(200).json({ saved: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'unsave') {
      try {
        const client = await pool.connect();
        await client.query('DELETE FROM saved_posts WHERE user_id=$1 AND post_id=$2', [user.id, parseInt(body.postId)]);
        client.release();
        return res.status(200).json({ saved: false });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // Default: Create Post
    if (!action) {
      const { image_url, caption, is_private } = body;
      if (!image_url) return res.status(400).json({ error: 'image_url required' });

      try {
        const client = await pool.connect();
        
        // 1. Insert into Neon Global Index (to generate a unique post ID)
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + 7);
        
        const neonResult = await client.query(
          'INSERT INTO posts (user_id, user_name, image_url, caption, is_private, expires_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at',
          [user.id, user.name, image_url, caption || '', is_private || false, expiry]
        );
        const post = neonResult.rows[0];

        // 2. Insert heavy post details into Sharded DB (MongoDB, Supabase, Neon, or D1 1-10)
        await DatabaseRouter.insertPost({
          id: post.id,
          user_id: user.id,
          user_name: user.name,
          image_url,
          caption: caption || '',
          is_private: is_private || false
        });

        // 3. Handle Hashtags on Neon
        const tags = extractHashtags(caption);
        for (const tag of tags) {
          await client.query('INSERT INTO hashtags (name) VALUES ($1) ON CONFLICT DO NOTHING', [tag]);
          const ht = await client.query('SELECT id FROM hashtags WHERE name=$1', [tag]);
          if (ht.rows.length) {
            await client.query('INSERT INTO post_hashtags (post_id,hashtag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [post.id, ht.rows[0].id]);
          }
        }
        client.release();

        return res.status(201).json({ ok: true, postId: post.id });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
  }

  // ── DELETE ──
  if (req.method === 'DELETE') {
    if (!user) return res.status(401).json({ error: 'Not logged in' });

    const postId = parseInt(qp.postId);
    if (!postId || isNaN(postId)) return res.status(400).json({ error: 'Valid postId required' });

    try {
      const postInfo = await getPostOwner(postId);
      if (!postInfo) return res.status(404).json({ error: 'Post not found' });
      if (postInfo.user_id !== user.id) return res.status(403).json({ error: 'Not your post' });

      // Delete from Sharded DB
      await DatabaseRouter.deletePost(postId, postInfo.user_id);

      // Clean up Redis Caches for this post
      const { Redis } = require('@upstash/redis');
      const redisA = new Redis({
          url: process.env.UPSTASH_REDIS_A_URL,
          token: process.env.UPSTASH_REDIS_A_TOKEN,
      });
      await Promise.all([
          redisA.del(`post:${postId}:likes_count`),
          redisA.del(`post:${postId}:comments_count`)
      ]).catch(() => {});

      // Delete from Neon Global Index
      const client = await pool.connect();
      await client.query('DELETE FROM posts WHERE id=$1', [postId]);
      client.release();

      return res.status(200).json({ deleted: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
