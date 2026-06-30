/**
 * src/services/audit.service.js
 *
 * Audit log service — append-only write to AuditLog table.
 * Used by all services that mutate significant state.
 */

'use strict';

const prisma = require('../config/prisma');

/**
 * Appends an entry to the AuditLog.
 * This function is intentionally fire-and-forget safe — it does not throw
 * if the audit write fails (logging errors are secondary to the main operation).
 * Use `await audit.log(...)` in critical paths where you DO want to catch failures.
 *
 * @param {object} params
 * @param {string|null}  params.actorId      User ID performing the action (null for system)
 * @param {string|null}  params.actorRole    Role at time of action (denormalized)
 * @param {string}       params.action       e.g. 'REGISTRATION_CANCELLED'
 * @param {string}       params.targetType   e.g. 'Registration', 'Event', 'User'
 * @param {string}       params.targetId     ID of the affected record
 * @param {object}       [params.metadata]   Arbitrary JSON context
 * @returns {Promise<void>}
 */
async function log({
  actorId = null,
  actorRole = null,
  action,
  targetType,
  targetId,
  metadata = {},
}) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId,
        actorRole,
        action,
        targetType,
        targetId: String(targetId),
        metadata,
      },
    });
  } catch (err) {
    // AuditLog write failure must never crash the main request.
    // Log to stderr but do not re-throw.
    console.error('[audit] Failed to write audit log entry:', {
      action,
      targetType,
      targetId,
      err: err.message,
    });
  }
}

module.exports = { log };
