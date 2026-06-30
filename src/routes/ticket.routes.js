/**
 * src/routes/ticket.routes.js
 *
 * Ticket / QR routes — Phase 4.
 *
 * GET  /api/v1/tickets/me        — participant's QR token + active ticket list
 * GET  /api/v1/tickets/me/pdf    — downloadable PDF ticket for one registration
 *
 * Both routes are PARTICIPANT-only.
 * Phase 5 adds volunteer-facing check-in routes that call resolveQrToken()
 * from qr.service.js.
 */

'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { requireRole }  = require('../middleware/rbac');
const ticketController = require('../controllers/ticket.controller');

const router = Router();

// Participant QR + ticket list
router.get(
  '/tickets/me',
  authenticate,
  requireRole(['PARTICIPANT']),
  ticketController.getMyTickets
);

// PDF ticket download — ?registrationId=... or ?eventId=...
router.get(
  '/tickets/me/pdf',
  authenticate,
  requireRole(['PARTICIPANT']),
  ticketController.downloadTicketPdf
);

module.exports = router;
