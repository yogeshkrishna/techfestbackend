/**
 * src/services/checkin.service.js
 *
 * Volunteer check-in / scan service — Phase 5.
 *
 * Implements all QR scanning, dashboard, CSV export, and email-lookup operations.
 *
 * Concurrency model (gate + venue scans):
 *   Uses prisma.registration.updateMany() with a WHERE guard on the timestamp field
 *   (arrivedAt IS NULL / checkedInAt IS NULL). Only one concurrent update wins;
 *   the other sees count=0 and returns an "already scanned" message. This is a
 *   standard conditional-update pattern — no distributed lock needed.
 *
 * Status semantics (per Phase 5 spec):
 *   - Gate scan:  sets arrivedAt = now. Status stays CONFIRMED.
 *   - Venue scan: sets checkedInAt = now. Status → CHECKED_IN.
 *   - The ARRIVED enum value exists in the schema but is not used in this flow;
 *     arrivedAt timestamp is the canonical "arrived at gate" signal.
 *
 * Volunteer scope:
 *   assertVolunteerScope() is called inside each service function (not middleware)
 *   for scan routes where eventId comes from the request body, not the URL.
 *   URL-param routes (/events/:id/dashboard, /events/:id/export) use the
 *   requireEventScope middleware in the router.
 */

'use strict';

const prisma  = require('../config/prisma');
const audit   = require('./audit.service');
const { resolveQrToken } = require('./qr.service');
const emailService       = require('./email.service');
const { AppError }  = require('../middleware/errorHandler');

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/** Statuses that represent a paid, active ticket. */
const ACTIVE_TICKET_STATUSES = ['CONFIRMED', 'CHECKED_IN'];

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Verifies that the actor is assigned to the given event.
 * ADMIN and HOST bypass this check (Decision #9).
 *
 * @param {string} actorId
 * @param {string} actorRole
 * @param {string} eventId
 * @throws {AppError} 403 if VOLUNTEER is not assigned
 */
async function assertVolunteerScope(actorId, actorRole, eventId) {
  if (actorRole === 'HOST' || actorRole === 'ADMIN') return;

  const assignment = await prisma.volunteerAssignment.findUnique({
    where: { volunteerId_eventId: { volunteerId: actorId, eventId } },
  });

  if (!assignment) {
    throw new AppError(
      403,
      'VOLUNTEER_NOT_ASSIGNED',
      'You are not assigned to this event and cannot scan or view its registrations.'
    );
  }
}

/**
 * Formats a registration row for scan response output.
 * @param {object} reg  Prisma Registration row (with user included)
 * @returns {object}
 */
function formatReg(reg) {
  return {
    registrationId: reg.id,
    status:         reg.status,
    paymentMethod:  reg.paymentMethod,
    paidAmount:     Number(reg.paidAmount),
    arrivedAt:      reg.arrivedAt,
    checkedInAt:    reg.checkedInAt,
    createdAt:      reg.createdAt,
    user: reg.user
      ? {
          id:          reg.user.id,
          name:        reg.user.name,
          email:       reg.user.email,
          phone:       reg.user.phone,
          institution: reg.user.institution,
        }
      : undefined,
  };
}

// ─────────────────────────────────────────────
// Gate scan
// ─────────────────────────────────────────────

/**
 * Marks a participant as arrived at the gate.
 *
 * Validates:
 *   - Volunteer is scoped to this event
 *   - QR token is valid (HMAC verified)
 *   - Registration exists and is CONFIRMED or CHECKED_IN
 *   - arrivedAt is not already set
 *
 * Concurrency: uses updateMany WHERE arrivedAt IS NULL.
 * If two simultaneous scans race, only one writes; the other gets a "already arrived" response.
 *
 * @param {object} params
 * @param {string} params.qrToken   Raw QR token from scanner
 * @param {string} params.eventId
 * @param {string} params.actorId   Scanning volunteer's user ID
 * @param {string} params.actorRole
 * @returns {Promise<object>}
 */
async function scanGate({ qrToken, eventId, actorId, actorRole }) {
  // 1. Scope check
  await assertVolunteerScope(actorId, actorRole, eventId);

  // 2. Verify QR token — throws AppError(400, INVALID_QR_TOKEN) on failure
  const userId = resolveQrToken(qrToken);

  // 3. Find registration
  const registration = await prisma.registration.findFirst({
    where: { userId, eventId },
    include: {
      user: { select: { id: true, name: true, email: true, phone: true, institution: true } },
    },
  });

  if (!registration) {
    throw new AppError(
      404,
      'REGISTRATION_NOT_FOUND',
      'No registration found for this QR code and event.'
    );
  }

  // 4. Validate status — must be a paid ticket
  if (!ACTIVE_TICKET_STATUSES.includes(registration.status)) {
    throw new AppError(
      409,
      'REGISTRATION_NOT_CONFIRMED',
      `Registration status is ${registration.status}. Only CONFIRMED tickets can be scanned.`
    );
  }

  // 5. Already arrived? Return informative message (not an error — help the volunteer)
  if (registration.arrivedAt) {
    return {
      alreadyScanned: true,
      message:        `Already marked as arrived at gate on ${registration.arrivedAt.toISOString()}.`,
      arrivedAt:      registration.arrivedAt,
      registration:   formatReg(registration),
    };
  }

  // 6. Atomic conditional update — only succeeds if arrivedAt IS STILL NULL
  const now    = new Date();
  const result = await prisma.registration.updateMany({
    where: { id: registration.id, arrivedAt: null },
    data:  { arrivedAt: now },
    // status intentionally left as CONFIRMED (per Phase 5 spec)
  });

  if (result.count === 0) {
    // Race condition: a concurrent scan just set arrivedAt milliseconds ago
    const fresh = await prisma.registration.findUnique({ where: { id: registration.id } });
    return {
      alreadyScanned: true,
      message:        `Concurrent scan: already arrived at gate on ${fresh?.arrivedAt?.toISOString()}.`,
      arrivedAt:      fresh?.arrivedAt,
      registration:   formatReg({ ...registration, arrivedAt: fresh?.arrivedAt }),
    };
  }

  // 7. Audit log
  await audit.log({
    actorId,
    actorRole,
    action:     'GATE_SCAN',
    targetType: 'Registration',
    targetId:   registration.id,
    metadata:   { eventId, userId, arrivedAt: now.toISOString() },
  });

  return {
    alreadyScanned: false,
    message:        'Arrival recorded. Welcome!',
    arrivedAt:      now,
    registration:   formatReg({ ...registration, arrivedAt: now }),
  };
}

// ─────────────────────────────────────────────
// Venue scan
// ─────────────────────────────────────────────

/**
 * Marks a participant as checked in at the event venue.
 *
 * Gate arrival (arrivedAt IS NOT NULL) is a hard prerequisite —
 * it matches the physical flow: participants pass gate first, then enter venue.
 *
 * Concurrency: uses updateMany WHERE checkedInAt IS NULL.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
async function scanVenue({ qrToken, eventId, actorId, actorRole }) {
  // 1. Scope check
  await assertVolunteerScope(actorId, actorRole, eventId);

  // 2. Verify QR token
  const userId = resolveQrToken(qrToken);

  // 3. Find registration
  const registration = await prisma.registration.findFirst({
    where: { userId, eventId },
    include: {
      user: { select: { id: true, name: true, email: true, phone: true, institution: true } },
    },
  });

  if (!registration) {
    throw new AppError(404, 'REGISTRATION_NOT_FOUND', 'No registration found for this QR code and event.');
  }

  if (!ACTIVE_TICKET_STATUSES.includes(registration.status) && registration.status !== 'CHECKED_IN') {
    throw new AppError(
      409,
      'REGISTRATION_NOT_CONFIRMED',
      `Registration status is ${registration.status}. Only CONFIRMED tickets can be scanned.`
    );
  }

  // 4. Gate arrival is a hard prerequisite
  if (!registration.arrivedAt) {
    throw new AppError(
      409,
      'GATE_ARRIVAL_REQUIRED',
      'Participant has not been scanned at the gate yet. Please scan at the gate first.'
    );
  }

  // 5. Already checked in?
  if (registration.checkedInAt) {
    return {
      alreadyScanned: true,
      message:        `Already checked in at venue on ${registration.checkedInAt.toISOString()}.`,
      checkedInAt:    registration.checkedInAt,
      registration:   formatReg(registration),
    };
  }

  // 6. Atomic conditional update
  const now    = new Date();
  const result = await prisma.registration.updateMany({
    where: { id: registration.id, checkedInAt: null },
    data:  { checkedInAt: now, status: 'CHECKED_IN' },
  });

  if (result.count === 0) {
    const fresh = await prisma.registration.findUnique({ where: { id: registration.id } });
    return {
      alreadyScanned: true,
      message:        `Concurrent scan: already checked in on ${fresh?.checkedInAt?.toISOString()}.`,
      checkedInAt:    fresh?.checkedInAt,
      registration:   formatReg({ ...registration, checkedInAt: fresh?.checkedInAt, status: 'CHECKED_IN' }),
    };
  }

  // 7. Audit log
  await audit.log({
    actorId,
    actorRole,
    action:     'VENUE_SCAN',
    targetType: 'Registration',
    targetId:   registration.id,
    metadata:   { eventId, userId, checkedInAt: now.toISOString() },
  });

  return {
    alreadyScanned: false,
    message:        'Venue check-in recorded. Enjoy the event!',
    checkedInAt:    now,
    registration:   formatReg({ ...registration, checkedInAt: now, status: 'CHECKED_IN' }),
  };
}

// ─────────────────────────────────────────────
// Read-only lookup
// ─────────────────────────────────────────────

/**
 * Resolves a QR token and returns the user's registration info without
 * making any state changes. For helping someone at the gate.
 *
 * For VOLUNTEERs: returns only registrations for their assigned event(s).
 * For ADMIN/HOST: returns all registrations.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
async function scanLookup({ qrToken, eventId, actorId, actorRole }) {
  // 1. Scope check
  await assertVolunteerScope(actorId, actorRole, eventId);

  // 2. Verify QR token
  const userId = resolveQrToken(qrToken);

  // 3. Load user
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { id: true, name: true, email: true, phone: true, institution: true, suspended: true },
  });

  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found for this QR token.');
  }

  // 4. Load registration for this event only
  const registration = await prisma.registration.findFirst({
    where: { userId, eventId },
    include: {
      event: { select: { id: true, name: true, timeslotStart: true, timeslotEnd: true, venue: true } },
    },
  });

  return {
    user,
    registration: registration ? formatReg(registration) : null,
    event:        registration?.event ?? null,
  };
}

// ─────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────

/**
 * Returns live event statistics and participant lists for a volunteer's dashboard.
 *
 * Scope is enforced by requireEventScope middleware (URL-param eventId).
 *
 * @param {string} eventId
 * @returns {Promise<object>}
 */
async function getEventDashboard(eventId) {
  const event = await prisma.event.findUnique({
    where:  { id: eventId },
    select: {
      id: true, name: true, venue: true, eventDate: true,
      timeslotStart: true, timeslotEnd: true,
      totalSeats: true, seatsRemaining: true, lifecycleState: true,
    },
  });

  if (!event) {
    throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found.');
  }

  const allRegistrations = await prisma.registration.findMany({
    where: {
      eventId,
      status: { in: ['CONFIRMED', 'CHECKED_IN'] },
    },
    include: {
      user: { select: { id: true, name: true, email: true, phone: true, institution: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const arrived    = allRegistrations.filter(r => r.arrivedAt !== null);
  const notArrived = allRegistrations.filter(r => r.arrivedAt === null && r.status !== 'CHECKED_IN');
  const checkedIn  = allRegistrations.filter(r => r.status === 'CHECKED_IN');

  return {
    event,
    counts: {
      totalSeats:     event.totalSeats,
      seatsRemaining: event.seatsRemaining,
      registered:     allRegistrations.length,
      arrived:        arrived.length,
      notArrived:     notArrived.length,
      checkedIn:      checkedIn.length,
    },
    lists: {
      registered:  allRegistrations.map(formatReg),
      arrived:     arrived.map(formatReg),
      notArrived:  notArrived.map(formatReg),
      checkedIn:   checkedIn.map(formatReg),
    },
  };
}

// ─────────────────────────────────────────────
// CSV Export
// ─────────────────────────────────────────────

/**
 * Builds and returns a CSV string of all registrations for an event.
 *
 * @param {string} eventId
 * @returns {Promise<{ csv: string, filename: string }>}
 */
async function exportEventCsv(eventId) {
  const data = await getEventDashboard(eventId);

  const escape = (v) => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const headers = [
    'RegistrationID', 'Status', 'Name', 'Email', 'Phone',
    'Institution', 'PaymentMethod', 'PaidAmount',
    'ArrivedAt', 'CheckedInAt', 'CreatedAt',
  ];

  const rows = data.lists.registered.map(r => [
    escape(r.registrationId),
    escape(r.status),
    escape(r.user?.name),
    escape(r.user?.email),
    escape(r.user?.phone),
    escape(r.user?.institution),
    escape(r.paymentMethod),
    escape(r.paidAmount),
    escape(r.arrivedAt ?? ''),
    escape(r.checkedInAt ?? ''),
    escape(r.createdAt ?? ''),
  ].join(','));

  const csv      = [headers.join(','), ...rows].join('\r\n');
  const filename = `event-${data.event.name.replace(/\s+/g, '-').toLowerCase()}-registrations.csv`;

  return { csv, filename };
}

// ─────────────────────────────────────────────
// Email OTP lookup
// ─────────────────────────────────────────────

/**
 * Step 1 — if called WITHOUT otp: sends a LOGIN OTP to the user's email.
 * Step 2 — if called WITH otp:    verifies OTP and returns user info + registration.
 *
 * This never issues a JWT — the volunteer is already authenticated.
 * The OTP proves the person standing at the gate owns the email address.
 *
 * @param {object} params
 * @param {string}       params.email
 * @param {string|null}  params.otp      If provided, verify and return user info
 * @param {string}       params.eventId  For scoping the returned registration info
 * @param {string}       params.actorId
 * @param {string}       params.actorRole
 * @returns {Promise<object>}
 */
async function lookupByEmail({ email, otp, eventId, actorId, actorRole }) {
  // Scope check
  await assertVolunteerScope(actorId, actorRole, eventId);

  // ── Step 1: No OTP provided — send challenge ─────────────────────────────
  if (!otp) {
    // Only send if user exists and is verified
    const user = await prisma.user.findUnique({
      where:  { email },
      select: { id: true, emailVerified: true, name: true, suspended: true },
    });

    // Generic response — don't reveal whether account exists
    if (!user || !user.emailVerified) {
      return {
        step:    'CHALLENGE_SENT',
        message: 'If this email is registered, an OTP has been sent. Ask the participant to check their email.',
      };
    }

    if (user.suspended) {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
    }

    // Reuse auth OTP infrastructure
    await clearExistingOtps(email, 'LOGIN');
    const otpValue = generateSecureOtp();
    await createOtpRecord(email, otpValue, 'LOGIN');
    await emailService.sendOtpEmail(email, otpValue, 'LOGIN', { name: user.name });

    return {
      step:    'CHALLENGE_SENT',
      message: 'OTP sent to the participant\'s email. Ask them to share it with you to continue.',
    };
  }

  // ── Step 2: OTP provided — verify and return user info ───────────────────
  const record = await findOtpRecord(email, 'LOGIN');
  if (!record) {
    throw new AppError(400, 'OTP_NOT_FOUND', 'No pending OTP for this email. Please initiate the lookup first.');
  }

  // Throws on wrong OTP / expired / max attempts
  await verifyOtpRecord(record, otp, 'LOGIN');

  // Delete OTP
  await prisma.emailOtp.delete({ where: { id: record.id } }).catch(() => {});

  // Load user + registration
  const user = await prisma.user.findUnique({
    where:  { email },
    select: {
      id: true, name: true, email: true, phone: true,
      institution: true, qrToken: true, suspended: true,
    },
  });

  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  }

  const registration = await prisma.registration.findFirst({
    where: { userId: user.id, eventId },
    include: {
      event: { select: { id: true, name: true, timeslotStart: true, timeslotEnd: true, venue: true } },
    },
  });

  await audit.log({
    actorId,
    actorRole,
    action:     'VOLUNTEER_EMAIL_LOOKUP',
    targetType: 'User',
    targetId:   user.id,
    metadata:   { email, eventId, method: 'OTP_VERIFIED' },
  });

  return {
    step:         'VERIFIED',
    user:         { id: user.id, name: user.name, email: user.email, phone: user.phone, institution: user.institution, qrToken: user.qrToken },
    registration: registration ? formatReg(registration) : null,
    event:        registration?.event ?? null,
  };
}

// ─────────────────────────────────────────────
// Internal helpers (re-used from auth.service)
// We can't import these directly without circular deps, so use local copies
// ─────────────────────────────────────────────

const crypto = require('crypto');
const bcrypt  = require('bcrypt');

function generateSecureOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

// These are small re-implementations to avoid a circular dependency on auth.service.
// auth.service → email.service, this service → email.service: no cycle.
// auth.service → prisma, this service → prisma: no cycle.
// The risk of divergence is low since the logic is trivial.
async function clearExistingOtps(email, purpose) {
  await prisma.emailOtp.deleteMany({ where: { email, purpose } });
}

async function createOtpRecord(email, otp, purpose) {
  const otpHash   = await bcrypt.hash(otp, 10);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await prisma.emailOtp.create({ data: { email, otpHash, purpose, expiresAt, attempts: 0 } });
}

async function findOtpRecord(email, purpose) {
  return prisma.emailOtp.findFirst({
    where:   { email, purpose },
    orderBy: { createdAt: 'desc' },
  });
}

const OTP_MAX_ATTEMPTS = 5;

async function verifyOtpRecord(record, otp) {
  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    throw new AppError(429, 'OTP_MAX_ATTEMPTS', 'Too many incorrect attempts. Please request a new OTP.');
  }
  if (new Date() > record.expiresAt) {
    throw new AppError(400, 'OTP_EXPIRED', 'This OTP has expired. Please request a new one.');
  }
  const isMatch = await bcrypt.compare(otp, record.otpHash);
  if (!isMatch) {
    await prisma.emailOtp.update({
      where: { id: record.id },
      data:  { attempts: { increment: 1 } },
    });
    const remaining = OTP_MAX_ATTEMPTS - (record.attempts + 1);
    throw new AppError(
      400,
      'OTP_INVALID',
      remaining > 0
        ? `Incorrect OTP. ${remaining} attempt(s) remaining.`
        : 'Incorrect OTP. No attempts remaining — please request a new OTP.'
    );
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
