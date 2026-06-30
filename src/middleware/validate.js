/**
 * src/middleware/validate.js
 *
 * Zod-based request validation middleware factory.
 * Usage:
 *   router.post('/signup', validate(signupSchema), controller.signup)
 *
 * On failure: returns 422 VALIDATION_ERROR with field-level detail.
 */

'use strict';

const { z } = require('zod');


/**
 * Creates an Express middleware that validates req.body against a Zod schema.
 *
 * @param {import('zod').ZodSchema} schema
 * @returns {import('express').RequestHandler}
 */
function validate(schema) {
  return function validationMiddleware(req, res, next) {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        field:   issue.path.join('.'),
        message: issue.message,
      }));

      return res.status(422).json({
        error: {
          code:    'VALIDATION_ERROR',
          message: 'Request body validation failed.',
          fields:  issues,
        },
      });
    }

    // Replace req.body with the parsed (coerced + stripped) value
    req.body = result.data;
    return next();
  };
}

// ─────────────────────────────────────────────
// Auth schemas
// ─────────────────────────────────────────────

const signupSchema = z.object({
  name:        z.string().trim().min(1, 'Name is required').max(120),
  email:       z.string().trim().email('Invalid email address').toLowerCase(),
  phone:       z.string().trim().min(7, 'Phone number too short').max(20),
  institution: z.string().trim().min(1).max(200).optional(),
});

const verifySignupSchema = z.object({
  email:       z.string().trim().email('Invalid email address').toLowerCase(),
  otp:         z.string().trim().regex(/^\d{6}$/, 'OTP must be exactly 6 digits'),
  name:        z.string().trim().min(1, 'Name is required').max(120),
  phone:       z.string().trim().min(7).max(20),
  institution: z.string().trim().min(1, 'Institution is required').max(200),
});

const loginSchema = z.object({
  email: z.string().trim().email('Invalid email address').toLowerCase(),
});

const verifyLoginSchema = z.object({
  email: z.string().trim().email('Invalid email address').toLowerCase(),
  otp:   z.string().trim().regex(/^\d{6}$/, 'OTP must be exactly 6 digits'),
});

// ─────────────────────────────────────────────
// Host schemas
// ─────────────────────────────────────────────

const grantAdminSchema = z.object({
  email: z.string().trim().email('Invalid email address').toLowerCase(),
});

// ─────────────────────────────────────────────
// Admin — volunteer schemas
// ─────────────────────────────────────────────

const createVolunteerSchema = z.object({
  email:    z.string().trim().email('Invalid email address').toLowerCase(),
  eventIds: z.array(z.string().uuid('Each eventId must be a valid UUID')).nonempty('At least one eventId is required'),
});

const updateAssignmentsSchema = z
  .object({
    add:    z.array(z.string().uuid()).optional().default([]),
    remove: z.array(z.string().uuid()).optional().default([]),
  })
  .refine(
    (data) => (data.add?.length ?? 0) + (data.remove?.length ?? 0) > 0,
    { message: 'At least one eventId must be provided in add or remove.' }
  );

// ─────────────────────────────────────────────
// Admin — event schemas
// ─────────────────────────────────────────────

const createEventSchema = z.object({
  name:          z.string().trim().min(1, 'Name is required').max(200),
  description:   z.string().trim().min(1, 'Description is required').max(2000),
  eventDate:     z.string().datetime({ message: 'eventDate must be an ISO 8601 datetime string' }),
  timeslotStart: z.string().datetime({ message: 'timeslotStart must be an ISO 8601 datetime string' }),
  timeslotEnd:   z.string().datetime({ message: 'timeslotEnd must be an ISO 8601 datetime string' }),
  venue:         z.string().trim().min(1, 'Venue is required').max(300),
  costPerPerson: z.number({ invalid_type_error: 'costPerPerson must be a number' }).nonnegative('Cost cannot be negative'),
  totalSeats:    z.number({ invalid_type_error: 'totalSeats must be a number' }).int().positive('totalSeats must be a positive integer'),
});

const updateEventSchema = z
  .object({
    name:          z.string().trim().min(1).max(200).optional(),
    description:   z.string().trim().min(1).max(2000).optional(),
    eventDate:     z.string().datetime().optional(),
    timeslotStart: z.string().datetime().optional(),
    timeslotEnd:   z.string().datetime().optional(),
    venue:         z.string().trim().min(1).max(300).optional(),
    costPerPerson: z.number().nonnegative().optional(),
    totalSeats:    z.number().int().positive().optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    { message: 'At least one field must be provided for update.' }
  );

const LIFECYCLE_STATES = ['REGISTRATION_CLOSED', 'ONGOING', 'COMPLETED'];

const lifecycleSchema = z.object({
  newState: z.enum(LIFECYCLE_STATES, {
    errorMap: () => ({ message: `newState must be one of: ${LIFECYCLE_STATES.join(', ')}` }),
  }),
});

// ─────────────────────────────────────────────
// Registration schemas
// ─────────────────────────────────────────────

// On-spot manual registration: look up walk-in by email (must have verified account)
const registerManualSchema = z.object({
  email: z.string().trim().email('Invalid email address').toLowerCase(),
});

// ─────────────────────────────────────────────
// Volunteer scan schemas
// ─────────────────────────────────────────────

// Gate scan, venue scan, read-only lookup: all need qrToken + eventId
const scanSchema = z.object({
  qrToken: z.string().trim().min(1, 'qrToken is required'),
  eventId: z.string().uuid('eventId must be a valid UUID'),
});

// Email lookup by OTP — otp is optional (absent on step 1, present on step 2)
const lookupByEmailSchema = z.object({
  email:   z.string().trim().email('Invalid email address').toLowerCase(),
  eventId: z.string().uuid('eventId must be a valid UUID'),
  otp:     z.string().trim().regex(/^\d{6}$/, 'OTP must be exactly 6 digits').optional(),
});

module.exports = {
  validate,
  // Auth
  signupSchema,
  verifySignupSchema,
  loginSchema,
  verifyLoginSchema,
  // Host
  grantAdminSchema,
  // Admin — volunteers
  createVolunteerSchema,
  updateAssignmentsSchema,
  // Admin — events
  createEventSchema,
  updateEventSchema,
  lifecycleSchema,
  // Registration
  registerManualSchema,
  // Volunteer scans
  scanSchema,
  lookupByEmailSchema,
};
