/**
 * src/controllers/ticket.controller.js
 *
 * HTTP handlers for the ticket/QR layer — Phase 4.
 */

'use strict';

const ticketService = require('../services/ticket.service');

// ─────────────────────────────────────────────
// GET /api/v1/tickets/me
// ─────────────────────────────────────────────

/**
 * Returns the authenticated participant's QR token, a rendered QR image,
 * and their list of active tickets (CONFIRMED/ARRIVED/CHECKED_IN registrations).
 *
 * The qrImageDataUrl is a "data:image/png;base64,..." string — clients can
 * embed it directly in an <img> tag to show the scannable QR code.
 *
 * Responses:
 *   200 — { qrToken, qrImageDataUrl, tickets: [...] }
 *   401 — not authenticated
 *   404 — user not found (shouldn't happen with valid JWT)
 */
async function getMyTickets(req, res, next) {
  try {
    const result = await ticketService.getMyTickets(req.user.id);
    return res.status(200).json({ data: result });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// GET /api/v1/tickets/me/pdf
// ─────────────────────────────────────────────

/**
 * Streams a PDF ticket for one of the participant's registrations.
 *
 * Query params (exactly one required):
 *   ?registrationId=<uuid>  — look up by registration ID
 *   ?eventId=<uuid>         — look up by event ID (finds their registration for that event)
 *
 * The PDF contains:
 *   - Event name, date, time, venue
 *   - Participant name, institution, email
 *   - Registration status + booking ID
 *   - QR code image (scannable at venue entry)
 *
 * Responses:
 *   200 — application/pdf download stream
 *   400 — missing query param
 *   403 — no active ticket for this event/registration
 */
async function downloadTicketPdf(req, res, next) {
  try {
    const { doc, filename } = await ticketService.generateTicketPdf(
      req.user.id,
      {
        registrationId: req.query.registrationId,
        eventId:        req.query.eventId,
      }
    );

    // Set headers BEFORE piping — headers must be sent before the stream body.
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // IMPORTANT: pipe() must be called BEFORE doc.end() so the response stream
    // is set up to receive data. ticket.service.generateTicketPdf() intentionally
    // does NOT call doc.end() — we do it here after establishing the pipe.
    doc.pipe(res);
    doc.end();
  } catch (err) {
    return next(err);
  }
}

module.exports = { getMyTickets, downloadTicketPdf };
