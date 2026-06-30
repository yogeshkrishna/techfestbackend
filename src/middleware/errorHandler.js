/**
 * src/middleware/errorHandler.js
 *
 * Provides:
 *  - AppError: typed error class for intentional HTTP errors
 *  - notFound:  catches unmatched routes → 404
 *  - errorHandler: global Express error handler — MUST be the last middleware
 *                  registered via app.use()
 *
 * All errors are normalised to:
 *  {
 *    "error": {
 *      "code":    "SNAKE_CASE_CODE",
 *      "message": "Human-readable description"
 *    }
 *  }
 */

'use strict';

/**
 * Typed application error.
 * Throw this (or pass to next()) anywhere in the app for a controlled HTTP error.
 *
 * @example
 *   throw new AppError(404, 'EVENT_NOT_FOUND', 'Event does not exist');
 *   next(new AppError(403, 'FORBIDDEN', 'Insufficient permissions'));
 */
class AppError extends Error {
  /**
   * @param {number} statusCode  HTTP status code (e.g. 400, 401, 403, 404, 409, 422, 500)
   * @param {string} code        Snake-case error identifier (e.g. 'EVENT_NOT_FOUND')
   * @param {string} message     Human-readable message
   * @param {object} [meta]      Optional extra context (not exposed in production responses)
   */
  constructor(statusCode, code, message, meta = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.meta = meta;

    // Maintains proper prototype chain in ES5 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * 404 middleware — catches requests that didn't match any route.
 * Must be mounted AFTER all routers, BEFORE errorHandler.
 *
 * @type {import('express').RequestHandler}
 */
function notFound(req, res, next) {
  next(
    new AppError(
      404,
      'ROUTE_NOT_FOUND',
      `Cannot ${req.method} ${req.originalUrl}`
    )
  );
}

/**
 * Global error handler.
 * Must be mounted LAST via app.use() — after all routers and notFound.
 *
 * @type {import('express').ErrorRequestHandler}
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const isDev = process.env.NODE_ENV === 'development';

  // Log all unexpected errors (not intentional AppErrors) at error level
  if (!(err instanceof AppError)) {
    console.error('[errorHandler] Unhandled error:', err);
  }

  // Prisma known error codes → friendly HTTP responses
  if (err.code === 'P2002') {
    // Unique constraint violation
    return res.status(409).json({
      error: {
        code: 'CONFLICT',
        message: 'A record with this value already exists.',
        ...(isDev && { field: err.meta?.target }),
      },
    });
  }

  if (err.code === 'P2025') {
    // Record not found (e.g. update/delete on non-existent record)
    return res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested record does not exist.',
      },
    });
  }

  const statusCode = err instanceof AppError ? err.statusCode : 500;
  const code =
    err instanceof AppError ? err.code : 'INTERNAL_SERVER_ERROR';
  const message =
    err instanceof AppError || isDev
      ? err.message
      : 'An unexpected error occurred. Please try again later.';

  return res.status(statusCode).json({
    error: {
      code,
      message,
      // Include stack only in development
      ...(isDev && !(err instanceof AppError) && { stack: err.stack }),
    },
  });
}

module.exports = { AppError, notFound, errorHandler };
