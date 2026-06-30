/**
 * src/app.js
 *
 * Express application factory.
 * This module creates and configures the app but does NOT start the HTTP listener.
 * The HTTP listener is started in server.js (separation of concerns allows easier testing).
 */

'use strict';

const express = require('express');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const rootRouter = require('./routes/index');

const app = express();

// ─────────────────────────────────────────────
// Body parsers
// ─────────────────────────────────────────────

// Raw body for Razorpay webhook signature verification.
// MUST be registered BEFORE express.json() for the webhook path.
// The webhook controller reads req.rawBody to verify the HMAC signature.
app.use(
  '/api/v1/payments/webhook',
  express.raw({ type: 'application/json' }),
  (req, res, next) => {
    // Store raw buffer on req for signature verification in the controller
    req.rawBody = req.body;
    // Parse JSON after storing raw so the controller can also access req.body as object
    try {
      req.body = JSON.parse(req.rawBody.toString('utf-8'));
    } catch {
      // Leave as buffer if parsing fails; webhook controller handles malformed JSON
    }
    next();
  }
);

// JSON body parser for all other routes
app.use(express.json({ limit: '10kb' }));

// ─────────────────────────────────────────────
// Security / misc headers
// ─────────────────────────────────────────────

// Disable X-Powered-By header (minor security hygiene)
app.disable('x-powered-by');

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────

app.use('/api/v1', rootRouter);

// ─────────────────────────────────────────────
// Error handling (must be LAST)
// ─────────────────────────────────────────────

app.use(notFound);      // 404 for unmatched routes
app.use(errorHandler);  // Global error normaliser

module.exports = app;
