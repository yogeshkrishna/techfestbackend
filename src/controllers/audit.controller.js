/**
 * src/controllers/audit.controller.js
 *
 * HTTP handlers for AuditLog management.
 * All business logic is inline (audit logs are simple reads from a single table).
 */

'use strict';

const prisma = require('../config/prisma');

/**
 * GET /api/v1/audit-logs
 * HOST and ADMIN only.
 *
 * Query parameters (all optional):
 *   actorId     {string}   Filter by the user who performed the action
 *   targetType  {string}   Filter by entity type (e.g. 'Registration', 'Event')
 *   startDate   {string}   ISO date — logs created on or after this date
 *   endDate     {string}   ISO date — logs created on or before this date (inclusive, end of day)
 *   page        {number}   Page number, default 1
 *   limit       {number}   Records per page, default 20, max 100
 *
 * Returns: { data: { logs, pagination: { page, limit, total, totalPages } } }
 */
async function listAuditLogs(req, res, next) {
  try {
    const {
      actorId,
      targetType,
      startDate,
      endDate,
    } = req.query;

    const page  = Math.max(1, parseInt(req.query.page  ?? '1',  10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '20', 10) || 20));
    const skip  = (page - 1) * limit;

    // Build dynamic WHERE filter
    const where = {};

    if (actorId)    where.actorId    = actorId;
    if (targetType) where.targetType = targetType;

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) {
        const start = new Date(startDate);
        if (isNaN(start.getTime())) {
          return res.status(400).json({
            error: { code: 'INVALID_DATE', message: 'startDate is not a valid ISO date.' },
          });
        }
        where.createdAt.gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        if (isNaN(end.getTime())) {
          return res.status(400).json({
            error: { code: 'INVALID_DATE', message: 'endDate is not a valid ISO date.' },
          });
        }
        // Make endDate inclusive by setting it to end-of-day
        end.setUTCHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }

    // Run count + findMany concurrently
    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take:    limit,
        select: {
          id:         true,
          actorId:    true,
          actorRole:  true,
          action:     true,
          targetType: true,
          targetId:   true,
          metadata:   true,
          createdAt:  true,
        },
      }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      data: {
        logs,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { listAuditLogs };
