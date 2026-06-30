/**
 * src/middleware/idempotency.js
 *
 * Idempotency key middleware stub (Architectural Decision #8).
 *
 * Reads the client-supplied `Idempotency-Key` header and attaches it to
 * `req.idempotencyKey` for downstream controllers and services.
 *
 * PHASE 3 NOTE: This is a read-and-attach stub only. The actual idempotency
 * enforcement (cache lookup, store response, return cached on replay) will be
 * wired in Phase 3 when payment/registration endpoints are implemented.
 * The hook points are marked with TODO comments below.
 *
 * Usage (apply to any payment/registration-mutating route):
 *   router.post('/events/:eventId/register',
 *     authenticate,
 *     checkIdempotency,
 *     requireRole(['PARTICIPANT', 'VOLUNTEER']),
 *     controller
 *   );
 */

'use strict';

/**
 * Middleware: reads Idempotency-Key header and attaches it to the request.
 * Does NOT yet cache or deduplicate requests — that is Phase 3 work.
 *
 * @type {import('express').RequestHandler}
 */
async function checkIdempotency(req, res, next) {
  const key = req.headers['idempotency-key'];

  if (key) {
    // Sanitize: strip whitespace, enforce reasonable max length
    req.idempotencyKey = key.trim().substring(0, 128);

    // Phase 3 TODO: Before calling next(), check a Redis/DB cache:
    //   const cached = await redis.get(`idem:${req.idempotencyKey}`);
    //   if (cached) {
    //     const { statusCode, body } = JSON.parse(cached);
    //     return res.status(statusCode).json(body);
    //   }
    //
    // Phase 3 TODO: After response is sent, store it:
    //   res.on('finish', () => {
    //     redis.setex(`idem:${req.idempotencyKey}`, 86400, JSON.stringify({ statusCode: res.statusCode, body: responseBody }));
    //   });
  } else {
    req.idempotencyKey = null;
  }

  return next();
}

module.exports = { checkIdempotency };
