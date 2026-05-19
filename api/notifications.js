// netlify/functions/notifications.js
const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

const H = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS' };
const ok  = (code, body) => ({ statusCode: code, headers: H, body: JSON.stringify(body) });
const err = (code, msg)  => ok(code, { error: msg });

function verifyToken(token, secret) {
  if (!token) return null;
  try {
    const [data, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
    if (sig !== expected) return null;
    return JSON.parse(Buffer.from(data, 'base64url').toString());
  } catch { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return ok(200, '');
  const DB = process.env.DATABASE_URL;
  if (!DB) return err(500, 'DATABASE_URL not set');
  const JWT_SECRET = DB.slice(-32);
  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  const user = verifyToken(token, JWT_SECRET);
  if (!user) return err(401, 'Not logged in');
  const sql = neon(DB);
  const qp = event.queryStringParameters || {};
  const action = qp.action || '';

  if (event.httpMethod === 'GET') {
    // Get notifications
    try {
      const notifs = await sql`
        SELECT n.id, n.type, n.post_id, n.comment_id, n.is_read, n.created_at,
               u.id as actor_id, u.name as actor_name, u.username as actor_username,
               u.avatar_url as actor_avatar, u.is_verified as actor_verified,
               p.image_url as post_image
        FROM notifications n
        JOIN users u ON u.id=n.actor_id
        LEFT JOIN posts p ON p.id=n.post_id
        WHERE n.user_id=${user.id}
        ORDER BY n.created_at DESC LIMIT 50`;
      const [{count}] = await sql`SELECT COUNT(*)::int as count FROM notifications WHERE user_id=${user.id} AND is_read=false`;
      return ok(200, { notifications: notifs, unread_count: count });
    } catch (e) { return err(500, e.message); }
  }

  if (event.httpMethod === 'POST') {
    // Mark all as read
    if (action === 'read') {
      try {
        await sql`UPDATE notifications SET is_read=true WHERE user_id=${user.id} AND is_read=false`;
        return ok(200, { ok: true });
      } catch (e) { return err(500, e.message); }
    }
    return err(400, 'Unknown action');
  }

  return err(405, 'Method not allowed');
};
