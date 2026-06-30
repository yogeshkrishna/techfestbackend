/**
 * src/services/email.service.js
 *
 * Email notification service using Nodemailer.
 * Exports a singleton transporter created once from SMTP env vars.
 */

'use strict';

const nodemailer = require('nodemailer');
const env = require('../config/env');

// ─────────────────────────────────────────────
// Singleton transporter
// ─────────────────────────────────────────────

let _transporter = null;

/**
 * Returns (or lazily creates) the singleton Nodemailer transporter.
 * Called on first email send so that startup doesn't fail if SMTP is unreachable.
 *
 * @returns {import('nodemailer').Transporter}
 */
function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      // Use TLS for port 465 (SMTPS), STARTTLS for 587, plain for 25
      secure: env.SMTP_PORT === 465,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    });
  }
  return _transporter;
}

// ─────────────────────────────────────────────
// HTML template helpers
// ─────────────────────────────────────────────

/**
 * Builds the branded HTML email body for an OTP.
 *
 * @param {object} opts
 * @param {string} opts.name        Recipient's name (used in greeting if provided)
 * @param {string} opts.otp         6-digit OTP code
 * @param {'SIGNUP'|'LOGIN'} opts.purpose
 * @returns {string} HTML string
 */
function buildOtpHtml({ name, otp, purpose }) {
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const action = purpose === 'SIGNUP'
    ? 'complete your registration'
    : 'log in to your account';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your OTP Code</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f4f5; margin: 0; padding: 0; }
    .wrapper { max-width: 480px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .header { background: #1e1b4b; padding: 28px 32px; }
    .header h1 { color: #ffffff; margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.3px; }
    .header p { color: #a5b4fc; margin: 4px 0 0; font-size: 13px; }
    .body { padding: 32px; }
    .greeting { color: #374151; font-size: 15px; margin-bottom: 16px; }
    .desc { color: #6b7280; font-size: 14px; line-height: 1.6; margin-bottom: 28px; }
    .otp-box { background: #f0f0ff; border: 2px dashed #6366f1; border-radius: 10px; text-align: center; padding: 20px; margin-bottom: 24px; }
    .otp-code { font-size: 40px; font-weight: 800; letter-spacing: 12px; color: #1e1b4b; font-family: 'Courier New', monospace; }
    .expiry { color: #9ca3af; font-size: 12px; margin-top: 8px; }
    .warning { background: #fef9c3; border-left: 3px solid #f59e0b; padding: 12px 16px; border-radius: 4px; font-size: 12px; color: #92400e; margin-bottom: 24px; }
    .footer { border-top: 1px solid #e5e7eb; padding: 20px 32px; text-align: center; }
    .footer p { color: #9ca3af; font-size: 11px; margin: 0; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>Tech Fest 🎉</h1>
      <p>Registration System</p>
    </div>
    <div class="body">
      <p class="greeting">${greeting}</p>
      <p class="desc">
        Use the code below to ${action}. This code is valid for <strong>10 minutes</strong>.
      </p>
      <div class="otp-box">
        <div class="otp-code">${otp}</div>
        <p class="expiry">Expires in 10 minutes</p>
      </div>
      <div class="warning">
        🔒 Never share this code with anyone. Our team will never ask for it.
      </div>
    </div>
    <div class="footer">
      <p>If you didn't request this code, you can safely ignore this email.</p>
    </div>
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────
// Exported functions
// ─────────────────────────────────────────────

/**
 * Sends an OTP email to the specified address.
 *
 * @param {string} to       Recipient email address
 * @param {string} otp      Plaintext 6-digit OTP (not the hash)
 * @param {'SIGNUP'|'LOGIN'} purpose
 * @param {{ name?: string }} [opts]  Optional extra context for the email template
 * @returns {Promise<void>}
 */
async function sendOtpEmail(to, otp, purpose, opts = {}) {
  const subject = purpose === 'SIGNUP'
    ? '🎉 Verify your Tech Fest registration'
    : '🔐 Your Tech Fest login code';

  const html = buildOtpHtml({ name: opts.name, otp, purpose });

  const transporter = getTransporter();

  await transporter.sendMail({
    from: `"Tech Fest" <${env.SMTP_FROM}>`,
    to,
    subject,
    html,
    // Plain text fallback
    text: `Your Tech Fest OTP is: ${otp}\n\nThis code expires in 10 minutes.\nNever share this code with anyone.`,
  });

  console.log(`[email] OTP sent to ${to} (purpose: ${purpose})`);
}

/**
 * Sends a registration confirmation email after payment is captured.
 * Triggered by payment.service.handlePaymentCaptured (fire-and-forget).
 *
 * @param {string} to
 * @param {object} params
 * @param {string} params.userName
 * @param {string} params.eventName
 * @param {string} [params.eventDate]
 * @param {string} [params.timeslotStart]
 * @param {string} [params.timeslotEnd]
 * @param {string} [params.venue]
 * @param {number} params.amount           Paid amount in INR
 * @param {string} params.registrationId
 * @returns {Promise<void>}
 */
async function sendConfirmationEmail(to, params) {
  const { userName, eventName, eventDate, timeslotStart, timeslotEnd, venue, amount, registrationId } = params;

  const fmtDate = (d) => d
    ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })
    : '\u2014';
  const fmtTime = (d) => d
    ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
    : '\u2014';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Registration Confirmed</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f4f5; margin: 0; padding: 0; }
    .wrapper { max-width: 480px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .header { background: #14532d; padding: 28px 32px; }
    .header h1 { color: #ffffff; margin: 0; font-size: 22px; font-weight: 700; }
    .header p { color: #86efac; margin: 4px 0 0; font-size: 13px; }
    .body { padding: 32px; }
    .badge { display: inline-block; background: #dcfce7; color: #14532d; padding: 6px 14px; border-radius: 999px; font-weight: 700; font-size: 13px; margin-bottom: 20px; }
    .detail-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    .detail-table td { padding: 8px 0; font-size: 13px; border-bottom: 1px solid #f3f4f6; }
    .detail-table td:first-child { color: #6b7280; width: 38%; }
    .detail-table td:last-child { color: #111827; font-weight: 500; }
    .footer { border-top: 1px solid #e5e7eb; padding: 20px 32px; text-align: center; }
    .footer p { color: #9ca3af; font-size: 11px; margin: 0; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>Tech Fest</h1>
      <p>Registration System</p>
    </div>
    <div class="body">
      <p style="color:#374151;font-size:15px;margin-bottom:12px;">Hi ${userName || 'there'},</p>
      <div class="badge">Registration Confirmed!</div>
      <p style="color:#374151;font-size:14px;margin-bottom:20px;">Your spot at <strong>${eventName}</strong> is confirmed.</p>
      <table class="detail-table">
        <tr><td>Event</td><td>${eventName}</td></tr>
        <tr><td>Date</td><td>${fmtDate(eventDate)}</td></tr>
        <tr><td>Time</td><td>${fmtTime(timeslotStart)} - ${fmtTime(timeslotEnd)}</td></tr>
        <tr><td>Venue</td><td>${venue || '\u2014'}</td></tr>
        <tr><td>Amount Paid</td><td>Rs.${Number(amount).toFixed(2)}</td></tr>
        <tr><td>Booking ID</td><td style="font-size:11px;word-break:break-all">${registrationId}</td></tr>
      </table>
      <p style="color:#6b7280;font-size:12px;">Present your QR code at the event entry. Log in to download your PDF ticket.</p>
    </div>
    <div class="footer"><p>Tech Fest Registration System</p></div>
  </div>
</body>
</html>`;

  await getTransporter().sendMail({
    from:    `"Tech Fest" <${env.SMTP_FROM}>`,
    to,
    subject: `Confirmed: Your ticket for ${eventName}`,
    html,
    text: `Hi ${userName},\n\nYour registration for ${eventName} is confirmed!\nDate: ${fmtDate(eventDate)}\nVenue: ${venue || 'TBD'}\nAmount Paid: Rs.${Number(amount).toFixed(2)}\nBooking ID: ${registrationId}\n\nPresent your QR code at entry.`,
  });

  console.log(`[email] Confirmation sent to ${to} for event: ${eventName}`);
}

/**
 * Sends a cancellation and refund notification email.
 * Triggered by registration.service.cancelRegistration (fire-and-forget).
 *
 * @param {string} to
 * @param {object} params
 * @param {string} params.userName
 * @param {string} params.eventName
 * @param {number} params.refundAmount    50% of paidAmount
 * @param {number} params.paidAmount      Original paid amount
 * @param {string} params.registrationId
 * @param {string} params.paymentMethod   'RAZORPAY' | 'CASH'
 * @returns {Promise<void>}
 */
async function sendCancellationEmail(to, params) {
  const { userName, eventName, refundAmount, paidAmount, registrationId, paymentMethod } = params;

  const refundNote = paymentMethod === 'CASH'
    ? `A manual refund of Rs.${Number(refundAmount).toFixed(2)} (50%) will be processed by our team within 3-5 business days.`
    : `A refund of Rs.${Number(refundAmount).toFixed(2)} (50% of Rs.${Number(paidAmount).toFixed(2)}) has been initiated to your original payment method. Allow 5-7 business days.`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Registration Cancelled</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f4f5; margin: 0; padding: 0; }
    .wrapper { max-width: 480px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .header { background: #7c2d12; padding: 28px 32px; }
    .header h1 { color: #ffffff; margin: 0; font-size: 22px; font-weight: 700; }
    .header p { color: #fdba74; margin: 4px 0 0; font-size: 13px; }
    .body { padding: 32px; }
    .badge { display: inline-block; background: #fee2e2; color: #7c2d12; padding: 6px 14px; border-radius: 999px; font-weight: 700; font-size: 13px; margin-bottom: 20px; }
    .detail-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .detail-table td { padding: 8px 0; font-size: 13px; border-bottom: 1px solid #f3f4f6; }
    .detail-table td:first-child { color: #6b7280; width: 38%; }
    .detail-table td:last-child { color: #111827; font-weight: 500; }
    .refund-box { background: #fef9c3; border-left: 3px solid #f59e0b; padding: 14px 16px; border-radius: 4px; font-size: 13px; color: #78350f; margin-bottom: 20px; }
    .footer { border-top: 1px solid #e5e7eb; padding: 20px 32px; text-align: center; }
    .footer p { color: #9ca3af; font-size: 11px; margin: 0; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>Tech Fest</h1>
      <p>Registration System</p>
    </div>
    <div class="body">
      <p style="color:#374151;font-size:15px;margin-bottom:12px;">Hi ${userName || 'there'},</p>
      <div class="badge">Registration Cancelled</div>
      <p style="color:#374151;font-size:14px;margin-bottom:4px;">Your registration for <strong>${eventName}</strong> has been cancelled.</p>
      <table class="detail-table">
        <tr><td>Event</td><td>${eventName}</td></tr>
        <tr><td>Booking ID</td><td style="font-size:11px;word-break:break-all">${registrationId}</td></tr>
        <tr><td>Amount Paid</td><td>Rs.${Number(paidAmount).toFixed(2)}</td></tr>
        <tr><td>Refund (50%)</td><td>Rs.${Number(refundAmount).toFixed(2)}</td></tr>
      </table>
      <div class="refund-box">${refundNote}</div>
      <p style="color:#6b7280;font-size:12px;">Questions? Contact support with your Booking ID.</p>
    </div>
    <div class="footer"><p>Tech Fest Registration System</p></div>
  </div>
</body>
</html>`;

  await getTransporter().sendMail({
    from:    `"Tech Fest" <${env.SMTP_FROM}>`,
    to,
    subject: `Cancellation confirmed for ${eventName}`,
    html,
    text: `Hi ${userName},\n\nYour registration for ${eventName} has been cancelled.\nBooking ID: ${registrationId}\nAmount Paid: Rs.${Number(paidAmount).toFixed(2)}\nRefund (50%): Rs.${Number(refundAmount).toFixed(2)}\n\n${refundNote}`,
  });

  console.log(`[email] Cancellation email sent to ${to} for event: ${eventName}`);
}

module.exports = { sendOtpEmail, sendConfirmationEmail, sendCancellationEmail };
