/**
 * src/routes/auth.routes.js
 *
 * Authentication routes — email OTP only (no passwords, no SMS).
 *
 * POST /api/v1/auth/signup          — initiate signup, send OTP
 * POST /api/v1/auth/verify-signup   — verify OTP, create User, return JWT
 * POST /api/v1/auth/login           — initiate login, send OTP
 * POST /api/v1/auth/verify-login    — verify OTP, return JWT
 *
 * Rate limiting (Phase 7):
 *   OTP request (signup/login):
 *     signupLoginLimiter — 5 req/15 min per IP   (blunt per-host spam)
 *     emailLimiter       — 3 req/15 min per email (protect users' inboxes)
 *   OTP verify:
 *     verifyLimiter      — 10 req/15 min per IP  (secondary to auth.service's 5-attempt cap)
 */

'use strict';

const { Router } = require('express');
const { signupLoginLimiter, emailLimiter, verifyLimiter } = require('../middleware/rateLimiter');
const { validate, signupSchema, verifySignupSchema, loginSchema, verifyLoginSchema } = require('../middleware/validate');
const authController = require('../controllers/auth.controller');

const router = Router();

// ── Signup flow ───────────────────────────────────────────────────────────────

// Step 1: request OTP — per-IP + per-email rate limited
router.post(
  '/signup',
  signupLoginLimiter,
  emailLimiter,
  validate(signupSchema),
  authController.signup
);

// Step 2: verify OTP, create user account, receive JWT
router.post(
  '/verify-signup',
  verifyLimiter,
  validate(verifySignupSchema),
  authController.verifySignup
);

// ── Login flow ────────────────────────────────────────────────────────────────

// Step 1: request login OTP — per-IP + per-email rate limited
router.post(
  '/login',
  signupLoginLimiter,
  emailLimiter,
  validate(loginSchema),
  authController.login
);

// Step 2: verify OTP, receive JWT
router.post(
  '/verify-login',
  verifyLimiter,
  validate(verifyLoginSchema),
  authController.verifyLogin
);

module.exports = router;
