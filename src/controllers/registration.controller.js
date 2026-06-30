/**
 * src/controllers/registration.controller.js
 *
 * HTTP handlers for registration endpoints.
 * All business logic lives in registration.service.
 */

'use strict';

const registrationService = require('../services/registration.service');

// ─────────────────────────────────────────────
// POST /api/v1/events/:eventId/register
// ─────────────────────────────────────────────

/**
 * Registers the authenticated participant for an event.
 *
 * Requires: Idempotency-Key header (enforced at service layer; 400 if missing).
 *
 * Responses:
 *   201 — { registrationId, orderId, amount, currency, seatHoldExpiresAt }
 *   200 — same structure with replayed: true (idempotent replay)
 *   400 — missing Idempotency-Key
 *   409 — already registered / event not OPEN / event full / idempotency conflict
 *   503 — Redis unavailable
 */
async function registerForEvent(req, res, next) {
  try {
    const result = await registrationService.registerForEvent({
      userId:         req.user.id,
      eventId:        req.params.eventId,
      idempotencyKey: req.idempotencyKey,
    });

    // 200 for idempotent replays, 201 for new registrations
    const status = result.replayed ? 200 : 201;
    return res.status(status).json({ data: result });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// POST /api/v1/events/:eventId/register-manual
// ─────────────────────────────────────────────

/**
 * On-spot cash registration by a volunteer or admin.
 *
 * Body (Zod-validated): { email }
 *
 * The walk-in must already have a verified account. If not, the volunteer should
 * direct them to complete OTP signup (POST /auth/signup + /auth/verify-signup) first.
 *
 * Responses:
 *   201 — { registrationId, user, status, paymentMethod, paidAmount }
 *   400 — user not verified
 *   403 — account suspended
 *   404 — user not found / event not found
 *   409 — already registered / event not OPEN / event full
 */
async function registerManual(req, res, next) {
  try {
    const result = await registrationService.registerManual({
      eventId:   req.params.eventId,
      email:     req.body.email,
      actorId:   req.user.id,
      actorRole: req.user.role,
    });
    return res.status(201).json({ data: result });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// GET /api/v1/registrations/me
// ─────────────────────────────────────────────

/**
 * Returns all registrations for the authenticated participant.
 *
 * Responses:
 *   200 — { registrations: [...] }
 */
async function getMyRegistrations(req, res, next) {
  try {
    const registrations = await registrationService.getMyRegistrations(req.user.id);
    return res.status(200).json({ data: { registrations } });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// GET /api/v1/events/:eventId/registrations
// ─────────────────────────────────────────────

/**
 * Lists registrations for a specific event (ADMIN, HOST, VOLUNTEER).
 * Volunteer scope is already enforced by requireEventScope middleware in the router.
 *
 * Query params: status (filter), page, limit
 *
 * Responses:
 *   200 — { registrations: [...], pagination: { page, limit, total } }
 */
async function listRegistrations(req, res, next) {
  try {
    const eventId = req.params.eventId;
    const page    = Math.max(1, parseInt(req.query.page  ?? '1',  10) || 1);
    const limit   = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '50', 10) || 50));
    const skip    = (page - 1) * limit;
    const statusFilter = req.query.status;

    const validStatuses = ['PENDING_PAYMENT', 'CONFIRMED', 'ARRIVED', 'CHECKED_IN', 'CANCELLED_REFUNDED'];

    const where = { eventId };
    if (statusFilter) {
      if (!validStatuses.includes(statusFilter)) {
        return res.status(422).json({
          error: { code: 'INVALID_STATUS', message: `status must be one of: ${validStatuses.join(', ')}` },
        });
      }
      where.status = statusFilter;
    }

    const prisma = require('../config/prisma');

    const [total, registrations] = await Promise.all([
      prisma.registration.count({ where }),
      prisma.registration.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true, phone: true, institution: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    const items = registrations.map(r => ({
      registrationId: r.id,
      status:         r.status,
      paymentMethod:  r.paymentMethod,
      paidAmount:     Number(r.paidAmount),
      arrivedAt:      r.arrivedAt,
      checkedInAt:    r.checkedInAt,
      createdAt:      r.createdAt,
      user: r.user
        ? { id: r.user.id, name: r.user.name, email: r.user.email, phone: r.user.phone, institution: r.user.institution }
        : undefined,
    }));

    return res.status(200).json({
      data: {
        registrations: items,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────
// PATCH /api/v1/registrations/:registrationId/cancel
// ─────────────────────────────────────────────

/**
 * Cancels a registration and triggers 50% refund (Decision #5).
 * Stub — Phase 5.
 */
async function cancelRegistration(req, res, next) {
  try {
    const result = await registrationService.cancelRegistration(
      req.params.registrationId,
      req.user.id,
      req.user.role
    );
    return res.status(200).json({ data: result });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  registerForEvent,
  registerManual,
  getMyRegistrations,
  listRegistrations,
  cancelRegistration,
};
