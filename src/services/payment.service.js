/**
 * src/services/payment.service.js
 *
 * Razorpay integration — order creation, webhook handling, refunds.
 *
 * Architectural decisions:
 *   #5 — Cancellation triggers automatic 50% refund (Phase 5 — stub here)
 *
 * Webhook idempotency:
 *   Before processing any event, check if Payment with razorpayPaymentId already
 *   has status CAPTURED. If yes, return immediately (Razorpay retries webhooks).
 *
 * Late webhook handling (payment.captured arrives after seat hold expired):
 *   - If seats still available → re-reserve, confirm registration
 *   - If event full → auto-refund 100% (not 50% — system fault, not user cancellation)
 */

'use strict';

const crypto    = require('crypto');
const Razorpay  = require('razorpay');

const prisma    = require('../config/prisma');
const redis     = require('../config/redis');
const env       = require('../config/env');
const audit     = require('./audit.service');
const { seatKey } = require('./event.service');
const { seatHoldJobId, LUA_DECR_IF_POSITIVE } = require('./registration.service');
const { seatReleaseQueue, postgresUpdateQueue } = require('../jobs/queues');
const { AppError } = require('../middleware/errorHandler');

// ─────────────────────────────────────────────
// Razorpay client singleton
// ─────────────────────────────────────────────

let _razorpay;
function getRazorpay() {
  if (!_razorpay) {
    _razorpay = new Razorpay({
      key_id:     env.RAZORPAY_KEY_ID,
      key_secret: env.RAZORPAY_KEY_SECRET,
    });
  }
  return _razorpay;
}

// ─────────────────────────────────────────────
// Order creation
// ─────────────────────────────────────────────

/**
 * Creates a new Razorpay order and stores a Payment row with status=CREATED.
 *
 * Amount is passed as a decimal (e.g. 499.00) and converted to paise internally.
 *
 * @param {object} params
 * @param {number} params.amount          Amount in INR (e.g. 499)
 * @param {string} params.currency        e.g. 'INR'
 * @param {string} params.registrationId  Used as the Razorpay receipt
 * @returns {Promise<{ id: string, amount: number, currency: string }>}
 */
async function createRazorpayOrder({ amount, currency, registrationId }) {
  const amountInPaise = Math.round(amount * 100);

  const order = await getRazorpay().orders.create({
    amount:   amountInPaise,
    currency,
    receipt:  registrationId,
    notes:    { registrationId },
  });

  // Persist Payment row with status CREATED
  await prisma.payment.create({
    data: {
      registrationId,
      razorpayOrderId: order.id,
      amount,
      status: 'CREATED',
    },
  });

  return { id: order.id, amount: amountInPaise, currency };
}

// ─────────────────────────────────────────────
// Webhook
// ─────────────────────────────────────────────

/**
 * Verifies Razorpay webhook signature and dispatches to the appropriate handler.
 *
 * Razorpay signs the raw request body with HMAC-SHA256 using RAZORPAY_WEBHOOK_SECRET.
 * The signature is in the `x-razorpay-signature` header.
 *
 * @param {object} params
 * @param {Buffer|string} params.rawBody    The unmodified request body (Buffer or string)
 * @param {string}        params.signature  Value of x-razorpay-signature header
 * @returns {Promise<void>}
 */
async function handleWebhook({ rawBody, signature }) {
  // 1. Verify signature
  const expectedSig = crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  if (expectedSig !== signature) {
    throw new AppError(400, 'INVALID_WEBHOOK_SIGNATURE', 'Webhook signature verification failed.');
  }

  // 2. Parse event
  const body  = typeof rawBody === 'string' ? JSON.parse(rawBody) : JSON.parse(rawBody.toString('utf-8'));
  const event = body.event;
  const payload = body.payload?.payment?.entity ?? body.payload?.payment ?? {};

  switch (event) {
    case 'payment.captured':
      await handlePaymentCaptured(payload);
      break;
    case 'payment.failed':
      await handlePaymentFailed(payload);
      break;
    default:
      // Unknown event — acknowledge and ignore (do not 4xx)
      console.log(`[payment.service] Unhandled webhook event: ${event}`);
  }
}

// ─────────────────────────────────────────────
// Internal webhook handlers
// ─────────────────────────────────────────────

/**
 * Handles payment.captured:
 *   1. Idempotency check — skip if already CAPTURED
 *   2. Find Payment + Registration by Razorpay order ID
 *   3. If Registration is PENDING_PAYMENT → normal confirm path
 *   4. If Registration is CANCELLED_REFUNDED (seat hold expired) → late webhook path
 *   5. Cancel the BullMQ seat-hold job
 *   6. Update Payment → CAPTURED, Registration → CONFIRMED
 *   7. Enqueue Postgres sync
 *   8. Audit log
 *
 * @param {object} entity  Razorpay payment entity from webhook payload
 */
async function handlePaymentCaptured(entity) {
  const razorpayPaymentId = entity.id;
  const razorpayOrderId   = entity.order_id;
  const capturedAmount    = entity.amount / 100; // paise → INR

  // ── Idempotency: skip if already processed ───────────────────────────────
  const alreadyProcessed = await prisma.payment.findFirst({
    where: { razorpayPaymentId, status: 'CAPTURED' },
  });
  if (alreadyProcessed) {
    console.log(`[payment.service] Webhook idempotent: payment ${razorpayPaymentId} already CAPTURED`);
    return;
  }

  // ── Find Payment + Registration ──────────────────────────────────────────
  const payment = await prisma.payment.findFirst({
    where:   { razorpayOrderId },
    include: { registration: true },
  });

  if (!payment) {
    console.error(`[payment.service] No Payment found for orderId: ${razorpayOrderId}`);
    return; // Can't process — log and return 200 to Razorpay to stop retries
  }

  const registration = payment.registration;

  // ── Late webhook path ────────────────────────────────────────────────────
  if (registration.status === 'CANCELLED_REFUNDED') {
    await handleLateWebhook({ payment, registration, razorpayPaymentId, capturedAmount });
    return;
  }

  // ── Normal confirm path ──────────────────────────────────────────────────
  if (registration.status !== 'PENDING_PAYMENT') {
    console.warn(`[payment.service] Unexpected registration status ${registration.status} for payment ${razorpayPaymentId}`);
    return;
  }

  // Cancel the BullMQ seat-hold release job
  try {
    const job = await seatReleaseQueue.getJob(seatHoldJobId(registration.id));
    if (job) await job.remove();
  } catch (err) {
    console.warn(`[payment.service] Could not cancel seat-hold job for registration ${registration.id}:`, err.message);
  }

  // Update Payment + Registration atomically
  await prisma.$transaction([
    prisma.payment.update({
      where: { id: payment.id },
      data: {
        razorpayPaymentId,
        status: 'CAPTURED',
        amount: capturedAmount,
      },
    }),
    prisma.registration.update({
      where: { id: registration.id },
      data: {
        status:     'CONFIRMED',
        paidAmount: capturedAmount,
      },
    }),
  ]);

  // Enqueue Postgres sync (seat already decremented in Redis at registration time)
  // This just ensures Postgres seatsRemaining stays in sync
  await postgresUpdateQueue.add('sync', { eventId: registration.eventId, action: 'confirm' });

  // Send confirmation email (fire-and-forget — don't fail the webhook on email issues)
  prisma.user.findUnique({ where: { id: registration.userId }, select: { email: true, name: true } })
    .then(user => {
      if (!user) return;
      return prisma.event.findUnique({
        where:  { id: registration.eventId },
        select: { name: true, eventDate: true, timeslotStart: true, timeslotEnd: true, venue: true },
      }).then(event => {
        if (!event) return;
        const emailSvc = require('./email.service');
        return emailSvc.sendConfirmationEmail(user.email, {
          userName:       user.name,
          eventName:      event.name,
          eventDate:      event.eventDate,
          timeslotStart:  event.timeslotStart,
          timeslotEnd:    event.timeslotEnd,
          venue:          event.venue,
          amount:         capturedAmount,
          registrationId: registration.id,
        });
      });
    })
    .catch(err => {
      console.error('[payment.service] Failed to send confirmation email:', err.message);
    });

  await audit.log({
    actorId:    null,
    actorRole:  'SYSTEM',
    action:     'PAYMENT_CAPTURED',
    targetType: 'Registration',
    targetId:   registration.id,
    metadata:   { razorpayPaymentId, razorpayOrderId, amount: capturedAmount },
  });
}

/**
 * Handles late webhook — payment.captured arrives after seat hold expired.
 *
 * Decision:
 *   - If seats still available: re-reserve atomically, re-confirm registration
 *   - If event full: issue 100% refund (system fault — not user's choice to cancel)
 */
async function handleLateWebhook({ payment, registration, razorpayPaymentId, capturedAmount }) {
  console.log(`[payment.service] Late webhook for registration ${registration.id} — seat hold already expired`);

  // Try to re-claim a seat
  let newSeatCount;
  try {
    newSeatCount = await redis.eval(LUA_DECR_IF_POSITIVE, 1, seatKey(registration.eventId));
  } catch (err) {
    console.error('[payment.service] Redis unavailable during late webhook handling:', err.message);
    // Can't determine seat availability — log and bail; Razorpay will retry
    return;
  }

  if (newSeatCount !== -1) {
    // Seat claimed — re-confirm the registration
    await prisma.$transaction([
      prisma.payment.update({
        where: { id: payment.id },
        data: { razorpayPaymentId, status: 'CAPTURED', amount: capturedAmount },
      }),
      prisma.registration.update({
        where: { id: registration.id },
        data: { status: 'CONFIRMED', paidAmount: capturedAmount, seatHoldExpiresAt: null },
      }),
    ]);

    await postgresUpdateQueue.add('sync', { eventId: registration.eventId, action: 'decrement' });

    await audit.log({
      actorId:    null,
      actorRole:  'SYSTEM',
      action:     'LATE_WEBHOOK_RECONFIRMED',
      targetType: 'Registration',
      targetId:   registration.id,
      metadata:   { razorpayPaymentId, capturedAmount, note: 'Seat re-reserved after hold expiry' },
    });
  } else {
    // Event full — auto-refund 100% (system fault)
    await handleFullRefundForLateWebhook({ payment, registration, razorpayPaymentId, capturedAmount });
  }
}

/**
 * Issues a 100% refund when late webhook arrives but event is full.
 * Phase 5 has the full refund API; this is a self-contained implementation
 * for this specific system-fault scenario.
 */
async function handleFullRefundForLateWebhook({ payment, registration, razorpayPaymentId, capturedAmount }) {
  try {
    const refund = await getRazorpay().payments.refund(razorpayPaymentId, {
      amount: Math.round(capturedAmount * 100), // full refund in paise
      notes:  { reason: 'LATE_WEBHOOK_NO_SEATS', registrationId: registration.id },
    });

    await prisma.$transaction([
      prisma.payment.update({
        where: { id: payment.id },
        data: { razorpayPaymentId, status: 'FAILED', amount: capturedAmount },
      }),
      prisma.refund.create({
        data: {
          registrationId:   registration.id,
          razorpayRefundId: refund.id,
          amount:           capturedAmount,
          status:           'processed',
        },
      }),
    ]);

    await audit.log({
      actorId:    null,
      actorRole:  'SYSTEM',
      action:     'LATE_WEBHOOK_FULL_REFUND',
      targetType: 'Registration',
      targetId:   registration.id,
      metadata:   { razorpayPaymentId, capturedAmount, refundId: refund.id, reason: 'LATE_WEBHOOK_NO_SEATS' },
    });
  } catch (err) {
    console.error(`[payment.service] Full refund failed for late webhook (registrationId: ${registration.id}):`, err.message);
  }
}

/**
 * Handles payment.failed:
 *   - Marks Payment status = FAILED
 *   - Leaves Registration as PENDING_PAYMENT
 *   - The seat-hold BullMQ job will clean it up if the user doesn't retry in time
 *
 * @param {object} entity  Razorpay payment entity
 */
async function handlePaymentFailed(entity) {
  const razorpayOrderId   = entity.order_id;
  const razorpayPaymentId = entity.id;

  const payment = await prisma.payment.findFirst({ where: { razorpayOrderId } });
  if (!payment) {
    console.warn(`[payment.service] No Payment found for failed orderId: ${razorpayOrderId}`);
    return;
  }

  // Idempotency — skip if already marked FAILED
  if (payment.status === 'FAILED') return;

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      razorpayPaymentId,
      status: 'FAILED',
    },
  });

  await audit.log({
    actorId:    null,
    actorRole:  'SYSTEM',
    action:     'PAYMENT_FAILED',
    targetType: 'Payment',
    targetId:   payment.id,
    metadata:   { razorpayPaymentId, razorpayOrderId },
  });
}

// ─────────────────────────────────────────────
// Refund (Phase 5 — stub)
// ─────────────────────────────────────────────

/**
 * Issues a partial refund on a captured payment.
 * Called by registration.service.cancelRegistration() for 50% auto-refund (Decision #5).
 * Full implementation in Phase 5.
 *
 * @param {string} razorpayPaymentId
 * @param {number} amountInr  Amount to refund in INR (not paise)
 * @returns {Promise<object>}  Razorpay refund object
 */
async function issueRefund(razorpayPaymentId, amountInr) {
  const amountInPaise = Math.round(amountInr * 100);
  return getRazorpay().payments.refund(razorpayPaymentId, { amount: amountInPaise });
}

module.exports = {
  createRazorpayOrder,
  handleWebhook,
  issueRefund,
};
