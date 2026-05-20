const { Pool } = require('@neondatabase/serverless');
const verifyToken = require('./utils/authHelper');
const RateLimiter = require('./utils/RateLimiter');

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
  const limit = isMutating ? 15 : 60;
  if (await RateLimiter.isRateLimited(user.id, `notifications:${isMutating ? 'write' : 'read'}`, limit, 60)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please slow down.' });
  }

  const qp = req.query || {};
  const action = qp.action || '';

  // ── GET ──
  if (req.method === 'GET') {
    try {
      const client = await pool.connect();
      const notifsRes = await client.query(
        `SELECT n.id, n.type, n.post_id, n.comment_id, n.is_read, n.created_at,
                u.id as actor_id, u.name as actor_name, u.username as actor_username,
                u.avatar_url as actor_avatar, u.is_verified as actor_verified,
                p.image_url as post_image
         FROM notifications n
         JOIN users u ON u.id=n.actor_id
         LEFT JOIN posts p ON p.id=n.post_id
         WHERE n.user_id=$1
         ORDER BY n.created_at DESC LIMIT 50`,
        [user.id]
      );
      
      const countRes = await client.query(
        'SELECT COUNT(*)::int as count FROM notifications WHERE user_id=$1 AND is_read=false',
        [user.id]
      );
      client.release();

      return res.status(200).json({
        notifications: notifsRes.rows,
        unread_count: countRes.rows[0].count
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST ──
  if (req.method === 'POST') {
    if (action === 'read') {
      try {
        const client = await pool.connect();
        await client.query('UPDATE notifications SET is_read=true WHERE user_id=$1 AND is_read=false', [user.id]);
        client.release();
        return res.status(200).json({ ok: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
    return res.status(400).json({ error: 'Unknown action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
