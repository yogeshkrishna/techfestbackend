/**
 * src/services/user.service.js
 *
 * User role management and suspension service.
 * Called by host.controller.js and admin.controller.js.
 *
 * Role promotion approach (documented decision):
 *   The target user MUST already exist as a verified PARTICIPANT or VOLUNTEER.
 *   HOST looks them up by email, verifies they exist and are verified, then
 *   promotes their role. No placeholder/invite system — consistent with the
 *   OTP-only auth model (everyone self-registers first).
 */

'use strict';

const prisma  = require('../config/prisma');
const audit   = require('./audit.service');
const { AppError } = require('../middleware/errorHandler');

// ─────────────────────────────────────────────
// Host-only: Admin management
// ─────────────────────────────────────────────

/**
 * Grants ADMIN role to an existing verified user found by email.
 * Target must be a verified PARTICIPANT or VOLUNTEER — not already ADMIN or HOST.
 *
 * Edge cases:
 *   - Email not found               → 404 USER_NOT_FOUND
 *   - Email found but not verified  → 400 USER_NOT_VERIFIED
 *   - Already ADMIN or HOST         → 409 ALREADY_ADMIN
 *
 * @param {string} email    Email of the user to promote
 * @param {string} actorId  HOST user ID
 * @returns {Promise<object>} Updated user record (sanitized)
 */
async function grantAdmin(email, actorId) {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', `No account found for email: ${email}`);
  }
  if (!user.emailVerified) {
    throw new AppError(400, 'USER_NOT_VERIFIED', 'User has not completed email verification.');
  }
  if (user.role === 'ADMIN' || user.role === 'HOST') {
    throw new AppError(409, 'ALREADY_ADMIN', `User already has role: ${user.role}`);
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data:  { role: 'ADMIN' },
  });

  await audit.log({
    actorId,
    actorRole:  'HOST',
    action:     'ADMIN_GRANTED',
    targetType: 'User',
    targetId:   user.id,
    metadata:   { email: user.email, previousRole: user.role, newRole: 'ADMIN' },
  });

  return sanitizeUser(updated);
}

/**
 * Revokes ADMIN role, demoting the user back to PARTICIPANT.
 * Target must currently be ADMIN.
 *
 * Edge cases:
 *   - userId not found   → 404 USER_NOT_FOUND
 *   - Not an ADMIN       → 409 NOT_ADMIN
 *   - Trying to demote HOST → 403 CANNOT_DEMOTE_HOST
 *
 * @param {string} targetUserId
 * @param {string} actorId  HOST user ID
 * @returns {Promise<object>}
 */
async function revokeAdmin(targetUserId, actorId) {
  const user = await prisma.user.findUnique({ where: { id: targetUserId } });

  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  }
  if (user.role === 'HOST') {
    throw new AppError(403, 'CANNOT_DEMOTE_HOST', 'The HOST account cannot be demoted.');
  }
  if (user.role !== 'ADMIN') {
    throw new AppError(409, 'NOT_ADMIN', `User's current role is ${user.role}, not ADMIN.`);
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data:  { role: 'PARTICIPANT' },
  });

  await audit.log({
    actorId,
    actorRole:  'HOST',
    action:     'ADMIN_REVOKED',
    targetType: 'User',
    targetId:   user.id,
    metadata:   { email: user.email, previousRole: 'ADMIN', newRole: 'PARTICIPANT' },
  });

  return sanitizeUser(updated);
}

// ─────────────────────────────────────────────
// Host-only: Suspend / Unsuspend
// ─────────────────────────────────────────────

/**
 * Suspends a user account. Suspended users cannot log in or register for events.
 * The HOST account itself cannot be suspended.
 *
 * @param {string} targetUserId
 * @param {string} actorId  HOST user ID
 * @returns {Promise<object>}
 */
async function suspendUser(targetUserId, actorId) {
  const user = await prisma.user.findUnique({ where: { id: targetUserId } });

  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  }
  if (user.role === 'HOST') {
    throw new AppError(403, 'CANNOT_SUSPEND_HOST', 'The HOST account cannot be suspended.');
  }
  if (user.suspended) {
    throw new AppError(409, 'ALREADY_SUSPENDED', 'User is already suspended.');
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data:  { suspended: true },
  });

  await audit.log({
    actorId,
    actorRole:  'HOST',
    action:     'USER_SUSPENDED',
    targetType: 'User',
    targetId:   user.id,
    metadata:   { email: user.email },
  });

  return sanitizeUser(updated);
}

/**
 * Unsuspends a user account.
 *
 * @param {string} targetUserId
 * @param {string} actorId  HOST user ID
 * @returns {Promise<object>}
 */
async function unsuspendUser(targetUserId, actorId) {
  const user = await prisma.user.findUnique({ where: { id: targetUserId } });

  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  }
  if (!user.suspended) {
    throw new AppError(409, 'NOT_SUSPENDED', 'User is not currently suspended.');
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data:  { suspended: false },
  });

  await audit.log({
    actorId,
    actorRole:  'HOST',
    action:     'USER_UNSUSPENDED',
    targetType: 'User',
    targetId:   user.id,
    metadata:   { email: user.email },
  });

  return sanitizeUser(updated);
}

// ─────────────────────────────────────────────
// Admin: Volunteer management
// ─────────────────────────────────────────────

/**
 * Promotes an existing verified user to VOLUNTEER and assigns them to events.
 *
 * Edge cases:
 *   - Email not found / not verified → 404 / 400
 *   - Already VOLUNTEER, ADMIN, HOST → 409 ROLE_CONFLICT
 *   - Any eventId doesn't exist      → 404 EVENT_NOT_FOUND
 *
 * @param {object} params
 * @param {string}   params.email      Email of user to promote
 * @param {string[]} params.eventIds   Events to assign the volunteer to
 * @param {string}   params.actorId
 * @param {string}   params.actorRole
 * @returns {Promise<{ user: object, assignments: object[] }>}
 */
async function grantVolunteer({ email, eventIds, actorId, actorRole }) {
  // 1. Validate target user
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', `No account found for email: ${email}`);
  }
  if (!user.emailVerified) {
    throw new AppError(400, 'USER_NOT_VERIFIED', 'User has not completed email verification.');
  }
  if (user.role === 'VOLUNTEER' || user.role === 'ADMIN' || user.role === 'HOST') {
    throw new AppError(409, 'ROLE_CONFLICT', `User already has role: ${user.role}. Cannot assign VOLUNTEER.`);
  }

  // 2. Validate all eventIds exist
  const events = await prisma.event.findMany({
    where: { id: { in: eventIds } },
    select: { id: true },
  });
  const foundIds = new Set(events.map(e => e.id));
  const missing  = eventIds.filter(id => !foundIds.has(id));
  if (missing.length > 0) {
    throw new AppError(404, 'EVENT_NOT_FOUND', `Event(s) not found: ${missing.join(', ')}`);
  }

  // 3. Promote + create assignments in one transaction
  const [updatedUser, assignments] = await prisma.$transaction(async (tx) => {
    const promoted = await tx.user.update({
      where: { id: user.id },
      data:  { role: 'VOLUNTEER' },
    });

    // Deduplicate eventIds
    const uniqueIds = [...new Set(eventIds)];
    const created   = await Promise.all(
      uniqueIds.map(eventId =>
        tx.volunteerAssignment.upsert({
          where:  { volunteerId_eventId: { volunteerId: user.id, eventId } },
          create: { volunteerId: user.id, eventId },
          update: {}, // already exists — no-op
        })
      )
    );

    return [promoted, created];
  });

  await audit.log({
    actorId,
    actorRole,
    action:     'VOLUNTEER_GRANTED',
    targetType: 'User',
    targetId:   user.id,
    metadata:   { email: user.email, previousRole: user.role, eventIds },
  });

  return { user: sanitizeUser(updatedUser), assignments };
}

/**
 * Adds or removes event assignments for an existing VOLUNTEER.
 * - `add` entries are idempotent (silently skipped if already assigned)
 * - `remove` entries return 404 if assignment doesn't exist
 *
 * @param {object} params
 * @param {string}   params.volunteerId
 * @param {string[]} [params.add]     Event IDs to add
 * @param {string[]} [params.remove]  Event IDs to remove
 * @param {string}   params.actorId
 * @param {string}   params.actorRole
 * @returns {Promise<{ added: string[], removed: string[] }>}
 */
async function updateVolunteerAssignments({ volunteerId, add = [], remove = [], actorId, actorRole }) {
  const volunteer = await prisma.user.findUnique({ where: { id: volunteerId } });
  if (!volunteer) {
    throw new AppError(404, 'USER_NOT_FOUND', 'Volunteer not found.');
  }
  if (volunteer.role !== 'VOLUNTEER') {
    throw new AppError(409, 'NOT_VOLUNTEER', `User role is ${volunteer.role}, not VOLUNTEER.`);
  }

  // Validate all add/remove event IDs exist
  const allIds = [...new Set([...add, ...remove])];
  if (allIds.length > 0) {
    const found  = await prisma.event.findMany({ where: { id: { in: allIds } }, select: { id: true } });
    const foundS = new Set(found.map(e => e.id));
    const missing = allIds.filter(id => !foundS.has(id));
    if (missing.length > 0) {
      throw new AppError(404, 'EVENT_NOT_FOUND', `Event(s) not found: ${missing.join(', ')}`);
    }
  }

  // Validate all remove IDs have existing assignments
  if (remove.length > 0) {
    const existing = await prisma.volunteerAssignment.findMany({
      where: {
        volunteerId,
        eventId: { in: remove },
      },
      select: { eventId: true },
    });
    const existingIds = new Set(existing.map(a => a.eventId));
    const notAssigned = remove.filter(id => !existingIds.has(id));
    if (notAssigned.length > 0) {
      throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', `No assignment found for event(s): ${notAssigned.join(', ')}`);
    }
  }

  await prisma.$transaction(async (tx) => {
    // Add — idempotent upsert
    if (add.length > 0) {
      await Promise.all(
        [...new Set(add)].map(eventId =>
          tx.volunteerAssignment.upsert({
            where:  { volunteerId_eventId: { volunteerId, eventId } },
            create: { volunteerId, eventId },
            update: {},
          })
        )
      );
    }
    // Remove
    if (remove.length > 0) {
      await tx.volunteerAssignment.deleteMany({
        where: { volunteerId, eventId: { in: remove } },
      });
    }
  });

  await audit.log({
    actorId,
    actorRole,
    action:     'VOLUNTEER_ASSIGNMENTS_UPDATED',
    targetType: 'User',
    targetId:   volunteerId,
    metadata:   { volunteerId, add, remove },
  });

  return { added: add, removed: remove };
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Returns a sanitized user object safe for API responses.
 * Identical to auth.service.sanitizeUser — defined here to avoid circular dep.
 *
 * @param {object} user Prisma User row
 * @returns {object}
 */
function sanitizeUser(user) {
  return {
    id:           user.id,
    name:         user.name,
    email:        user.email,
    phone:        user.phone,
    institution:  user.institution,
    role:         user.role,
    emailVerified: user.emailVerified,
    suspended:    user.suspended,
    createdAt:    user.createdAt,
  };
}

module.exports = {
  grantAdmin,
  revokeAdmin,
  suspendUser,
  unsuspendUser,
  grantVolunteer,
  updateVolunteerAssignments,
};
