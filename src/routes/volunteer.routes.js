/**
 * src/routes/volunteer.routes.js
 *
 * Volunteer assignment management routes.
 * These are nested under /events/:eventId for clarity.
 *
 * POST   /api/v1/events/:eventId/volunteers           — assign a user as volunteer
 * DELETE /api/v1/events/:eventId/volunteers/:userId   — remove volunteer assignment
 */

'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const volunteerController = require('../controllers/volunteer.controller');

// mergeParams allows access to :eventId from the parent router
const router = Router({ mergeParams: true });

// Assign volunteer to event — ADMIN and HOST only
router.post(
  '/:eventId/volunteers',
  authenticate,
  requireRole(['ADMIN', 'HOST']),
  volunteerController.assignVolunteer
);

// Remove volunteer from event — ADMIN and HOST only
router.delete(
  '/:eventId/volunteers/:userId',
  authenticate,
  requireRole(['ADMIN', 'HOST']),
  volunteerController.removeVolunteer
);

module.exports = router;
