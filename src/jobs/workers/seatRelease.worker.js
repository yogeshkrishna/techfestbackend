/**
 * src/jobs/workers/seatRelease.worker.js
 *
 * BullMQ worker: seatReleaseQueue
 *
 * Fires SEAT_HOLD_MINUTES (10) minutes after a seat hold is created (Decision #4).
 * If the Registration is still PENDING_PAYMENT, the user did not complete payment —
 * release the held seat back to the pool.
 *
 * Job data shape: { registrationId: string, eventId: string, userId: string }
 *
 * Idempotency: if status is already not PENDING_PAYMENT (payment confirmed or
 * already released), the job is a no-op — safe to retry.
 */

'use strict';

const { Worker } = require('bullmq');

const prisma  = require('../../config/prisma');
const redis   = require('../../config/redis');
const audit   = require('../../services/audit.service');
const { seatKey } = require('../../services/event.service');
const { postgresUpdateQueue } = require('../queues');
const env     = require('../../config/env');

/**
 * Job processor for seatReleaseQueue.
 *
 * @param {import('bullmq').Job} job
 */
async function processSeatRelease(job) {
  const { registrationId, eventId, userId } = job.data;
  console.log(`[seatRelease.worker] Processing job ${job.id} for registration ${registrationId}`);

  // 1. Load the registration
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
  });

  if (!registration) {
    console.warn(`[seatRelease.worker] Registration ${registrationId} not found — skipping`);
    return;
  }

  // 2. Idempotency guard — only act if still PENDING_PAYMENT
  if (registration.status !== 'PENDING_PAYMENT') {
    console.log(
      `[seatRelease.worker] Registration ${registrationId} is already ${registration.status} — seat hold release skipped`
    );
    return;
  }

  // 3. Mark registration as CANCELLED_REFUNDED (seat hold expired = no payment received)
  await prisma.registration.update({
    where: { id: registrationId },
    data:  { status: 'CANCELLED_REFUNDED' },
  });

  // 4. Restore the seat in Redis
  try {
    await redis.incr(seatKey(eventId));
  } catch (err) {
    console.error(`[seatRelease.worker] Redis INCR failed for event ${eventId}:`, err.message);
    // Do not throw — Postgres sync below will bring it back in line
  }

  // 5. Enqueue Postgres seat increment (eventual consistency)
  await postgresUpdateQueue.add('sync', { eventId, action: 'increment' });

  // 6. Audit log (actorId = null → system-initiated action)
  await audit.log({
    actorId:    null,
    actorRole:  'SYSTEM',
    action:     'SEAT_HOLD_EXPIRED',
    targetType: 'Registration',
    targetId:   registrationId,
    metadata:   { registrationId, eventId, userId },
  });

  console.log(`[seatRelease.worker] Seat released for registration ${registrationId}`);
}

/**
 * Starts the seatRelease worker.
 * Called from src/jobs/index.js during app startup.
 *
 * @returns {Worker}
 */
function startSeatReleaseWorker() {
  const worker = new Worker('seatReleaseQueue', processSeatRelease, {
    connection: { url: env.REDIS_URL },
    concurrency: 10,
  });

  worker.on('completed', (job) => {
    console.log(`[seatRelease.worker] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[seatRelease.worker] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

module.exports = { startSeatReleaseWorker };
