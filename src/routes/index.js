/**
 * src/routes/index.js
 *
 * Root router — mounts all sub-routers under /api/v1.
 * Import and mount this in app.js via app.use('/api/v1', rootRouter).
 */

'use strict';

const { Router } = require('express');
const { apiLimiter } = require('../middleware/rateLimiter');

const authRoutes         = require('./auth.routes');
const userRoutes         = require('./user.routes');
const eventRoutes        = require('./event.routes');
const registrationRoutes = require('./registration.routes');
const paymentRoutes      = require('./payment.routes');
const volunteerRoutes    = require('./volunteer.routes');
const adminRoutes        = require('./admin.routes');
const hostRoutes         = require('./host.routes');
const ticketRoutes       = require('./ticket.routes');
const volunteerScanRoutes = require('./volunteer-scan.routes');
const auditRoutes        = require('./audit.routes');

// Health check dependencies (imported lazily here to keep routes/index.js
// focused on routing — these are only needed for the /health endpoint)
const prisma = require('../config/prisma');
const redis  = require('../config/redis');

const router = Router();

// Apply general rate limiter to all API routes
router.use(apiLimiter);

// Health check — no auth required, no rate limit
// Checks real DB + Redis connectivity so load-balancers and README readers
// can distinguish "process is up" from "process is actually operational".
router.get('/health', async (req, res) => {
  const checks = { db: false, redis: false };
  const start  = Date.now();

  // Postgres — lightweight SELECT 1
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = true;
  } catch (err) {
    console.error('[health] Postgres check failed:', err.message);
  }

  // Redis — PING/PONG
  try {
    const pong = await redis.ping();
    checks.redis = pong === 'PONG';
  } catch (err) {
    console.error('[health] Redis check failed:', err.message);
  }

  const healthy = checks.db && checks.redis;

  return res.status(healthy ? 200 : 503).json({
    status:    healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    latencyMs: Date.now() - start,
    checks,
  });
});

// Sub-routers
router.use('/auth',          authRoutes);
router.use('/users',         userRoutes);
router.use('/events',        eventRoutes);
// Registration routes handle both /events/:id/register* and /registrations/* paths,
// so they are mounted at root level (not under a prefix) to keep URLs spec-exact.
router.use('/',              registrationRoutes);
router.use('/payments',      paymentRoutes);
router.use('/events',        volunteerRoutes);   // /events/:eventId/volunteers
router.use('/admin',         adminRoutes);
router.use('/host',          hostRoutes);
// Ticket routes handle /tickets/me and /tickets/me/pdf — mounted at root
router.use('/',              ticketRoutes);
// Volunteer check-in, scan, dashboard, and export routes
router.use('/volunteer',     volunteerScanRoutes);
// Audit logs — HOST and ADMIN only
router.use('/audit-logs',    auditRoutes);

module.exports = router;
