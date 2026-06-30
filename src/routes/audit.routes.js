/**
 * src/routes/audit.routes.js
 *
 * Audit log routes — HOST and ADMIN only.
 *
 * GET /api/v1/audit-logs   — list audit logs with optional filters + pagination
 */

'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { requireRole }  = require('../middleware/rbac');
const auditController  = require('../controllers/audit.controller');

const router = Router();

router.get(
  '/',
  authenticate,
  requireRole(['HOST', 'ADMIN']),
  auditController.listAuditLogs
);

module.exports = router;
