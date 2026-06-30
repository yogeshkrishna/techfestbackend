/**
 * src/routes/payment.routes.js
 *
 * Payment webhook and verification routes.
 *
 * POST /api/v1/payments/webhook
 *   — Razorpay webhook callback. No JWT auth — verified by Razorpay signature.
 *   — Raw body parsing is required for signature verification; configured in app.js.
 *
 * POST /api/v1/registrations/:registrationId/payment/verify
 *   — Client-side payment verification after Razorpay checkout completes.
 *   — Idempotency key supported (Decision #8).
 */

'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { checkIdempotency } = require('../middleware/idempotency');
const paymentController = require('../controllers/payment.controller');

const router = Router({ mergeParams: true });

// Razorpay webhook — no auth; signature verified inside the controller
// NOTE: This route must receive the raw (unparsed) request body.
// See app.js where express.raw() is applied to this path before express.json().
router.post('/payments/webhook', paymentController.handleWebhook);

// Client-initiated payment verification
router.post(
  '/registrations/:registrationId/payment/verify',
  authenticate,
  requireRole(['PARTICIPANT']),
  checkIdempotency,
  paymentController.verifyPayment
);

module.exports = router;
