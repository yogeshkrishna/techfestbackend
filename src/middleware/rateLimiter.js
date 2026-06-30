/**
 * src/middleware/rateLimiter.js
 *
 * Rate limiting middleware — Phase 7 hardening pass.
 *
 * All limiters use a Redis-backed store (rate-limit-redis@4 + ioredis) so that
 * counters are shared across multiple Node.js instances behind a load balancer.
 * If Redis is temporarily unavailable, the limiter fails OPEN (requests pass
 * through) rather than taking down the entire API.
 *
 * ── Limiter inventory ────────────────────────────────────────────────────────
 *
 *   signupLoginLimiter   POST /auth/signup, /auth/login
 *                        5 req / 15 min per IP
 *                        Prevents OTP spam from a single host.
 *
 *   emailLimiter         POST /auth/signup, /auth/login (applied alongside above)
 *                        3 req / 15 min per email address
 *                        Prevents flooding a specific person's inbox.
 *                        Key: req.body.email (falls back to IP if absent).
 *
 *   verifyLimiter        POST /auth/verify-signup, /auth/verify-login
 *                        10 req / 15 min per IP
 *                        Secondary protection — primary cap is auth.service's
 *                        5-attempt-per-OTP-session brute-force guard.
 *
 *   registrationLimiter  POST /events/:id/register
 *                        10 req / 1 min per authenticated user
 *                        Blunts retry storms during a registration-opening spike.
 *                        Idempotent retries don't consume a seat, but they do
 *                        cost DB reads; this cap keeps that load bounded.
 *                        Key: req.user.id (set by authenticate middleware).
 *
 *   apiLimiter           All /api/v1/* routes (global)
 *                        300 req / 15 min per IP
 *                        Catch-all baseline; specific limiters above are tighter.
 *
 * ── SCALE.md context ─────────────────────────────────────────────────────────
 * 2,000 unique students registering in 60s means 2,000 distinct user IDs, each
 * hitting the registrationLimiter once. That's well within limits (10/min/user).
 * The Redis Lua script is the real concurrency guard — rate limiting here is
 * defence-in-depth against abusive clients, not the primary seat-allocation mechanism.
 */

'use strict';

const rateLimit            = require('express-rate-limit');
const { RedisStore }       = require('rate-limit-redis');
const redis                = require('../config/redis');

// ─────────────────────────────────────────────
// Shared Redis store factory
// ─────────────────────────────────────────────

/**
 * Creates a rate-limit-redis store backed by the existing ioredis singleton.
 *
 * Fails open: if Redis is unreachable, sendCommand throws. express-rate-limit
 * catches store errors and calls next() by default, so requests still pass
 * through. The server won't 500 just because the rate-limit store is down.
 *
 * @param {string} [prefix]  Key prefix (default 'rl:')
 * @returns {RedisStore}
 */
function makeStore(prefix = 'rl:') {
  return new RedisStore({
    sendCommand: (...args) => redis.call(...args),
    prefix,
  });
}

// ─────────────────────────────────────────────
// OTP request limiters (per-IP + per-email)
// ─────────────────────────────────────────────

/**
 * Per-IP limiter for OTP request endpoints.
 * Applied to POST /auth/signup and POST /auth/login.
 */
const signupLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max:      5,                  // 5 OTP requests per IP per window
  standardHeaders: true,
  legacyHeaders:   false,
  store: makeStore('rl:signup_login_ip:'),
  message: {
    error: {
      code:    'RATE_LIMIT_EXCEEDED',
      message: 'Too many OTP requests from this IP. Please wait 15 minutes and try again.',
    },
  },
});

/**
 * Per-email limiter for OTP request endpoints.
 * Prevents a malicious actor from flooding another user's inbox.
 * Applied alongside signupLoginLimiter on the same routes.
 *
 * Key: req.body.email (body is parsed before middleware runs).
 * Falls back to IP if email is absent (pre-validation error case).
 */
const emailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      3,                  // 3 OTPs per email per 15 min
  standardHeaders: true,
  legacyHeaders:   false,
  store: makeStore('rl:signup_login_email:'),
  keyGenerator: (req) => {
    const email = req.body?.email;
    return typeof email === 'string' && email.length > 0
      ? `email:${email.toLowerCase().trim()}`
      : `ip:${req.ip}`;
  },
  message: {
    error: {
      code:    'EMAIL_RATE_LIMIT_EXCEEDED',
      message: 'Too many OTP requests for this email address. Please wait 15 minutes.',
    },
  },
});

// ─────────────────────────────────────────────
// OTP verify limiter (per-IP)
// ─────────────────────────────────────────────

/**
 * Per-IP rate limiter for OTP verification endpoints.
 * Applied to POST /auth/verify-signup and POST /auth/verify-login.
 *
 * Note: auth.service already enforces a 5-attempt cap per OTP session
 * (tracked in the EmailOtp.attempts column). This limiter is defence-in-depth
 * against attackers who repeatedly request fresh OTPs and retry from one IP.
 */
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  standardHeaders: true,
  legacyHeaders:   false,
  store: makeStore('rl:verify:'),
  message: {
    error: {
      code:    'AUTH_RATE_LIMIT_EXCEEDED',
      message: 'Too many verification attempts. Please wait 15 minutes.',
    },
  },
});

// ─────────────────────────────────────────────
// Registration limiter (per-user)
// ─────────────────────────────────────────────

/**
 * Per-user rate limiter for the self-registration endpoint.
 * Applied to POST /events/:eventId/register.
 *
 * Runs AFTER authenticate so req.user is guaranteed to be set.
 * Key is req.user.id — each user gets an independent 10 req/min budget.
 *
 * Why 10/min:  registration retries should be idempotent (Idempotency-Key),
 * so 10 attempts is far more than any legitimate single-user flow needs.
 * During a 2,000-student spike: each of the 2,000 distinct users sends 1 request,
 * well within their individual budget.
 */
const registrationLimiter = rateLimit({
  windowMs: 60 * 1000,          // 1 minute rolling window
  max:      10,                  // 10 attempts per user per minute
  standardHeaders: true,
  legacyHeaders:   false,
  store: makeStore('rl:register:'),
  keyGenerator: (req) => req.user?.id ?? req.ip,
  message: {
    error: {
      code:    'REGISTRATION_RATE_LIMIT_EXCEEDED',
      message: 'Too many registration attempts. Please wait a moment and try again.',
    },
  },
});

// ─────────────────────────────────────────────
// Global API limiter (catch-all baseline)
// ─────────────────────────────────────────────

/**
 * Catch-all limiter applied to all /api/v1/* routes in routes/index.js.
 * Provides a baseline floor; specific endpoint limiters above are tighter.
 *
 * 300 req/15 min per IP is intentionally high — on a campus network many
 * students share the same external IP (NAT). The per-endpoint limiters
 * carry the real enforcement load.
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      300,
  standardHeaders: true,
  legacyHeaders:   false,
  store: makeStore('rl:api:'),
  message: {
    error: {
      code:    'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please slow down and try again later.',
    },
  },
});

// Keep backward-compatible exports so existing imports don't break
// otpLimiter and authLimiter are now aliases for the new specific limiters
module.exports = {
  apiLimiter,
  signupLoginLimiter,
  emailLimiter,
  verifyLimiter,
  registrationLimiter,
  // Legacy aliases (used by auth.routes.js before this phase):
  otpLimiter:  signupLoginLimiter,
  authLimiter: verifyLimiter,
};
