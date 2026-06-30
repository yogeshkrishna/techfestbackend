/**
 * src/routes/admin.routes.js
 *
 * ADMIN + HOST management routes.
 *
 * POST   /api/v1/admin/volunteers                         — grant VOLUNTEER + assign events
 * PATCH  /api/v1/admin/volunteers/:userId/assignments     — add/remove event assignments
 * POST   /api/v1/admin/events                             — create event
 * PATCH  /api/v1/admin/events/:eventId                    — edit event details
 * PATCH  /api/v1/admin/events/:eventId/lifecycle          — advance lifecycle state
 *
 * NOTE: There is NO delete endpoint for events — ever (Architectural Decision #7).
 */

'use strict';

const { Router } = require('express');
const { authenticate }  = require('../middleware/auth');
const { requireRole }   = require('../middleware/rbac');
const {
  validate,
  createVolunteerSchema,
  updateAssignmentsSchema,
  createEventSchema,
  updateEventSchema,
  lifecycleSchema,
} = require('../middleware/validate');
const adminController = require('../controllers/admin.controller');

const router = Router();

// All admin routes require authentication + ADMIN or HOST role
router.use(authenticate, requireRole(['ADMIN', 'HOST']));

// ── Volunteer management ──────────────────────────────────────────────────────

router.post(
  '/volunteers',
  validate(createVolunteerSchema),
  adminController.createVolunteer
);

router.patch(
  '/volunteers/:userId/assignments',
  validate(updateAssignmentsSchema),
  adminController.updateVolunteerAssignments
);

// ── Event management ──────────────────────────────────────────────────────────

// NOTE: No DELETE endpoint for events — ever (Decision #7).
router.post(
  '/events',
  validate(createEventSchema),
  adminController.createEvent
);

router.patch(
  '/events/:eventId',
  validate(updateEventSchema),
  adminController.updateEvent
);

router.patch(
  '/events/:eventId/lifecycle',
  validate(lifecycleSchema),
  adminController.transitionLifecycle
);

module.exports = router;
