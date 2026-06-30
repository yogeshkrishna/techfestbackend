/**
 * src/controllers/event.controller.js
 *
 * Public event read handlers (any authenticated user).
 *
 * Write operations (create, update, lifecycle) live in admin.controller.js
 * and are mounted under /api/v1/admin/events/*.
 *
 * IMPORTANT: There is NO deleteEvent handler — ever (Architectural Decision #7).
 */

'use strict';

const eventService = require('../services/event.service');

// ─────────────────────────────────────────────
// GET /api/v1/events
// ─────────────────────────────────────────────

/**
 * Returns a paginated list of events.
 *
 * Query params:
 *   lifecycleState  — filter by state (OPEN | REGISTRATION_CLOSED | ONGOING | COMPLETED)
 *   page            — 1-indexed page number (default 1)
 *   limit           — items per page (default 20, max 100)
 *
 * Volunteer scoping: VOLUNTEERs only see events they are assigned to.
 *
 * Responses:
 *   200 — { items, total, page, limit }
 */
async function listEvents(req, res, next) {
  try {
    const filters = {
      lifecycleState: req.query.lifecycleState,
      page:           req.query.page,
      limit:          req.query.limit,
    };
    const result = await eventService.listEvents(filters, req.user.id, req.user.role);
    return res.status(200).json({ data: result });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// GET /api/v1/events/:eventId
// ─────────────────────────────────────────────

/**
 * Returns a single event with Redis-backed seatsRemaining.
 * VOLUNTEERs must be assigned to the event, otherwise 403.
 *
 * Responses:
 *   200 — { event }
 *   403 — volunteer not assigned to this event
 *   404 — event not found
 */
async function getEvent(req, res, next) {
  try {
    const event = await eventService.getEvent(
      req.params.eventId,
      req.user.id,
      req.user.role,
    );
    return res.status(200).json({ data: { event } });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// Stubs retained for reference (moved to admin.controller)
// ─────────────────────────────────────────────

/**
 * @deprecated Use POST /api/v1/admin/events instead.
 */
async function createEvent(req, res, next) {
  return res.status(301).json({
    error: { code: 'MOVED', message: 'Use POST /api/v1/admin/events to create events.' },
  });
}

/**
 * @deprecated Use PATCH /api/v1/admin/events/:eventId instead.
 */
async function updateEvent(req, res, next) {
  return res.status(301).json({
    error: { code: 'MOVED', message: 'Use PATCH /api/v1/admin/events/:eventId to update events.' },
  });
}

/**
 * @deprecated Use PATCH /api/v1/admin/events/:eventId/lifecycle instead.
 */
async function transitionLifecycle(req, res, next) {
  return res.status(301).json({
    error: { code: 'MOVED', message: 'Use PATCH /api/v1/admin/events/:eventId/lifecycle for lifecycle changes.' },
  });
}

module.exports = {
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  transitionLifecycle,
};
