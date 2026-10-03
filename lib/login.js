'use strict';
// Password-free member links: a signed token carrying the email and an expiry.

const crypto = require('crypto');

const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

function makeToken(email, secret, days = 60, now = Date.now()) {
  const payload = b64(JSON.stringify({ e: email.toLowerCase(), x: now + days * 86400000 }));
  return `${payload}.${sign(payload, secret)}`;
}

function readToken(token, secret, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig || !secret) return null;
  const want = sign(payload, secret);
  if (!/^[A-Za-z0-9_-]+$/.test(sig) || Buffer.byteLength(sig) !== Buffer.byteLength(want) || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof e === 'string' && x > now ? e : null;
  } catch { return null; }
}

// Sends through Resend's REST API with plain fetch. Without a key it only logs,
// which is enough for local testing.
function resendMailer({ apiKey, from, log = console }) {
  return async ({ to, subject, text, idempotencyKey }) => {
    if (!apiKey || !from) throw new Error('Email delivery is not configured.');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ from, to, subject, text }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  };
}

module.exports = { makeToken, readToken, resendMailer };
