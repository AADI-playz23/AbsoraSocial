const { Redis } = require('@upstash/redis');

const redisB = new Redis({
    url: process.env.UPSTASH_REDIS_B_URL,
    token: process.env.UPSTASH_REDIS_B_TOKEN,
});

/**
 * Idempotency Shield (Deduplication)
 * Prevents double-clicks or duplicate requests from causing double actions
 * (e.g. duplicate chat messages sent in immediate succession).
 */
class IdempotencyShield {

    /**
     * Checks if the request is a duplicate.
     * @param {number} userId - The acting user ID
     * @param {string} action - The action name
     * @param {string} signature - Unique request identifier/payload signature
     * @param {number} ttlSec - Lock time-to-live in seconds
     * @returns {Promise<boolean>} True if duplicate, false if allowed (lock acquired)
     */
    static async isDuplicate(userId, action, signature, ttlSec = 3) {
        const key = `idem:${userId}:${action}:${signature}`;
        try {
            // SET if Not Exists with dynamic TTL
            const status = await redisB.set(key, '1', { nx: true, ex: ttlSec });
            return status !== 'OK' && status !== true;
        } catch (error) {
            // Fail open if Redis has issues
            return false;
        }
    }
}

module.exports = IdempotencyShield;
