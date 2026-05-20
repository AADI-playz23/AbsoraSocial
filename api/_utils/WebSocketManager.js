const Pusher = require('pusher');
const Ably = require('ably');
const jwt = require('jsonwebtoken');

// Initialize Pusher Client
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true
});

// Initialize Ably Client
const ably = new Ably.Rest(process.env.ABLY_API_KEY);

/**
 * Real-Time WebSocket Manager
 * Distributes connections and broadcasts evenly across Pusher, Ably, PieSocket, and Scaledrone.
 */
class WebSocketManager {

  /**
   * Determine a User's allocated WebSocket Shard.
   * @param {number} userId - Authenticated user ID
   * @returns {string} Shard key ('pusher', 'ably', 'piesocket', 'scaledrone')
   */
  static getProvider(userId) {
    const uId = parseInt(userId) || 1;
    const index = uId % 4;
    const providers = ['pusher', 'ably', 'piesocket', 'scaledrone'];
    return providers[index];
  }

  /**
   * Route and send a real-time event specifically to the user's allocated WebSocket provider.
   * @param {number} userId - Recipient user ID
   * @param {string} event - Event name
   * @param {object} data - Event payload
   */
  static async sendToUser(userId, event, data) {
    const provider = this.getProvider(userId);
    const channel = `user-${userId}`;
    await this.sendToProvider(provider, channel, event, data);
  }

  /**
   * Dynamically routes 1-to-1 or group conversation broadcasts specifically to the providers
   * that conversation members are sharded onto.
   * @param {number} conversationId - The conversation ID
   * @param {number[]} memberIds - Array of participant user IDs
   * @param {string} event - Event name
   * @param {object} data - Event payload
   */
  static async broadcastToConversation(conversationId, memberIds, event, data) {
    const providers = new Set(memberIds.map(mid => this.getProvider(mid)));
    const channel = `conversation-${conversationId}`;
    const promises = [];
    
    for (const provider of providers) {
      promises.push(this.sendToProvider(provider, channel, event, data));
    }
    
    await Promise.all(promises);
  }

  /**
   * Universal Single-Provider WebSocket Broadcast Client.
   */
  static async sendToProvider(provider, channel, event, data) {
    try {
      if (provider === 'pusher') {
        await pusher.trigger(channel, event, data);
      } else if (provider === 'ably') {
        await ably.channels.get(channel).publish(event, data);
      } else if (provider === 'piesocket') {
        const pieSocketUrl = `https://${process.env.PIESOCKET_CLUSTER_ID}.piesocket.com/v3/${channel}?api_key=${process.env.PIESOCKET_API_KEY}`;
        await fetch(pieSocketUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'o-api-secret': process.env.PIESOCKET_SECRET_KEY
          },
          body: JSON.stringify({ event, data })
        });
      } else if (provider === 'scaledrone') {
        const scaledroneAuth = Buffer.from(`bearer:${process.env.SCALEDRONE_SECRET_KEY}`).toString('base64');
        const scaledroneUrl = `https://api2.scaledrone.com/v3/channels/${process.env.SCALEDRONE_CHANNEL_ID}/publish`;
        await fetch(scaledroneUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${scaledroneAuth}`
          },
          body: JSON.stringify({
            room: channel,
            message: { event, data }
          })
        });
      }
    } catch (err) {
      console.error(`WebSocket Shard [${provider.toUpperCase()}] Broadcast Failed:`, err.message);
    }
  }

  /**
   * Generates secure authentication variables for PieSocket.
   */
  static generatePieSocketToken(channel, userId) {
    const payload = {
      sub: userId,
      room: channel,
      permission: {
        subscribe: true,
        publish: false
      },
      exp: Math.floor(Date.now() / 1000) + 3600
    };
    return jwt.sign(payload, process.env.PIESOCKET_SECRET_KEY, { algorithm: 'HS256' });
  }

  /**
   * Generates secure authentication variables for Scaledrone.
   */
  static generateScaledroneToken(clientId, channel) {
    const payload = {
      client: clientId,
      channel: process.env.SCALEDRONE_CHANNEL_ID,
      permissions: {
        [`^${channel}$`]: {
          publish: false,
          subscribe: true
        }
      },
      exp: Math.floor(Date.now() / 1000) + 3600
    };
    return jwt.sign(payload, process.env.SCALEDRONE_SECRET_KEY, { algorithm: 'HS256' });
  }
}

module.exports = WebSocketManager;
