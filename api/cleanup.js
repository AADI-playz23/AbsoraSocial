const { Pool } = require('@neondatabase/serverless');
const DatabaseRouter = require('./_utils/DatabaseRouter');
const RateLimiter = require('./_utils/RateLimiter');

const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL });

module.exports = async (req, res) => {
  // Rate Limiting (Strictly 1 cleanup trigger per 10 minutes per IP)
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
  if (await RateLimiter.isRateLimited(ip, 'cleanup', 1, 600)) {
    return res.status(429).json({ error: 'Cleanup already run recently. Please try again later.' });
  }

  try {
    const client = await pool.connect();

    // 1. Cleanup expired posts
    const expiredPosts = await client.query('SELECT id, user_id FROM posts WHERE expires_at <= NOW()');
    let postsCount = 0;
    if (expiredPosts.rows.length) {
      for (const post of expiredPosts.rows) {
        // Delete from Sharded DB
        await DatabaseRouter.deletePost(post.id, post.user_id).catch(() => {});
        // Delete from Neon Global Index
        await client.query('DELETE FROM posts WHERE id=$1', [post.id]);
        postsCount++;
      }
      console.log(`Cleanup: deleted ${postsCount} expired posts`);
    }

    // 2. Cleanup expired stories
    const expiredStories = await client.query('SELECT id FROM stories WHERE expires_at <= NOW()');
    let storiesCount = 0;
    if (expiredStories.rows.length) {
      const ids = expiredStories.rows.map(s => s.id);
      await client.query('DELETE FROM stories WHERE id = ANY($1)', [ids]);
      storiesCount = ids.length;
      console.log(`Cleanup: deleted ${storiesCount} expired stories`);
    }

    // 3. Cleanup old notifications (> 30 days) on Neon
    await client.query("DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '30 days'");

    client.release();

    return res.status(200).json({
      message: `Cleaned up ${postsCount} posts, ${storiesCount} stories`
    });
  } catch (e) {
    return res.status(500).json({ error: 'Cleanup failed: ' + e.message });
  }
};
