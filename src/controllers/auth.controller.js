/**
 * src/controllers/auth.controller.js
 *
 * Auth route handlers — thin layer between HTTP and auth.service.
 * All business logic lives in the service; controllers only handle
 * HTTP concerns (status codes, response shaping, error delegation).
 */

'use strict';

const authService = require('../services/auth.service');

// ─────────────────────────────────────────────
// POST /api/v1/auth/signup
// ─────────────────────────────────────────────

/**
 * Initiates the signup flow by sending an OTP to the supplied email.
 *
 * Body (Zod-validated upstream):
 *   { name, email, phone, institution? }
 *
 * Responses:
 *   202 — OTP sent; includes institution auto-detect suggestion
 *   409 — email already registered
 *   422 — validation error
 */
async function signup(req, res, next) {
  try {
    const { name, email, phone, institution } = req.body;
    const result = await authService.initiateSignup({ name, email, phone, institution });

    return res.status(202).json({
      data: {
        message:              result.message,
        institutionDetected:  result.institutionDetected,
        suggestedInstitution: result.suggestedInstitution,
      },
    });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// POST /api/v1/auth/verify-signup
// ─────────────────────────────────────────────

/**
 * Verifies the signup OTP, creates the User record, and returns a JWT.
 *
 * Body (Zod-validated upstream):
 *   { email, otp, name, phone, institution }
 *
 * The client re-submits name/phone/institution from the signup step so we don't
 * need server-side session storage between signup and verify-signup.
 *
 * Responses:
 *   201 — user created; { token, user }
 *   400 — OTP not found, expired, or invalid
 *   409 — email taken (race condition)
 *   422 — validation error
 *   429 — max OTP attempts exceeded
 */
async function verifySignup(req, res, next) {
  try {
    const { email, otp, name, phone, institution } = req.body;
    const { token, user } = await authService.verifySignup({
      email,
      otp,
      name,
      phone,
      institution,
    });

    return res.status(201).json({
      data: { token, user },
    });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// POST /api/v1/auth/login
// ─────────────────────────────────────────────

/**
 * Initiates the login flow by sending an OTP.
 * Always returns the same generic response regardless of whether the
 * email exists — intentional: do not leak which emails are registered.
 *
 * Body (Zod-validated upstream):
 *   { email }
 *
 * Responses:
 *   200 — generic "if registered, you'll get an OTP" message
 *   422 — validation error
 */
async function login(req, res, next) {
  try {
    const { email } = req.body;
    const result = await authService.initiateLogin(email);

    return res.status(200).json({ data: result });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// POST /api/v1/auth/verify-login
// ─────────────────────────────────────────────

/**
 * Verifies the login OTP and returns a JWT.
 *
 * Body (Zod-validated upstream):
 *   { email, otp }
 *
 * Responses:
 *   200 — { token, user }
 *   400 — OTP not found, expired, or invalid
 *   403 — account suspended (revealed here, after OTP is proven)
 *   422 — validation error
 *   429 — max OTP attempts exceeded
 */
async function verifyLogin(req, res, next) {
  try {
    const { email, otp } = req.body;
    const { token, user } = await authService.verifyLogin(email, otp);

    return res.status(200).json({ data: { token, user } });
  } catch (err) {
    return next(err);
  }
}

module.exports = { signup, verifySignup, login, verifyLogin };
