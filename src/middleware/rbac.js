/**
 * src/middleware/rbac.js
 *
 * Role-Based Access Control middleware factory.
 *
 * Usage:
 *   router.patch('/events/:id/lifecycle', authenticate, requireRole(['ADMIN', 'HOST']), controller);
 *
 * The HOST role is implicitly included in every role check — HOST can do everything.
 * Explicitly pass 'HOST' in the roles array if you want to restrict to HOST-only.
 */

'use strict';

const { AppError } = require('./errorHandler');

/**
 * Returns an Express middleware that enforces role-based access control.
 *
 * @param {Array<'HOST'|'ADMIN'|'VOLUNTEER'|'PARTICIPANT'>} allowedRoles
 *   Roles permitted to access the route. HOST always passes, regardless of this list,
 *   unless you are intentionally building a HOST-exclusive route — in which case
 *   pass only ['HOST'] to make that intent explicit.
 * @returns {import('express').RequestHandler}
 */
function requireRole(allowedRoles) {
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) {
    throw new Error('[requireRole] allowedRoles must be a non-empty array');
  }

  return function roleGuard(req, res, next) {
    if (!req.user) {
      // authenticate() middleware must run before requireRole()
      return next(
        new AppError(401, 'UNAUTHENTICATED', 'Authentication required.')
      );
    }

    const { role } = req.user;

    // HOST bypasses all role checks — HOST is the superuser
    if (role === 'HOST') return next();

    if (!allowedRoles.includes(role)) {
      return next(
        new AppError(
          403,
          'FORBIDDEN',
          `Access denied. Required role(s): ${allowedRoles.join(', ')}.`
        )
      );
    }

    return next();
  };
}

module.exports = { requireRole };
