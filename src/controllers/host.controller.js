/**
 * src/controllers/host.controller.js
 *
 * HOST-only route handlers.
 * All business logic lives in user.service — this is a thin HTTP layer.
 */

'use strict';

const userService = require('../services/user.service');

// ─────────────────────────────────────────────
// POST /api/v1/host/admins
// ─────────────────────────────────────────────

/**
 * Grants ADMIN role to an existing verified user found by email.
 *
 * Body (Zod-validated): { email }
 *
 * Responses:
 *   200 — { user } with updated role
 *   400 — user not verified
 *   404 — user not found
 *   409 — already ADMIN or HOST
 */
async function grantAdmin(req, res, next) {
  try {
    const user = await userService.grantAdmin(req.body.email, req.user.id);
    return res.status(200).json({ data: { user } });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// DELETE /api/v1/host/admins/:userId
// ─────────────────────────────────────────────

/**
 * Revokes ADMIN role, demoting user to PARTICIPANT.
 *
 * Responses:
 *   200 — { user } with updated role
 *   403 — trying to demote HOST
 *   404 — user not found
 *   409 — user is not ADMIN
 */
async function revokeAdmin(req, res, next) {
  try {
    const user = await userService.revokeAdmin(req.params.userId, req.user.id);
    return res.status(200).json({ data: { user } });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// POST /api/v1/host/users/:userId/suspend
// ─────────────────────────────────────────────

/**
 * Suspends a user account.
 *
 * Responses:
 *   200 — { user } with suspended: true
 *   403 — trying to suspend HOST
 *   404 — user not found
 *   409 — already suspended
 */
async function suspendUser(req, res, next) {
  try {
    const user = await userService.suspendUser(req.params.userId, req.user.id);
    return res.status(200).json({ data: { user } });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// POST /api/v1/host/users/:userId/unsuspend
// ─────────────────────────────────────────────

/**
 * Unsuspends a user account.
 *
 * Responses:
 *   200 — { user } with suspended: false
 *   404 — user not found
 *   409 — not currently suspended
 */
async function unsuspendUser(req, res, next) {
  try {
    const user = await userService.unsuspendUser(req.params.userId, req.user.id);
    return res.status(200).json({ data: { user } });
  } catch (err) {
    return next(err);
  }
}

module.exports = { grantAdmin, revokeAdmin, suspendUser, unsuspendUser };
