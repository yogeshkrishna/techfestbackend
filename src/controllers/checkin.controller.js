/**
 * src/controllers/checkin.controller.js
 *
 * HTTP handlers for volunteer scan, dashboard, export, and email-lookup routes.
 * All business logic lives in checkin.service.js.
 */

'use strict';

const checkinService = require('../services/checkin.service');

// ─────────────────────────────────────────────
// POST /api/v1/volunteer/scan/gate
// ─────────────────────────────────────────────

/**
 * Marks a participant as arrived at the gate.
 * Body: { qrToken, eventId }
 *
 * Returns:
 *   200 — { alreadyScanned: true, message, arrivedAt, registration }
 *   200 — { alreadyScanned: false, message, arrivedAt, registration }
 *   400 — invalid QR token
 *   403 — volunteer not assigned to event
 *   404 — registration not found
 *   409 — registration not confirmed
 */
async function scanGate(req, res, next) {
  try {
    const result = await checkinService.scanGate({
      qrToken:   req.body.qrToken,
      eventId:   req.body.eventId,
      actorId:   req.user.id,
      actorRole: req.user.role,
    });
    return res.status(200).json({ data: result });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// POST /api/v1/volunteer/scan/venue
// ─────────────────────────────────────────────

/**
 * Marks a participant as checked in at the venue.
 * Requires gate arrival to have been recorded first.
 * Body: { qrToken, eventId }
 */
async function scanVenue(req, res, next) {
  try {
    const result = await checkinService.scanVenue({
      qrToken:   req.body.qrToken,
      eventId:   req.body.eventId,
      actorId:   req.user.id,
      actorRole: req.user.role,
    });
    return res.status(200).json({ data: result });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// POST /api/v1/volunteer/scan/lookup
// ─────────────────────────────────────────────

/**
 * Read-only QR lookup — returns user + registration info without any state change.
 * Body: { qrToken, eventId }
 */
async function scanLookup(req, res, next) {
  try {
    const result = await checkinService.scanLookup({
      qrToken:   req.body.qrToken,
      eventId:   req.body.eventId,
      actorId:   req.user.id,
      actorRole: req.user.role,
    });
    return res.status(200).json({ data: result });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// GET /api/v1/volunteer/events/:id/dashboard
// ─────────────────────────────────────────────

/**
 * Returns live event statistics and participant lists.
 * Scope is enforced by requireEventScope middleware (URL-param eventId).
 */
async function getEventDashboard(req, res, next) {
  try {
    const result = await checkinService.getEventDashboard(req.params.eventId);
    return res.status(200).json({ data: result });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// GET /api/v1/volunteer/events/:id/export
// ─────────────────────────────────────────────

/**
 * Streams a CSV file of all registrations for the event.
 */
async function exportEventCsv(req, res, next) {
  try {
    const { csv, filename } = await checkinService.exportEventCsv(req.params.eventId);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// POST /api/v1/volunteer/users/lookup-by-email
// ─────────────────────────────────────────────

/**
 * Two-step OTP-gated email lookup.
 *
 * Step 1 — body: { email, eventId }
 *   Sends OTP to the user's email. Returns 202 CHALLENGE_SENT.
 *
 * Step 2 — body: { email, otp, eventId }
 *   Verifies OTP. Returns user info + registration. Returns 200.
 *
 * Note: 202 is only used for step 1 (OTP sent); step 2 returns 200.
 */
async function lookupByEmail(req, res, next) {
  try {
    const result = await checkinService.lookupByEmail({
      email:     req.body.email,
      otp:       req.body.otp ?? null,
      eventId:   req.body.eventId,
      actorId:   req.user.id,
      actorRole: req.user.role,
    });

    const status = result.step === 'CHALLENGE_SENT' ? 202 : 200;
    return res.status(status).json({ data: result });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  scanGate,
  scanVenue,
  scanLookup,
  getEventDashboard,
  exportEventCsv,
  lookupByEmail,
};
