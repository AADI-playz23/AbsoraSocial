// netlify/functions/stories.js
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
  const sql = neon(DB);
  const qp = event.queryStringParameters || {};
  const action = qp.action || '';

  if (event.httpMethod === 'GET') {
    // Get all active stories grouped by user
    if (action === 'feed') {
      try {
        const uid = user ? user.id : -1;
        const stories = await sql`
          SELECT s.id, s.user_id, s.image_url, s.text_overlay, s.created_at, s.expires_at,
                 u.name as user_name, u.username, u.avatar_url, u.is_verified,
                 EXISTS(SELECT 1 FROM story_views WHERE story_id=s.id AND user_id=${uid}) as is_viewed
          FROM stories s JOIN users u ON s.user_id=u.id
          WHERE s.expires_at > NOW()
            AND s.user_id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id=${uid})
          ORDER BY s.created_at DESC`;
        // Group by user
        const grouped = {};
        stories.forEach(s => {
          if (!grouped[s.user_id]) grouped[s.user_id] = { user_id: s.user_id, user_name: s.user_name, username: s.username, avatar_url: s.avatar_url, is_verified: s.is_verified, stories: [], all_viewed: true };
          grouped[s.user_id].stories.push(s);
          if (!s.is_viewed) grouped[s.user_id].all_viewed = false;
        });
        // Sort: own stories first, then unviewed, then viewed
        const result = Object.values(grouped).sort((a, b) => {
          if (a.user_id === uid) return -1;
          if (b.user_id === uid) return 1;
          if (a.all_viewed !== b.all_viewed) return a.all_viewed ? 1 : -1;
          return 0;
        });
        return ok(200, result);
      } catch (e) { return err(500, e.message); }
    }

    // Get story viewers (own stories only)
    if (action === 'viewers') {
      if (!user) return err(401, 'Not logged in');
      const storyId = parseInt(qp.storyId);
      try {
        const viewers = await sql`
          SELECT u.id, u.name, u.username, u.avatar_url, sv.viewed_at
          FROM story_views sv JOIN users u ON u.id=sv.user_id
          WHERE sv.story_id=${storyId} ORDER BY sv.viewed_at DESC`;
        return ok(200, viewers);
      } catch (e) { return err(500, e.message); }
    }

    return err(400, 'Unknown action');
  }

  if (event.httpMethod === 'POST') {
    if (!user) return err(401, 'Not logged in');
    let body;
    try { body = JSON.parse(event.body); } catch { return err(400, 'Invalid JSON'); }

    if (action === 'create') {
      const { image_url, cloudinary_public_id, text_overlay } = body;
      if (!image_url) return err(400, 'image_url required');
      try {
        const [story] = await sql`
          INSERT INTO stories (user_id, image_url, cloudinary_public_id, text_overlay)
          VALUES (${user.id}, ${image_url}, ${cloudinary_public_id||''}, ${text_overlay||''})
          RETURNING id, created_at, expires_at`;
        return ok(201, story);
      } catch (e) { return err(500, e.message); }
    }

    if (action === 'view') {
      const storyId = parseInt(body.storyId);
      try {
        await sql`INSERT INTO story_views (story_id, user_id) VALUES (${storyId}, ${user.id}) ON CONFLICT DO NOTHING`;
        return ok(200, { viewed: true });
      } catch (e) { return err(500, e.message); }
    }

    return err(400, 'Unknown action');
  }

  if (event.httpMethod === 'DELETE') {
    if (!user) return err(401, 'Not logged in');
    const storyId = parseInt(qp.storyId);
    try {
      await sql`DELETE FROM stories WHERE id=${storyId} AND user_id=${user.id}`;
      return ok(200, { deleted: true });
    } catch (e) { return err(500, e.message); }
  }

  return err(405, 'Method not allowed');
};
