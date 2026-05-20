require('dotenv').config();

const assert = require('assert');

console.log('--- STARTING ABSORA SYSTEM VALIDATION DRY RUN ---');

try {
    // 1. Rate Limiting test
    const RateLimiter = require('./api/utils/RateLimiter');
    console.log('✓ RateLimiter successfully loaded');

    // 2. Idempotency Shield test
    const IdempotencyShield = require('./api/utils/IdempotencyShield');
    console.log('✓ IdempotencyShield successfully loaded');

    // 3. DatabaseRouter sharding test
    const DatabaseRouter = require('./api/utils/DatabaseRouter');
    console.log('✓ DatabaseRouter successfully loaded');
    const u1Shard = DatabaseRouter.determineShard(1);
    const u2Shard = DatabaseRouter.determineShard(2);
    const u3Shard = DatabaseRouter.determineShard(3);
    const u14Shard = DatabaseRouter.determineShard(14); // 14 % 13 + 1 = 2
    console.log(`  - Shard Allocation: user 1 -> ${u1Shard.name}, user 2 -> ${u2Shard.name}, user 3 -> ${u3Shard.name}, user 14 -> ${u14Shard.name}`);
    assert.strictEqual(u1Shard.name, 'Shard 2');
    assert.strictEqual(u2Shard.name, 'Shard 3');
    assert.strictEqual(u3Shard.name, 'Shard 4');
    assert.strictEqual(u14Shard.name, 'Shard 2');
    console.log('✓ DatabaseRouter Shard Modulo Modulo Mapping verified');

    // 4. ImageRouter sharding test
    const ImageRouter = require('./api/utils/ImageRouter');
    console.log('✓ ImageRouter successfully loaded');
    const imgProv1 = ImageRouter.determineShard(1);
    const imgProv2 = ImageRouter.determineShard(2);
    const imgProv3 = ImageRouter.determineShard(3);
    console.log(`  - Image Provider: user 1 -> ${imgProv1}, user 2 -> ${imgProv2}, user 3 -> ${imgProv3}`);
    assert.strictEqual(imgProv1, 'imagekit');
    assert.strictEqual(imgProv2, 'uploadcare');
    assert.strictEqual(imgProv3, 'cloudinary');
    console.log('✓ ImageRouter Shard Modulo Allocation verified');

    // 5. WebSocketManager sharding test
    const WebSocketManager = require('./api/utils/WebSocketManager');
    console.log('✓ WebSocketManager successfully loaded');
    const wsProv1 = WebSocketManager.getProvider(1);
    const wsProv2 = WebSocketManager.getProvider(2);
    const wsProv3 = WebSocketManager.getProvider(3);
    const wsProv4 = WebSocketManager.getProvider(4);
    console.log(`  - WebSocket Provider: user 1 -> ${wsProv1}, user 2 -> ${wsProv2}, user 3 -> ${wsProv3}, user 4 -> ${wsProv4}`);
    assert.strictEqual(wsProv1, 'ably');
    assert.strictEqual(wsProv2, 'piesocket');
    assert.strictEqual(wsProv3, 'scaledrone');
    assert.strictEqual(wsProv4, 'pusher');
    console.log('✓ WebSocketManager Single-Socket Provider Allocation verified');

    // 6. CacheLayer interaction counters test
    const CacheLayer = require('./api/utils/CacheLayer');
    console.log('✓ CacheLayer successfully loaded');
    console.log('  - Counter methods detected:', {
        getPostLikesCount: typeof CacheLayer.getPostLikesCount,
        incrementLikesCount: typeof CacheLayer.incrementLikesCount,
        decrementLikesCount: typeof CacheLayer.decrementLikesCount,
        getPostCommentsCount: typeof CacheLayer.getPostCommentsCount,
        incrementCommentsCount: typeof CacheLayer.incrementCommentsCount,
        decrementCommentsCount: typeof CacheLayer.decrementCommentsCount,
    });

    console.log('--- ALL VALIDATION CHECKS PASSED SUCCESSFULLY ---');
} catch (e) {
    console.error('✗ Validation Dry-Run FAILED:', e);
    process.exit(1);
}
