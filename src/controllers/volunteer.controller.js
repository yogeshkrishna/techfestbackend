/**
 * src/controllers/volunteer.controller.js
 *
 * Stub handlers for volunteer assignment management.
 * Business logic is implemented in Phase 3.
 */

'use strict';

/**
 * POST /api/v1/events/:eventId/volunteers
 * Body: { userId: string }
 *
 * Phase 3:
 *  1. Verify target user exists and has role VOLUNTEER
 *  2. Create VolunteerAssignment (unique constraint prevents duplicates)
 *  3. Create AuditLog entry
 */
async function assignVolunteer(req, res, next) {
  return res.status(501).json({
    error: { code: 'NOT_IMPLEMENTED', message: 'Volunteer logic is implemented in Phase 3.' },
  });
}

/**
 * DELETE /api/v1/events/:eventId/volunteers/:userId
 *
 * Phase 3:
 *  1. Verify assignment exists
 *  2. Delete VolunteerAssignment record
 *  3. Create AuditLog entry
 */
async function removeVolunteer(req, res, next) {
  return res.status(501).json({
    error: { code: 'NOT_IMPLEMENTED', message: 'Volunteer logic is implemented in Phase 3.' },
  });
}

module.exports = { assignVolunteer, removeVolunteer };
