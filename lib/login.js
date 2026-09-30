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
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || !secret) return null;
  const want = sign(payload, secret);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof e === 'string' && x > now ? e : null;
  } catch { return null; }
}

// Sends through Resend's REST API with plain fetch. Without a key it only logs,
// which is enough for local testing.
function resendMailer({ apiKey, from, log = console }) {
  return async ({ to, subject, text }) => {
    if (!apiKey) { log.log(`[mail] (no RESEND_API_KEY) to ${to}: ${subject}\n${text}`); return; }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  };
}

module.exports = { makeToken, readToken, resendMailer };
