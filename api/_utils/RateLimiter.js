const { Redis } = require('@upstash/redis');

const redisB = new Redis({
    url: process.env.UPSTASH_REDIS_B_URL,
    token: process.env.UPSTASH_REDIS_B_TOKEN,
});

/**
 * Standardized Redis-backed Rate Limiter for Vercel Serverless Functions.
 * Implements rolling/window limit counters to protect against bot spam, brute force, and DDoS.
 */
class RateLimiter {

    /**
     * Checks if a request should be rate-limited.
     * @param {string} identifier - Unique key (e.g., user:123 or ip:192.168.1.1)
     * @param {string} action - Action name (e.g., global, login, like, follow, upload)
     * @param {number} limit - Max requests allowed in the window
     * @param {number} windowSec - Time window size in seconds (default: 60s)
     * @returns {Promise<boolean>} True if rate-limited, false otherwise
     */
    static async isRateLimited(identifier, action, limit = 60, windowSec = 60) {
        const key = `rate:${identifier}:${action}`;
        
        try {
            const current = await redisB.incr(key);
            
            // On first hit, set the expiration window
            if (current === 1) {
                await redisB.expire(key, windowSec);
            }
            
            return current > limit;
        } catch (error) {
            console.error('Rate Limiter Cache Error:', error.message);
            // Graceful degradation: do not block users if Redis is offline
            return false;
        }
    }
}

module.exports = RateLimiter;
