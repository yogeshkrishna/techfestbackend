# Tech Fest Registration System — Project Spec

> **This file is the canonical reference for all future phases.**
> Future agent invocations should read this file instead of re-reading the full original prompt.

---

## 1. System Overview

A backend API for a college tech fest registration system. Participants register for events, pay online, and receive a QR-based ticket. Volunteers scan QR codes at event entry. Admins and the Host manage events, users, and reports.

---

## 2. Roles

| Role | Description |
|---|---|
| `HOST` | Single top-level account. Seeded into DB — not self-registerable. Grants ADMIN role. |
| `ADMIN` | Granted by HOST. Manages events, volunteers, and users. |
| `VOLUNTEER` | Created by ADMINs. Scoped to specific events via VolunteerAssignment. |
| `PARTICIPANT` | Self-registers. Registers for events and pays. |

---

## 3. Authentication

- **Email OTP only.** No passwords, no SMS.
- Phone number is collected at signup for contact/on-spot purposes but is **never** an auth channel.
- JWTs are issued after OTP verification.
- `EmailOtp.purpose` distinguishes SIGNUP vs LOGIN flows.

---

## 4. The 9 Architectural Decisions (FINAL — do not deviate)

### #1 — QR Code: one-time generated, never regenerated
Each user has exactly one QR code generated at signup. It is reused across every event. The QR encodes an HMAC-signed token (field: `User.qrToken`) pointing to their user ID. It **never expires** and is **never regenerated**.

### #2 — QR validity is a Registration property, not a QR property
A QR scan at an event looks up the `Registration` row for `(userId, eventId)` and reads its `status`. The QR itself carries no validity data. The same QR scanned at two different events hits two different Registration rows.

Registration lifecycle:
```
PENDING_PAYMENT → CONFIRMED → ARRIVED → CHECKED_IN
                                      ↘ CANCELLED_REFUNDED (from CONFIRMED)
```

### #3 — Seat counting: Redis fast-path + async Postgres sync
- `Event.seatsRemaining` in Postgres is the **canonical** count.
- At registration time, Redis `DECR` is used atomically to prevent overselling under load.
- Postgres `seatsRemaining` is updated **asynchronously** via a BullMQ job (`postgresUpdateQueue`) — **not** synchronously in the request path.

### #4 — Seat holds: 10-minute window with automatic release
When a user starts checkout, their seat is reserved for 10 minutes (`Registration.seatHoldExpiresAt`). A BullMQ **delayed job** (`seatReleaseQueue`) automatically releases the seat back to the pool if payment is not confirmed within that window.

### #5 — Cancellation triggers automatic 50% refund
Cancellation of a CONFIRMED registration immediately calls Razorpay's refund API for 50% of `paidAmount`. No manual approval step. Refund is recorded in the `Refund` table.

### #6 — Email OTP only; phone is never an auth channel
See §3. Phone is stored for contact purposes only.

### #7 — Events are never deleted; only lifecycle transitions
There is **no DELETE endpoint for events, ever.** Events progress through:
```
OPEN → REGISTRATION_CLOSED → ONGOING → COMPLETED
```
An event can only move forward in this lifecycle (no reversal).

### #8 — Idempotency keys on all mutating endpoints
All payment/registration-mutating endpoints accept an `Idempotency-Key` client-supplied header. Re-sending the same key returns the cached response without re-executing the operation. Key is stored in `Registration.idempotencyKey`.

### #9 — Volunteers are event-scoped
Volunteers can only see and act on events they are explicitly assigned to via `VolunteerAssignment`. The `requireEventScope` middleware enforces this. HOST and ADMIN bypass this check.

---

## 5. Prisma Schema — Full Field List

### `User`
| Field | Type | Notes |
|---|---|---|
| id | String (UUID) | PK |
| name | String | |
| email | String | Unique |
| phone | String | Contact only, never auth |
| institution | String | |
| role | Enum Role | HOST, ADMIN, VOLUNTEER, PARTICIPANT |
| emailVerified | Boolean | Default false |
| qrToken | String | Unique; HMAC-signed at signup; never regenerated |
| suspended | Boolean | Default false |
| createdAt | DateTime | |

### `EmailOtp`
| Field | Type | Notes |
|---|---|---|
| id | String (UUID) | PK |
| email | String | |
| otpHash | String | bcrypt hash of the OTP |
| purpose | Enum OtpPurpose | SIGNUP, LOGIN |
| expiresAt | DateTime | |
| attempts | Int | Default 0; brute-force guard |
| createdAt | DateTime | |

### `VolunteerAssignment`
| Field | Type | Notes |
|---|---|---|
| id | String (UUID) | PK |
| volunteerId | String | FK → User |
| eventId | String | FK → Event |
| | | Unique on (volunteerId, eventId) |

### `Event`
| Field | Type | Notes |
|---|---|---|
| id | String (UUID) | PK |
| name | String | |
| description | String | |
| eventDate | DateTime | |
| timeslotStart | DateTime | |
| timeslotEnd | DateTime | |
| venue | String | |
| costPerPerson | Decimal | |
| totalSeats | Int | |
| seatsRemaining | Int | Postgres canonical count |
| lifecycleState | Enum EventLifecycle | OPEN, REGISTRATION_CLOSED, ONGOING, COMPLETED |
| createdById | String | FK → User |
| createdAt | DateTime | |
| updatedAt | DateTime | |

### `Registration`
| Field | Type | Notes |
|---|---|---|
| id | String (UUID) | PK |
| userId | String | FK → User |
| eventId | String | FK → Event |
| status | Enum RegistrationStatus | PENDING_PAYMENT, CONFIRMED, ARRIVED, CHECKED_IN, CANCELLED_REFUNDED |
| paymentMethod | Enum PaymentMethod | RAZORPAY, CASH |
| paidAmount | Decimal | |
| seatHoldExpiresAt | DateTime? | Nullable; set during checkout window |
| arrivedAt | DateTime? | Nullable |
| checkedInAt | DateTime? | Nullable |
| registeredById | String? | Nullable; FK → User; set when volunteer does on-spot registration |
| idempotencyKey | String? | Nullable; unique per registration attempt |
| createdAt | DateTime | |

### `Payment`
| Field | Type | Notes |
|---|---|---|
| id | String (UUID) | PK |
| registrationId | String | FK → Registration |
| razorpayOrderId | String | |
| razorpayPaymentId | String? | Nullable; set after capture |
| amount | Decimal | |
| status | Enum PaymentStatus | CREATED, CAPTURED, FAILED |
| createdAt | DateTime | |

### `Refund`
| Field | Type | Notes |
|---|---|---|
| id | String (UUID) | PK |
| registrationId | String | FK → Registration |
| razorpayRefundId | String | |
| amount | Decimal | |
| status | String | e.g. "processed", "pending" |
| createdAt | DateTime | |

### `AuditLog`
| Field | Type | Notes |
|---|---|---|
| id | String (UUID) | PK |
| actorId | String? | Nullable FK → User; null for system-initiated actions |
| actorRole | String? | Denormalized for immutability |
| action | String | e.g. "REGISTRATION_CANCELLED", "SEAT_RELEASED" |
| targetType | String | e.g. "Registration", "Event" |
| targetId | String | ID of the affected record |
| metadata | Json | Arbitrary context (amounts, reasons, etc.) |
| createdAt | DateTime | |

---

## 6. Queue Names (BullMQ)

| Queue | Purpose |
|---|---|
| `seatReleaseQueue` | Delayed job to release held seat if payment window expires (Decision #4) |
| `postgresUpdateQueue` | Async job to sync Redis seat count → Postgres (Decision #3) |

---

## 7. Folder Structure

```
/
├── prisma/
│   ├── schema.prisma
│   └── seed.js
├── src/
│   ├── app.js                  # Express app factory
│   ├── server.js               # HTTP server entry point
│   ├── config/
│   │   ├── env.js              # Validated env exports
│   │   ├── prisma.js           # Singleton PrismaClient
│   │   └── redis.js            # Singleton ioredis client
│   ├── middleware/
│   │   ├── auth.js             # JWT verification → req.user
│   │   ├── rbac.js             # requireRole([...]) factory
│   │   ├── volunteerScope.js   # requireEventScope guard
│   │   ├── errorHandler.js     # Global error handler + AppError class
│   │   ├── rateLimiter.js      # express-rate-limit stubs
│   │   └── idempotency.js      # Idempotency-Key header reader stub
│   ├── routes/
│   │   ├── index.js
│   │   ├── auth.routes.js
│   │   ├── user.routes.js
│   │   ├── event.routes.js
│   │   ├── registration.routes.js
│   │   ├── payment.routes.js
│   │   ├── volunteer.routes.js
│   │   └── admin.routes.js
│   ├── controllers/
│   │   ├── auth.controller.js
│   │   ├── user.controller.js
│   │   ├── event.controller.js
│   │   ├── registration.controller.js
│   │   ├── payment.controller.js
│   │   ├── volunteer.controller.js
│   │   └── admin.controller.js
│   ├── services/
│   │   ├── auth.service.js
│   │   ├── event.service.js
│   │   ├── registration.service.js
│   │   ├── payment.service.js
│   │   ├── email.service.js
│   │   ├── qr.service.js
│   │   └── audit.service.js
│   └── jobs/
│       ├── index.js
│       ├── queues.js
│       └── workers/
│           ├── seatRelease.worker.js
│           └── postgresUpdate.worker.js
├── .env.example
├── .gitignore
├── package.json
└── PROJECT_SPEC.md
```

---

## 8. API Route Map

| Method | Path | Auth | Roles | Status |
|---|---|---|---|---|
| POST | `/api/v1/auth/signup` | None | Public | ✅ Phase 2 |
| POST | `/api/v1/auth/verify-signup` | None | Public | ✅ Phase 2 |
| POST | `/api/v1/auth/login` | None | Public | ✅ Phase 2 |
| POST | `/api/v1/auth/verify-login` | None | Public | ✅ Phase 2 |
| GET | `/api/v1/users/me` | JWT | Any | ✅ Phase 2 |
| POST | `/api/v1/host/admins` | JWT | HOST | ✅ Phase 3 |
| DELETE | `/api/v1/host/admins/:userId` | JWT | HOST | ✅ Phase 3 |
| POST | `/api/v1/host/users/:userId/suspend` | JWT | HOST | ✅ Phase 3 |
| POST | `/api/v1/host/users/:userId/unsuspend` | JWT | HOST | ✅ Phase 3 |
| POST | `/api/v1/admin/volunteers` | JWT | ADMIN, HOST | ✅ Phase 3 |
| PATCH | `/api/v1/admin/volunteers/:userId/assignments` | JWT | ADMIN, HOST | ✅ Phase 3 |
| POST | `/api/v1/admin/events` | JWT | ADMIN, HOST | ✅ Phase 3 |
| PATCH | `/api/v1/admin/events/:eventId` | JWT | ADMIN, HOST | ✅ Phase 3 |
| PATCH | `/api/v1/admin/events/:eventId/lifecycle` | JWT | ADMIN, HOST | ✅ Phase 3 |
| GET | `/api/v1/events` | JWT | Any | ✅ Phase 3 |
| GET | `/api/v1/events/:eventId` | JWT | Any | ✅ Phase 3 |

| PATCH | `/api/v1/users/me` | JWT | Any | stub |
| POST | `/api/v1/events/:eventId/register` | JWT | PARTICIPANT, VOLUNTEER | stub |
| GET | `/api/v1/events/:eventId/registrations` | JWT | ADMIN, HOST, VOLUNTEER | stub |
| PATCH | `/api/v1/registrations/:registrationId/cancel` | JWT | PARTICIPANT, ADMIN, HOST | stub |
| POST | `/api/v1/payments/webhook` | Razorpay sig | None | stub |
| POST | `/api/v1/registrations/:registrationId/payment/verify` | JWT | PARTICIPANT | stub |
| POST | `/api/v1/events/:eventId/volunteers` | JWT | ADMIN, HOST | stub |
| DELETE | `/api/v1/events/:eventId/volunteers/:userId` | JWT | ADMIN, HOST | stub |

## 9. QR Token Delivery (Phase 2)

The `qrToken` string (format: `<userId>.<hmac-sha256-hex>`) is returned in:
- `POST /auth/verify-signup` response (on account creation)
- `GET /users/me` response (always available)

The **client renders the QR image** from this string using a JS library (e.g. `qrcode.js`). No server-side image generation. The token itself is safe to expose — it's the QR payload, not a secret.

---

*Last updated: Phase 3 — Event Management & Admin Hierarchy*
