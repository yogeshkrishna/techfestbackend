/**
 * src/services/auth.service.js
 *
 * Full authentication service implementation.
 * Handles signup, login, OTP lifecycle, JWT issuance, institution detection.
 *
 * Architectural decisions enforced here:
 *   - Decision #1: qrToken generated ONCE at signup via qr.service, never regenerated
 *   - Decision #6: email OTP only — phone is stored but never used for auth
 */

'use strict';

const crypto   = require('crypto');
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const prisma         = require('../config/prisma');
const env            = require('../config/env');
const { generateQrToken } = require('./qr.service');
const emailService   = require('./email.service');
const audit          = require('./audit.service');
const COLLEGE_DOMAINS = require('../data/college-domains');
const { AppError }   = require('../middleware/errorHandler');

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const OTP_EXPIRY_MINUTES  = 10;
const OTP_MAX_ATTEMPTS    = 5;
const BCRYPT_ROUNDS       = 10;

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Generates a cryptographically random 6-digit OTP string.
 * Uses crypto.randomInt to avoid modulo bias.
 *
 * @returns {string}  Zero-padded 6-digit string e.g. "042891"
 */
function generateOtp() {
  // randomInt(min, max) — max is exclusive, so 999999 → at most 999999
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, '0');
}

/**
 * Returns a Date object OTP_EXPIRY_MINUTES from now.
 * @returns {Date}
 */
function otpExpiry() {
  return new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
}

/**
 * Extracts the domain part of an email address (lowercased).
 * @param {string} email
 * @returns {string}
 */
function emailDomain(email) {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

/**
 * Sanitizes a User object for safe API responses.
 * Returns only fields appropriate for the client to receive.
 *
 * @param {object} user  Prisma User row
 * @returns {object}
 */
function sanitizeUser(user) {
  return {
    id:           user.id,
    name:         user.name,
    email:        user.email,
    phone:        user.phone,
    institution:  user.institution,
    role:         user.role,
    emailVerified: user.emailVerified,
    qrToken:      user.qrToken,   // intentionally included — needed by client to render QR
    suspended:    user.suspended,
    createdAt:    user.createdAt,
  };
}

// ─────────────────────────────────────────────
// Institution auto-detect
// ─────────────────────────────────────────────

/**
 * Checks if the email domain maps to a known institution.
 *
 * @param {string} email
 * @returns {{ detected: boolean, suggestedInstitution: string | null }}
 */
function detectInstitution(email) {
  const domain = emailDomain(email);
  const match  = COLLEGE_DOMAINS[domain] ?? null;
  return {
    detected:             match !== null,
    suggestedInstitution: match,
  };
}

// ─────────────────────────────────────────────
// OTP helpers
// ─────────────────────────────────────────────

/**
 * Deletes any existing OTP records for (email, purpose).
 * Used before creating a fresh OTP to prevent pile-up.
 *
 * @param {string} email
 * @param {'SIGNUP'|'LOGIN'} purpose
 */
async function clearExistingOtps(email, purpose) {
  await prisma.emailOtp.deleteMany({
    where: { email, purpose },
  });
}

/**
 * Creates a new OTP record in the DB after hashing the plaintext OTP.
 *
 * @param {string} email
 * @param {string} otp         Plaintext 6-digit OTP
 * @param {'SIGNUP'|'LOGIN'} purpose
 * @returns {Promise<void>}
 */
async function createOtpRecord(email, otp, purpose) {
  const otpHash  = await bcrypt.hash(otp, BCRYPT_ROUNDS);
  const expiresAt = otpExpiry();

  await prisma.emailOtp.create({
    data: { email, otpHash, purpose, expiresAt, attempts: 0 },
  });
}

/**
 * Finds the most recent valid OTP record for (email, purpose).
 * Returns null if none exist.
 *
 * @param {string} email
 * @param {'SIGNUP'|'LOGIN'} purpose
 * @returns {Promise<object|null>}
 */
async function findOtpRecord(email, purpose) {
  // Get the most recently created record (handles edge case of multiple rows)
  return prisma.emailOtp.findFirst({
    where: { email, purpose },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Verifies a plaintext OTP against a stored record.
 * Handles attempt counting, expiry checks, and deletion on success.
 *
 * @param {object}  record      Prisma EmailOtp row
 * @param {string}  otp         Plaintext OTP from user
 * @param {'SIGNUP'|'LOGIN'} purpose  For error messaging
 * @throws {AppError} on any verification failure
 */
async function verifyOtpRecord(record, otp, purpose) {
  // 1. Brute-force cap — check BEFORE comparing (don't give another try)
  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    throw new AppError(
      429,
      'OTP_MAX_ATTEMPTS',
      `Too many incorrect attempts. Please request a new OTP.`
    );
  }

  // 2. Expiry check
  if (new Date() > record.expiresAt) {
    throw new AppError(
      400,
      'OTP_EXPIRED',
      'This OTP has expired. Please request a new one.'
    );
  }

  // 3. Hash comparison
  const isMatch = await bcrypt.compare(otp, record.otpHash);
  if (!isMatch) {
    // Increment attempts counter
    await prisma.emailOtp.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });

    const remaining = OTP_MAX_ATTEMPTS - (record.attempts + 1);
    throw new AppError(
      400,
      'OTP_INVALID',
      remaining > 0
        ? `Incorrect OTP. ${remaining} attempt(s) remaining.`
        : `Incorrect OTP. No attempts remaining — please request a new OTP.`
    );
  }
  // On success, do NOT delete here — caller does it inside a transaction
}

// ─────────────────────────────────────────────
// JWT
// ─────────────────────────────────────────────

/**
 * Issues a signed JWT for a user.
 * Payload: { sub: userId, role }
 *
 * @param {{ id: string, role: string }} user
 * @returns {string}
 */
function issueJwt(user) {
  return jwt.sign(
    { sub: user.id, role: user.role },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN }
  );
}

// ─────────────────────────────────────────────
// Public service functions
// ─────────────────────────────────────────────

/**
 * Step 1 of signup: validates there's no existing verified user, sends OTP.
 *
 * Edge cases handled:
 *   - Existing verified user → 409 EMAIL_ALREADY_REGISTERED
 *   - Pending OTP already exists → overwritten (fresh OTP sent)
 *
 * @param {object} params
 * @param {string} params.name
 * @param {string} params.email
 * @param {string} params.phone
 * @param {string|undefined} params.institution  Optional — may be auto-detected
 * @returns {Promise<{ message: string, institutionDetected: boolean, suggestedInstitution: string|null }>}
 */
async function initiateSignup({ name, email, phone, institution }) {
  // 1. Check for an existing verified account
  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true, emailVerified: true },
  });

  if (existingUser && existingUser.emailVerified) {
    throw new AppError(
      409,
      'EMAIL_ALREADY_REGISTERED',
      'An account with this email already exists. Please log in instead.'
    );
  }

  // 2. Detect institution from email domain
  const { detected, suggestedInstitution } = detectInstitution(email);

  // 3. Clear any old SIGNUP OTPs for this email (overwrite pattern)
  await clearExistingOtps(email, 'SIGNUP');

  // 4. Generate and store OTP
  const otp = generateOtp();
  await createOtpRecord(email, otp, 'SIGNUP');

  // 5. Send email — name stored in session via OTP context; pass it for greeting
  await emailService.sendOtpEmail(email, otp, 'SIGNUP', { name });

  return {
    message: 'OTP sent to your email address. Please verify within 10 minutes.',
    institutionDetected:  detected,
    suggestedInstitution: suggestedInstitution,
  };
}

/**
 * Step 2 of signup: verifies OTP and creates the User row atomically.
 *
 * Edge cases handled:
 *   - No pending OTP → 400 OTP_NOT_FOUND
 *   - Max attempts exceeded → 429 OTP_MAX_ATTEMPTS
 *   - Expired OTP → 400 OTP_EXPIRED
 *   - Wrong OTP → 400 OTP_INVALID (with remaining count)
 *   - Race condition (user created between OTP send and verify) → 409
 *
 * @param {object} params
 * @param {string} params.email
 * @param {string} params.otp       Plaintext 6-digit OTP
 * @param {string} params.name      Captured from signup step (passed from controller)
 * @param {string} params.phone     Captured from signup step
 * @param {string} params.institution  Final value chosen by user (may override suggestion)
 * @returns {Promise<{ token: string, user: object }>}
 */
async function verifySignup({ email, otp, name, phone, institution }) {
  // 1. Find pending OTP record
  const record = await findOtpRecord(email, 'SIGNUP');
  if (!record) {
    throw new AppError(
      400,
      'OTP_NOT_FOUND',
      'No pending signup OTP found for this email. Please start the signup process again.'
    );
  }

  // 2. Verify OTP (throws on failure)
  await verifyOtpRecord(record, otp, 'SIGNUP');

  // 3. Create user + delete OTP atomically
  let user;
  try {
    const userId  = uuidv4();
    const qrToken = generateQrToken(userId);

    user = await prisma.$transaction(async (tx) => {
      // Race-condition guard: check again inside transaction
      const alreadyExists = await tx.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (alreadyExists) {
        throw new AppError(
          409,
          'EMAIL_ALREADY_REGISTERED',
          'An account with this email was created during verification. Please log in.'
        );
      }

      const created = await tx.user.create({
        data: {
          id:           userId,
          name,
          email,
          phone,
          institution,
          role:          'PARTICIPANT',
          emailVerified: true,
          qrToken,
          suspended:     false,
        },
      });

      await tx.emailOtp.delete({ where: { id: record.id } });

      return created;
    });
  } catch (err) {
    // Re-throw AppError from inside transaction
    if (err instanceof AppError) throw err;
    // Prisma unique constraint (P2002) — race condition
    if (err.code === 'P2002') {
      throw new AppError(
        409,
        'EMAIL_ALREADY_REGISTERED',
        'An account with this email already exists. Please log in instead.'
      );
    }
    throw err;
  }

  // 4. Audit log
  await audit.log({
    actorId:    user.id,
    actorRole:  'PARTICIPANT',
    action:     'USER_SIGNUP',
    targetType: 'User',
    targetId:   user.id,
    metadata:   { email: user.email, institution: user.institution },
  });

  // 5. Issue JWT and return
  const token = issueJwt(user);
  return { token, user: sanitizeUser(user) };
}

/**
 * Step 1 of login: sends OTP if the user exists and is verified.
 *
 * Edge cases handled:
 *   - Non-existent email → generic response (no leak)
 *   - Suspended user → generic response at this stage (revealed at verifyLogin)
 *   - Existing LOGIN OTP → overwritten with fresh one
 *
 * @param {string} email
 * @returns {Promise<{ message: string }>}
 */
async function initiateLogin(email) {
  const GENERIC_RESPONSE = {
    message: "If this email is registered, you'll receive a login code shortly.",
  };

  // Look up verified user — do not reveal if not found
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, emailVerified: true, suspended: true, name: true },
  });

  // Return generic response for non-existent or unverified accounts
  if (!user || !user.emailVerified) {
    return GENERIC_RESPONSE;
  }

  // Also return generic if suspended — actual 403 is at verifyLogin
  // (We still send an OTP so timing analysis can't distinguish suspended vs active)
  await clearExistingOtps(email, 'LOGIN');
  const otp = generateOtp();
  await createOtpRecord(email, otp, 'LOGIN');
  await emailService.sendOtpEmail(email, otp, 'LOGIN', { name: user.name });

  return GENERIC_RESPONSE;
}

/**
 * Step 2 of login: verifies OTP and issues JWT.
 *
 * Edge cases handled:
 *   - No pending OTP → 400 OTP_NOT_FOUND
 *   - Max attempts → 429
 *   - Expired OTP → 400
 *   - Wrong OTP → 400 with remaining count
 *   - Suspended user → 403 ACCOUNT_SUSPENDED (clear message here)
 *
 * @param {string} email
 * @param {string} otp  Plaintext 6-digit OTP
 * @returns {Promise<{ token: string, user: object }>}
 */
async function verifyLogin(email, otp) {
  // 1. Find pending LOGIN OTP
  const record = await findOtpRecord(email, 'LOGIN');
  if (!record) {
    throw new AppError(
      400,
      'OTP_NOT_FOUND',
      'No pending login OTP found for this email. Please request a new login code.'
    );
  }

  // 2. Verify OTP (throws on failure)
  await verifyOtpRecord(record, otp, 'LOGIN');

  // 3. Load user
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Shouldn't happen if login flow is followed correctly — guard anyway
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  }

  // 4. Suspended check — clear 403 revealed AFTER OTP is proven
  if (user.suspended) {
    // Delete the OTP so it can't be reused after discovering suspension
    await prisma.emailOtp.delete({ where: { id: record.id } }).catch(() => {});
    throw new AppError(
      403,
      'ACCOUNT_SUSPENDED',
      'Your account has been suspended. Please contact the organizers for assistance.'
    );
  }

  // 5. Delete OTP record
  await prisma.emailOtp.delete({ where: { id: record.id } });

  // 6. Audit log
  await audit.log({
    actorId:    user.id,
    actorRole:  user.role,
    action:     'USER_LOGIN',
    targetType: 'User',
    targetId:   user.id,
    metadata:   { email: user.email },
  });

  // 7. Issue JWT
  const token = issueJwt(user);
  return { token, user: sanitizeUser(user) };
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

module.exports = {
  detectInstitution,
  initiateSignup,
  verifySignup,
  initiateLogin,
  verifyLogin,
  issueJwt,
  sanitizeUser,
};
