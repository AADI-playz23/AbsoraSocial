// netlify/functions/cleanup.js
const { neon } = require('@neondatabase/serverless');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

exports.handler = async () => {
  const sql = neon(process.env.DATABASE_URL);

  // Cleanup expired posts
  const expiredPosts = await sql`SELECT id, cloudinary_public_id FROM posts WHERE expires_at <= NOW()`;
  if (expiredPosts.length) {
    const pids = expiredPosts.map(p => p.cloudinary_public_id).filter(Boolean);
    if (pids.length) { try { await cloudinary.api.delete_resources(pids); } catch {} }
    const ids = expiredPosts.map(p => p.id);
    await sql`DELETE FROM posts WHERE id = ANY(${ids})`;
    console.log(`Cleanup: deleted ${ids.length} expired posts`);
  }

  // Cleanup expired stories
  const expiredStories = await sql`SELECT id, cloudinary_public_id FROM stories WHERE expires_at <= NOW()`;
  if (expiredStories.length) {
    const sids = expiredStories.map(s => s.cloudinary_public_id).filter(Boolean);
    if (sids.length) { try { await cloudinary.api.delete_resources(sids); } catch {} }
    const ids = expiredStories.map(s => s.id);
    await sql`DELETE FROM stories WHERE id = ANY(${ids})`;
    console.log(`Cleanup: deleted ${ids.length} expired stories`);
  }

  // Cleanup old notifications (> 30 days)
  await sql`DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '30 days'`;

  // Cleanup old read messages (> 90 days)
  await sql`DELETE FROM messages WHERE created_at < NOW() - INTERVAL '90 days'`;

  return { statusCode: 200, body: `Cleaned up ${expiredPosts.length} posts, ${expiredStories.length} stories` };
};
