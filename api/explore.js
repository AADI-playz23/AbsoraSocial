// netlify/functions/explore.js
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
  if (event.httpMethod !== 'GET') return err(405, 'Method not allowed');

  const DB = process.env.DATABASE_URL;
  if (!DB) return err(500, 'DATABASE_URL not set');
  const JWT_SECRET = DB.slice(-32);
  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  const user = verifyToken(token, JWT_SECRET);
  const sql = neon(DB);
  const qp = event.queryStringParameters || {};
  const action = qp.action || 'trending';

  const uid = user ? user.id : -1;

  // Trending posts (most liked recently)
  if (action === 'trending') {
    const cursor = parseInt(qp.cursor) || 0;
    try {
      const posts = await sql`
        SELECT p.id, p.image_url, p.caption, p.user_id, p.created_at, p.user_name,
               u.username, u.avatar_url, u.is_verified,
               (SELECT COUNT(*)::int FROM likes WHERE post_id=p.id) as like_count,
               (SELECT COUNT(*)::int FROM comments WHERE post_id=p.id) as comment_count
        FROM posts p JOIN users u ON p.user_id=u.id
        WHERE p.expires_at > NOW() AND p.is_archived=false AND p.is_private=false
          AND p.user_id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id=${uid})
        ORDER BY like_count DESC, p.created_at DESC
        LIMIT 30 OFFSET ${cursor}`;
      return ok(200, { posts, nextCursor: posts.length === 30 ? cursor + 30 : null });
    } catch (e) { return err(500, e.message); }
  }

  // Posts by hashtag
  if (action === 'hashtag') {
    const tag = (qp.tag || '').toLowerCase();
    if (!tag) return err(400, 'tag required');
    try {
      const posts = await sql`
        SELECT p.id, p.image_url, p.caption, p.user_id, p.created_at, p.user_name,
               u.username, u.avatar_url, u.is_verified,
               (SELECT COUNT(*)::int FROM likes WHERE post_id=p.id) as like_count,
               (SELECT COUNT(*)::int FROM comments WHERE post_id=p.id) as comment_count
        FROM posts p
        JOIN users u ON p.user_id=u.id
        JOIN post_hashtags ph ON ph.post_id=p.id
        JOIN hashtags h ON h.id=ph.hashtag_id
        WHERE h.name=${tag} AND p.expires_at > NOW() AND p.is_archived=false AND p.is_private=false
        ORDER BY p.created_at DESC LIMIT 60`;
      const [{count}] = await sql`
        SELECT COUNT(*)::int as count FROM post_hashtags ph
        JOIN hashtags h ON h.id=ph.hashtag_id WHERE h.name=${tag}`;
      return ok(200, { posts, tag, post_count: count });
    } catch (e) { return err(500, e.message); }
  }

  // Trending hashtags
  if (action === 'tags') {
    try {
      const tags = await sql`
        SELECT h.name, COUNT(ph.post_id)::int as post_count
        FROM hashtags h JOIN post_hashtags ph ON ph.hashtag_id=h.id
        JOIN posts p ON p.id=ph.post_id
        WHERE p.expires_at > NOW() AND p.is_archived=false
        GROUP BY h.id ORDER BY post_count DESC LIMIT 20`;
      return ok(200, tags);
    } catch (e) { return err(500, e.message); }
  }

  return err(400, 'Unknown action');
};
