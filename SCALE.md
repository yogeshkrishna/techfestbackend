# SCALE.md — Handling 2,000 Concurrent Registrations on 1 GB RAM

> **Scenario:** Registrations open Friday 6 PM. 2,000 students hit `POST /api/v1/events/:id/register` within 60 seconds. The server has 1 GB RAM with Postgres and Redis co-located on the same machine.

---

## The Core Problem

A naive implementation reads `event.seatsRemaining` from Postgres, checks if it's > 0, then decrements it in a separate UPDATE. Under concurrency:

```
Thread A: SELECT seatsRemaining = 1 ✓
Thread B: SELECT seatsRemaining = 1 ✓   ← reads before A's UPDATE commits
Thread A: UPDATE seatsRemaining = 0
Thread B: UPDATE seatsRemaining = -1    ← oversold
```

Even with `SELECT FOR UPDATE`, all 2,000 requests queue behind a DB lock — turning the registration endpoint into a bottleneck that serialises at Postgres.

Additionally, 2,000 simultaneous requests each holding a Postgres connection would require 2,000 connections × ~15 MB/connection = **30 GB** — far beyond 1 GB RAM.

---

## The Implemented Strategy

### 1. Redis Atomic Seat Counter — the fast gatekeeper

**Implementation:** `src/services/registration.service.js` — Lua script executed via `redis.eval()`

A Redis key `event:{eventId}:seatsRemaining` mirrors `Event.seatsRemaining`. At registration time, a Lua script performs the check-and-decrement atomically:

```lua
local current = tonumber(redis.call('GET', KEYS[1]))
if current == nil then
  return -2  -- key not initialised
end
if current <= 0 then
  return -1  -- event full
end
redis.call('DECRBY', KEYS[1], 1)
return current - 1
```

Because Redis is single-threaded and Lua scripts execute atomically, this is a true compare-and-swap with **no race condition** and no locks. The 2,000 requests hit Redis (in-memory, sub-millisecond) rather than Postgres. The first seat-holder gets decremented; once the counter reaches 0, all subsequent requests receive `EVENT_FULL (409)` immediately — no DB touch.

**RAM impact:** Redis with a few thousand integer keys uses kilobytes. The Redis process itself is ~50 MB RSS on the 1 GB machine — trivial.

### 2. BullMQ for Async Postgres Writes — smoothing the write spike

**Implementation:** `src/jobs/workers/postgresUpdate.worker.js`

After the Redis decrement succeeds, the registration is written to Postgres and a BullMQ job is enqueued to update `Event.seatsRemaining`:

```
Request → Redis DECR (sync, fast) → Registration INSERT (sync) → BullMQ job (async) → Postgres UPDATE
```

The BullMQ `postgresUpdateQueue` worker processes these updates sequentially (or with controlled concurrency). Instead of 2,000 simultaneous `UPDATE events SET seatsRemaining = seatsRemaining - 1` hitting Postgres, the worker processes them as a queue — flattening the write burst into a controlled stream.

This means Postgres only sees a fraction of the 2,000 requests at once. The queue absorbs the spike; Postgres remains stable.

**RAM impact:** BullMQ uses Redis for its queue storage (same Redis instance, ~1–5 MB for 2,000 job payloads at ~2 KB each = ~4 MB). The worker runs in the same Node.js process. No additional process overhead.

### 3. Capped Postgres Connection Pool — protecting RAM

**Implementation:** `src/config/prisma.js`

```js
function cappedDatabaseUrl(baseUrl, limit = 10) {
  const url = new URL(baseUrl);
  if (!url.searchParams.has('connection_limit')) {
    url.searchParams.set('connection_limit', '10');
  }
  return url.toString();
}
```

Prisma's connection pool is capped at `connection_limit=10`. Memory budget:

| Component | RSS |
|---|---|
| PostgreSQL (10 backends × 15 MB) | ~150 MB |
| Redis server | ~50 MB |
| Node.js heap + V8 | ~200–300 MB |
| BullMQ worker (in-process) | ~0 MB extra |
| OS / buffers | ~100 MB |
| **Total** | **~600 MB** — within 1 GB |

Without this cap, Prisma could spawn as many connections as there are concurrent requests. 2,000 requests × 15 MB/connection = 30 GB — an OOM crash within seconds of registration opening.

With the cap at 10: when all 10 connections are busy, additional requests queue inside Prisma's pool — adding latency but **not consuming additional RAM**. The server stays alive.

The seat counter decision above means most requests are already resolved at the Redis layer before reaching Postgres, so the real DB load is much lower than 2,000.

### 4. Per-User Rate Limiting — blunting retry storms

**Implementation:** `src/middleware/rateLimiter.js` — `registrationLimiter`

```js
const registrationLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max:      10,           // per user
  store:    makeStore('rl:register:'),
  keyGenerator: (req) => req.user?.id ?? req.ip,
});
```

The limiter is keyed per user ID (not per IP), mounted after `authenticate`. A single user cannot hammer the endpoint more than 10 times per minute. This is important in two ways:

1. **Protects against retry-storm clients:** A frustrated student whose payment failed repeatedly hitting the endpoint gets bounded at 10 attempts/min, not unlimited.
2. **Protects the seat counter:** Since `Idempotency-Key` makes retries idempotent (same key → same response from cache/DB), legitimate retries never double-decrement the counter. The rate limit ensures even non-idempotent retry storms are bounded.

**RAM impact:** Rate limit counters are stored in Redis. 2,000 users × 1 counter × ~100 bytes each = ~200 KB — negligible.

---

## End-to-End Flow Under Load

```
2,000 requests arrive in 60s
         │
         ▼
  [apiLimiter] 300/15min per IP — blocks only per-IP spammers
         │
         ▼
  [authenticate] JWT verify — CPU-only, no DB/Redis
         │
         ▼
  [registrationLimiter] 10/min per user — drops abusive clients
         │
         ▼
  [checkIdempotency] reads header, attaches key — no I/O
         │
         ▼
  [Redis Lua DECR] ← single-threaded, atomic, in-memory
    ├── seatsRemaining > 0  → registration proceeds (fast path)
    └── seatsRemaining = 0  → 409 EVENT_FULL immediately (no DB)
         │
         ▼ (only successful decrements reach here)
  [Postgres INSERT Registration]  ← via capped pool (max 10 connections)
         │
         ▼
  [BullMQ enqueue] ← async, non-blocking
         │
         ▼
  201 Created + Razorpay order details
```

### Why this survives 1 GB RAM

| Concern | Without strategy | With strategy |
|---|---|---|
| Race condition on last seat | Overselling possible | Lua script prevents it |
| Postgres connection burst | 2,000 connections × 15 MB = 30 GB OOM | Pool cap → 10 connections = 150 MB |
| Write amplification to Postgres | 2,000 simultaneous UPDATEs | BullMQ queue serialises them |
| Abusive retry storms | Unbounded DB reads | 10/min per user hard cap |
| Redis memory | N/A | ~55 MB total (Redis + counters) |

The Redis Lua script is the keystone: it eliminates the need for Postgres to be in the hot path of the seat-check decision. Once the counter hits 0, every subsequent request is rejected at the sub-millisecond Redis layer — Postgres is shielded from the full 2,000-request burst.
