/**
 * src/routes/user.routes.js
 *
 * Authenticated user self-service routes.
 *
 * GET   /api/v1/users/me  — fetch own profile
 * PATCH /api/v1/users/me  — update own profile fields
 */

'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const userController = require('../controllers/user.controller');

const router = Router();

// All user routes require authentication
router.use(authenticate);

router.get('/me',   userController.getMe);
router.patch('/me', userController.updateMe);

module.exports = router;
