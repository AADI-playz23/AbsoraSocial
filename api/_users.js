const { Pool } = require('@neondatabase/serverless');
const verifyToken = require('./_utils/authHelper');
const DatabaseRouter = require('./_utils/DatabaseRouter');
const CacheLayer = require('./_utils/CacheLayer');
const WebSocketManager = require('./_utils/WebSocketManager');
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

  // 1. IP & User Rate Limiting
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
  if (await RateLimiter.isRateLimited(ip, 'global', 120, 60)) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  const user = verifyToken(req);
  if (user) {
    // Authenticated actions limit (60 mutating actions per minute)
    const isMutating = req.method !== 'GET';
    const limit = isMutating ? 15 : 60;
    if (await RateLimiter.isRateLimited(user.id, `user:${isMutating ? 'write' : 'read'}`, limit, 60)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please slow down.' });
    }
  }

  const qp = req.query || {};
  const action = qp.action || '';

  // ── GET ──
  if (req.method === 'GET') {
    if (action === 'profile') {
      const userId = parseInt(qp.userId);
      const username = qp.username;
      if (!userId && !username) return res.status(400).json({ error: 'userId or username required' });

      try {
        const client = await pool.connect();
        
        // Fetch User Profile from cache-first or Neon
        let profile;
        if (userId) {
          profile = await CacheLayer.getProfile(userId, async (id) => {
            const result = await client.query(
              'SELECT id,name,username,bio,avatar_url,is_verified,is_private,show_activity,last_active,created_at FROM users WHERE id=$1',
              [id]
            );
            return result.rows[0];
          });
        } else {
          const result = await client.query(
            'SELECT id,name,username,bio,avatar_url,is_verified,is_private,show_activity,last_active,created_at FROM users WHERE username=$1',
            [username.toLowerCase()]
          );
          profile = result.rows[0];
        }

        if (!profile) {
          client.release();
          return res.status(404).json({ error: 'User not found' });
        }

        const uid = user ? user.id : -1;

        // Sharded query for post count
        const posts_count = await DatabaseRouter.getPostCount(profile.id);

        // Neon queries for relationship metadata (social graph is stored on Neon)
        const followersRes = await client.query('SELECT COUNT(*)::int as count FROM follows WHERE following_id=$1', [profile.id]);
        const followingRes = await client.query('SELECT COUNT(*)::int as count FROM follows WHERE follower_id=$1', [profile.id]);
        
        let is_following = false;
        let is_blocked = false;
        let is_close_friend = false;

        if (uid > 0) {
          is_following = await CacheLayer.checkFollowing(uid, profile.id, async (followerId) => {
            const list = await client.query('SELECT following_id FROM follows WHERE follower_id = $1', [followerId]);
            return list.rows.map(r => r.following_id);
          });

          const blockCheck = await client.query('SELECT COUNT(*)::int as count FROM blocked_users WHERE blocker_id=$1 AND blocked_id=$2', [uid, profile.id]);
          is_blocked = blockCheck.rows[0].count > 0;

          const friendCheck = await client.query('SELECT COUNT(*)::int as count FROM close_friends WHERE user_id=$1 AND friend_id=$2', [uid, profile.id]);
          is_close_friend = friendCheck.rows[0].count > 0;
        }

        client.release();

        return res.status(200).json({
          ...profile,
          posts_count,
          followers_count: followersRes.rows[0].count,
          following_count: followingRes.rows[0].count,
          is_following,
          is_blocked,
          is_close_friend,
          is_own: uid === profile.id
        });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'posts') {
      const userId = parseInt(qp.userId);
      const tab = qp.tab || 'posts';
      const uid = user ? user.id : -1;

      try {
        if (tab === 'saved' && uid === userId) {
          // Saved posts join lookup from Neon (central bookmarks index)
          const client = await pool.connect();
          const result = await client.query(
            'SELECT p.id,p.image_url,p.caption,p.created_at FROM saved_posts s JOIN posts p ON s.post_id=p.id WHERE s.user_id=$1 ORDER BY s.created_at DESC LIMIT 60',
            [uid]
          );
          client.release();
          return res.status(200).json(result.rows);
        } else {
          // Sharded database retrieval for the user's uploaded posts
          const posts = await DatabaseRouter.getUserPosts(userId, uid);
          return res.status(200).json(posts);
        }
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'search') {
      const q = (qp.q || '').trim();
      if (q.length < 1) return res.status(200).json({ users: [], hashtags: [] });

      try {
        const client = await pool.connect();
        const usersRes = await client.query(
          'SELECT id,name,username,avatar_url,is_verified FROM users WHERE username ILIKE $1 OR name ILIKE $1 LIMIT 20',
          [`%${q}%`]
        );
        const hashtagsRes = await client.query(
          'SELECT h.id,h.name,COUNT(ph.post_id)::int as post_count FROM hashtags h LEFT JOIN post_hashtags ph ON ph.hashtag_id=h.id WHERE h.name ILIKE $1 GROUP BY h.id ORDER BY post_count DESC LIMIT 10',
          [`%${q}%`]
        );
        client.release();

        return res.status(200).json({
          users: usersRes.rows,
          hashtags: hashtagsRes.rows
        });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'followers') {
      const userId = parseInt(qp.userId);
      try {
        const client = await pool.connect();
        const result = await client.query(
          'SELECT u.id,u.name,u.username,u.avatar_url,u.is_verified FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.following_id=$1 ORDER BY f.created_at DESC LIMIT 100',
          [userId]
        );
        client.release();
        return res.status(200).json(result.rows);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'following') {
      const userId = parseInt(qp.userId);
      try {
        const client = await pool.connect();
        const result = await client.query(
          'SELECT u.id,u.name,u.username,u.avatar_url,u.is_verified FROM follows f JOIN users u ON u.id=f.following_id WHERE f.follower_id=$1 ORDER BY f.created_at DESC LIMIT 100',
          [userId]
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

    if (action === 'follow') {
      const targetId = parseInt(body.userId);
      if (targetId === user.id) return res.status(400).json({ error: 'Cannot follow yourself' });

      try {
        const client = await pool.connect();
        await client.query('INSERT INTO follows (follower_id,following_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [user.id, targetId]);
        await client.query("INSERT INTO notifications (user_id,actor_id,type) VALUES ($1,$2,'follow')", [targetId, user.id]);
        client.release();

        // Update Redis Social Sets Cache
        await CacheLayer.followUserCache(user.id, targetId);

        // Real-Time notification broadcast specifically to recipient user's sharded provider
        await WebSocketManager.sendToUser(targetId, 'notification', {
          type: 'follow',
          actor_name: user.name,
          actor_id: user.id
        });

        return res.status(200).json({ following: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'unfollow') {
      const targetId = parseInt(body.userId);
      try {
        const client = await pool.connect();
        await client.query('DELETE FROM follows WHERE follower_id=$1 AND following_id=$2', [user.id, targetId]);
        client.release();

        // Update Redis Social Sets Cache
        await CacheLayer.unfollowUserCache(user.id, targetId);

        return res.status(200).json({ following: false });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'block') {
      const targetId = parseInt(body.userId);
      try {
        const client = await pool.connect();
        await client.query('INSERT INTO blocked_users (blocker_id,blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [user.id, targetId]);
        await client.query('DELETE FROM follows WHERE (follower_id=$1 AND following_id=$2) OR (follower_id=$2 AND following_id=$1)', [user.id, targetId]);
        client.release();

        // Update Redis Social Sets Cache (unfollow in both directions)
        await CacheLayer.unfollowUserCache(user.id, targetId);
        await CacheLayer.unfollowUserCache(targetId, user.id);

        return res.status(200).json({ blocked: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'unblock') {
      try {
        const client = await pool.connect();
        await client.query('DELETE FROM blocked_users WHERE blocker_id=$1 AND blocked_id=$2', [user.id, parseInt(body.userId)]);
        client.release();
        return res.status(200).json({ blocked: false });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  // ── PUT (Edit profile) ──
  if (req.method === 'PUT') {
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const body = req.body || {};

    if (action === 'edit') {
      const { name, bio, avatar_url, username, is_private, show_activity } = body;
      try {
        const client = await pool.connect();
        if (username) {
          const check = await client.query('SELECT id FROM users WHERE username=$1 AND id != $2', [username.toLowerCase(), user.id]);
          if (check.rows.length) {
            client.release();
            return res.status(409).json({ error: 'Username taken' });
          }
        }
        await client.query(
          `UPDATE users SET
            name = COALESCE($1, name),
            bio = COALESCE($2, bio),
            avatar_url = COALESCE($3, avatar_url),
            username = COALESCE($4, username),
            is_private = COALESCE($5, is_private),
            show_activity = COALESCE($6, show_activity)
          WHERE id = $7`,
          [
            name || null,
            bio !== undefined ? bio : null,
            avatar_url || null,
            username ? username.toLowerCase() : null,
            is_private !== undefined ? is_private : null,
            show_activity !== undefined ? show_activity : null,
            user.id
          ]
        );

        const updated = await client.query(
          'SELECT id,name,username,email,bio,avatar_url,is_verified,is_private,show_activity FROM users WHERE id=$1',
          [user.id]
        );
        client.release();

        // Invalidate profile cache so the update is immediate globally
        await CacheLayer.invalidateProfile(user.id);

        return res.status(200).json(updated.rows[0]);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
    return res.status(400).json({ error: 'Unknown action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
