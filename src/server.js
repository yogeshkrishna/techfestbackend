/**
 * src/server.js
 *
 * HTTP server entry point.
 * Imports the configured Express app, connects to infrastructure,
 * starts workers, and begins listening.
 */

'use strict';

// Load and validate all env vars before anything else.
// If any required var is missing, this throws immediately with a clear message.
const env = require('./config/env');

const http = require('http');
const app = require('./app');
const prisma = require('./config/prisma');
const redis = require('./config/redis');
const { initJobs } = require('./jobs/index');

const server = http.createServer(app);

async function start() {
  try {
    // Verify Postgres connectivity
    await prisma.$connect();
    console.log('[server] PostgreSQL connected');

    // Redis connectivity is verified by the ioredis client's 'connect' event
    // (handled in config/redis.js). No explicit check needed here.

    // Start BullMQ workers
    const workers = initJobs();

    // Start HTTP server
    server.listen(env.PORT, () => {
      console.log(`[server] Listening on port ${env.PORT} (${env.NODE_ENV})`);
      console.log(`[server] Health: http://localhost:${env.PORT}/api/v1/health`);
    });

    // ─────────────────────────────────────────────
    // Graceful shutdown
    // ─────────────────────────────────────────────

    async function shutdown(signal) {
      console.log(`\n[server] Received ${signal}. Shutting down gracefully...`);

      // Stop accepting new connections
      server.close(async () => {
        console.log('[server] HTTP server closed');

        // Close BullMQ workers
        await Promise.all(workers.map((w) => w.close()));
        console.log('[server] BullMQ workers stopped');

        // Disconnect Prisma
        await prisma.$disconnect();
        console.log('[server] Prisma disconnected');

        // Disconnect Redis
        await redis.quit();
        console.log('[server] Redis disconnected');

        process.exit(0);
      });

      // Force exit after 15 seconds if graceful shutdown hangs
      setTimeout(() => {
        console.error('[server] Forced shutdown after timeout');
        process.exit(1);
      }, 15_000);
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

  } catch (err) {
    console.error('[server] Failed to start:', err);
    process.exit(1);
  }
}

start();
