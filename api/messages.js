const { Pool } = require('@neondatabase/serverless');
const verifyToken = require('./utils/authHelper');
const DatabaseRouter = require('./utils/DatabaseRouter');
const WebSocketManager = require('./utils/WebSocketManager');
const RateLimiter = require('./utils/RateLimiter');
const IdempotencyShield = require('./utils/IdempotencyShield');

const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL });

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  // 1. IP & User Rate Limiting (Bot & Abuse Protection)
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
  if (await RateLimiter.isRateLimited(ip, 'global', 120, 60)) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  const isMutating = req.method !== 'GET';
  const limit = isMutating ? 20 : 60;
  if (await RateLimiter.isRateLimited(user.id, `messages:${isMutating ? 'write' : 'read'}`, limit, 60)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please slow down.' });
  }

  const qp = req.query || {};
  const action = qp.action || '';

  // Update last_active on Neon
  try {
    const client = await pool.connect();
    await client.query('UPDATE users SET last_active=NOW() WHERE id=$1', [user.id]);
    client.release();
  } catch (err) {}

  // ── GET ──
  if (req.method === 'GET') {
    if (action === 'conversations') {
      try {
        const client = await pool.connect();
        
        // Find all conversations where the authenticated user is a member
        const convosRes = await client.query(
          `SELECT c.id, c.updated_at
           FROM conversations c
           JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=$1
           ORDER BY c.updated_at DESC LIMIT 50`,
          [user.id]
        );
        const conversations = convosRes.rows;

        const enrichedConvos = [];
        for (const c of conversations) {
          // Get other conversation members
          const membersRes = await client.query(
            `SELECT u.id, u.name, u.username, u.avatar_url, u.is_verified, u.last_active, u.show_activity
             FROM conversation_members cm
             JOIN users u ON u.id=cm.user_id
             WHERE cm.conversation_id=$1 AND cm.user_id != $2`,
            [c.id, user.id]
          );

          // Get all member IDs in this conversation to query their shards
          const allMembersRes = await client.query(
            'SELECT user_id FROM conversation_members WHERE conversation_id=$1',
            [c.id]
          );
          const memberIds = allMembersRes.rows.map(r => r.user_id);

          // Concurrently fetch messages from all member shards
          const msgPromises = memberIds.map(mid => DatabaseRouter.getMemberMessages(c.id, mid));
          const msgGroups = await Promise.all(msgPromises);
          const allMsgs = msgGroups.flat().sort((x, y) => new Date(x.created_at) - new Date(y.created_at));

          const last_message = allMsgs[allMsgs.length - 1] || null;
          const unread_count = allMsgs.filter(m => m.sender_id !== user.id && !m.is_read).length;

          enrichedConvos.push({
            id: c.id,
            updated_at: c.updated_at,
            members: membersRes.rows,
            last_message: last_message ? {
              text: last_message.text,
              sender_id: last_message.sender_id,
              created_at: last_message.created_at,
              image_url: last_message.image_url
            } : null,
            unread_count
          });
        }
        client.release();

        return res.status(200).json(enrichedConvos);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'messages') {
      const convId = parseInt(qp.conversationId);
      if (!convId) return res.status(400).json({ error: 'conversationId required' });

      try {
        const client = await pool.connect();
        
        // Verify Membership
        const memberCheck = await client.query('SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [convId, user.id]);
        if (memberCheck.rows.length === 0) {
          client.release();
          return res.status(403).json({ error: 'Not a member' });
        }

        // Get conversation member IDs
        const membersRes = await client.query('SELECT user_id FROM conversation_members WHERE conversation_id=$1', [convId]);
        const memberIds = membersRes.rows.map(r => r.user_id);

        // Fetch messages from all member shards
        const msgPromises = memberIds.map(mid => DatabaseRouter.getMemberMessages(convId, mid));
        const msgGroups = await Promise.all(msgPromises);
        const allMsgs = msgGroups.flat().sort((x, y) => new Date(x.created_at) - new Date(y.created_at));

        // Enrich messages with sender metadata from central Neon users
        const enrichedMessages = [];
        for (const msg of allMsgs) {
          const senderRes = await client.query('SELECT name as sender_name, username as sender_username, avatar_url as sender_avatar FROM users WHERE id=$1', [msg.sender_id]);
          const sender = senderRes.rows[0] || { sender_name: 'Unknown', sender_username: 'unknown', sender_avatar: '' };
          enrichedMessages.push({
            ...msg,
            ...sender
          });
        }
        client.release();

        return res.status(200).json(enrichedMessages);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'unread') {
      try {
        const client = await pool.connect();
        const convosRes = await client.query('SELECT conversation_id FROM conversation_members WHERE user_id=$1', [user.id]);
        const convoIds = convosRes.rows.map(r => r.conversation_id);

        let totalUnread = 0;
        for (const cid of convoIds) {
          const membersRes = await client.query('SELECT user_id FROM conversation_members WHERE conversation_id=$1', [cid]);
          const memberIds = membersRes.rows.map(r => r.user_id);

          const msgPromises = memberIds.map(mid => DatabaseRouter.getMemberMessages(cid, mid));
          const msgGroups = await Promise.all(msgPromises);
          const allMsgs = msgGroups.flat();
          totalUnread += allMsgs.filter(m => m.sender_id !== user.id && !m.is_read).length;
        }
        client.release();

        return res.status(200).json({ unread: totalUnread });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  // ── POST ──
  if (req.method === 'POST') {
    const body = req.body || {};

    if (action === 'start') {
      const targetId = parseInt(body.userId);
      if (targetId === user.id) return res.status(400).json({ error: 'Cannot message yourself' });

      try {
        const client = await pool.connect();
        
        // Check if conversation already exists
        const existing = await client.query(
          `SELECT c.id FROM conversations c
           JOIN conversation_members cm1 ON cm1.conversation_id=c.id AND cm1.user_id=$1
           JOIN conversation_members cm2 ON cm2.conversation_id=c.id AND cm2.user_id=$2
           LIMIT 1`,
          [user.id, targetId]
        );

        if (existing.rows.length) {
          client.release();
          return res.status(200).json({ conversationId: existing.rows[0].id });
        }

        // Create new conversation
        const convResult = await client.query('INSERT INTO conversations DEFAULT VALUES RETURNING id');
        const convId = convResult.rows[0].id;
        
        await client.query('INSERT INTO conversation_members (conversation_id,user_id) VALUES ($1,$2),($1,$3)', [convId, user.id, targetId]);
        client.release();

        return res.status(201).json({ conversationId: convId });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'send') {
      const { conversationId, text, image_url, postId } = body;
      if (!conversationId) return res.status(400).json({ error: 'conversationId required' });
      if (!text && !image_url && !postId) return res.status(400).json({ error: 'Message content required' });

      // 2. Idempotency Shield: Deduplicate messages (prevent double submits in 3s window)
      const msgSignature = `${text || ''}:${image_url || ''}:${postId || ''}`;
      const isDuplicate = await IdempotencyShield.isDuplicate(user.id, `msg:${conversationId}`, msgSignature, 3);
      if (isDuplicate) {
        return res.status(409).json({ error: 'Duplicate message detected. Please wait.' });
      }

      try {
        const client = await pool.connect();
        
        // Verify Membership
        const memberCheck = await client.query('SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [parseInt(conversationId), user.id]);
        if (memberCheck.rows.length === 0) {
          client.release();
          return res.status(403).json({ error: 'Not a member' });
        }

        // Save sharded message using DatabaseRouter (by sender's shard)
        const msg = await DatabaseRouter.insertMessage(
          parseInt(conversationId),
          user.id,
          text || null,
          image_url || null,
          postId ? parseInt(postId) : null
        );

        // Update last active/updated_at on Neon conversations
        await client.query('UPDATE conversations SET updated_at=NOW() WHERE id=$1', [parseInt(conversationId)]);
        
        // Get all members to broadcast WebSocket message securely
        const membersList = await client.query('SELECT user_id FROM conversation_members WHERE conversation_id=$1', [parseInt(conversationId)]);
        client.release();

        const memberIds = membersList.rows.map(r => r.user_id);

        // Targeted conversation dynamic WebSocket sharding broadcast (0% waste, only to active members' sharded providers)
        await WebSocketManager.broadcastToConversation(parseInt(conversationId), memberIds, 'new-message', {
          id: msg.id,
          conversation_id: conversationId,
          sender_id: user.id,
          sender_name: user.name,
          sender_username: user.username,
          text: text || '',
          image_url: image_url || '',
          created_at: msg.created_at
        });

        return res.status(201).json({ id: msg.id, created_at: msg.created_at });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
