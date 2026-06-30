/**
 * src/jobs/workers/postgresUpdate.worker.js
 *
 * BullMQ worker: postgresUpdateQueue
 *
 * Asynchronously syncs Redis seat state → Postgres seatsRemaining (Decision #3).
 * This maintains eventual consistency between the Redis fast-path counter and
 * the canonical Postgres value.
 *
 * Job data shape: { eventId: string, action: 'decrement' | 'increment' | 'confirm' }
 *
 * Actions:
 *   'decrement' — seat was taken (registration created or late-webhook re-reserve)
 *   'increment' — seat was released (hold expired)
 *   'confirm'   — payment confirmed; Postgres already decremented at registration time,
 *                 so this is a no-op sync validation (logged but no DB write needed)
 *
 * Floor guard: seatsRemaining never goes below 0 (Postgres constraint + worker guard).
 */

'use strict';

const { Worker } = require('bullmq');

const prisma  = require('../../config/prisma');
const redis   = require('../../config/redis');
const { seatKey } = require('../../services/event.service');
const env     = require('../../config/env');

/**
 * Job processor for postgresUpdateQueue.
 *
 * @param {import('bullmq').Job} job
 */
async function processPostgresUpdate(job) {
  const { eventId, action } = job.data;
  console.log(`[postgresUpdate.worker] Processing job ${job.id}: action=${action} eventId=${eventId}`);

  if (action === 'decrement') {
    // Decrement seatsRemaining in Postgres, floored at 0
    // Uses Prisma's raw update with a GREATEST guard to prevent negative values
    await prisma.$executeRaw`
      UPDATE "Event"
      SET "seatsRemaining" = GREATEST("seatsRemaining" - 1, 0)
      WHERE id = ${eventId}
    `;
    console.log(`[postgresUpdate.worker] Decremented seatsRemaining for event ${eventId}`);

  } else if (action === 'increment') {
    // Increment seatsRemaining, cap at totalSeats to prevent overshooting
    await prisma.$executeRaw`
      UPDATE "Event"
      SET "seatsRemaining" = LEAST("seatsRemaining" + 1, "totalSeats")
      WHERE id = ${eventId}
    `;
    console.log(`[postgresUpdate.worker] Incremented seatsRemaining for event ${eventId}`);

  } else if (action === 'confirm') {
    // Payment confirmed — seat was already decremented at registration creation.
    // Optionally cross-check Redis vs Postgres here for monitoring.
    try {
      const redisVal = await redis.get(seatKey(eventId));
      const event    = await prisma.event.findUnique({
        where:  { id: eventId },
        select: { seatsRemaining: true },
      });
      if (event && redisVal !== null && parseInt(redisVal, 10) !== event.seatsRemaining) {
        console.warn(
          `[postgresUpdate.worker] Drift detected for event ${eventId}: ` +
          `Redis=${redisVal}, Postgres=${event.seatsRemaining}`
        );
      }
    } catch (err) {
      console.warn(`[postgresUpdate.worker] Drift check failed for event ${eventId}:`, err.message);
    }

  } else {
    console.warn(`[postgresUpdate.worker] Unknown action: ${action} for event ${eventId}`);
  }
}

/**
 * Starts the postgresUpdate worker.
 * Called from src/jobs/index.js during app startup.
 *
 * @returns {Worker}
 */
function startPostgresUpdateWorker() {
  const worker = new Worker('postgresUpdateQueue', processPostgresUpdate, {
    connection: { url: env.REDIS_URL },
    concurrency: 5,
  });

  worker.on('completed', (job) => {
    console.log(`[postgresUpdate.worker] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[postgresUpdate.worker] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

module.exports = { startPostgresUpdateWorker };
