/**
 * src/controllers/admin.controller.js
 *
 * ADMIN + HOST route handlers for volunteer and event management.
 * All business logic lives in user.service and event.service.
 */

'use strict';

const userService  = require('../services/user.service');
const eventService = require('../services/event.service');

// ─────────────────────────────────────────────
// POST /api/v1/admin/volunteers
// ─────────────────────────────────────────────

/**
 * Promotes an existing verified user to VOLUNTEER and assigns them to events.
 *
 * Body (Zod-validated): { email, eventIds }
 *
 * Responses:
 *   201 — { user, assignments }
 *   400 — user not verified
 *   404 — user or event not found
 *   409 — role conflict
 */
async function createVolunteer(req, res, next) {
  try {
    const { email, eventIds } = req.body;
    const result = await userService.grantVolunteer({
      email,
      eventIds,
      actorId:   req.user.id,
      actorRole: req.user.role,
    });
    return res.status(201).json({ data: result });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// PATCH /api/v1/admin/volunteers/:userId/assignments
// ─────────────────────────────────────────────

/**
 * Adds or removes event assignments for an existing volunteer.
 *
 * Body (Zod-validated): { add?: string[], remove?: string[] }
 *
 * Responses:
 *   200 — { added, removed }
 *   404 — volunteer or event/assignment not found
 *   409 — user is not a volunteer
 */
async function updateVolunteerAssignments(req, res, next) {
  try {
    const { add, remove } = req.body;
    const result = await userService.updateVolunteerAssignments({
      volunteerId: req.params.userId,
      add,
      remove,
      actorId:     req.user.id,
      actorRole:   req.user.role,
    });
    return res.status(200).json({ data: result });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// POST /api/v1/admin/events
// ─────────────────────────────────────────────

/**
 * Creates a new event with lifecycleState = OPEN.
 * Seeds Redis seat counter on creation.
 *
 * Body (Zod-validated): { name, description, eventDate, timeslotStart,
 *                         timeslotEnd, venue, costPerPerson, totalSeats }
 *
 * Responses:
 *   201 — { event }
 *   422 — validation error or invalid timeslot
 */
async function createEvent(req, res, next) {
  try {
    const event = await eventService.createEvent(
      req.body,
      req.user.id,
      req.user.role,
    );
    return res.status(201).json({ data: { event } });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// PATCH /api/v1/admin/events/:eventId
// ─────────────────────────────────────────────

/**
 * Updates mutable event fields.
 * Blocked for COMPLETED events (403 EVENT_COMPLETED_IMMUTABLE).
 *
 * Body (Zod-validated): partial event fields (at least one required)
 *
 * Responses:
 *   200 — { event }
 *   403 — event is COMPLETED
 *   404 — event not found
 *   422 — invalid timeslot ordering
 */
async function updateEvent(req, res, next) {
  try {
    const event = await eventService.updateEvent(
      req.params.eventId,
      req.body,
      req.user.id,
      req.user.role,
    );
    return res.status(200).json({ data: { event } });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// PATCH /api/v1/admin/events/:eventId/lifecycle
// ─────────────────────────────────────────────

/**
 * Advances event lifecycle state (forward-only, no skipping).
 * Valid: OPEN → REGISTRATION_CLOSED → ONGOING → COMPLETED
 *
 * Body (Zod-validated): { newState }
 *
 * Responses:
 *   200 — { event } with updated lifecycleState
 *   404 — event not found
 *   422 — invalid transition
 */
async function transitionLifecycle(req, res, next) {
  try {
    const event = await eventService.transitionLifecycle(
      req.params.eventId,
      req.body.newState,
      req.user.id,
      req.user.role,
    );
    return res.status(200).json({ data: { event } });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createVolunteer,
  updateVolunteerAssignments,
  createEvent,
  updateEvent,
  transitionLifecycle,
};
