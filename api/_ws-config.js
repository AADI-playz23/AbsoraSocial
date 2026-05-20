const verifyToken = require('./_utils/authHelper');
const WebSocketManager = require('./_utils/WebSocketManager');
const RateLimiter = require('./_utils/RateLimiter');

module.exports = async (req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 1. Global IP-based & User-based Rate Limiter (Abuse & Bot protection)
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
  if (await RateLimiter.isRateLimited(ip, 'global', 120, 60)) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // User Specific limit check
  if (await RateLimiter.isRateLimited(user.id, 'ws-config', 30, 60)) {
    return res.status(429).json({ error: 'Too many configuration requests.' });
  }

  const { channel, clientId } = req.query;
  const targetChannel = channel || `user-${user.id}`;
  const provider = WebSocketManager.getProvider(user.id);

  const config = { provider, channel: targetChannel };

  try {
    if (provider === 'pusher') {
      config.key = process.env.PUSHER_KEY;
      config.cluster = process.env.PUSHER_CLUSTER;
    } else if (provider === 'ably') {
      // In production, return a token request to Ably instead of API Key to protect credentials
      config.apiKey = process.env.ABLY_API_KEY;
    } else if (provider === 'piesocket') {
      config.apiKey = process.env.PIESOCKET_API_KEY;
      config.clusterId = process.env.PIESOCKET_CLUSTER_ID;
      config.token = WebSocketManager.generatePieSocketToken(targetChannel, user.id);
    } else if (provider === 'scaledrone') {
      config.channelId = process.env.SCALEDRONE_CHANNEL_ID;
      if (clientId) {
        config.token = WebSocketManager.generateScaledroneToken(clientId, targetChannel);
      }
    }

    return res.status(200).json(config);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
