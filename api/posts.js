// netlify/functions/posts.js
const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;

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

function extractHashtags(text) {
  if (!text) return [];
  const m = text.match(/#[a-zA-Z0-9_]+/g);
  return m ? [...new Set(m.map(t => t.slice(1).toLowerCase()))] : [];
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
  const action = (event.queryStringParameters || {}).action || '';
  const qp = event.queryStringParameters || {};

  // ── GET ──
  if (event.httpMethod === 'GET') {
    if (action === 'comments') {
      const postId = parseInt(qp.postId);
      if (!postId) return err(400, 'postId required');
      try {
        const comments = await sql`
          SELECT c.id, c.text, c.created_at, c.user_id,
                 u.name as user_name, u.username, u.avatar_url, u.is_verified
          FROM comments c JOIN users u ON c.user_id = u.id
          WHERE c.post_id = ${postId} ORDER BY c.created_at ASC LIMIT 200`;
        return ok(200, comments);
      } catch (e) { return err(500, e.message); }
    }
    if (action === 'single') {
      const postId = parseInt(qp.postId);
      if (!postId) return err(400, 'postId required');
      try {
        const uid = user ? user.id : -1;
        const [post] = await sql`
          SELECT p.*, u.username, u.avatar_url, u.is_verified,
            (SELECT COUNT(*)::int FROM likes WHERE post_id=p.id) as like_count,
            (SELECT COUNT(*)::int FROM comments WHERE post_id=p.id) as comment_count,
            EXISTS(SELECT 1 FROM likes WHERE post_id=p.id AND user_id=${uid}) as is_liked,
            EXISTS(SELECT 1 FROM saved_posts WHERE post_id=p.id AND user_id=${uid}) as is_saved
          FROM posts p JOIN users u ON p.user_id=u.id WHERE p.id=${postId} AND p.is_archived=false`;
        if (!post) return err(404, 'Not found');
        return ok(200, post);
      } catch (e) { return err(500, e.message); }
    }
    // Feed
    try {
      const cursor = parseInt(qp.cursor) || 0;
      const limit = Math.min(parseInt(qp.limit) || 20, 50);
      const mode = qp.mode || 'all';
      const uid = user ? user.id : -1;
      let posts;
      if (mode === 'following' && user) {
        posts = await sql`
          SELECT p.id, p.image_url, p.caption, p.is_private, p.user_id,
                 p.created_at, p.expires_at, p.user_name, u.username, u.avatar_url, u.is_verified,
                 (SELECT COUNT(*)::int FROM likes WHERE post_id=p.id) as like_count,
                 (SELECT COUNT(*)::int FROM comments WHERE post_id=p.id) as comment_count,
                 EXISTS(SELECT 1 FROM likes WHERE post_id=p.id AND user_id=${uid}) as is_liked,
                 EXISTS(SELECT 1 FROM saved_posts WHERE post_id=p.id AND user_id=${uid}) as is_saved
          FROM posts p JOIN users u ON p.user_id=u.id
          WHERE p.expires_at > NOW() AND p.is_archived=false
            AND (p.user_id=${uid} OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id=${uid}))
            AND (p.is_private=false OR p.user_id=${uid})
            AND p.user_id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id=${uid})
          ORDER BY p.created_at DESC LIMIT ${limit} OFFSET ${cursor}`;
      } else {
        posts = await sql`
          SELECT p.id, p.image_url, p.caption, p.is_private, p.user_id,
                 p.created_at, p.expires_at, p.user_name, u.username, u.avatar_url, u.is_verified,
                 (SELECT COUNT(*)::int FROM likes WHERE post_id=p.id) as like_count,
                 (SELECT COUNT(*)::int FROM comments WHERE post_id=p.id) as comment_count,
                 EXISTS(SELECT 1 FROM likes WHERE post_id=p.id AND user_id=${uid}) as is_liked,
                 EXISTS(SELECT 1 FROM saved_posts WHERE post_id=p.id AND user_id=${uid}) as is_saved
          FROM posts p JOIN users u ON p.user_id=u.id
          WHERE p.expires_at > NOW() AND p.is_archived=false
            AND (p.is_private=false OR p.user_id=${uid})
            AND p.user_id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id=${uid})
          ORDER BY p.created_at DESC LIMIT ${limit} OFFSET ${cursor}`;
      }
      return ok(200, { posts, nextCursor: posts.length === limit ? cursor + limit : null });
    } catch (e) { return err(500, e.message); }
  }

  // ── POST ──
  if (event.httpMethod === 'POST') {
    if (!user) return err(401, 'Not logged in');
    let body;
    try { body = JSON.parse(event.body); } catch { return err(400, 'Invalid JSON'); }

    if (action === 'like') {
      const pid = parseInt(body.postId);
      try {
        await sql`INSERT INTO likes (user_id,post_id) VALUES (${user.id},${pid}) ON CONFLICT DO NOTHING`;
        const [p] = await sql`SELECT user_id FROM posts WHERE id=${pid}`;
        if (p && p.user_id !== user.id) await sql`INSERT INTO notifications (user_id,actor_id,type,post_id) VALUES (${p.user_id},${user.id},'like',${pid})`;
        const [{count}] = await sql`SELECT COUNT(*)::int as count FROM likes WHERE post_id=${pid}`;
        return ok(200, { liked: true, like_count: count });
      } catch (e) { return err(500, e.message); }
    }
    if (action === 'unlike') {
      const pid = parseInt(body.postId);
      try {
        await sql`DELETE FROM likes WHERE user_id=${user.id} AND post_id=${pid}`;
        const [{count}] = await sql`SELECT COUNT(*)::int as count FROM likes WHERE post_id=${pid}`;
        return ok(200, { liked: false, like_count: count });
      } catch (e) { return err(500, e.message); }
    }
    if (action === 'comment') {
      const { postId, text } = body;
      if (!postId || !text?.trim()) return err(400, 'postId and text required');
      try {
        const [c] = await sql`INSERT INTO comments (user_id,post_id,text) VALUES (${user.id},${parseInt(postId)},${text.trim()}) RETURNING id, created_at`;
        const [p] = await sql`SELECT user_id FROM posts WHERE id=${parseInt(postId)}`;
        if (p && p.user_id !== user.id) await sql`INSERT INTO notifications (user_id,actor_id,type,post_id,comment_id) VALUES (${p.user_id},${user.id},'comment',${parseInt(postId)},${c.id})`;
        const mentions = text.match(/@([a-zA-Z0-9._]+)/g);
        if (mentions) {
          for (const m of mentions) {
            const [mu] = await sql`SELECT id FROM users WHERE username=${m.slice(1).toLowerCase()}`;
            if (mu && mu.id !== user.id) await sql`INSERT INTO notifications (user_id,actor_id,type,post_id,comment_id) VALUES (${mu.id},${user.id},'mention',${parseInt(postId)},${c.id})`;
          }
        }
        return ok(201, { id: c.id, text: text.trim(), created_at: c.created_at, user_id: user.id, user_name: user.name, username: user.username });
      } catch (e) { return err(500, e.message); }
    }
    if (action === 'save') {
      try { await sql`INSERT INTO saved_posts (user_id,post_id) VALUES (${user.id},${parseInt(body.postId)}) ON CONFLICT DO NOTHING`; return ok(200, { saved: true }); }
      catch (e) { return err(500, e.message); }
    }
    if (action === 'unsave') {
      try { await sql`DELETE FROM saved_posts WHERE user_id=${user.id} AND post_id=${parseInt(body.postId)}`; return ok(200, { saved: false }); }
      catch (e) { return err(500, e.message); }
    }
    if (action === 'archive') {
      try { await sql`UPDATE posts SET is_archived=true WHERE id=${parseInt(body.postId)} AND user_id=${user.id}`; return ok(200, { archived: true }); }
      catch (e) { return err(500, e.message); }
    }
    if (action === 'unarchive') {
      try { await sql`UPDATE posts SET is_archived=false WHERE id=${parseInt(body.postId)} AND user_id=${user.id}`; return ok(200, { archived: false }); }
      catch (e) { return err(500, e.message); }
    }
    if (action === 'report') {
      try { await sql`INSERT INTO reports (reporter_id,post_id,reason) VALUES (${user.id},${parseInt(body.postId)},${body.reason||'Inappropriate'})`; return ok(200, { reported: true }); }
      catch (e) { return err(500, e.message); }
    }
    // Default: create post
    if (!action) {
      const { image_url, cloudinary_public_id, caption, is_private } = body;
      if (!image_url) return err(400, 'image_url required');
      try {
        const [post] = await sql`
          INSERT INTO posts (user_id,user_name,image_url,cloudinary_public_id,caption,is_private)
          VALUES (${user.id},${user.name},${image_url},${cloudinary_public_id||''},${caption||''},${is_private||false})
          RETURNING id, created_at`;
        const tags = extractHashtags(caption);
        for (const tag of tags) {
          await sql`INSERT INTO hashtags (name) VALUES (${tag}) ON CONFLICT DO NOTHING`;
          const [ht] = await sql`SELECT id FROM hashtags WHERE name=${tag}`;
          if (ht) await sql`INSERT INTO post_hashtags (post_id,hashtag_id) VALUES (${post.id},${ht.id}) ON CONFLICT DO NOTHING`;
        }
        return ok(201, { ok: true, postId: post.id });
      } catch (e) { return err(500, e.message); }
    }
    return err(400, 'Unknown action');
  }

  // ── DELETE ──
  if (event.httpMethod === 'DELETE') {
    if (!user) return err(401, 'Not logged in');
    if (action === 'comment') {
      try { await sql`DELETE FROM comments WHERE id=${parseInt(qp.commentId)} AND user_id=${user.id}`; return ok(200, { deleted: true }); }
      catch (e) { return err(500, e.message); }
    }
    const postId = parseInt(qp.postId);
    if (!postId) return err(400, 'postId required');
    try {
      const [post] = await sql`SELECT * FROM posts WHERE id=${postId} AND user_id=${user.id}`;
      if (!post) return err(403, 'Not your post');
      if (post.cloudinary_public_id && process.env.CLOUDINARY_API_SECRET) {
        cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
        try { await cloudinary.uploader.destroy(post.cloudinary_public_id); } catch {}
      }
      await sql`DELETE FROM posts WHERE id=${postId}`;
      return ok(200, { deleted: true });
    } catch (e) { return err(500, e.message); }
  }
  return err(405, 'Method not allowed');
};
