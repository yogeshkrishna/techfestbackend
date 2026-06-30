/**
 * src/services/ticket.service.js
 *
 * Ticket / QR layer service — Phase 4.
 *
 * Provides:
 *   getMyTickets(userId)         — returns qrToken, base64 QR image, and active registrations
 *   generateTicketPdf(userId, query) — produces a PDF download for one registration
 *
 * QR token format (from qr.service.js):
 *   "<userId>.<hmac-sha256-hex>"
 *
 * The token is stored once on User.qrToken at signup (Decision #1).
 * It is never regenerated.
 */

'use strict';

const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');

const prisma = require('../config/prisma');
const { AppError } = require('../middleware/errorHandler');

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/** Registration statuses that represent an active/valid ticket. */
const TICKET_STATUSES = ['CONFIRMED', 'ARRIVED', 'CHECKED_IN'];

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Generates a base64-encoded PNG QR code image for a given token string.
 *
 * @param {string} token  The raw qrToken string to encode
 * @returns {Promise<string>}  Data URL: "data:image/png;base64,..."
 */
async function tokenToQrDataUrl(token) {
  return QRCode.toDataURL(token, {
    errorCorrectionLevel: 'H',   // High — resilient to damage/partial obstruction
    margin: 2,
    width:  400,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}

/**
 * Formats a Date for display in the PDF.
 * @param {Date|null} d
 * @returns {string}
 */
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric',
  });
}

/**
 * Formats a time for display in the PDF.
 * @param {Date|null} d
 * @returns {string}
 */
function fmtTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

// ─────────────────────────────────────────────
// Public service functions
// ─────────────────────────────────────────────

/**
 * Returns the user's QR token, a base64 QR image, and their active tickets.
 *
 * "Active ticket" = a Registration with status CONFIRMED, ARRIVED, or CHECKED_IN.
 *
 * @param {string} userId
 * @returns {Promise<{
 *   qrToken: string,
 *   qrImageDataUrl: string,
 *   tickets: object[]
 * }>}
 */
async function getMyTickets(userId) {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { id: true, name: true, email: true, institution: true, qrToken: true },
  });

  if (!user || !user.qrToken) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found or QR token not generated.');
  }

  // Generate QR image from the token
  const qrImageDataUrl = await tokenToQrDataUrl(user.qrToken);

  // Load all active ticket registrations
  const registrations = await prisma.registration.findMany({
    where: {
      userId,
      status: { in: TICKET_STATUSES },
    },
    include: {
      event: {
        select: {
          id:             true,
          name:           true,
          description:    true,
          eventDate:      true,
          timeslotStart:  true,
          timeslotEnd:    true,
          venue:          true,
          costPerPerson:  true,
          lifecycleState: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const tickets = registrations.map(r => ({
    registrationId: r.id,
    status:         r.status,
    paymentMethod:  r.paymentMethod,
    paidAmount:     Number(r.paidAmount),
    arrivedAt:      r.arrivedAt,
    checkedInAt:    r.checkedInAt,
    event:          r.event,
  }));

  return {
    qrToken:        user.qrToken,
    qrImageDataUrl, // "data:image/png;base64,..." — render directly in browser
    tickets,
  };
}

/**
 * Generates a branded PDF ticket for a single registration.
 *
 * The caller must pass either registrationId or eventId (not both).
 * Validates that the user has an active ticket for that registration.
 *
 * Returns a PDFDocument stream — the controller pipes it to the response.
 *
 * @param {string} userId
 * @param {object} query
 * @param {string} [query.registrationId]
 * @param {string} [query.eventId]
 * @returns {Promise<{ doc: PDFDocument, filename: string }>}
 */
async function generateTicketPdf(userId, { registrationId, eventId }) {
  if (!registrationId && !eventId) {
    throw new AppError(400, 'MISSING_QUERY', 'Provide either registrationId or eventId as a query parameter.');
  }

  // 1. Find the registration
  const where = registrationId
    ? { id: registrationId, userId }
    : { userId, eventId, status: { in: TICKET_STATUSES } };

  const registration = await prisma.registration.findFirst({
    where,
    include: {
      event: {
        select: {
          id:            true,
          name:          true,
          description:   true,
          eventDate:     true,
          timeslotStart: true,
          timeslotEnd:   true,
          venue:         true,
          costPerPerson: true,
        },
      },
    },
  });

  if (!registration) {
    throw new AppError(403, 'TICKET_NOT_FOUND', 'You do not have an active ticket for this event.');
  }

  // 2. Verify the registration status is active
  if (!TICKET_STATUSES.includes(registration.status)) {
    throw new AppError(403, 'TICKET_NOT_ACTIVE', `Registration status is ${registration.status} — no ticket issued.`);
  }

  // 3. Load the user's QR token
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { name: true, email: true, institution: true, qrToken: true },
  });

  if (!user?.qrToken) {
    throw new AppError(500, 'QR_TOKEN_MISSING', 'QR token not found for this user.');
  }

  // 4. Generate QR image as PNG buffer
  const qrPngBuffer = await QRCode.toBuffer(user.qrToken, {
    errorCorrectionLevel: 'H',
    margin: 2,
    width:  220,
    color: { dark: '#1a1a2e', light: '#FFFFFF' },
  });

  // 5. Build the PDF
  const event    = registration.event;
  const doc      = new PDFDocument({ size: 'A4', margin: 50 });
  const filename = `ticket-${event.name.replace(/\s+/g, '-').toLowerCase()}.pdf`;

  // ── Header ────────────────────────────────────────────────────────────────
  doc
    .fontSize(26)
    .fillColor('#1a1a2e')
    .font('Helvetica-Bold')
    .text('🎟  EVENT TICKET', { align: 'center' });

  doc
    .moveDown(0.5)
    .moveTo(50, doc.y)
    .lineTo(545, doc.y)
    .strokeColor('#cccccc')
    .stroke();

  // ── Event details ─────────────────────────────────────────────────────────
  doc.moveDown(1);

  doc
    .fontSize(20)
    .fillColor('#1a1a2e')
    .font('Helvetica-Bold')
    .text(event.name, { align: 'left' });

  doc.moveDown(0.4);

  const detailY = doc.y;

  // Left column — event info
  doc
    .fontSize(11)
    .font('Helvetica')
    .fillColor('#444444');

  const details = [
    ['Date',  fmtDate(event.eventDate)],
    ['Time',  `${fmtTime(event.timeslotStart)} – ${fmtTime(event.timeslotEnd)}`],
    ['Venue', event.venue],
    ['', ''],
    ['Participant', user.name],
    ['Institution', user.institution || '—'],
    ['Email',       user.email],
    ['', ''],
    ['Status',       registration.status],
    ['Payment',      `${registration.paymentMethod} — ₹${Number(registration.paidAmount).toFixed(2)}`],
    ['Booking ID',   registration.id],
  ];

  const colX = 50;
  let   rowY = detailY;

  for (const [label, value] of details) {
    if (!label && !value) { rowY += 8; continue; }
    doc
      .font('Helvetica-Bold')
      .fillColor('#1a1a2e')
      .text(`${label}:`, colX, rowY, { width: 110, continued: false });
    doc
      .font('Helvetica')
      .fillColor('#444444')
      .text(value, colX + 115, rowY - doc.currentLineHeight(true), { width: 260 });
    rowY += doc.currentLineHeight(true) + 4;
  }

  // ── QR code ───────────────────────────────────────────────────────────────
  const qrX = 380;
  const qrY = detailY - 5;

  doc.image(qrPngBuffer, qrX, qrY, { width: 150, height: 150 });

  doc
    .fontSize(8)
    .fillColor('#888888')
    .font('Helvetica')
    .text('Scan at entry', qrX, qrY + 155, { width: 150, align: 'center' });

  // ── Divider + footer ──────────────────────────────────────────────────────
  const footerY = Math.max(rowY, qrY + 175) + 20;

  doc
    .moveTo(50, footerY)
    .lineTo(545, footerY)
    .strokeColor('#cccccc')
    .stroke();

  doc
    .moveDown(0.5)
    .fontSize(9)
    .fillColor('#aaaaaa')
    .font('Helvetica-Oblique')
    .text(
      'This is an official ticket. Please present this QR code at the venue entry. ' +
      'Do not share — this QR is unique to your account.',
      { align: 'center' }
    );

  // NOTE: doc.end() is intentionally NOT called here.
  // The caller (ticket.controller.downloadTicketPdf) pipes the doc to the HTTP
  // response and then calls doc.end(). PDFKit requires pipe() to be set up
  // before end() is called, so this ordering is mandatory.

  return { doc, filename };
}

module.exports = { getMyTickets, generateTicketPdf };
