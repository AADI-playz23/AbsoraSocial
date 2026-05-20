const { Redis } = require('@upstash/redis');

// Initialize the 2 Redis Shards (512MB total RAM pool)
const redisA = new Redis({
    url: process.env.UPSTASH_REDIS_A_URL,
    token: process.env.UPSTASH_REDIS_A_TOKEN,
});

const redisB = new Redis({
    url: process.env.UPSTASH_REDIS_B_URL,
    token: process.env.UPSTASH_REDIS_B_TOKEN,
});

/**
 * The Strict Read-Through Cache Layer.
 * Intercepts requests before they hit the hard drives.
 */
class CacheLayer {
    
    // ==========================================
    // SHARD A: Heavy Data (Profiles, Feeds)
    // ==========================================
    static async getProfile(userId, fetchFunction) {
        const cacheKey = `profile:${userId}`;
        const cached = await redisA.get(cacheKey);
        
        if (cached) return cached; // Cache Hit! Return instantly.
        
        // Cache Miss -> Fetch from DatabaseRouter (Hard Drive)
        const data = await fetchFunction(userId);
        if (data) {
            // Save to Redis for 10 minutes so next request is instant
            await redisA.set(cacheKey, data, { ex: 600 });
        }
        return data;
    }
    
    static async getExploreFeed(fetchFunction) {
        const cacheKey = `feed:explore`;
        const cached = await redisA.get(cacheKey);
        
        if (cached) return cached;
        
        const data = await fetchFunction();
        if (data) {
            await redisA.set(cacheKey, data, { ex: 300 }); // 5 minute cache
        }
        return data;
    }

    // ==========================================
    // SHARD B: Ephemeral Data & Pointers
    // ==========================================
    static async getTrendingTags(fetchFunction) {
        const cacheKey = `trends:hashtags`;
        const cached = await redisB.get(cacheKey);
        
        if (cached) return cached;
        
        const data = await fetchFunction();
        if (data) {
            await redisB.set(cacheKey, data, { ex: 300 }); 
        }
        return data;
    }
    
    // Invalidate Cache Functions
    static async invalidateProfile(userId) {
        await redisA.del(`profile:${userId}`);
    }

    // ==========================================
    // SHARD A: Social Relationships Cache (Sets)
    // ==========================================
    static async followUserCache(followerId, followingId) {
        const followingKey = `user:${followerId}:following`;
        const followersKey = `user:${followingId}:followers`;
        await Promise.all([
            redisA.sadd(followingKey, String(followingId)),
            redisA.sadd(followersKey, String(followerId))
        ]);
    }

    static async unfollowUserCache(followerId, followingId) {
        const followingKey = `user:${followerId}:following`;
        const followersKey = `user:${followingId}:followers`;
        await Promise.all([
            redisA.srem(followingKey, String(followingId)),
            redisA.srem(followersKey, String(followerId))
        ]);
    }

    static async checkFollowing(followerId, followingId, fetchFunction) {
        const followingKey = `user:${followerId}:following`;
        
        try {
            const exists = await redisA.exists(followingKey);
            if (!exists) {
                const list = await fetchFunction(followerId);
                if (list && list.length) {
                    await redisA.sadd(followingKey, ...list.map(String));
                } else {
                    await redisA.sadd(followingKey, "0");
                    await redisA.expire(followingKey, 60);
                }
            }
            
            const isMember = await redisA.sismember(followingKey, String(followingId));
            return isMember === 1 || isMember === true;
        } catch (e) {
            // Fallback directly to DB fetch on Redis outage
            const list = await fetchFunction(followerId);
            return list.includes(followingId);
        }
    }

    static async getMutualConnections(userA, userB, fetchFunction) {
        const keyA = `user:${userA}:following`;
        const keyB = `user:${userB}:following`;

        try {
            // Ensure both sets are loaded in cache
            const existsA = await redisA.exists(keyA);
            if (!existsA) {
                const listA = await fetchFunction(userA);
                if (listA && listA.length) await redisA.sadd(keyA, ...listA.map(String));
                else { await redisA.sadd(keyA, "0"); await redisA.expire(keyA, 60); }
            }

            const existsB = await redisA.exists(keyB);
            if (!existsB) {
                const listB = await fetchFunction(userB);
                if (listB && listB.length) await redisA.sadd(keyB, ...listB.map(String));
                else { await redisA.sadd(keyB, "0"); await redisA.expire(keyB, 60); }
            }

            const mutuals = await redisA.sinter(keyA, keyB);
            return mutuals.filter(id => id !== "0").map(id => parseInt(id));
        } catch (e) {
            const [listA, listB] = await Promise.all([fetchFunction(userA), fetchFunction(userB)]);
            return listA.filter(id => listB.includes(id));
        }
    }

    // ==========================================
    // SHARD A: Atomic Interaction Counters (Hot Posts)
    // ==========================================
    static async getPostLikesCount(postId, fetchFunction) {
        const key = `post:${postId}:likes_count`;
        try {
            const cached = await redisA.get(key);
            if (cached !== null) return parseInt(cached);
            
            const count = await fetchFunction();
            await redisA.set(key, String(count), { ex: 3600 });
            return count;
        } catch (e) {
            return fetchFunction();
        }
    }

    static async incrementLikesCount(postId) {
        const key = `post:${postId}:likes_count`;
        try {
            const exists = await redisA.exists(key);
            if (exists) {
                await redisA.incr(key);
            }
        } catch (e) {}
    }

    static async decrementLikesCount(postId) {
        const key = `post:${postId}:likes_count`;
        try {
            const exists = await redisA.exists(key);
            if (exists) {
                await redisA.decr(key);
            }
        } catch (e) {}
    }

    static async getPostCommentsCount(postId, fetchFunction) {
        const key = `post:${postId}:comments_count`;
        try {
            const cached = await redisA.get(key);
            if (cached !== null) return parseInt(cached);
            
            const count = await fetchFunction();
            await redisA.set(key, String(count), { ex: 3600 });
            return count;
        } catch (e) {
            return fetchFunction();
        }
    }

    static async incrementCommentsCount(postId) {
        const key = `post:${postId}:comments_count`;
        try {
            const exists = await redisA.exists(key);
            if (exists) {
                await redisA.incr(key);
            }
        } catch (e) {}
    }

    static async decrementCommentsCount(postId) {
        const key = `post:${postId}:comments_count`;
        try {
            const exists = await redisA.exists(key);
            if (exists) {
                await redisA.decr(key);
            }
        } catch (e) {}
    }
}

module.exports = CacheLayer;
