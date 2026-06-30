/**
 * src/controllers/user.controller.js
 *
 * User self-service route handlers.
 */

'use strict';

const prisma = require('../config/prisma');
const { AppError } = require('../middleware/errorHandler');
const { sanitizeUser } = require('../services/auth.service');

// ─────────────────────────────────────────────
// GET /api/v1/users/me
// ─────────────────────────────────────────────

/**
 * Returns the authenticated user's own profile, including their QR token.
 *
 * QR token delivery approach: the raw `qrToken` string is returned in the
 * response body. The client is responsible for rendering it into a QR code
 * image (e.g. using a JS library like `qrcode.js`). This keeps the API
 * simple and avoids a server-side image generation dependency.
 *
 * The qrToken format is: "<userId>.<hmac-sha256-hex>"
 * Clients should pass this entire string to their QR rendering library as-is.
 *
 * Responses:
 *   200 — { user } including qrToken
 *   401 — missing or invalid JWT (handled by authenticate middleware)
 *   404 — user not found (shouldn't happen with valid JWT, but guarded)
 */
async function getMe(req, res, next) {
  try {
    // Fresh DB read — don't rely on JWT claims for suspended/role state
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });

    if (!user) {
      return next(new AppError(404, 'USER_NOT_FOUND', 'User not found.'));
    }

    return res.status(200).json({
      data: {
        user: sanitizeUser(user),
        qrTokenNote: 'Pass qrToken to a QR code rendering library (e.g. qrcode.js) to generate the scannable QR image client-side.',
      },
    });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// PATCH /api/v1/users/me
// ─────────────────────────────────────────────

/**
 * Updates mutable profile fields for the authenticated user.
 * Implemented in a later phase.
 *
 * Mutable fields: name, phone, institution
 * Immutable fields: email, role, qrToken, emailVerified
 */
async function updateMe(req, res, next) {
  return res.status(501).json({
    error: { code: 'NOT_IMPLEMENTED', message: 'Profile update is implemented in a later phase.' },
  });
}

module.exports = { getMe, updateMe };
