/**
 * src/jobs/index.js
 *
 * BullMQ job system bootstrap.
 * Call initJobs() during app startup (from server.js) to start all workers.
 *
 * Workers connect to Redis independently of the shared ioredis client.
 * Each worker manages its own BullMQ connection pool.
 */

'use strict';

const { startSeatReleaseWorker } = require('./workers/seatRelease.worker');
const { startPostgresUpdateWorker } = require('./workers/postgresUpdate.worker');

/**
 * Starts all BullMQ workers.
 * Returns an array of running Worker instances so they can be gracefully
 * shut down on SIGTERM (handled in server.js).
 *
 * @returns {import('bullmq').Worker[]}
 */
function initJobs() {
  console.log('[jobs] Starting BullMQ workers...');

  const workers = [
    startSeatReleaseWorker(),
    startPostgresUpdateWorker(),
  ];

  console.log(`[jobs] ${workers.length} worker(s) running.`);
  return workers;
}

module.exports = { initJobs };
