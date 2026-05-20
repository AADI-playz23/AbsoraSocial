const { Pool } = require('@neondatabase/serverless');
const verifyToken = require('./_utils/authHelper');
const DatabaseRouter = require('./_utils/DatabaseRouter');
const CacheLayer = require('./_utils/CacheLayer');
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

  // 1. IP & User Rate Limiting (Bot & Abuse Protection)
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
  if (await RateLimiter.isRateLimited(ip, 'global', 120, 60)) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  const user = verifyToken(req);
  if (user) {
    if (await RateLimiter.isRateLimited(user.id, 'explore', 60, 60)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please slow down.' });
    }
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const qp = req.query || {};
  const action = qp.action || 'trending';
  const uid = user ? user.id : -1;

  // Trending posts (Explore Feed)
  if (action === 'trending') {
    const cursor = parseInt(qp.cursor) || 0;
    try {
      // Use Cache Shield for the Explore Feed
      const fetchExploreFeed = async () => {
        const client = await pool.connect();
        const postsRes = await client.query(
          `SELECT p.id, p.image_url, p.caption, p.user_id, p.created_at, p.user_name
           FROM posts p
           WHERE p.expires_at > NOW() AND p.is_archived=false AND p.is_private=false
           ORDER BY p.created_at DESC LIMIT 60`
        );
        client.release();
        return postsRes.rows;
      };

      const rawPosts = await CacheLayer.getExploreFeed(fetchExploreFeed);

      // Filter blocked users and slice/enrich for the specific request in memory
      const client = await pool.connect();
      const enrichedPosts = [];

      // Filter blocked users
      let filtered = rawPosts;
      if (uid > 0) {
        const blocksRes = await client.query('SELECT blocked_id FROM blocked_users WHERE blocker_id=$1', [uid]);
        const blockedIds = new Set(blocksRes.rows.map(r => r.blocked_id));
        filtered = rawPosts.filter(p => !blockedIds.has(p.user_id));
      }

      // Paginate
      const paginated = filtered.slice(cursor, cursor + 30);

      // Enrich paginated posts with sharded like counts and author metadata
      for (const p of paginated) {
        const authorRes = await client.query('SELECT username, avatar_url, is_verified FROM users WHERE id=$1', [p.user_id]);
        const author = authorRes.rows[0] || { username: 'unknown', avatar_url: '', is_verified: false };

        const likeCount = await CacheLayer.getPostLikesCount(p.id, async () => {
          return await DatabaseRouter.getLikesCount(p.id, p.user_id);
        });
        const commentCount = await CacheLayer.getPostCommentsCount(p.id, async () => {
          return (await DatabaseRouter.getComments(p.id, p.user_id)).length;
        });

        enrichedPosts.push({
          ...p,
          ...author,
          like_count: likeCount,
          comment_count: commentCount
        });
      }
      client.release();

      // Sort by like count descending (Trending sorting)
      enrichedPosts.sort((a, b) => b.like_count - a.like_count);

      return res.status(200).json({
        posts: enrichedPosts,
        nextCursor: filtered.length > cursor + 30 ? cursor + 30 : null
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Posts by hashtag
  if (action === 'hashtag') {
    const tag = (qp.tag || '').toLowerCase();
    if (!tag) return res.status(400).json({ error: 'tag required' });
    try {
      const client = await pool.connect();
      const postsRes = await client.query(
        `SELECT p.id, p.image_url, p.caption, p.user_id, p.created_at, p.user_name
         FROM posts p
         JOIN post_hashtags ph ON ph.post_id=p.id
         JOIN hashtags h ON h.id=ph.hashtag_id
         WHERE h.name=$1 AND p.expires_at > NOW() AND p.is_archived=false AND p.is_private=false
           AND p.user_id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id=$2)
         ORDER BY p.created_at DESC LIMIT 60`,
        [tag, uid]
      );

      const posts = postsRes.rows;
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

        enrichedPosts.push({
          ...p,
          ...author,
          like_count: likeCount,
          comment_count: commentCount
        });
      }

      const countRes = await client.query(
        `SELECT COUNT(*)::int as count FROM post_hashtags ph
         JOIN hashtags h ON h.id=ph.hashtag_id WHERE h.name=$1`,
        [tag]
      );
      client.release();

      return res.status(200).json({
        posts: enrichedPosts,
        tag,
        post_count: countRes.rows[0].count
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Trending hashtags
  if (action === 'tags') {
    try {
      const fetchTrends = async () => {
        const client = await pool.connect();
        const tagsRes = await client.query(
          `SELECT h.name, COUNT(ph.post_id)::int as post_count
           FROM hashtags h JOIN post_hashtags ph ON ph.hashtag_id=h.id
           JOIN posts p ON p.id=ph.post_id
           WHERE p.expires_at > NOW() AND p.is_archived=false
           GROUP BY h.id ORDER BY post_count DESC LIMIT 20`
        );
        client.release();
        return tagsRes.rows;
      };

      // Shard B handles light trends metadata
      const tags = await CacheLayer.getTrendingTags(fetchTrends);
      return res.status(200).json(tags);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
};
