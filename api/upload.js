const verifyToken = require('./_utils/authHelper');
const ImageRouter = require('./_utils/ImageRouter');
const RateLimiter = require('./_utils/RateLimiter');

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  // 1. IP & User Rate Limiting (Strict 5 uploads per minute)
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
  if (await RateLimiter.isRateLimited(ip, 'global', 120, 60)) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  if (await RateLimiter.isRateLimited(user.id, 'upload', 5, 60)) {
    return res.status(429).json({ error: 'Upload limit exceeded. You can upload up to 5 files per minute.' });
  }

  const body = req.body || {};
  const { file } = body;
  if (!file) return res.status(400).json({ error: 'File content required (base64 data URL)' });

  try {
    // Dynamically route upload to Cloudinary, ImageKit, or Uploadcare depending on user_id sharding
    const secureUrl = await ImageRouter.upload(file, user.id);
    return res.status(200).json({ secure_url: secureUrl });
  } catch (e) {
    return res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
};
