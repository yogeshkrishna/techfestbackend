/**
 * src/services/qr.service.js
 *
 * QR token generation service.
 * Architectural Decision #1: QR token is generated ONCE at signup, NEVER regenerated.
 */

'use strict';

const crypto = require('crypto');
const env = require('../config/env');

/**
 * Generates an HMAC-signed QR token for a given user ID.
 *
 * Format: "<userId>.<hmac-sha256-hex-signature>"
 *
 * The token encodes the user's ID in the payload and is signed with
 * QR_HMAC_SECRET so that:
 *   1. Scanners can verify authenticity without a DB hit.
 *   2. The userId is extractable from the token without decryption.
 *
 * This is the CANONICAL implementation. The seed script (prisma/seed.js)
 * replicates this exact algorithm. Keep them in sync.
 *
 * @param {string} userId  UUID of the user
 * @returns {string}  QR token string — embed this in the QR code image
 */
function generateQrToken(userId) {
  const hmac = crypto.createHmac('sha256', env.QR_HMAC_SECRET);
  hmac.update(userId);
  const signature = hmac.digest('hex');
  return `${userId}.${signature}`;
}

/**
 * Verifies a QR token and returns the embedded userId if valid.
 *
 * @param {string} token  The scanned QR token string
 * @returns {{ valid: boolean, userId: string | null }}
 */
function verifyQrToken(token) {
  if (!token || !token.includes('.')) {
    return { valid: false, userId: null };
  }

  const dotIndex = token.indexOf('.');
  const userId = token.substring(0, dotIndex);
  const receivedSignature = token.substring(dotIndex + 1);

  // Recompute expected signature
  const hmac = crypto.createHmac('sha256', env.QR_HMAC_SECRET);
  hmac.update(userId);
  const expectedSignature = hmac.digest('hex');

  // Timing-safe comparison to prevent timing attacks
  const sigBuffer = Buffer.from(receivedSignature, 'hex');
  const expBuffer = Buffer.from(expectedSignature, 'hex');

  if (sigBuffer.length !== expBuffer.length) {
    return { valid: false, userId: null };
  }

  const isValid = crypto.timingSafeEqual(sigBuffer, expBuffer);
  return { valid: isValid, userId: isValid ? userId : null };
}

/**
 * Resolves a scanned QR token to a userId, throwing an AppError on failure.
 *
 * Intended for use by Phase 5 check-in routes and any server-side code that
 * scans a QR token and needs a clean error (not a null return) on invalid input.
 *
 * Compared to verifyQrToken (which returns { valid, userId }):
 *   - resolveQrToken throws AppError(400, 'INVALID_QR_TOKEN') on any failure
 *   - Returns userId string directly on success
 *
 * This is the function Phase 5 volunteer check-in routes should call.
 *
 * @param {string} token  The raw QR token string (from scanner)
 * @returns {string}  userId
 * @throws {AppError}  If token is missing, malformed, or signature is invalid
 */
function resolveQrToken(token) {
  const { AppError } = require('../middleware/errorHandler');
  const result = verifyQrToken(token);
  if (!result.valid) {
    throw new AppError(
      400,
      'INVALID_QR_TOKEN',
      'QR token is invalid or has been tampered with.'
    );
  }
  return result.userId;
}

module.exports = { generateQrToken, verifyQrToken, resolveQrToken };
