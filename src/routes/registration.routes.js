/**
 * src/routes/registration.routes.js
 *
 * Registration routes — mounted at the root level in routes/index.js
 * so that full paths match the spec exactly.
 *
 * POST   /api/v1/events/:eventId/register          — participant self-registration
 * POST   /api/v1/events/:eventId/register-manual   — on-spot cash (ADMIN, HOST, VOLUNTEER)
 * GET    /api/v1/events/:eventId/registrations     — list event registrations (ADMIN, HOST, VOL)
 * GET    /api/v1/registrations/me                  — participant's own registrations
 * PATCH  /api/v1/registrations/:registrationId/cancel — cancel + 50% refund (Phase 6)
 *
 * ── Idempotency audit (Phase 7) ──────────────────────────────────────────────
 *
 *  /register          — checkIdempotency reads Idempotency-Key header →
 *                       registration.service checks Registration.idempotencyKey
 *                       (DB unique constraint). True idempotency: same key returns
 *                       original response. registrationLimiter blunts retry storms.
 *
 *  /register-manual   — NO Idempotency-Key required (CASH, no Razorpay payment).
 *                       Idempotency enforced via business logic: duplicate check
 *                       in registerManual() returns ALREADY_REGISTERED on retry.
 *                       This is sufficient — there is no external API call to replay.
 *
 *  /cancel            — checkIdempotency reads header (passed to service but not
 *                       cached; service-level guard is the status check:
 *                       ALREADY_CANCELLED → 409 on any retry). Razorpay refund
 *                       call is skipped once status = CANCELLED_REFUNDED, so no
 *                       double-refund is possible.
 */

'use strict';

const { Router } = require('express');
const { authenticate }        = require('../middleware/auth');
const { requireRole }         = require('../middleware/rbac');
const { requireEventScope }   = require('../middleware/volunteerScope');
const { checkIdempotency }    = require('../middleware/idempotency');
const { registrationLimiter } = require('../middleware/rateLimiter');
const { validate, registerManualSchema } = require('../middleware/validate');
const registrationController = require('../controllers/registration.controller');

const router = Router({ mergeParams: true });

// ── Participant self-registration ─────────────────────────────────────────────

// registrationLimiter runs AFTER authenticate so req.user is available for key.
// Idempotency-Key header is required — enforced inside the service (400 if absent).
router.post(
  '/events/:eventId/register',
  authenticate,
  requireRole(['PARTICIPANT']),
  checkIdempotency,
  registrationLimiter,
  registrationController.registerForEvent
);

// ── On-spot cash registration (ADMIN or assigned VOLUNTEER) ───────────────────
// No rate limiter: called by trusted staff, already behind RBAC + scope guard.
// Idempotency: business-logic duplicate check (see header comment above).
router.post(
  '/events/:eventId/register-manual',
  authenticate,
  requireRole(['ADMIN', 'HOST', 'VOLUNTEER']),
  requireEventScope,
  validate(registerManualSchema),
  registrationController.registerManual
);

// ── Event-level registration list (ADMIN, HOST, VOLUNTEER) ───────────────────

router.get(
  '/events/:eventId/registrations',
  authenticate,
  requireRole(['ADMIN', 'HOST', 'VOLUNTEER']),
  requireEventScope,
  registrationController.listRegistrations
);

// ── Participant's own registration history ────────────────────────────────────

// NOTE: /registrations/me must come before /registrations/:registrationId
// to prevent Express matching 'me' as a registrationId param.
router.get(
  '/registrations/me',
  authenticate,
  requireRole(['PARTICIPANT']),
  registrationController.getMyRegistrations
);

// ── Cancel registration (Phase 6) ────────────────────────────────────────────
// Idempotency: ALREADY_CANCELLED guard prevents double-cancel; see header comment.
router.patch(
  '/registrations/:registrationId/cancel',
  authenticate,
  requireRole(['PARTICIPANT', 'ADMIN', 'HOST']),
  checkIdempotency,
  registrationController.cancelRegistration
);

module.exports = router;
