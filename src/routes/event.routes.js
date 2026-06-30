/**
 * src/routes/event.routes.js
 *
 * Event CRUD and lifecycle routes.
 *
 * POST   /api/v1/events                         — create event (ADMIN, HOST)
 * GET    /api/v1/events                         — list events (any authenticated)
 * GET    /api/v1/events/:eventId                — get single event (any authenticated)
 * PATCH  /api/v1/events/:eventId                — update event details (ADMIN, HOST)
 * PATCH  /api/v1/events/:eventId/lifecycle      — advance lifecycle state (ADMIN, HOST)
 *
 * NOTE: There is NO delete endpoint for events — ever (Architectural Decision #7).
 */

'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const eventController = require('../controllers/event.controller');

const router = Router();

// Create event — ADMIN and HOST only
router.post(
  '/',
  authenticate,
  requireRole(['ADMIN', 'HOST']),
  eventController.createEvent
);

// List and fetch events — any authenticated user
router.get('/',          authenticate, eventController.listEvents);
router.get('/:eventId',  authenticate, eventController.getEvent);

// Update event details — ADMIN and HOST only
router.patch(
  '/:eventId',
  authenticate,
  requireRole(['ADMIN', 'HOST']),
  eventController.updateEvent
);

// Lifecycle state transition — ADMIN and HOST only
// Valid transitions: OPEN → REGISTRATION_CLOSED → ONGOING → COMPLETED
router.patch(
  '/:eventId/lifecycle',
  authenticate,
  requireRole(['ADMIN', 'HOST']),
  eventController.transitionLifecycle
);

module.exports = router;
