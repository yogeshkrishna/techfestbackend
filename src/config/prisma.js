/**
 * src/config/prisma.js
 *
 * Exports a singleton PrismaClient instance.
 * Import this everywhere instead of calling `new PrismaClient()` directly,
 * so that only one connection pool exists for the lifetime of the process.
 *
 * ── Connection pool cap (SCALE.md rationale) ─────────────────────────────────
 * Prisma's default pool is min=2, max=cpu_count*2+1 which on even a 2-core box
 * is 5 connections, but can grow if `connection_limit` isn't set explicitly.
 *
 * On our target server (1 GB RAM, Postgres co-located):
 *   - Each Postgres backend process: ~5–15 MB RSS
 *   - 10 connections × 15 MB = 150 MB overhead
 *   - Remaining budget: Redis (~50 MB) + Node heap (~200–300 MB) + BullMQ workers
 *
 * Setting connection_limit=10 keeps memory within budget while still supporting
 * the 2,000 req/60s spike: requests queue behind the pool rather than spawning
 * unlimited Postgres backends that would OOM the server.
 *
 * If the app is moved to a dedicated DB server or larger instance, raise this.
 */

'use strict';

const { PrismaClient } = require('@prisma/client');
const env = require('./env');

/**
 * Appends `?connection_limit=N` to the DATABASE_URL if not already present.
 * This is the only reliable way to set the pool cap in code — Prisma reads
 * it from the connection string, not from a PrismaClient constructor option.
 *
 * @param {string} baseUrl
 * @param {number} limit
 * @returns {string}
 */
function cappedDatabaseUrl(baseUrl, limit = 10) {
  try {
    const url = new URL(baseUrl);
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', String(limit));
    }
    return url.toString();
  } catch {
    // Non-parseable URL (e.g. env placeholder in CI) — return as-is
    return baseUrl;
  }
}

const prisma = new PrismaClient({
  datasources: {
    db: { url: cappedDatabaseUrl(env.DATABASE_URL, 10) },
  },
  log:
    env.NODE_ENV === 'development'
      ? ['query', 'info', 'warn', 'error']
      : ['warn', 'error'],
});

module.exports = prisma;
