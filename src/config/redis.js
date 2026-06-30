/**
 * src/config/redis.js
 *
 * Exports a singleton ioredis client.
 * Import this everywhere instead of calling `new Redis()` directly.
 *
 * BullMQ requires its own separate connections (it manages them internally
 * from the connection config object). Do NOT pass this client to BullMQ.
 * Use `jobs/queues.js` for BullMQ connections, which reads the same REDIS_URL.
 */

'use strict';

const Redis = require('ioredis');
const env = require('./env');

const redis = new Redis(env.REDIS_URL, {
  // Retry strategy: exponential backoff, max 10 retries
  retryStrategy(times) {
    if (times > 10) {
      console.error('[redis] Max retry attempts reached. Giving up.');
      return null; // Stop retrying
    }
    const delay = Math.min(times * 100, 3000);
    console.warn(`[redis] Reconnecting in ${delay}ms (attempt ${times})...`);
    return delay;
  },
  // Lazy connect — don't crash immediately at import time if Redis is offline
  lazyConnect: false,
});

redis.on('connect', () => {
  console.log('[redis] Connected');
});

redis.on('error', (err) => {
  console.error('[redis] Connection error:', err.message);
});

module.exports = redis;
