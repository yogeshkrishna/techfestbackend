/**
 * src/routes/host.routes.js
 *
 * HOST-only management routes.
 *
 * POST   /api/v1/host/admins               — grant ADMIN role to a verified user
 * DELETE /api/v1/host/admins/:userId       — revoke ADMIN role → demote to PARTICIPANT
 * POST   /api/v1/host/users/:userId/suspend    — suspend a user account
 * POST   /api/v1/host/users/:userId/unsuspend  — unsuspend a user account
 */

'use strict';

const { Router } = require('express');
const { authenticate }  = require('../middleware/auth');
const { requireRole }   = require('../middleware/rbac');
const { validate, grantAdminSchema } = require('../middleware/validate');
const hostController    = require('../controllers/host.controller');

const router = Router();

// All host routes require authentication + HOST role
router.use(authenticate, requireRole(['HOST']));

// Admin management
router.post(   '/admins',          validate(grantAdminSchema), hostController.grantAdmin);
router.delete( '/admins/:userId',                              hostController.revokeAdmin);

// User suspension
router.post('/users/:userId/suspend',   hostController.suspendUser);
router.post('/users/:userId/unsuspend', hostController.unsuspendUser);

module.exports = router;
