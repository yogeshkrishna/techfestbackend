/**
 * src/middleware/auth.js
 *
 * JWT authentication middleware.
 *
 * Reads:  Authorization: Bearer <token>
 * Writes: req.user = { id: string, role: string }
 *
 * Returns 401 AppError on:
 *   - Missing header
 *   - Malformed token
 *   - Expired token
 *   - Invalid signature
 *
 * Returns 403 AppError on:
 *   - Suspended account (checked against DB on every request for instant effect)
 *
 * NOTE: After JWT verification, we perform a lightweight DB lookup (SELECT id,
 * suspended, role on primary key) to enforce suspension immediately rather than
 * waiting for the 7-day JWT to expire. This costs ~1 extra DB query per request
 * but is well within the capped pool budget at normal load.
 */

'use strict';

const jwt    = require('jsonwebtoken');
const prisma = require('../config/prisma');
const { AppError } = require('./errorHandler');
const env = require('../config/env');

/**
 * Middleware: verifies JWT, checks suspension, and attaches user to req.user.
 *
 * @type {import('express').RequestHandler}
 */
async function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(
      new AppError(
        401,
        'MISSING_TOKEN',
        'Authorization header is required. Format: Bearer <token>'
      )
    );
  }

  const token = authHeader.slice(7); // Remove "Bearer " prefix

  let decoded;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(
        new AppError(401, 'TOKEN_EXPIRED', 'Your session has expired. Please log in again.')
      );
    }
    if (err.name === 'JsonWebTokenError') {
      return next(
        new AppError(401, 'INVALID_TOKEN', 'The provided token is invalid.')
      );
    }
    return next(err);
  }

  // DB check — fast primary-key lookup, enforces suspension immediately.
  // This is the only place we hit the DB in the auth layer.
  try {
    const user = await prisma.user.findUnique({
      where:  { id: decoded.sub },
      select: { id: true, role: true, suspended: true },
    });

    if (!user) {
      return next(new AppError(401, 'INVALID_TOKEN', 'The account associated with this token no longer exists.'));
    }

    if (user.suspended) {
      return next(new AppError(403, 'ACCOUNT_SUSPENDED', 'Your account has been suspended. Please contact the organizers.'));
    }

    // Attach live role from DB (not stale JWT role) so role changes take effect immediately
    req.user = { id: user.id, role: user.role };
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { authenticate };
