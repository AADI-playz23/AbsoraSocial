// netlify/functions/users.js
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

  // ── GET ──
  if (event.httpMethod === 'GET') {
    if (action === 'profile') {
      const userId = parseInt(qp.userId);
      const username = qp.username;
      if (!userId && !username) return err(400, 'userId or username required');
      try {
        const [profile] = userId
          ? await sql`SELECT id,name,username,bio,avatar_url,is_verified,is_private,show_activity,last_active,created_at FROM users WHERE id=${userId}`
          : await sql`SELECT id,name,username,bio,avatar_url,is_verified,is_private,show_activity,last_active,created_at FROM users WHERE username=${username.toLowerCase()}`;
        if (!profile) return err(404, 'User not found');
        const uid = user ? user.id : -1;
        const [{posts_count}] = await sql`SELECT COUNT(*)::int as posts_count FROM posts WHERE user_id=${profile.id} AND is_archived=false AND expires_at > NOW()`;
        const [{followers_count}] = await sql`SELECT COUNT(*)::int as followers_count FROM follows WHERE following_id=${profile.id}`;
        const [{following_count}] = await sql`SELECT COUNT(*)::int as following_count FROM follows WHERE follower_id=${profile.id}`;
        const is_following = uid > 0 ? (await sql`SELECT COUNT(*)::int as c FROM follows WHERE follower_id=${uid} AND following_id=${profile.id}`)[0].c > 0 : false;
        const is_blocked = uid > 0 ? (await sql`SELECT COUNT(*)::int as c FROM blocked_users WHERE blocker_id=${uid} AND blocked_id=${profile.id}`)[0].c > 0 : false;
        const is_close_friend = uid > 0 ? (await sql`SELECT COUNT(*)::int as c FROM close_friends WHERE user_id=${uid} AND friend_id=${profile.id}`)[0].c > 0 : false;
        return ok(200, { ...profile, posts_count, followers_count, following_count, is_following, is_blocked, is_close_friend, is_own: uid === profile.id });
      } catch (e) { return err(500, e.message); }
    }

    if (action === 'posts') {
      const userId = parseInt(qp.userId);
      const tab = qp.tab || 'posts'; // posts, saved
      const uid = user ? user.id : -1;
      try {
        let posts;
        if (tab === 'saved' && uid === userId) {
          posts = await sql`SELECT p.id,p.image_url,p.caption,p.like_count,p.created_at FROM posts p JOIN saved_posts s ON s.post_id=p.id WHERE s.user_id=${uid} AND p.is_archived=false ORDER BY s.created_at DESC LIMIT 60`;
        } else {
          posts = await sql`SELECT id,image_url,caption,created_at,(SELECT COUNT(*)::int FROM likes WHERE post_id=posts.id) as like_count,(SELECT COUNT(*)::int FROM comments WHERE post_id=posts.id) as comment_count FROM posts WHERE user_id=${userId} AND is_archived=false AND expires_at > NOW() AND (is_private=false OR user_id=${uid}) ORDER BY created_at DESC LIMIT 60`;
        }
        return ok(200, posts);
      } catch (e) { return err(500, e.message); }
    }

    if (action === 'search') {
      const q = (qp.q || '').trim();
      if (q.length < 1) return ok(200, { users: [], hashtags: [] });
      try {
        const users = await sql`SELECT id,name,username,avatar_url,is_verified FROM users WHERE (username ILIKE ${'%'+q+'%'} OR name ILIKE ${'%'+q+'%'}) LIMIT 20`;
        const hashtags = await sql`SELECT h.id,h.name,COUNT(ph.post_id)::int as post_count FROM hashtags h LEFT JOIN post_hashtags ph ON ph.hashtag_id=h.id WHERE h.name ILIKE ${'%'+q+'%'} GROUP BY h.id ORDER BY post_count DESC LIMIT 10`;
        return ok(200, { users, hashtags });
      } catch (e) { return err(500, e.message); }
    }

    if (action === 'followers') {
      const userId = parseInt(qp.userId);
      try {
        const followers = await sql`SELECT u.id,u.name,u.username,u.avatar_url,u.is_verified FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.following_id=${userId} ORDER BY f.created_at DESC LIMIT 100`;
        return ok(200, followers);
      } catch (e) { return err(500, e.message); }
    }

    if (action === 'following') {
      const userId = parseInt(qp.userId);
      try {
        const following = await sql`SELECT u.id,u.name,u.username,u.avatar_url,u.is_verified FROM follows f JOIN users u ON u.id=f.following_id WHERE f.follower_id=${userId} ORDER BY f.created_at DESC LIMIT 100`;
        return ok(200, following);
      } catch (e) { return err(500, e.message); }
    }

    return err(400, 'Unknown action');
  }

  // ── POST ──
  if (event.httpMethod === 'POST') {
    if (!user) return err(401, 'Not logged in');
    let body;
    try { body = JSON.parse(event.body); } catch { return err(400, 'Invalid JSON'); }

    if (action === 'follow') {
      const targetId = parseInt(body.userId);
      if (targetId === user.id) return err(400, 'Cannot follow yourself');
      try {
        await sql`INSERT INTO follows (follower_id,following_id) VALUES (${user.id},${targetId}) ON CONFLICT DO NOTHING`;
        await sql`INSERT INTO notifications (user_id,actor_id,type) VALUES (${targetId},${user.id},'follow')`;
        return ok(200, { following: true });
      } catch (e) { return err(500, e.message); }
    }

    if (action === 'unfollow') {
      try {
        await sql`DELETE FROM follows WHERE follower_id=${user.id} AND following_id=${parseInt(body.userId)}`;
        return ok(200, { following: false });
      } catch (e) { return err(500, e.message); }
    }

    if (action === 'block') {
      const targetId = parseInt(body.userId);
      try {
        await sql`INSERT INTO blocked_users (blocker_id,blocked_id) VALUES (${user.id},${targetId}) ON CONFLICT DO NOTHING`;
        await sql`DELETE FROM follows WHERE (follower_id=${user.id} AND following_id=${targetId}) OR (follower_id=${targetId} AND following_id=${user.id})`;
        return ok(200, { blocked: true });
      } catch (e) { return err(500, e.message); }
    }

    if (action === 'unblock') {
      try {
        await sql`DELETE FROM blocked_users WHERE blocker_id=${user.id} AND blocked_id=${parseInt(body.userId)}`;
        return ok(200, { blocked: false });
      } catch (e) { return err(500, e.message); }
    }

    if (action === 'close-friend') {
      try {
        await sql`INSERT INTO close_friends (user_id,friend_id) VALUES (${user.id},${parseInt(body.userId)}) ON CONFLICT DO NOTHING`;
        return ok(200, { close_friend: true });
      } catch (e) { return err(500, e.message); }
    }

    if (action === 'remove-close-friend') {
      try {
        await sql`DELETE FROM close_friends WHERE user_id=${user.id} AND friend_id=${parseInt(body.userId)}`;
        return ok(200, { close_friend: false });
      } catch (e) { return err(500, e.message); }
    }

    if (action === 'report') {
      try {
        await sql`INSERT INTO reports (reporter_id,reported_user_id,reason) VALUES (${user.id},${parseInt(body.userId)},${body.reason||'Inappropriate'})`;
        return ok(200, { reported: true });
      } catch (e) { return err(500, e.message); }
    }

    return err(400, 'Unknown action');
  }

  // ── PUT (edit profile) ──
  if (event.httpMethod === 'PUT') {
    if (!user) return err(401, 'Not logged in');
    let body;
    try { body = JSON.parse(event.body); } catch { return err(400, 'Invalid JSON'); }

    if (action === 'edit') {
      const { name, bio, avatar_url, username, is_private, show_activity } = body;
      try {
        if (username) {
          const [existing] = await sql`SELECT id FROM users WHERE username=${username.toLowerCase()} AND id != ${user.id}`;
          if (existing) return err(409, 'Username taken');
        }
        await sql`UPDATE users SET
          name = COALESCE(${name || null}, name),
          bio = COALESCE(${bio !== undefined ? bio : null}, bio),
          avatar_url = COALESCE(${avatar_url || null}, avatar_url),
          username = COALESCE(${username ? username.toLowerCase() : null}, username),
          is_private = COALESCE(${is_private !== undefined ? is_private : null}, is_private),
          show_activity = COALESCE(${show_activity !== undefined ? show_activity : null}, show_activity)
        WHERE id = ${user.id}`;
        const [updated] = await sql`SELECT id,name,username,email,bio,avatar_url,is_verified,is_private,show_activity FROM users WHERE id=${user.id}`;
        return ok(200, updated);
      } catch (e) { return err(500, e.message); }
    }
    return err(400, 'Unknown action');
  }

  return err(405, 'Method not allowed');
};
