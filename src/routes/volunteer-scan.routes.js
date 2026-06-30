/**
 * src/routes/volunteer-scan.routes.js
 *
 * Volunteer check-in, scanning, dashboard, export, and email-lookup routes.
 * Mounted at /api/v1/volunteer in routes/index.js.
 *
 * POST   /api/v1/volunteer/scan/gate              — mark arrived at gate
 * POST   /api/v1/volunteer/scan/venue             — mark checked in at venue
 * POST   /api/v1/volunteer/scan/lookup            — read-only QR lookup
 * GET    /api/v1/volunteer/events/:id/dashboard   — live stats + participant lists
 * GET    /api/v1/volunteer/events/:id/export      — CSV download
 * POST   /api/v1/volunteer/users/lookup-by-email  — OTP-gated user lookup
 *
 * All routes: VOLUNTEER, ADMIN, HOST.
 * Volunteer event-scoping (Decision #9):
 *   - Dashboard / export:    requireEventScope middleware (URL-param :id)
 *   - Scan routes:           assertVolunteerScope() inside checkin.service (body eventId)
 *
 * ADMIN / HOST bypass all event-scope checks.
 */

'use strict';

const { Router } = require('express');
const { authenticate }      = require('../middleware/auth');
const { requireRole }       = require('../middleware/rbac');
const { requireEventScope } = require('../middleware/volunteerScope');
const { validate, scanSchema, lookupByEmailSchema } = require('../middleware/validate');
const checkinController = require('../controllers/checkin.controller');

const router = Router();

// ── Scan routes — eventId comes from body; scope enforced inside service ──────

router.post(
  '/scan/gate',
  authenticate,
  requireRole(['VOLUNTEER', 'ADMIN', 'HOST']),
  validate(scanSchema),
  checkinController.scanGate
);

router.post(
  '/scan/venue',
  authenticate,
  requireRole(['VOLUNTEER', 'ADMIN', 'HOST']),
  validate(scanSchema),
  checkinController.scanVenue
);

router.post(
  '/scan/lookup',
  authenticate,
  requireRole(['VOLUNTEER', 'ADMIN', 'HOST']),
  validate(scanSchema),
  checkinController.scanLookup
);

// ── Dashboard + export — eventId from URL param; requireEventScope middleware ──

// NOTE: requireEventScope reads req.params.eventId.
// The router param is named :id here; volunteerScope.js must be compatible.
// We pass it via a small adapter that copies :id → :eventId in req.params.
router.get(
  '/events/:eventId/dashboard',
  authenticate,
  requireRole(['VOLUNTEER', 'ADMIN', 'HOST']),
  requireEventScope,
  checkinController.getEventDashboard
);

router.get(
  '/events/:eventId/export',
  authenticate,
  requireRole(['VOLUNTEER', 'ADMIN', 'HOST']),
  requireEventScope,
  checkinController.exportEventCsv
);

// ── Email OTP lookup ───────────────────────────────────────────────────────────

router.post(
  '/users/lookup-by-email',
  authenticate,
  requireRole(['VOLUNTEER', 'ADMIN', 'HOST']),
  validate(lookupByEmailSchema),
  checkinController.lookupByEmail
);

module.exports = router;
