const { Pool } = require('@neondatabase/serverless');
const verifyToken = require('./_utils/authHelper');
const RateLimiter = require('./_utils/RateLimiter');

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
  
  // 1. IP & User Rate Limiting (Bot & Abuse Protection)
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
  if (await RateLimiter.isRateLimited(ip, 'global', 120, 60)) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  const isMutating = req.method !== 'GET';
  const limit = isMutating ? 15 : 60;
  if (user) {
    if (await RateLimiter.isRateLimited(user.id, `stories:${isMutating ? 'write' : 'read'}`, limit, 60)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please slow down.' });
    }
  }

  const qp = req.query || {};
  const action = qp.action || '';

  // ── GET ──
  if (req.method === 'GET') {
    if (action === 'feed') {
      try {
        const uid = user ? user.id : -1;
        const client = await pool.connect();
        const result = await client.query(
          `SELECT s.id, s.user_id, s.image_url, s.text_overlay, s.created_at, s.expires_at,
                  u.name as user_name, u.username, u.avatar_url, u.is_verified,
                  EXISTS(SELECT 1 FROM story_views WHERE story_id=s.id AND user_id=$1) as is_viewed
           FROM stories s JOIN users u ON s.user_id=u.id
           WHERE s.expires_at > NOW()
             AND s.user_id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id=$1)
           ORDER BY s.created_at DESC`,
          [uid]
        );
        client.release();

        const stories = result.rows;
        // Group by user
        const grouped = {};
        stories.forEach(s => {
          if (!grouped[s.user_id]) {
            grouped[s.user_id] = {
              user_id: s.user_id,
              user_name: s.user_name,
              username: s.username,
              avatar_url: s.avatar_url,
              is_verified: s.is_verified,
              stories: [],
              all_viewed: true
            };
          }
          grouped[s.user_id].stories.push(s);
          if (!s.is_viewed) grouped[s.user_id].all_viewed = false;
        });

        // Sort: own stories first, then unviewed, then viewed
        const sortedResult = Object.values(grouped).sort((a, b) => {
          if (a.user_id === uid) return -1;
          if (b.user_id === uid) return 1;
          if (a.all_viewed !== b.all_viewed) return a.all_viewed ? 1 : -1;
          return 0;
        });

        return res.status(200).json(sortedResult);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'viewers') {
      if (!user) return res.status(401).json({ error: 'Not logged in' });
      const storyId = parseInt(qp.storyId);
      try {
        const client = await pool.connect();
        const result = await client.query(
          `SELECT u.id, u.name, u.username, u.avatar_url, sv.viewed_at
           FROM story_views sv JOIN users u ON u.id=sv.user_id
           WHERE sv.story_id=$1 ORDER BY sv.viewed_at DESC`,
          [storyId]
        );
        client.release();
        return res.status(200).json(result.rows);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  // ── POST ──
  if (req.method === 'POST') {
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const body = req.body || {};

    if (action === 'create') {
      const { image_url, text_overlay } = body;
      if (!image_url) return res.status(400).json({ error: 'image_url required' });
      try {
        const client = await pool.connect();
        const result = await client.query(
          'INSERT INTO stories (user_id, image_url, text_overlay) VALUES ($1, $2, $3) RETURNING id, created_at, expires_at',
          [user.id, image_url, text_overlay || '']
        );
        client.release();
        return res.status(201).json(result.rows[0]);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'view') {
      const storyId = parseInt(body.storyId);
      try {
        const client = await pool.connect();
        await client.query('INSERT INTO story_views (story_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [storyId, user.id]);
        client.release();
        return res.status(200).json({ viewed: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  // ── DELETE ──
  if (req.method === 'DELETE') {
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const storyId = parseInt(qp.storyId);
    try {
      const client = await pool.connect();
      await client.query('DELETE FROM stories WHERE id=$1 AND user_id=$2', [storyId, user.id]);
      client.release();
      return res.status(200).json({ deleted: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
