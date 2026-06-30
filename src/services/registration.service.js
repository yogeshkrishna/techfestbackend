/**
 * src/services/registration.service.js
 *
 * Registration service — the most concurrency-sensitive module in the system.
 *
 * Architectural decisions enforced:
 *   #3 — Redis fast-path for seat counting (Lua atomic check-and-decrement)
 *   #4 — 10-minute seat hold with BullMQ delayed release job
 *   #7 — Event must be OPEN to accept registrations
 *   #8 — Idempotency-Key enforced; service-layer check against Registration.idempotencyKey
 *
 * Redis failure policy:
 *   If Redis is unreachable during seat claim, return 503 SERVICE_UNAVAILABLE.
 *   Do NOT fall back to Postgres for seat counting — the risk of double-booking
 *   outweighs the availability cost. Redis downtime is an ops incident.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');

const prisma     = require('../config/prisma');
const redis      = require('../config/redis');
const audit      = require('./audit.service');
const { REGISTRATION_OPEN_STATES, seatKey } = require('./event.service');
const { seatReleaseQueue, postgresUpdateQueue } = require('../jobs/queues');
const { AppError } = require('../middleware/errorHandler');

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const SEAT_HOLD_MINUTES = 10;

/**
 * Lua script: atomically check-and-decrement the seat counter.
 *
 * Returns the new counter value on success, or -1 if the counter is already 0
 * (or the key doesn't exist). Never decrements below 0.
 *
 * This runs as a single atomic unit on Redis — two concurrent calls cannot
 * both see the same non-zero value and both succeed.
 */
const LUA_DECR_IF_POSITIVE = `
local current = tonumber(redis.call('GET', KEYS[1]))
if current == nil or current <= 0 then
  return -1
end
return redis.call('DECR', KEYS[1])
`;

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Returns the timestamp 10 minutes from now (seat hold expiry).
 * @returns {Date}
 */
function seatHoldExpiry() {
  return new Date(Date.now() + SEAT_HOLD_MINUTES * 60 * 1000);
}

/**
 * Deterministic BullMQ job ID for a seat-hold release job.
 * Using a fixed scheme lets us cancel the job by ID without storing it.
 *
 * @param {string} registrationId
 * @returns {string}
 */
function seatHoldJobId(registrationId) {
  return `seat-hold-${registrationId}`;
}

// ─────────────────────────────────────────────
// Public service functions
// ─────────────────────────────────────────────

/**
 * Registers a participant for an event (online/Razorpay flow).
 *
 * Steps:
 *   1. Validate idempotency key (required, enforced here)
 *   2. Check event exists and is OPEN
 *   3. Check user isn't already registered (non-cancelled)
 *   4. Atomically claim a seat via Lua script
 *   5. Create Registration (PENDING_PAYMENT) + enqueue seat-hold release job
 *   6. Create Razorpay order via payment.service
 *   7. Return { registrationId, orderId, seatHoldExpiresAt }
 *
 * Edge cases:
 *   - Missing idempotency key            → 400 MISSING_IDEMPOTENCY_KEY
 *   - Same key, same (user, event)       → return original response (idempotent)
 *   - Same key, different (user, event)  → 409 IDEMPOTENCY_CONFLICT
 *   - Event not OPEN                     → 409 EVENT_NOT_OPEN
 *   - Already registered                 → 409 ALREADY_REGISTERED
 *   - Seat counter = 0                   → 409 EVENT_FULL
 *   - Redis unreachable                  → 503 SERVICE_UNAVAILABLE
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.eventId
 * @param {string} params.idempotencyKey  Required
 * @returns {Promise<object>}
 */
async function registerForEvent({ userId, eventId, idempotencyKey }) {
  if (!idempotencyKey) {
    throw new AppError(400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required for registration.');
  }

  // ── 1. Idempotency check ─────────────────────────────────────────────────
  const existing = await prisma.registration.findUnique({
    where: { idempotencyKey },
    include: { event: { select: { costPerPerson: true } } },
  });

  if (existing) {
    if (existing.userId !== userId || existing.eventId !== eventId) {
      throw new AppError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This Idempotency-Key was used for a different registration. Use a unique key per registration attempt.'
      );
    }
    // True replay — return the original response
    const payment = await prisma.payment.findFirst({
      where: { registrationId: existing.id },
      orderBy: { createdAt: 'desc' },
    });
    return {
      registrationId:    existing.id,
      orderId:           payment?.razorpayOrderId ?? null,
      amount:            Number(existing.event?.costPerPerson ?? 0),
      currency:          'INR',
      seatHoldExpiresAt: existing.seatHoldExpiresAt,
      replayed:          true,
    };
  }

  // ── 2. Load and validate event ───────────────────────────────────────────
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) {
    throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found.');
  }
  if (!REGISTRATION_OPEN_STATES.has(event.lifecycleState)) {
    throw new AppError(
      409,
      'EVENT_NOT_OPEN',
      `Registrations are not accepted for events in state: ${event.lifecycleState}.`
    );
  }

  // ── 3. Duplicate registration check ─────────────────────────────────────
  const duplicate = await prisma.registration.findFirst({
    where: { userId, eventId, status: { not: 'CANCELLED_REFUNDED' } },
  });
  if (duplicate) {
    throw new AppError(409, 'ALREADY_REGISTERED', 'You are already registered for this event.');
  }

  // ── 4. Atomic seat claim via Lua script ──────────────────────────────────
  let newSeatCount;
  try {
    newSeatCount = await redis.eval(LUA_DECR_IF_POSITIVE, 1, seatKey(eventId));
  } catch (err) {
    throw new AppError(
      503,
      'SERVICE_UNAVAILABLE',
      'Seat reservation service is temporarily unavailable. Please try again shortly.'
    );
  }

  if (newSeatCount === -1) {
    throw new AppError(409, 'EVENT_FULL', 'Sorry, this event is full. No seats remaining.');
  }

  // ── 5. Create Registration + enqueue seat-hold release job ───────────────
  const registrationId = uuidv4();
  const expiresAt      = seatHoldExpiry();

  let registration;
  try {
    registration = await prisma.registration.create({
      data: {
        id:                registrationId,
        userId,
        eventId,
        status:            'PENDING_PAYMENT',
        paymentMethod:     'RAZORPAY',
        paidAmount:        0,
        seatHoldExpiresAt: expiresAt,
        idempotencyKey,
      },
    });
  } catch (err) {
    // P2002 = unique constraint on idempotencyKey — race condition
    if (err.code === 'P2002') {
      await redis.incr(seatKey(eventId)).catch(() => {});
      throw new AppError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'A concurrent request with the same Idempotency-Key was processed. Please retry.'
      );
    }
    await redis.incr(seatKey(eventId)).catch(() => {});
    throw err;
  }

  // Enqueue delayed seat-hold release (Decision #4)
  await seatReleaseQueue.add(
    'release',
    { registrationId, eventId, userId },
    {
      jobId: seatHoldJobId(registrationId),
      delay: SEAT_HOLD_MINUTES * 60 * 1000,
    }
  );

  // Enqueue Postgres seat decrement (eventual consistency, Decision #3)
  await postgresUpdateQueue.add('sync', { eventId, action: 'decrement' });

  // ── 6. Create Razorpay order ─────────────────────────────────────────────
  // Inline require to break circular dependency (payment.service → registration.service)
  const paymentService = require('./payment.service');
  const order = await paymentService.createRazorpayOrder({
    amount:         Number(event.costPerPerson),
    currency:       'INR',
    registrationId: registration.id,
  });

  // ── 7. Audit log ─────────────────────────────────────────────────────────
  await audit.log({
    actorId:    userId,
    actorRole:  'PARTICIPANT',
    action:     'REGISTRATION_CREATED',
    targetType: 'Registration',
    targetId:   registration.id,
    metadata:   { eventId, orderId: order.id, seatHoldExpiresAt: expiresAt },
  });

  return {
    registrationId:    registration.id,
    orderId:           order.id,
    amount:            Number(event.costPerPerson),
    currency:          'INR',
    seatHoldExpiresAt: expiresAt,
    replayed:          false,
  };
}

/**
 * On-spot cash registration (ADMIN or assigned VOLUNTEER).
 *
 * The walk-in MUST already have a verified User account.
 * If they don't have an account, direct them to complete OTP signup first.
 * This ensures every participant in the system has a verified identity.
 *
 * @param {object} params
 * @param {string} params.eventId
 * @param {string} params.email       Walk-in's email — must match an existing verified account
 * @param {string} params.actorId     The volunteer/admin doing the registration
 * @param {string} params.actorRole
 * @returns {Promise<object>}
 */
async function registerManual({ eventId, email, actorId, actorRole }) {
  // 1. Validate event
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) {
    throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found.');
  }
  if (!REGISTRATION_OPEN_STATES.has(event.lifecycleState)) {
    throw new AppError(
      409,
      'EVENT_NOT_OPEN',
      `Registrations are not accepted for events in state: ${event.lifecycleState}.`
    );
  }

  // 2. Look up walk-in user
  const walkIn = await prisma.user.findUnique({ where: { email } });
  if (!walkIn) {
    throw new AppError(
      404,
      'USER_NOT_FOUND',
      'No account found for this email. Please ask the participant to complete OTP signup first, then retry.'
    );
  }
  if (!walkIn.emailVerified) {
    throw new AppError(
      400,
      'USER_NOT_VERIFIED',
      'This account has not completed email verification. Please ask the participant to verify their email first.'
    );
  }
  if (walkIn.suspended) {
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended and cannot be registered.');
  }

  // 3. Duplicate check
  const duplicate = await prisma.registration.findFirst({
    where: { userId: walkIn.id, eventId, status: { not: 'CANCELLED_REFUNDED' } },
  });
  if (duplicate) {
    throw new AppError(409, 'ALREADY_REGISTERED', 'This participant is already registered for this event.');
  }

  // 4. Atomic seat claim
  let newSeatCount;
  try {
    newSeatCount = await redis.eval(LUA_DECR_IF_POSITIVE, 1, seatKey(eventId));
  } catch (err) {
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Seat reservation service is temporarily unavailable.');
  }
  if (newSeatCount === -1) {
    throw new AppError(409, 'EVENT_FULL', 'Sorry, this event is full. No seats remaining.');
  }

  // 5. Create Registration — CONFIRMED immediately (cash, no hold needed)
  const registrationId = uuidv4();
  let registration;
  try {
    registration = await prisma.registration.create({
      data: {
        id:             registrationId,
        userId:         walkIn.id,
        eventId,
        status:         'CONFIRMED',
        paymentMethod:  'CASH',
        paidAmount:     event.costPerPerson,
        registeredById: actorId,
      },
    });
  } catch (err) {
    await redis.incr(seatKey(eventId)).catch(() => {});
    throw err;
  }

  // 6. Enqueue Postgres decrement
  await postgresUpdateQueue.add('sync', { eventId, action: 'decrement' });

  // 7. Audit log — cash trail is critical
  await audit.log({
    actorId,
    actorRole,
    action:     'MANUAL_REGISTRATION_CREATED',
    targetType: 'Registration',
    targetId:   registration.id,
    metadata: {
      eventId,
      walkInUserId:   walkIn.id,
      walkInEmail:    walkIn.email,
      paidAmount:     String(event.costPerPerson),
      paymentMethod:  'CASH',
      registeredById: actorId,
    },
  });

  return {
    registrationId:  registration.id,
    user: {
      id:          walkIn.id,
      name:        walkIn.name,
      email:       walkIn.email,
      institution: walkIn.institution,
    },
    status:        'CONFIRMED',
    paymentMethod: 'CASH',
    paidAmount:    Number(event.costPerPerson),
  };
}

/**
 * Returns all registrations for a user across all events.
 *
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
async function getMyRegistrations(userId) {
  const registrations = await prisma.registration.findMany({
    where:   { userId },
    include: {
      event: {
        select: {
          id: true, name: true, eventDate: true,
          timeslotStart: true, timeslotEnd: true,
          venue: true, lifecycleState: true, costPerPerson: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return registrations.map(r => ({
    registrationId:    r.id,
    status:            r.status,
    paymentMethod:     r.paymentMethod,
    paidAmount:        Number(r.paidAmount),
    seatHoldExpiresAt: r.seatHoldExpiresAt,
    arrivedAt:         r.arrivedAt,
    checkedInAt:       r.checkedInAt,
    createdAt:         r.createdAt,
    event:             r.event,
  }));
}

/**
 * Cancels a CONFIRMED registration and issues a 50% refund (Decision #5).
 *
 * Authorization:
 *   PARTICIPANT — can only cancel their own registration
 *   ADMIN/HOST  — can cancel any registration
 *
 * Validations:
 *   - Registration must be CONFIRMED
 *   - Event must still be OPEN (closing registration also closes cancellations)
 *
 * Refund policy:
 *   - RAZORPAY: call Razorpay refund API for 50% of paidAmount.
 *     If the API call fails → return 502 and leave registration as CONFIRMED (spec requirement).
 *   - CASH: no Razorpay call; create a Refund row with status MANUAL_REQUIRED
 *     so finance knows to process it manually.
 *
 * Seat restoration:
 *   - Redis INCR (fire-and-forget, tolerates temporary Redis failure)
 *   - Postgres eventual-consistency via postgresUpdateQueue (same as Phase 3 pattern)
 *
 * @param {string} registrationId
 * @param {string} actorId
 * @param {string} actorRole
 * @returns {Promise<object>}
 */
async function cancelRegistration(registrationId, actorId, actorRole) {
  // ── 1. Load registration ─────────────────────────────────────────────────
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    include: {
      event: {
        select: {
          id: true, name: true, lifecycleState: true,
          eventDate: true, timeslotStart: true, venue: true,
        },
      },
      user:  { select: { id: true, name: true, email: true } },
    },
  });

  if (!registration) {
    throw new AppError(404, 'REGISTRATION_NOT_FOUND', 'Registration not found.');
  }

  // ── 2. Authorization ─────────────────────────────────────────────────────
  if (actorRole === 'PARTICIPANT' && registration.userId !== actorId) {
    throw new AppError(403, 'FORBIDDEN', 'You can only cancel your own registrations.');
  }

  // ── 3. Status guard ──────────────────────────────────────────────────────
  if (registration.status === 'CANCELLED_REFUNDED') {
    throw new AppError(409, 'ALREADY_CANCELLED', 'This registration has already been cancelled.');
  }
  if (registration.status !== 'CONFIRMED') {
    throw new AppError(
      409,
      'CANNOT_CANCEL',
      `Cannot cancel a registration with status: ${registration.status}. Only CONFIRMED registrations can be cancelled.`
    );
  }

  // ── 4. Event lifecycle guard ─────────────────────────────────────────────
  if (registration.event.lifecycleState !== 'OPEN') {
    throw new AppError(
      409,
      'CANCELLATION_NOT_ALLOWED',
      `Cancellations are not allowed once the event moves past OPEN state (current: ${registration.event.lifecycleState}).`
    );
  }

  const paidAmount   = Number(registration.paidAmount);
  const refundAmount = paidAmount * 0.5;  // 50% refund (Decision #5)
  const eventId      = registration.eventId;

  // ── 5. Razorpay refund (RAZORPAY payments only) ──────────────────────────
  let razorpayRefundId = null;

  if (registration.paymentMethod === 'RAZORPAY') {
    // Find the captured payment record
    const payment = await prisma.payment.findFirst({
      where: { registrationId: registration.id, status: 'CAPTURED' },
      orderBy: { createdAt: 'desc' },
    });

    if (!payment?.razorpayPaymentId) {
      throw new AppError(
        409,
        'PAYMENT_NOT_CAPTURED',
        'No captured payment found for this registration. Cannot process a refund.'
      );
    }

    // Attempt refund — if this throws, we DO NOT cancel (spec: leave in CONFIRMED)
    try {
      // Inline require breaks circular dep: payment.service → registration.service
      const paymentService = require('./payment.service');
      const refund = await paymentService.issueRefund(payment.razorpayPaymentId, refundAmount);
      razorpayRefundId = refund.id;
    } catch (err) {
      // Log the failure but do NOT mutate registration status
      await audit.log({
        actorId,
        actorRole,
        action:     'REFUND_FAILED',
        targetType: 'Registration',
        targetId:   registration.id,
        metadata:   { reason: err.message, attemptedRefundAmount: refundAmount },
      });
      throw new AppError(
        502,
        'REFUND_FAILED',
        `Refund initiation failed: ${err.message}. ` +
        'Your registration has NOT been cancelled — please try again or contact support.'
      );
    }
  }

  // ── 6. Create Refund row ─────────────────────────────────────────────────
  //    For CASH, razorpayRefundId is a placeholder; status MANUAL_REQUIRED
  //    signals finance to process the refund manually.
  await prisma.refund.create({
    data: {
      registrationId:   registration.id,
      razorpayRefundId: razorpayRefundId ?? `CASH-${registration.id}`,
      amount:           refundAmount,
      status:           registration.paymentMethod === 'CASH' ? 'MANUAL_REQUIRED' : 'processed',
    },
  });

  // ── 7. Mark registration cancelled ──────────────────────────────────────
  await prisma.registration.update({
    where: { id: registration.id },
    data:  { status: 'CANCELLED_REFUNDED' },
  });

  // ── 8. Restore seat — Redis INCR (fire-and-forget) + Postgres sync ───────
  redis.incr(seatKey(eventId)).catch(err => {
    console.error(
      `[registration.service] Redis INCR failed on cancellation for event ${eventId}:`,
      err.message
    );
  });
  await postgresUpdateQueue.add('sync', { eventId, action: 'increment' });

  // ── 9. Audit log ─────────────────────────────────────────────────────────
  await audit.log({
    actorId,
    actorRole,
    action:     'REGISTRATION_CANCELLED',
    targetType: 'Registration',
    targetId:   registration.id,
    metadata:   {
      eventId,
      userId:          registration.userId,
      refundAmount,
      paymentMethod:   registration.paymentMethod,
      razorpayRefundId: razorpayRefundId ?? null,
    },
  });

  // ── 10. Send cancellation email (fire-and-forget) ────────────────────────
  const emailService = require('./email.service');
  emailService.sendCancellationEmail(registration.user.email, {
    userName:       registration.user.name,
    eventName:      registration.event.name,
    refundAmount,
    paidAmount,
    registrationId: registration.id,
    paymentMethod:  registration.paymentMethod,
  }).catch(err => {
    console.error('[registration.service] Failed to send cancellation email:', err.message);
  });

  const refundMsg = registration.paymentMethod === 'CASH'
    ? 'A manual refund will be processed by our team.'
    : `A 50% refund of ₹${refundAmount.toFixed(2)} has been initiated via Razorpay.`;

  return {
    registrationId: registration.id,
    status:         'CANCELLED_REFUNDED',
    refundAmount,
    paymentMethod:  registration.paymentMethod,
    message:        `Registration cancelled. ${refundMsg}`,
  };
}

module.exports = {
  registerForEvent,
  registerManual,
  getMyRegistrations,
  cancelRegistration,
  seatHoldJobId,
  LUA_DECR_IF_POSITIVE,
};
