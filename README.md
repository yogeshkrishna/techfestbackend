# Tech Fest Registration System — Backend API

> **Production-ready backend for a college tech fest.** Handles online registration, Razorpay payments, QR-based ticketing, volunteer check-in scanning, and full event lifecycle management.

---

## TL;DR — What is this?

Think of this as the entire back-office system for running a tech fest — from a student signing up and paying for an event, to a volunteer scanning their QR code at the gate on the day.

Here's the big picture of how it works:

**Students (Participants)** sign up with their name, email, phone, and college — the system tries to auto-detect their college from their email domain. Signup and login are both done via email OTP (a 6-digit code sent to their inbox — no passwords anywhere). Once signed up, a student gets a single permanent QR code tied to their account. That same QR works for every event they register for — they can literally just print it out and show up.

Participants browse open events, pick one, pay via Razorpay (online card/UPI), and get a 10-minute window to complete payment before their seat hold expires automatically. After payment, their QR becomes active for that event. They can cancel for a 50% refund as long as the event is still open for registrations.

**Admins** are created by the Host (you). Admins can create events — specifying the name, description, date, timeslot, venue, cost per seat, and total seats available. They can edit events, advance the event lifecycle (Open → Registration Closed → Ongoing → Completed), manage volunteers, and do on-spot cash registrations for walk-ins. Admins can also view live dashboards and export CSV attendance sheets.

**Volunteers** are created by Admins and get assigned to specific events. At the event, volunteers use this API (or a frontend built on it) to:
- Scan QR codes at the gate — marks the participant as arrived
- Scan QR codes at the venue entrance — marks them as checked in and deactivates re-entry
- Do on-spot registrations for walk-ins who haven't signed up yet (the walk-in must have a verified account first)
- Look up any participant by scanning their QR — shows their full registration details
- Look up a participant by email with OTP verification — useful if someone lost their QR printout
- See a live dashboard of the event (seats filled, arrived, checked in, pending)
- Export the full attendee list as a CSV

**The Host** (you, the sole superadmin) can grant or revoke Admin status, suspend or unsuspend any user, and do everything Admins can do.

Every action — every scan, every registration, every role change — is recorded in an immutable audit log with timestamps and which staff member did it. All data is always there and nothing is ever deleted.

For frontend developers: this is a pure REST API (JSON in, JSON out). Every user has a QR token that's just a URL-safe string — you can render it as a QR image using any QR library. Authentication is JWT via `Authorization: Bearer <token>` header.

---

## Table of Contents

1. [Who Can Do What](#who-can-do-what)
2. [Prerequisites](#prerequisites)
3. [Local Setup — Step by Step](#local-setup--step-by-step)
4. [Creating Test Accounts](#creating-test-accounts)
5. [Architecture & Design Decisions](#architecture--design-decisions)
6. [API Reference](#api-reference)
7. [Frontend Development Guide](#frontend-development-guide)
8. [Rate Limits](#rate-limits)
9. [Email Notifications](#email-notifications)
10. [Scale & Performance](#scale--performance)

---

## Who Can Do What

| Capability | Participant | Volunteer | Admin | Host |
|---|:---:|:---:|:---:|:---:|
| Sign up / log in via email OTP | ✅ | ✅ | ✅ | ✅ |
| View open events | ✅ | ✅ | ✅ | ✅ |
| Register & pay for events | ✅ | — | — | — |
| Cancel registration (50% refund) | ✅ | — | — | — |
| View own tickets & QR | ✅ | ✅ | ✅ | ✅ |
| Download PDF ticket | ✅ | ✅ | ✅ | ✅ |
| Scan QR at gate (mark arrived) | — | ✅ | ✅ | ✅ |
| Scan QR at venue (mark checked in) | — | ✅ | ✅ | ✅ |
| Read-only QR lookup | — | ✅ | ✅ | ✅ |
| Lookup by email (OTP-gated) | — | ✅ | ✅ | ✅ |
| Live event dashboard | — | ✅ | ✅ | ✅ |
| Export attendee CSV | — | ✅ | ✅ | ✅ |
| On-spot cash registration | — | ✅ (assigned events) | ✅ | ✅ |
| Create / edit events | — | — | ✅ | ✅ |
| Advance event lifecycle | — | — | ✅ | ✅ |
| Create volunteer accounts | — | — | ✅ | ✅ |
| Manage volunteer assignments | — | — | ✅ | ✅ |
| Grant / revoke Admin role | — | — | — | ✅ |
| Suspend / unsuspend any user | — | — | — | ✅ |
| View audit logs | — | — | ✅ | ✅ |

> **Scope rule:** Volunteers can only act on events they are explicitly assigned to. Admins and the Host bypass this restriction.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 18.0.0 | |
| PostgreSQL | ≥ 14 | Local install or Docker |
| Redis | ≥ 6 | Local install or Docker |
| Razorpay account | — | Test-mode keys are enough for development |
| SMTP service | — | [Mailtrap](https://mailtrap.io) free tier works perfectly for dev |

---

## Local Setup — Step by Step

> **For senior devs pulling this for the first time:** follow every step in order. The server will not start if any step is skipped.

### Step 1 — Clone and install dependencies

```bash
git clone <your-repo-url>
cd techfest-backend
npm install
```

`node_modules/` is not committed to git (it's in `.gitignore`). `npm install` recreates it from `package.json`.

---

### Step 2 — Set up your environment file

```bash
cp .env.example .env
```

Now open `.env` and fill in **every value**. Here's what each one means:

```env
# The port the server listens on
PORT=3000
NODE_ENV=development

# Your local Postgres connection string
# Format: postgresql://USER:PASSWORD@HOST:PORT/DATABASE?schema=public
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/techfest?schema=public

# Your local Redis URL
REDIS_URL=redis://localhost:6379

# JWT signing secret — generate a random one:
#   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=<64-char random hex>

# JWT expiry — how long login sessions last
JWT_EXPIRES_IN=7d

# Razorpay test keys (from your Razorpay dashboard → API Keys)
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxxxxx
RAZORPAY_KEY_SECRET=your_razorpay_key_secret

# Razorpay webhook secret (from your Razorpay dashboard → Webhooks)
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret

# SMTP settings — use Mailtrap for development
SMTP_HOST=smtp.mailtrap.io
SMTP_PORT=587
SMTP_USER=your_mailtrap_username
SMTP_PASS=your_mailtrap_password
SMTP_FROM=noreply@techfest.example.com

# QR token signing secret — generate a random one:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
QR_HMAC_SECRET=<32-char random hex>

# Host (super-admin) account details — used only by the seed script
# Change these to real values before any real deployment
SEED_HOST_EMAIL=host@techfest.example.com
SEED_HOST_NAME=Tech Fest Host
SEED_HOST_PHONE=+910000000000
SEED_HOST_INSTITUTION=Tech Fest Organizing Committee
```

> ⚠️ **Never commit `.env` to git.** It's in `.gitignore`. Each developer/server needs their own `.env`.

---

### Step 3 — Start Redis

Redis must be running before the server starts. Choose whichever method you have:

```bash
# Option A — Docker (easiest, no install needed)
docker run -d --name redis -p 6379:6379 redis:7-alpine

# Option B — if Redis is installed natively on Windows (via WSL or Redis for Windows)
redis-server

# Option C — WSL
wsl redis-server
```

Verify it's running: `redis-cli ping` should return `PONG`.

---

### Step 4 — Create the database

Create a blank Postgres database named `techfest` (or whatever you used in `DATABASE_URL`):

```bash
# Using psql:
psql -U postgres -c "CREATE DATABASE techfest;"
```

---

### Step 5 — Run database migrations

This creates all the tables, indexes, and constraints from the migration files:

```bash
npx prisma migrate deploy
```

> **Note:** `prisma/migrations/` is committed to git. `migrate deploy` replays all migration files in order — it will always produce the exact schema this app expects. Do **not** run `migrate dev` on production or shared environments; use `migrate deploy`.

If you want to view the schema visually:
```bash
npx prisma studio
```

---

### Step 6 — Seed the HOST account

The HOST is the top-level superadmin. It's never created via the API — only through this one-time seed script:

```bash
npm run prisma:seed
```

Expected output:
```
─────────────────────────────────────────────
[seed] HOST user created successfully.
  id:    <uuid>
  email: host@techfest.example.com
  role:  HOST
─────────────────────────────────────────────
[seed] IMPORTANT: The HOST logs in via email OTP — there is no password.
```

> The seed is **idempotent** — running it again on an existing database does nothing (it checks first and skips creation if the HOST already exists). Safe to run multiple times.

---

### Step 7 — Start the server

```bash
npm run dev      # Development mode (nodemon — auto-restarts on file changes)
npm start        # Production mode (plain node)
```

Server starts on `http://localhost:3000` (or your `PORT`).

---

### Step 8 — Verify everything is working

```bash
curl http://localhost:3000/api/v1/health
```

**Both services up:**
```json
{
  "status": "ok",
  "timestamp": "2026-06-28T00:00:00.000Z",
  "latencyMs": 8,
  "checks": { "db": true, "redis": true }
}
```

If you see `"status": "degraded"`, check that both Postgres and Redis are running and reachable at the URLs in your `.env`.

---

## Creating Test Accounts

### Log in as HOST

The HOST account uses email OTP — no password.

**1a — Request a login OTP (check your Mailtrap inbox for the code):**
```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "host@techfest.example.com"}'
```

**1b — Verify the OTP and get your JWT:**
```bash
curl -X POST http://localhost:3000/api/v1/auth/verify-login \
  -H "Content-Type: application/json" \
  -d '{"email": "host@techfest.example.com", "otp": "123456"}'
```

Save the returned `token` value — you'll pass it as `Authorization: Bearer <token>` for all HOST requests.

---

### Create a regular participant account (for testing)

**2a — Sign up:**
```bash
curl -X POST http://localhost:3000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Alice Smith",
    "email": "alice@example.com",
    "phone": "+919876543210",
    "institution": "Example College"
  }'
```

**2b — Verify OTP from inbox:**
```bash
curl -X POST http://localhost:3000/api/v1/auth/verify-signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alice@example.com",
    "otp": "123456",
    "name": "Alice Smith",
    "phone": "+919876543210",
    "institution": "Example College"
  }'
```

---

### Promote a user to ADMIN (HOST only)

The user must already have a verified account before you can promote them:

```bash
curl -X POST http://localhost:3000/api/v1/host/admins \
  -H "Authorization: Bearer $HOST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com"}'
```

---

### Create a VOLUNTEER account (Admin only, step by step)

> The volunteer must already have a verified participant account. They sign up themselves, then an admin promotes them.

**Step 1 — Volunteer signs up** (same as participant signup above).

**Step 2 — Admin creates the volunteer and assigns events:**
```bash
curl -X POST http://localhost:3000/api/v1/admin/volunteers \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "volunteer@example.com",
    "eventIds": ["<event-uuid-1>", "<event-uuid-2>"]
  }'
```

**Step 3 — Volunteer logs in normally** (email OTP, same as any other user) and gets a JWT. Their role in the token will be `VOLUNTEER`.

---

## Architecture & Design Decisions

These are the key choices made during development. Frontend developers and senior devs should understand these to avoid surprises.

### #1 — One QR per user, for life

Every user gets a single QR token generated at signup. It never changes, never regenerates. The token is an HMAC-SHA256 signed string: `userId.HMAC(userId, QR_HMAC_SECRET)`. The same QR works across all events — it simply encodes the user's identity. Event validity is checked by looking up the `Registration` row for `(userId, eventId)`.

**Why:** Stateless, printable, shareable. A participant can hand their QR printout to a friend to show at the gate.

### #2 — QR encodes identity, not ticket

Scanning a QR resolves the user. The system then looks up whether that user has a valid registration for the event being scanned. The QR itself carries no event or ticket data.

**Status progression per registration:**
```
PENDING_PAYMENT → CONFIRMED → [arrivedAt timestamp set] → [checkedInAt timestamp set → CHECKED_IN]
                  ↘ CANCELLED_REFUNDED (from CONFIRMED only, event must be OPEN)
```

`arrivedAt` (gate scan) and `checkedInAt` (venue scan) are separate timestamps. The `status` field stays `CONFIRMED` after gate scan — only venue scan changes it to `CHECKED_IN`. A participant can only check in at the venue if they've already been gate-scanned. Re-scanning at either point returns a clear "already scanned at [time] by [volunteer]" message.

### #3 — Redis handles seat counting under load

`Event.seatsRemaining` in Postgres is the source of truth, but during a registration burst it's not read directly. A Redis key `event:{eventId}:seatsRemaining` is decremented atomically via a Lua script (one round-trip, guaranteed atomic). If Redis goes down during registration, the endpoint returns `503 SERVICE_UNAVAILABLE` — it does not fall back to Postgres. This is intentional; falling back would risk overselling seats.

See `SCALE.md` for the full breakdown of how this handles 2,000 concurrent registrations on a 1 GB RAM server.

### #4 — 10-minute seat hold, auto-released

When a participant initiates checkout, a seat is reserved for 10 minutes. A BullMQ delayed job is queued. If the Razorpay payment is not confirmed (via webhook) within 10 minutes, the job fires: the registration is set to `CANCELLED_REFUNDED` (a hold expiry, not a user cancellation), the Redis counter is incremented back, and a Postgres sync is enqueued. The seat re-enters the pool automatically.

### #5 — Cancellation always triggers a 50% refund

Cancelling a `CONFIRMED` registration immediately calls Razorpay's refund API for 50% of the paid amount. If the Razorpay call fails, the registration is **not** cancelled — the error is returned to the caller. This prevents partial state (money refunded but registration still active, or vice versa). The refund is recorded in the `Refund` table.

For CASH registrations cancelled by staff, no Razorpay call is made — a `Refund` row with `status: MANUAL_REQUIRED` is created so finance knows to process it manually.

### #6 — Email OTP only — no passwords, no SMS

Auth is entirely email-based OTP. Phone numbers are stored for display purposes but never used for authentication. OTPs are bcrypt-hashed before storage, expire in 10 minutes, and are locked after 5 wrong attempts.

### #7 — Events are never deleted

There is no DELETE endpoint for events. Events only move forward through: `OPEN → REGISTRATION_CLOSED → ONGOING → COMPLETED`. This preserves the full audit trail. Closing registration also closes cancellations — once an event is no longer `OPEN`, participants cannot cancel.

### #8 — Idempotency keys on registration

`POST /events/:id/register` requires an `Idempotency-Key` header (any UUID you generate). Sending the same key twice returns the original response without re-executing (no double-charging, no double seat decrement). The key is stored in the database as a unique constraint on the `Registration` row.

### #9 — Volunteer event scoping

Volunteers can only see and act on events they're assigned to via `VolunteerAssignment`. Admins and the Host bypass all scope restrictions.

### #10 — Late webhook handling

If Razorpay's `payment.captured` webhook arrives after the 10-minute seat hold has already expired, the system checks if a seat is still available. If yes → re-reserves the seat and confirms the registration. If no (event full) → issues a 100% automatic refund and does not confirm.

### #11 — Connection pool capped at 10

On a 1 GB server with Postgres co-located, Prisma's pool is capped at 10 connections via `?connection_limit=10` in the connection string. This keeps memory within budget. See `SCALE.md` for the full memory budget breakdown.

---

## API Reference

All endpoints are prefixed with `/api/v1`.

**Authentication:** Pass the JWT as `Authorization: Bearer <token>` on all protected routes.

**Error format** (all errors follow this structure):
```json
{
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "Human-readable description of what went wrong."
  }
}
```

**Validation errors** (422) also include field-level detail:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request body validation failed.",
    "fields": [{ "field": "email", "message": "Invalid email address" }]
  }
}
```

---

### System

#### `GET /health`
**Auth:** None | **Rate limit:** None

Checks Postgres and Redis connectivity.

**200 — both up:**
```json
{ "status": "ok", "timestamp": "...", "latencyMs": 8, "checks": { "db": true, "redis": true } }
```
**503 — any service down:**
```json
{ "status": "degraded", "latencyMs": 5004, "checks": { "db": true, "redis": false } }
```

---

### Authentication

#### `POST /auth/signup`
**Auth:** None | **Rate limit:** 5/15 min per IP, 3/15 min per email

Step 1 of signup — validates the email isn't already registered and sends a 6-digit OTP.

**Body:**
```json
{
  "name": "Alice Smith",
  "email": "alice@example.com",
  "phone": "+919876543210",
  "institution": "Example College"
}
```

**200 Response:**
```json
{
  "message": "OTP sent to your email address. Please verify within 10 minutes.",
  "institutionDetected": true,
  "suggestedInstitution": "Example College"
}
```
> If the email domain matches a known college, `institutionDetected` is `true` and `suggestedInstitution` contains the college name. Frontend can pre-fill the institution field.

**Errors:** `EMAIL_ALREADY_REGISTERED (409)`

---

#### `POST /auth/verify-signup`
**Auth:** None | **Rate limit:** 10/15 min per IP

Step 2 of signup — verifies OTP and creates the account. Returns a JWT.

**Body:**
```json
{
  "email": "alice@example.com",
  "otp": "123456",
  "name": "Alice Smith",
  "phone": "+919876543210",
  "institution": "Example College"
}
```

**201 Response:**
```json
{
  "token": "<jwt>",
  "user": {
    "id": "<uuid>",
    "name": "Alice Smith",
    "email": "alice@example.com",
    "phone": "+919876543210",
    "institution": "Example College",
    "role": "PARTICIPANT",
    "emailVerified": true,
    "qrToken": "<userId>.<hmac-hex>",
    "suspended": false,
    "createdAt": "..."
  }
}
```

**Errors:** `OTP_NOT_FOUND (400)`, `OTP_EXPIRED (400)`, `OTP_INVALID (400)`, `OTP_MAX_ATTEMPTS (429)`

---

#### `POST /auth/login`
**Auth:** None | **Rate limit:** 5/15 min per IP, 3/15 min per email

Step 1 of login — sends OTP. Returns a generic response regardless of whether the email exists (prevents email enumeration).

**Body:** `{ "email": "alice@example.com" }`

**200 Response:** `{ "message": "If this email is registered, you'll receive a login code shortly." }`

---

#### `POST /auth/verify-login`
**Auth:** None | **Rate limit:** 10/15 min per IP

Step 2 of login — verifies OTP and returns JWT.

**Body:** `{ "email": "alice@example.com", "otp": "123456" }`

**200 Response:** `{ "token": "<jwt>", "user": { ... } }`

**Errors:** `OTP_NOT_FOUND (400)`, `OTP_INVALID (400)`, `OTP_EXPIRED (400)`, `ACCOUNT_SUSPENDED (403)`

---

### Users

#### `GET /users/me`
**Auth:** JWT (any role)

Returns the current user's profile.

**200 Response:**
```json
{
  "data": {
    "id": "<uuid>",
    "name": "Alice Smith",
    "email": "alice@example.com",
    "phone": "+919876543210",
    "institution": "Example College",
    "role": "PARTICIPANT",
    "emailVerified": true,
    "qrToken": "<userId>.<hmac-hex>",
    "suspended": false,
    "createdAt": "..."
  }
}
```

---

### Host Management

All `/host/*` routes require `HOST` role.

#### `POST /host/admins`
Grants `ADMIN` role to an existing verified user.

**Body:** `{ "email": "user@example.com" }`

**200 Response:** `{ "data": { "id": "...", "email": "...", "role": "ADMIN", ... } }`

**Errors:** `USER_NOT_FOUND (404)`, `USER_NOT_VERIFIED (400)`, `ALREADY_ADMIN (409)`

---

#### `DELETE /host/admins/:userId`
Revokes `ADMIN` role — demotes back to `PARTICIPANT`.

**200 Response:** `{ "data": { "id": "...", "role": "PARTICIPANT", ... } }`

**Errors:** `USER_NOT_FOUND (404)`, `NOT_ADMIN (409)`, `CANNOT_DEMOTE_HOST (403)`

---

#### `POST /host/users/:userId/suspend`
Suspends a user. They will immediately receive `ACCOUNT_SUSPENDED (403)` on their next API call (even if they have a valid JWT).

**200 Response:** `{ "data": { "id": "...", "suspended": true, ... } }`

---

#### `POST /host/users/:userId/unsuspend`
Re-enables a suspended account.

**200 Response:** `{ "data": { "id": "...", "suspended": false, ... } }`

---

### Admin Management

All `/admin/*` routes require `ADMIN` or `HOST` role.

#### `POST /admin/volunteers`
Promotes a verified user to `VOLUNTEER` and assigns them to events in one step.

**Body:**
```json
{
  "email": "volunteer@example.com",
  "eventIds": ["<event-uuid-1>", "<event-uuid-2>"]
}
```

**201 Response:** `{ "data": { "user": { ... }, "assignments": [{ "eventId": "..." }] } }`

**Errors:** `USER_NOT_FOUND (404)`, `USER_NOT_VERIFIED (400)`, `ROLE_CONFLICT (409)`, `EVENT_NOT_FOUND (404)`

---

#### `PATCH /admin/volunteers/:userId/assignments`
Adds or removes event assignments for an existing volunteer.

**Body:** `{ "add": ["<event-uuid>"], "remove": ["<event-uuid>"] }`

At least one of `add` or `remove` must be provided.

**200 Response:** `{ "data": { "added": [...], "removed": [...] } }`

---

#### `POST /admin/events`
Creates a new event. Automatically initialises the Redis seat counter.

**Body:**
```json
{
  "name": "Robotics Workshop",
  "description": "Build and race line-following robots.",
  "eventDate": "2026-08-15T00:00:00.000Z",
  "timeslotStart": "2026-08-15T10:00:00.000Z",
  "timeslotEnd": "2026-08-15T13:00:00.000Z",
  "venue": "Seminar Hall A",
  "costPerPerson": 299.00,
  "totalSeats": 50
}
```

**201 Response:** Full event object including `id`, `seatsRemaining`, `lifecycleState: "OPEN"`.

---

#### `PATCH /admin/events/:eventId`
Updates event details. Only works when `lifecycleState` is `OPEN`.

**Body:** Any subset of the create fields (at least one required).

**200 Response:** Updated event object.

**Errors:** `EVENT_NOT_FOUND (404)`, `EVENT_COMPLETED_IMMUTABLE (403)`

---

#### `PATCH /admin/events/:eventId/lifecycle`
Advances the event lifecycle. Transitions are one-way — no going back, no skipping states.

Valid chain: `OPEN → REGISTRATION_CLOSED → ONGOING → COMPLETED`

Closing registration (`REGISTRATION_CLOSED`) also prevents new cancellations.

**Body:** `{ "newState": "REGISTRATION_CLOSED" }`

**200 Response:** Updated event object.

**Errors:** `INVALID_LIFECYCLE_TRANSITION (422)`

---

### Events (Public Read)

#### `GET /events`
**Auth:** JWT (any role)

Lists all events. Volunteers only see their assigned events.

**Query params:** `lifecycleState`, `page`, `limit`

**200 Response:**
```json
{
  "data": {
    "items": [{ "id": "...", "name": "...", "seatsRemaining": 42, "lifecycleState": "OPEN", "costPerPerson": 299 }],
    "total": 5,
    "page": 1,
    "limit": 20
  }
}
```

---

#### `GET /events/:eventId`
**Auth:** JWT (any role)

Returns a single event. Volunteers get `403` if not assigned.

**200 Response:** Full event object with live `seatsRemaining`.

---

### Volunteer Assignments

#### `POST /events/:eventId/volunteers`
**Auth:** JWT | **Role:** ADMIN, HOST

Assigns an existing VOLUNTEER user to an event.

**Body:** `{ "userId": "<volunteer-uuid>" }`

**Errors:** `USER_NOT_VOLUNTEER (409)`, `ALREADY_ASSIGNED (409)`

---

#### `DELETE /events/:eventId/volunteers/:userId`
**Auth:** JWT | **Role:** ADMIN, HOST

Removes a volunteer assignment.

---

### Registration & Payment

#### `POST /events/:eventId/register`
**Auth:** JWT | **Role:** PARTICIPANT | **Header:** `Idempotency-Key: <uuid>` (required) | **Rate limit:** 10/min per user

Creates a registration and a Razorpay order. Atomically decrements the Redis seat counter.

**Body:** *(empty — participant identity comes from JWT)*

**201 Response:**
```json
{
  "data": {
    "registrationId": "<uuid>",
    "status": "PENDING_PAYMENT",
    "seatHoldExpiresAt": "2026-08-15T10:10:00.000Z",
    "orderId": "order_xxx",
    "razorpayKeyId": "rzp_test_xxx",
    "amount": 299.00,
    "currency": "INR"
  }
}
```

Use `orderId` and `razorpayKeyId` to initialise the Razorpay checkout widget on the frontend.

**Errors:** `EVENT_NOT_OPEN (409)`, `ALREADY_REGISTERED (409)`, `EVENT_FULL (409)`, `MISSING_IDEMPOTENCY_KEY (400)`, `SERVICE_UNAVAILABLE (503)` (Redis down)

---

#### `POST /events/:eventId/register-manual`
**Auth:** JWT | **Role:** ADMIN, HOST, VOLUNTEER (assigned events only)

On-spot cash registration for a walk-in participant. The walk-in must already have a verified account. Immediately confirms the registration (no payment flow).

**Body:** `{ "email": "walkin@example.com" }`

**201 Response:**
```json
{
  "data": {
    "registrationId": "<uuid>",
    "user": { "id": "...", "name": "...", "email": "...", "institution": "..." },
    "status": "CONFIRMED",
    "paymentMethod": "CASH",
    "paidAmount": 299.00
  }
}
```

**Errors:** `USER_NOT_FOUND (404)`, `USER_NOT_VERIFIED (400)`, `ACCOUNT_SUSPENDED (403)`, `ALREADY_REGISTERED (409)`, `EVENT_FULL (409)`

---

#### `GET /events/:eventId/registrations`
**Auth:** JWT | **Role:** ADMIN, HOST, VOLUNTEER (assigned events only)

Lists all registrations for an event with participant details.

**Query params:** `status` (filter: `PENDING_PAYMENT`, `CONFIRMED`, `CHECKED_IN`, `CANCELLED_REFUNDED`), `page`, `limit`

**200 Response:**
```json
{
  "data": {
    "registrations": [{
      "registrationId": "<uuid>",
      "status": "CONFIRMED",
      "paymentMethod": "RAZORPAY",
      "paidAmount": 299.00,
      "arrivedAt": null,
      "checkedInAt": null,
      "createdAt": "...",
      "user": { "id": "...", "name": "...", "email": "...", "phone": "...", "institution": "..." }
    }],
    "pagination": { "page": 1, "limit": 50, "total": 120, "totalPages": 3 }
  }
}
```

---

#### `GET /registrations/me`
**Auth:** JWT | **Role:** PARTICIPANT

Returns the current participant's full registration history across all events.

**200 Response:**
```json
{
  "data": [{
    "registrationId": "<uuid>",
    "status": "CONFIRMED",
    "paymentMethod": "RAZORPAY",
    "paidAmount": 299.00,
    "arrivedAt": null,
    "checkedInAt": null,
    "createdAt": "...",
    "event": { "id": "...", "name": "Robotics Workshop", "eventDate": "...", "venue": "..." }
  }]
}
```

---

#### `POST /payments/webhook`
**Auth:** Razorpay signature (header: `x-razorpay-signature`) — **no JWT**

Razorpay webhook receiver. Must receive the raw (unparsed) request body for signature verification (configured automatically in `app.js`).

On `payment.captured`: confirms the registration, cancels the seat-hold BullMQ job, updates Postgres seat count, sends confirmation email.

Always returns `200` to Razorpay even on errors (to prevent unnecessary retries), except `400` for invalid signatures.

> **Local testing:** Use [Razorpay's webhook simulator](https://dashboard.razorpay.com/app/webhooks) or ngrok to forward webhooks to `localhost`.

---

#### `POST /registrations/:registrationId/payment/verify`
**Auth:** JWT | **Role:** PARTICIPANT | **Header:** `Idempotency-Key: <uuid>`

Client-side payment verification — use this as a fallback after Razorpay checkout completes if the webhook is slow.

**Body:**
```json
{
  "razorpayPaymentId": "pay_xxx",
  "razorpayOrderId": "order_xxx",
  "razorpaySignature": "<hmac-hex>"
}
```

**200 Response:** `{ "data": { "message": "Payment verified. Registration confirmed.", "status": "CONFIRMED", "registrationId": "..." } }`

**Errors:** `MISSING_FIELDS (400)`, `INVALID_PAYMENT_SIGNATURE (400)`, `PAYMENT_NOT_FOUND (404)`, `FORBIDDEN (403)`

---

#### `PATCH /registrations/:registrationId/cancel`
**Auth:** JWT | **Role:** PARTICIPANT (own only), ADMIN, HOST | **Header:** `Idempotency-Key: <uuid>`

Cancels a `CONFIRMED` registration. Calls Razorpay refund API for 50% of `paidAmount`. If Razorpay fails, the registration is **not** cancelled.

**Conditions:** Registration must be `CONFIRMED`. Event must be `OPEN`.

**200 Response:**
```json
{
  "data": {
    "registrationId": "<uuid>",
    "status": "CANCELLED_REFUNDED",
    "refundAmount": 149.50,
    "paymentMethod": "RAZORPAY",
    "message": "Registration cancelled. A 50% refund of ₹149.50 has been initiated via Razorpay."
  }
}
```

**Errors:** `ALREADY_CANCELLED (409)`, `CANNOT_CANCEL (409)`, `CANCELLATION_NOT_ALLOWED (409)`, `REFUND_FAILED (502)`

---

### Tickets

#### `GET /tickets/me`
**Auth:** JWT | **Role:** PARTICIPANT

Returns the participant's QR token, a base64 PNG of the QR image, and their confirmed tickets.

**200 Response:**
```json
{
  "data": {
    "qrToken": "<userId>.<hmac-hex>",
    "qrImageDataUrl": "data:image/png;base64,...",
    "tickets": [{
      "registrationId": "<uuid>",
      "status": "CONFIRMED",
      "arrivedAt": null,
      "checkedInAt": null,
      "event": { "id": "...", "name": "Robotics Workshop", "eventDate": "...", "venue": "...", "timeslotStart": "...", "timeslotEnd": "..." }
    }]
  }
}
```

> The `qrImageDataUrl` is ready to drop into an `<img>` src. The `qrToken` string can also be encoded into a QR by any QR library on the frontend.

---

#### `GET /tickets/me/pdf`
**Auth:** JWT | **Role:** PARTICIPANT

Downloads a PDF ticket for one registration.

**Query params:** `registrationId=<uuid>` OR `eventId=<uuid>` (one is required)

**Response:** `application/pdf` file download.

---

### Check-in / Volunteer Scanning

All `/volunteer/*` routes require `VOLUNTEER`, `ADMIN`, or `HOST` role.

#### `POST /volunteer/scan/gate`
Marks a participant as arrived at the gate. Sets `arrivedAt` timestamp. Requires `status = CONFIRMED` and `arrivedAt` not already set.

**Body:** `{ "qrToken": "<userId>.<hmac-hex>", "eventId": "<uuid>" }`

**200 Response:**
```json
{
  "data": {
    "alreadyScanned": false,
    "userId": "<uuid>",
    "registrationId": "<uuid>",
    "arrivedAt": "2026-08-15T09:55:00.000Z",
    "message": "Gate arrival recorded."
  }
}
```

If already scanned, `alreadyScanned: true` with original `arrivedAt` and the volunteer who scanned — **no error thrown**, just an informational response.

**Errors:** `QR_TOKEN_INVALID (400)`, `REGISTRATION_NOT_FOUND (404)`, `NOT_CONFIRMED (409)`

---

#### `POST /volunteer/scan/venue`
Marks a participant as checked in at the venue. Requires gate arrival to have happened first.

**Body:** `{ "qrToken": "...", "eventId": "<uuid>" }`

**200 Response:** Similar to gate scan, sets `checkedInAt` and `status: CHECKED_IN`.

**Errors:** `GATE_ARRIVAL_REQUIRED (409)`, `ALREADY_CHECKED_IN (409)`

---

#### `POST /volunteer/scan/lookup`
Read-only QR lookup — returns participant info and registration status without changing anything.

**Body:** `{ "qrToken": "...", "eventId": "<uuid>" }`

---

#### `POST /volunteer/users/lookup-by-email`
Two-step OTP lookup — finds a participant by email with OTP verification. Useful when someone lost their QR printout.

**Step 1 — send OTP** (body has `email` and `eventId`, no `otp`):
```json
{ "email": "participant@example.com", "eventId": "<uuid>" }
```
**202 Response:** `{ "data": { "step": "CHALLENGE_SENT", "message": "OTP sent..." } }`

**Step 2 — verify OTP** (body includes `otp`):
```json
{ "email": "participant@example.com", "eventId": "<uuid>", "otp": "123456" }
```
**200 Response:** Full user profile and registration details for the event.

---

#### `GET /volunteer/events/:eventId/dashboard`
**Auth:** JWT | **Role:** VOLUNTEER (assigned), ADMIN, HOST

Live event statistics and paginated participant list.

**200 Response:**
```json
{
  "data": {
    "eventId": "<uuid>",
    "stats": {
      "totalSeats": 50,
      "seatsRemaining": 8,
      "totalRegistrations": 42,
      "confirmed": 42,
      "arrived": 28,
      "checkedIn": 19,
      "cancelled": 3
    },
    "participants": [{ "name": "...", "email": "...", "status": "CONFIRMED", "arrivedAt": null }],
    "pagination": { "page": 1, "limit": 50, "total": 42 }
  }
}
```

---

#### `GET /volunteer/events/:eventId/export`
**Auth:** JWT | **Role:** VOLUNTEER (assigned), ADMIN, HOST

Streams a CSV file of all registrations for the event.

**Response:** `text/csv` file download.

CSV columns: `registrationId, status, paymentMethod, paidAmount, arrivedAt, checkedInAt, createdAt, userId, name, email, phone, institution`

---

### Audit Logs

#### `GET /audit-logs`
**Auth:** JWT | **Role:** HOST, ADMIN

Returns paginated audit log entries — every action taken by any staff member.

**Query params:**

| Param | Type | Description |
|---|---|---|
| `actorId` | UUID | Filter by user who performed the action |
| `targetType` | string | e.g. `Registration`, `Event`, `User` |
| `startDate` | ISO date | Inclusive lower bound |
| `endDate` | ISO date | Inclusive upper bound (extended to 23:59:59 UTC) |
| `page` | int | Default: 1 |
| `limit` | int | Default: 20, max: 100 |

**200 Response:**
```json
{
  "data": {
    "logs": [{
      "id": "<uuid>",
      "actorId": "<uuid>",
      "actorRole": "VOLUNTEER",
      "action": "GATE_ARRIVAL_RECORDED",
      "targetType": "Registration",
      "targetId": "<uuid>",
      "metadata": { "eventId": "...", "scannedAt": "..." },
      "createdAt": "..."
    }],
    "pagination": { "page": 1, "limit": 20, "total": 42, "totalPages": 3 }
  }
}
```

---

## Frontend Development Guide

This backend is designed to be consumed by any frontend — React, Vue, Next.js, plain HTML. Here's everything you need to build one.

### Base URL & Auth

```
Base URL: http://localhost:3000/api/v1   (development)
          https://yourdomain.com/api/v1  (production)

All protected routes:
  Header: Authorization: Bearer <token>
  Content-Type: application/json
```

Store the JWT in `localStorage` or a cookie on login. Attach it to every request. On `401 TOKEN_EXPIRED`, redirect to login. On `403 ACCOUNT_SUSPENDED`, show a suspension notice.

---

### Authentication Flow (UI)

```
Signup:
  1. Show form: name, email, phone, institution
  2. POST /auth/signup → on success, move to OTP screen
     - Use institutionDetected + suggestedInstitution to pre-fill college
  3. Show 6-digit OTP input (hint: check email)
  4. POST /auth/verify-signup → save token + user, redirect to dashboard

Login:
  1. Show email input
  2. POST /auth/login → show OTP screen regardless of response
  3. POST /auth/verify-login → save token + user, redirect to dashboard
```

---

### Registration & Payment Flow (Participant UI)

```
1. GET /events → show event list with seatsRemaining
2. User picks an event → GET /events/:id → show details
3. User clicks "Register"
   - Generate a UUID (idempotency key) and store in sessionStorage
   - POST /events/:id/register (with Idempotency-Key header)
   - Response: { orderId, razorpayKeyId, amount, seatHoldExpiresAt }
4. Show a countdown timer from seatHoldExpiresAt
5. Open Razorpay checkout widget:
   - key: razorpayKeyId
   - order_id: orderId
   - amount: amount * 100  (Razorpay uses paise)
   - currency: "INR"
   - handler: function(response) { verifyPayment(response) }
6. On Razorpay success callback:
   - POST /registrations/:id/payment/verify (as fallback)
   - Redirect to "Registration confirmed!" screen
7. Webhook fires in background → confirmation email sent automatically
```

**Razorpay Checkout snippet:**
```javascript
const rzp = new Razorpay({
  key: razorpayKeyId,
  order_id: orderId,
  amount: amount * 100,
  currency: 'INR',
  name: 'Tech Fest',
  handler: async function(response) {
    await fetch(`/api/v1/registrations/${registrationId}/payment/verify`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        razorpayPaymentId: response.razorpay_payment_id,
        razorpayOrderId: response.razorpay_order_id,
        razorpaySignature: response.razorpay_signature,
      }),
    });
    // Redirect to success screen
  }
});
rzp.open();
```

---

### QR Code Display (Participant)

```
1. GET /tickets/me
   Response includes:
     - qrImageDataUrl  → <img src={qrImageDataUrl} />  (ready to use)
     - qrToken         → pass to a QR library if you need custom size/style
     - tickets[]       → list of confirmed registrations

2. For PDF download:
   GET /tickets/me/pdf?registrationId=<uuid>
   Set the link as <a href="..." download> for browser download
```

The `qrToken` format is `<userId>.<hmac-hex>`. It's a URL-safe string — you can encode it as a QR using libraries like `qrcode.react` on the frontend for custom styling:

```jsx
import QRCode from 'qrcode.react';
<QRCode value={qrToken} size={200} />
```

---

### Volunteer Scanning UI

```
Scan flow (gate or venue):
  1. Use device camera to scan QR → decode to qrToken string
  2. POST /volunteer/scan/gate or /venue with { qrToken, eventId }
  3. Show result:
     - alreadyScanned: false → green "Arrival recorded ✓"
     - alreadyScanned: true  → yellow "Already scanned at [time]"
     - 409 NOT_CONFIRMED     → red "Not a confirmed registration"
     - 400 QR_TOKEN_INVALID  → red "Invalid QR code"

Lookup (lost QR):
  1. POST /volunteer/users/lookup-by-email { email, eventId }
     → user receives OTP
  2. POST same endpoint with { email, eventId, otp }
     → returns user details and registration info
```

---

### Admin Event Management UI

```
Create event:
  POST /admin/events { name, description, eventDate, timeslotStart,
                       timeslotEnd, venue, costPerPerson, totalSeats }

Advance lifecycle (in order):
  PATCH /admin/events/:id/lifecycle { "newState": "REGISTRATION_CLOSED" }
  PATCH /admin/events/:id/lifecycle { "newState": "ONGOING" }
  PATCH /admin/events/:id/lifecycle { "newState": "COMPLETED" }

Live dashboard (poll every 30s or on action):
  GET /volunteer/events/:id/dashboard

Export CSV (trigger download):
  GET /volunteer/events/:id/export
  → set as <a href="..." download> link
```

---

### Common Response Patterns

All successful responses wrap data in a `data` key:
```json
{ "data": { ... } }
```

All errors use:
```json
{ "error": { "code": "...", "message": "..." } }
```

Status codes to handle in every frontend:
| Code | Meaning | Frontend action |
|---|---|---|
| `200` / `201` | Success | Show data |
| `400` | Bad input | Show field-level errors |
| `401 TOKEN_EXPIRED` | Session expired | Redirect to login |
| `401 INVALID_TOKEN` | Bad token | Clear storage, redirect |
| `403 ACCOUNT_SUSPENDED` | Suspended | Show suspension notice |
| `403 FORBIDDEN` | Not your resource | Show "not allowed" |
| `404` | Not found | Show not found state |
| `409` | Conflict (already exists, etc.) | Show specific message from `error.code` |
| `422 VALIDATION_ERROR` | Bad body fields | Show `error.fields` inline |
| `429` | Rate limit hit | Show "too many requests, wait..." |
| `502 REFUND_FAILED` | Razorpay issue | Show "refund failed, contact support" |
| `503 SERVICE_UNAVAILABLE` | Redis down | Show "registration temporarily unavailable" |

---

### Live Data (Polling)

This API has no WebSocket support. For live dashboard updates (seats remaining, checked-in counts), poll on an interval:

```javascript
// Poll dashboard every 30 seconds
useEffect(() => {
  const interval = setInterval(() => {
    fetch(`/api/v1/volunteer/events/${eventId}/dashboard`, {
      headers: { Authorization: `Bearer ${token}` }
    }).then(r => r.json()).then(setDashboard);
  }, 30_000);
  return () => clearInterval(interval);
}, [eventId]);
```

For `seatsRemaining` on the event list, the same pattern applies — poll `GET /events/:id` every minute or so.

---

## Rate Limits

| Endpoint | Limit |
|---|---|
| All `/api/v1/*` (baseline) | 300 req / 15 min per IP |
| `POST /auth/signup`, `/auth/login` | 5 req / 15 min per IP + 3 req / 15 min per email |
| `POST /auth/verify-signup`, `/auth/verify-login` | 10 req / 15 min per IP |
| `POST /events/:id/register` | 10 req / 1 min per user |

Rate limit responses: `429 Too Many Requests` with `Retry-After` and `RateLimit-*` headers.

---

## Email Notifications

The system sends transactional emails automatically for:

| Trigger | Recipient | Email content |
|---|---|---|
| `POST /auth/signup` | New user | 6-digit OTP for account verification |
| `POST /auth/login` | Existing user | 6-digit OTP for login |
| Razorpay `payment.captured` webhook | Participant | Booking confirmation with event details |
| `PATCH /registrations/:id/cancel` | Participant | Cancellation confirmation with refund details |

Emails are fire-and-forget — failures are logged to the console but do **not** affect the API response or the registration state.

---

## Scale & Performance

See [`SCALE.md`](./SCALE.md) for a full technical breakdown of how this handles **2,000 concurrent registrations in 60 seconds on a 1 GB RAM server**.

Short version:
- **Redis Lua script** atomically checks and decrements the seat counter — no race conditions, no Postgres in the hot path
- **BullMQ queue** absorbs the Postgres write burst and processes updates sequentially
- **Prisma pool capped at 10 connections** — prevents OOM on constrained hardware
- **Per-user rate limiting** caps retry storms at 10 req/min per user

---



> **For senior devs cloning this:** clone the repo, then `npm install` to pull dependencies. Copy `.env.example` to `.env` and fill in your own DB/Redis URLs, JWT secret, Razorpay test keys, and SMTP credentials — nobody's secrets are shared, each environment needs its own. Run `npx prisma migrate deploy` to build the schema, then `npm run prisma:seed` to create the one-time HOST account (it's idempotent, safe to re-run). Start with `npm run dev`, and hit `GET /api/v1/health` to confirm Postgres and Redis are both reachable.
