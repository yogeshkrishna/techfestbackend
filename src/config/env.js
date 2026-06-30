/**
 * src/config/env.js
 *
 * Single source of truth for all environment variables.
 * Validates required vars at startup — the process throws immediately
 * if a critical var is missing rather than failing at runtime mid-request.
 */

'use strict';

require('dotenv').config();

/**
 * Reads an env var and throws a descriptive error if it is missing/empty.
 * @param {string} key
 * @returns {string}
 */
function required(key) {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(
      `[env] Missing required environment variable: ${key}\n` +
        `  → Check your .env file against .env.example`
    );
  }
  return value;
}

/**
 * Reads an env var with a fallback default.
 * @param {string} key
 * @param {string} defaultValue
 * @returns {string}
 */
function optional(key, defaultValue) {
  return process.env[key] || defaultValue;
}

const env = {
  // Server
  PORT: parseInt(optional('PORT', '3000'), 10),
  NODE_ENV: optional('NODE_ENV', 'development'),

  // Database
  DATABASE_URL: required('DATABASE_URL'),

  // Redis
  REDIS_URL: required('REDIS_URL'),

  // JWT
  JWT_SECRET: required('JWT_SECRET'),
  JWT_EXPIRES_IN: optional('JWT_EXPIRES_IN', '7d'),

  // Razorpay
  RAZORPAY_KEY_ID: required('RAZORPAY_KEY_ID'),
  RAZORPAY_KEY_SECRET: required('RAZORPAY_KEY_SECRET'),
  RAZORPAY_WEBHOOK_SECRET: required('RAZORPAY_WEBHOOK_SECRET'),

  // SMTP (Nodemailer)
  SMTP_HOST: required('SMTP_HOST'),
  SMTP_PORT: parseInt(required('SMTP_PORT'), 10),
  SMTP_USER: required('SMTP_USER'),
  SMTP_PASS: required('SMTP_PASS'),
  SMTP_FROM: optional('SMTP_FROM', 'noreply@techfest.example.com'),

  // QR / HMAC
  QR_HMAC_SECRET: required('QR_HMAC_SECRET'),
};

module.exports = env;
