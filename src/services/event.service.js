/**
 * src/services/event.service.js
 *
 * Event management service.
 * Implements Architectural Decisions #3, #7.
 *
 * Lifecycle transition matrix (Decision #7 — forward-only, no skipping):
 *   OPEN → REGISTRATION_CLOSED → ONGOING → COMPLETED
 *
 * Redis seat key format: event:{eventId}:seatsRemaining
 *   Phase 4 registration uses DECR on this key atomically.
 *
 * Edit policy:
 *   Edits are allowed for OPEN, REGISTRATION_CLOSED, ONGOING.
 *   COMPLETED events are immutable (403 EVENT_COMPLETED_IMMUTABLE).
 */

'use strict';

const prisma  = require('../config/prisma');
const redis   = require('../config/redis');
const audit   = require('./audit.service');
const { AppError } = require('../middleware/errorHandler');

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/**
 * Legal forward-only lifecycle transitions.
 * Key = current state, Value = array of valid next states.
 */
const VALID_TRANSITIONS = {
  OPEN:                ['REGISTRATION_CLOSED'],
  REGISTRATION_CLOSED: ['ONGOING'],
  ONGOING:             ['COMPLETED'],
  COMPLETED:           [],
};

/**
 * States in which the event is open for registration/cancellation.
 * Phase 4 registration endpoint will check this.
 *
 * PHASE 4 HOOK: Import REGISTRATION_OPEN_STATES in registration.service.js
 * and verify event.lifecycleState is in this set before accepting registrations.
 */
const REGISTRATION_OPEN_STATES = new Set(['OPEN']);

/**
 * States from which the event can be edited.
 */
const EDITABLE_STATES = new Set(['OPEN', 'REGISTRATION_CLOSED', 'ONGOING']);

/**
 * Redis key for an event's seat counter.
 * @param {string} eventId
 * @returns {string}
 */
const seatKey = (eventId) => `event:${eventId}:seatsRemaining`;

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Reads seatsRemaining from Redis, falls back to Postgres value.
 *
 * @param {string} eventId
 * @param {number} pgFallback  Value from the Postgres row
 * @returns {Promise<number>}
 */
async function getSeatsFromRedis(eventId, pgFallback) {
  try {
    const val = await redis.get(seatKey(eventId));
    if (val !== null) return parseInt(val, 10);
  } catch (err) {
    console.warn(`[event.service] Redis read failed for ${seatKey(eventId)}, using PG fallback:`, err.message);
  }
  return pgFallback;
}

/**
 * Sanitizes an event row for API response.
 * Replaces seatsRemaining with the Redis value if available.
 *
 * @param {object} event       Prisma Event row
 * @param {number} [redisSeats] Seat count from Redis (if already fetched)
 * @returns {object}
 */
function sanitizeEvent(event, redisSeats) {
  return {
    id:             event.id,
    name:           event.name,
    description:    event.description,
    eventDate:      event.eventDate,
    timeslotStart:  event.timeslotStart,
    timeslotEnd:    event.timeslotEnd,
    venue:          event.venue,
    costPerPerson:  event.costPerPerson,
    totalSeats:     event.totalSeats,
    seatsRemaining: redisSeats ?? event.seatsRemaining,
    lifecycleState: event.lifecycleState,
    createdById:    event.createdById,
    createdAt:      event.createdAt,
    updatedAt:      event.updatedAt,
  };
}

// ─────────────────────────────────────────────
// Public service functions
// ─────────────────────────────────────────────

/**
 * Creates a new event and seeds the Redis seat counter.
 *
 * @param {object} data
 * @param {string} data.name
 * @param {string} data.description
 * @param {string|Date} data.eventDate
 * @param {string|Date} data.timeslotStart
 * @param {string|Date} data.timeslotEnd
 * @param {string} data.venue
 * @param {number|string} data.costPerPerson
 * @param {number} data.totalSeats
 * @param {string} createdById   Actor's user ID
 * @param {string} actorRole
 * @returns {Promise<object>}  Created event (sanitized)
 */
async function createEvent(data, createdById, actorRole) {
  const { name, description, eventDate, timeslotStart, timeslotEnd, venue, costPerPerson, totalSeats } = data;

  // Validate logical time ordering
  if (new Date(timeslotStart) >= new Date(timeslotEnd)) {
    throw new AppError(422, 'INVALID_TIMESLOT', 'timeslotStart must be before timeslotEnd.');
  }

  const event = await prisma.event.create({
    data: {
      name,
      description,
      eventDate:     new Date(eventDate),
      timeslotStart: new Date(timeslotStart),
      timeslotEnd:   new Date(timeslotEnd),
      venue,
      costPerPerson,
      totalSeats,
      seatsRemaining: totalSeats,
      lifecycleState: 'OPEN',
      createdById,
    },
  });

  // Seed Redis seat counter (Decision #3)
  try {
    await redis.set(seatKey(event.id), totalSeats);
  } catch (err) {
    console.error(`[event.service] Failed to seed Redis seat counter for event ${event.id}:`, err.message);
    // Do not fail the request — Postgres is canonical; Redis will be seeded on next read
  }

  await audit.log({
    actorId:    createdById,
    actorRole,
    action:     'EVENT_CREATED',
    targetType: 'Event',
    targetId:   event.id,
    metadata:   { name, totalSeats, venue, eventDate },
  });

  return sanitizeEvent(event, totalSeats);
}

/**
 * Updates mutable event fields.
 * Blocked for COMPLETED events (403 EVENT_COMPLETED_IMMUTABLE).
 * If totalSeats changes, recalculates seatsRemaining and updates Redis.
 *
 * @param {string} eventId
 * @param {object} updates  Partial event fields (at least one required)
 * @param {string} actorId
 * @param {string} actorRole
 * @returns {Promise<object>}
 */
async function updateEvent(eventId, updates, actorId, actorRole) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) {
    throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found.');
  }

  // Block edits on COMPLETED events
  if (!EDITABLE_STATES.has(event.lifecycleState)) {
    throw new AppError(
      403,
      'EVENT_COMPLETED_IMMUTABLE',
      'Completed events cannot be edited. Only lifecycle transitions forward are allowed.'
    );
  }

  // If totalSeats is changing, reconcile seatsRemaining
  let seatsRemainingUpdate;
  if (updates.totalSeats !== undefined && updates.totalSeats !== event.totalSeats) {
    const delta = updates.totalSeats - event.totalSeats;
    seatsRemainingUpdate = Math.max(0, event.seatsRemaining + delta);
    updates.seatsRemaining = seatsRemainingUpdate;
  }

  // Validate timeslot ordering if either is being updated
  const newStart = updates.timeslotStart ? new Date(updates.timeslotStart) : event.timeslotStart;
  const newEnd   = updates.timeslotEnd   ? new Date(updates.timeslotEnd)   : event.timeslotEnd;
  if (newStart >= newEnd) {
    throw new AppError(422, 'INVALID_TIMESLOT', 'timeslotStart must be before timeslotEnd.');
  }

  // Build update payload (parse dates)
  const updateData = {};
  if (updates.name)          updateData.name        = updates.name;
  if (updates.description)   updateData.description = updates.description;
  if (updates.venue)         updateData.venue        = updates.venue;
  if (updates.eventDate)     updateData.eventDate    = new Date(updates.eventDate);
  if (updates.timeslotStart) updateData.timeslotStart = new Date(updates.timeslotStart);
  if (updates.timeslotEnd)   updateData.timeslotEnd   = new Date(updates.timeslotEnd);
  if (updates.costPerPerson !== undefined) updateData.costPerPerson = updates.costPerPerson;
  if (updates.totalSeats    !== undefined) updateData.totalSeats    = updates.totalSeats;
  if (seatsRemainingUpdate  !== undefined) updateData.seatsRemaining = seatsRemainingUpdate;

  const before = {
    name: event.name, venue: event.venue, totalSeats: event.totalSeats,
    seatsRemaining: event.seatsRemaining, costPerPerson: String(event.costPerPerson),
  };

  const updated = await prisma.event.update({
    where: { id: eventId },
    data:  updateData,
  });

  // Sync Redis if seats changed
  if (seatsRemainingUpdate !== undefined) {
    try {
      await redis.set(seatKey(eventId), seatsRemainingUpdate);
    } catch (err) {
      console.error(`[event.service] Redis sync failed for event ${eventId}:`, err.message);
    }
  }

  await audit.log({
    actorId,
    actorRole,
    action:     'EVENT_UPDATED',
    targetType: 'Event',
    targetId:   eventId,
    metadata:   { before, after: updateData },
  });

  const seats = await getSeatsFromRedis(eventId, updated.seatsRemaining);
  return sanitizeEvent(updated, seats);
}

/**
 * Advances an event's lifecycle state (forward-only, no skipping).
 *
 * Valid transitions:
 *   OPEN → REGISTRATION_CLOSED → ONGOING → COMPLETED
 *
 * PHASE 4 HOOK: When state leaves OPEN (i.e. → REGISTRATION_CLOSED),
 * no new registrations or cancellations should be accepted.
 * registration.service.js must check event.lifecycleState is in
 * REGISTRATION_OPEN_STATES (exported below) before processing.
 *
 * @param {string} eventId
 * @param {string} newState  The desired next state
 * @param {string} actorId
 * @param {string} actorRole
 * @returns {Promise<object>}
 */
async function transitionLifecycle(eventId, newState, actorId, actorRole) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) {
    throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found.');
  }

  const allowed = VALID_TRANSITIONS[event.lifecycleState] ?? [];
  if (!allowed.includes(newState)) {
    throw new AppError(
      422,
      'INVALID_LIFECYCLE_TRANSITION',
      `Cannot transition from ${event.lifecycleState} to ${newState}. ` +
        (allowed.length > 0
          ? `Allowed next state(s): ${allowed.join(', ')}.`
          : `${event.lifecycleState} is the terminal state.`)
    );
  }

  const updated = await prisma.event.update({
    where: { id: eventId },
    data:  { lifecycleState: newState },
  });

  await audit.log({
    actorId,
    actorRole,
    action:     'EVENT_LIFECYCLE_CHANGED',
    targetType: 'Event',
    targetId:   eventId,
    metadata:   { previousState: event.lifecycleState, newState },
  });

  const seats = await getSeatsFromRedis(eventId, updated.seatsRemaining);
  return sanitizeEvent(updated, seats);
}

/**
 * Returns a paginated list of events.
 * - VOLUNTEER: sees only events they are assigned to
 * - ADMIN, HOST, PARTICIPANT: sees all (with optional lifecycle filter)
 *
 * seatsRemaining is read from Redis with Postgres fallback per event.
 *
 * @param {object} filters
 * @param {string} [filters.lifecycleState]  Filter by exact lifecycle state
 * @param {number} [filters.page]            1-indexed page (default 1)
 * @param {number} [filters.limit]           Items per page (default 20, max 100)
 * @param {string} actorId
 * @param {string} actorRole
 * @returns {Promise<{ items: object[], total: number, page: number, limit: number }>}
 */
async function listEvents(filters, actorId, actorRole) {
  const page  = Math.max(1, parseInt(filters.page  ?? 1,  10));
  const limit = Math.min(100, Math.max(1, parseInt(filters.limit ?? 20, 10)));
  const skip  = (page - 1) * limit;

  // Build where clause
  const where = {};
  if (filters.lifecycleState) {
    where.lifecycleState = filters.lifecycleState;
  }

  // Volunteer scoping: only show assigned events
  if (actorRole === 'VOLUNTEER') {
    const assignments = await prisma.volunteerAssignment.findMany({
      where:  { volunteerId: actorId },
      select: { eventId: true },
    });
    where.id = { in: assignments.map(a => a.eventId) };
  }

  const [events, total] = await prisma.$transaction([
    prisma.event.findMany({ where, skip, take: limit, orderBy: { eventDate: 'asc' } }),
    prisma.event.count({ where }),
  ]);

  // Enrich with Redis seat counts
  const items = await Promise.all(
    events.map(async (e) => {
      const seats = await getSeatsFromRedis(e.id, e.seatsRemaining);
      return sanitizeEvent(e, seats);
    })
  );

  return { items, total, page, limit };
}

/**
 * Returns a single event by ID with Redis-backed seatsRemaining.
 *
 * @param {string} eventId
 * @param {string} actorId
 * @param {string} actorRole
 * @returns {Promise<object>}
 */
async function getEvent(eventId, actorId, actorRole) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) {
    throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found.');
  }

  // Volunteer scope check: must be assigned to this event
  if (actorRole === 'VOLUNTEER') {
    const assignment = await prisma.volunteerAssignment.findUnique({
      where: { volunteerId_eventId: { volunteerId: actorId, eventId } },
    });
    if (!assignment) {
      throw new AppError(403, 'VOLUNTEER_NOT_ASSIGNED', 'You are not assigned to this event.');
    }
  }

  const seats = await getSeatsFromRedis(eventId, event.seatsRemaining);
  return sanitizeEvent(event, seats);
}

module.exports = {
  createEvent,
  updateEvent,
  transitionLifecycle,
  listEvents,
  getEvent,
  REGISTRATION_OPEN_STATES,
  VALID_TRANSITIONS,
  seatKey,
};
