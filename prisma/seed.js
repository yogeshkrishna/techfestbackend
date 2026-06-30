/**
 * prisma/seed.js
 *
 * Seeds the database with the single HOST user.
 * The HOST account is never created via the API — only through this script.
 *
 * Run: node prisma/seed.js
 *   OR: npm run prisma:seed
 *
 * Required env vars (from .env):
 *   DATABASE_URL, QR_HMAC_SECRET, SEED_HOST_EMAIL, SEED_HOST_NAME,
 *   SEED_HOST_PHONE, SEED_HOST_INSTITUTION
 */

'use strict';

require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const prisma = new PrismaClient();

/**
 * Generates the HMAC-signed QR token for a given userId.
 * This is the canonical implementation — qr.service.js will re-export this
 * exact algorithm so QR generation is consistent system-wide.
 *
 * @param {string} userId
 * @returns {string}  "<userId>.<hmac-hex-signature>"
 */
function generateQrToken(userId) {
  const secret = process.env.QR_HMAC_SECRET;
  if (!secret) {
    throw new Error('QR_HMAC_SECRET is not set in environment variables');
  }
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(userId);
  const signature = hmac.digest('hex');
  return `${userId}.${signature}`;
}

async function main() {
  const email = process.env.SEED_HOST_EMAIL;
  const name = process.env.SEED_HOST_NAME;
  const phone = process.env.SEED_HOST_PHONE;
  const institution = process.env.SEED_HOST_INSTITUTION;

  if (!email || !name || !phone || !institution) {
    throw new Error(
      'Missing required SEED_HOST_* environment variables. ' +
        'Check your .env file against .env.example.'
    );
  }

  // Check if HOST already exists to make seed idempotent
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(
      `[seed] HOST user already exists (id: ${existing.id}). Skipping creation.`
    );
    return;
  }

  const hostId = uuidv4();
  const qrToken = generateQrToken(hostId);

  const host = await prisma.user.create({
    data: {
      id: hostId,
      name,
      email,
      phone,
      institution,
      role: 'HOST',
      emailVerified: true,
      qrToken,
      suspended: false,
    },
  });

  console.log('─────────────────────────────────────────────');
  console.log('[seed] HOST user created successfully.');
  console.log(`  id:    ${host.id}`);
  console.log(`  email: ${host.email}`);
  console.log(`  role:  ${host.role}`);
  console.log('─────────────────────────────────────────────');
  console.log('[seed] IMPORTANT: The HOST logs in via email OTP — there is no password.');
}

main()
  .catch((err) => {
    console.error('[seed] Fatal error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
