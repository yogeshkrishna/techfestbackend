/**
 * src/controllers/payment.controller.js
 *
 * Razorpay webhook handler.
 * Client-side payment verification stub (Phase 5).
 */

'use strict';

const paymentService = require('../services/payment.service');

// ─────────────────────────────────────────────
// POST /api/v1/payments/webhook
// ─────────────────────────────────────────────

/**
 * Razorpay webhook receiver.
 *
 * NOTE: app.js registers express.raw({ type: 'application/json' }) for this path
 * BEFORE express.json(), so req.rawBody contains the unmodified Buffer for
 * HMAC signature verification, and req.body contains the parsed JSON object.
 *
 * Always returns 200 to Razorpay (even on errors) to prevent endless retries,
 * except for invalid signatures which get 400 to signal misconfiguration.
 *
 * Responses:
 *   200 — event processed (or acknowledged and ignored)
 *   400 — invalid webhook signature
 */
async function handleWebhook(req, res, next) {
  try {
    const signature = req.headers['x-razorpay-signature'];

    if (!signature) {
      return res.status(400).json({
        error: { code: 'MISSING_WEBHOOK_SIGNATURE', message: 'x-razorpay-signature header is required.' },
      });
    }

    await paymentService.handleWebhook({
      rawBody:   req.rawBody,   // Buffer — set by app.js raw-body middleware
      signature,
    });

    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    // INVALID_WEBHOOK_SIGNATURE → 400 (tells Razorpay the secret is wrong, stop retrying)
    if (err.code === 'INVALID_WEBHOOK_SIGNATURE') {
      return res.status(400).json({ error: { code: err.code, message: err.message } });
    }
    // All other errors → 200 (let Razorpay retry; don't block on transient failures)
    console.error('[payment.controller] Webhook processing error:', err.message);
    return res.status(200).json({ status: 'processing_error', message: err.message });
  }
}

// ─────────────────────────────────────────────
// POST /api/v1/registrations/:registrationId/payment/verify
// ─────────────────────────────────────────────

/**
 * Client-initiated payment verification.
 *
 * Called by the frontend after Razorpay checkout completes, as a fallback
 * if the webhook hasn't fired yet. Verifies the client-supplied Razorpay
 * signature and confirms the registration if valid.
 *
 * Body: { razorpayPaymentId, razorpayOrderId, razorpaySignature }
 *
 * Responses:
 *   200 — registration confirmed
 *   400 — invalid signature
 *   404 — registration or payment not found
 *   409 — already confirmed (idempotent OK)
 */
async function verifyPayment(req, res, next) {
  try {
    const { razorpayPaymentId, razorpayOrderId, razorpaySignature } = req.body;

    if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
      return res.status(400).json({
        error: { code: 'MISSING_FIELDS', message: 'razorpayPaymentId, razorpayOrderId, and razorpaySignature are required.' },
      });
    }

    // Verify Razorpay client-side signature: HMAC_SHA256(orderId + '|' + paymentId, keySecret)
    const crypto = require('crypto');
    const env    = require('../config/env');
    const expected = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');

    if (expected !== razorpaySignature) {
      return res.status(400).json({
        error: { code: 'INVALID_PAYMENT_SIGNATURE', message: 'Payment signature verification failed.' },
      });
    }

    // Find the Registration via registrationId URL param
    const prisma = require('../config/prisma');
    const registrationId = req.params.registrationId;

    const payment = await prisma.payment.findFirst({
      where: { registrationId, razorpayOrderId },
      include: { registration: true },
    });

    if (!payment) {
      return res.status(404).json({
        error: { code: 'PAYMENT_NOT_FOUND', message: 'No payment found for this registration and order ID.' },
      });
    }

    // Ensure this participant owns the registration
    if (payment.registration.userId !== req.user.id) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'You do not own this registration.' },
      });
    }

    if (payment.registration.status === 'CONFIRMED') {
      return res.status(200).json({
        data: { message: 'Registration already confirmed.', status: 'CONFIRMED', registrationId },
      });
    }

    // Confirm the payment and registration atomically
    await prisma.$transaction([
      prisma.payment.update({
        where: { id: payment.id },
        data: { razorpayPaymentId, status: 'CAPTURED' },
      }),
      prisma.registration.update({
        where: { id: registrationId },
        data: { status: 'CONFIRMED', paidAmount: Number(payment.amount) },
      }),
    ]);

    const audit = require('../services/audit.service');
    await audit.log({
      actorId:    req.user.id,
      actorRole:  'PARTICIPANT',
      action:     'PAYMENT_VERIFIED_CLIENT',
      targetType: 'Registration',
      targetId:   registrationId,
      metadata:   { razorpayPaymentId, razorpayOrderId },
    });

    return res.status(200).json({
      data: { message: 'Payment verified. Registration confirmed.', status: 'CONFIRMED', registrationId },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { handleWebhook, verifyPayment };
