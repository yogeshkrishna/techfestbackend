/**
 * src/jobs/queues.js
 *
 * BullMQ queue definitions.
 *
 * BullMQ requires its own Redis connections — do NOT pass the shared ioredis
 * singleton from config/redis.js. Instead, pass a connection config object and
 * let BullMQ manage its own pool.
 *
 * Queues defined here:
 *   seatReleaseQueue    — delayed job to release a held seat if payment window expires
 *   postgresUpdateQueue — async job to sync Redis seat counter → Postgres
 */

'use strict';

const { Queue } = require('bullmq');
const env = require('../config/env');

/**
 * Shared BullMQ Redis connection config.
 * Parsed from REDIS_URL env var.
 */
function getBullMQConnection() {
  // BullMQ accepts either a full URL string or a host/port/password object.
  // Passing the URL string directly is supported in ioredis >= 4.
  return { url: env.REDIS_URL };
}

/**
 * Queue: seatReleaseQueue
 *
 * Holds delayed jobs that fire 10 minutes after a seat hold is created.
 * If payment has not been confirmed by then, the worker releases the seat
 * back to the pool (INCR Redis counter, enqueue postgresUpdateQueue job).
 *
 * Job data shape: { registrationId: string, eventId: string, userId: string }
 */
const seatReleaseQueue = new Queue('seatReleaseQueue', {
  connection: getBullMQConnection(),
  defaultJobOptions: {
    // Jobs should not be retried — a seat release is idempotent enough
    // that the worker should always succeed on first attempt
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 60 * 60 * 24 }, // keep 24h for debugging
    removeOnFail: { age: 60 * 60 * 24 * 7 }, // keep failures 7d for inspection
  },
});

/**
 * Queue: postgresUpdateQueue
 *
 * Holds jobs that sync the Redis seat count to Postgres' seatsRemaining field.
 * Enqueued after every seat take or release so Postgres remains eventually consistent.
 *
 * Job data shape: { eventId: string, delta: number } (delta = -1 for take, +1 for release)
 */
const postgresUpdateQueue = new Queue('postgresUpdateQueue', {
  connection: getBullMQConnection(),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 500 },
    removeOnComplete: { age: 60 * 60 * 24 },
    removeOnFail: { age: 60 * 60 * 24 * 7 },
  },
});

module.exports = { seatReleaseQueue, postgresUpdateQueue };
