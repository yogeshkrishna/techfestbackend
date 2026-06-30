/**
 * src/middleware/volunteerScope.js
 *
 * Volunteer event-scope guard (Architectural Decision #9).
 *
 * Enforces that a VOLUNTEER can only act on events they are explicitly
 * assigned to via the VolunteerAssignment table.
 *
 * HOST and ADMIN bypass this check entirely.
 *
 * Usage:
 *   router.get('/:eventId/registrations',
 *     authenticate,
 *     requireRole(['ADMIN', 'HOST', 'VOLUNTEER']),
 *     requireEventScope,   // ← add after requireRole on volunteer-accessible routes
 *     controller
 *   );
 *
 * Expects:
 *   - req.user.id and req.user.role (set by authenticate middleware)
 *   - req.params.eventId (must be a route parameter on the matched route)
 */

'use strict';

const prisma = require('../config/prisma');
const { AppError } = require('./errorHandler');

/**
 * Middleware: rejects VOLUNTEER requests for events they are not assigned to.
 * HOST and ADMIN pass through unconditionally.
 *
 * @type {import('express').RequestHandler}
 */
async function requireEventScope(req, res, next) {
  try {
    if (!req.user) {
      return next(
        new AppError(401, 'UNAUTHENTICATED', 'Authentication required.')
      );
    }

    const { id: userId, role } = req.user;

    // HOST and ADMIN are not event-scoped
    if (role === 'HOST' || role === 'ADMIN') {
      return next();
    }

    // Only apply scoping to VOLUNTEERs
    if (role !== 'VOLUNTEER') {
      // PARTICIPANT should not be reaching volunteer-guarded routes
      return next(
        new AppError(403, 'FORBIDDEN', 'Access denied.')
      );
    }

    const eventId = req.params.eventId;
    if (!eventId) {
      // Developer error: guard mounted on a route without :eventId param
      throw new Error(
        '[requireEventScope] Route must have an :eventId param. ' +
          `Route: ${req.route?.path}`
      );
    }

    const assignment = await prisma.volunteerAssignment.findUnique({
      where: {
        volunteerId_eventId: {
          volunteerId: userId,
          eventId,
        },
      },
    });

    if (!assignment) {
      return next(
        new AppError(
          403,
          'VOLUNTEER_NOT_ASSIGNED',
          'You are not assigned to this event.'
        )
      );
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireEventScope };
