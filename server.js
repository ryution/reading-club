'use strict';
// Builds the site from environment variables. Works as a normal Node server
// (npm start, Render) and as a Vercel function (Vercel imports the exported app).

const path = require('path');
require('express'); // Vercel finds the entry point by its Express import
const { loadLocalEnv, resolveSiteUrl, parseSourcePromos } = require('./config');
const { createApp, loadProgram, loadPrivate } = require('./lib/app');
const { createLocalLedger, createFileStore, createRedisStore } = require('./lib/ledger-local');
const { createStripeLedger } = require('./lib/ledger-stripe');
const { resendMailer } = require('./lib/login');

loadLocalEnv();
const env = process.env;
const program = loadProgram();
const onVercel = Boolean(env.VERCEL);

function pickLedger() {
  if (env.STRIPE_SECRET_KEY && env.MEMBER_PRICE_ID && env.DROPIN_PRICE_ID) {
    const Stripe = require('stripe');
    console.log('[payments] Stripe checkout is on.');
    return createStripeLedger({
      stripe: new Stripe(env.STRIPE_SECRET_KEY), program,
      prices: { member: env.MEMBER_PRICE_ID, dropin: env.DROPIN_PRICE_ID },
      sourcePromos: parseSourcePromos(env.SOURCE_PROMOS),
    });
  }
  const redisUrl = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const redisToken = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (redisUrl && redisToken) {
    console.log('[payments] Stripe is off. Reservations are saved to Redis.');
    return createLocalLedger({ program, store: createRedisStore({ url: redisUrl, token: redisToken }) });
  }
  // Vercel's disk is read-only apart from /tmp, and /tmp is wiped often.
  const dataDir = env.DATA_DIR || (onVercel ? '/tmp/reading-club' : path.join(__dirname, 'data'));
  if (onVercel) console.warn('[storage] No Redis connected. Reservations go to /tmp and WILL be lost. Signups stay closed until Redis is added.');
  return createLocalLedger({ program, store: createFileStore(dataDir) });
}

const ledger = pickLedger();
// Never take real signups somewhere they'd be lost.
const durable = ledger.mode === 'stripe' || ledger.storage === 'redis' || !onVercel;
const enrollmentOpen = durable && env.ENROLLMENT_OPEN !== 'false';
if (!env.LOGIN_SECRET) console.warn('[config] LOGIN_SECRET is not set. Member sign-in is off.');

const app = createApp({
  ledger, program,
  siteUrl: resolveSiteUrl(env),
  privateInfo: loadPrivate(env),
  portalUrl: env.BILLING_PORTAL_URL,
  loginSecret: env.LOGIN_SECRET,
  notifyEmail: env.NOTIFY_EMAIL,
  enrollmentOpen,
  mailer: resendMailer({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM || 'Reading Club <onboarding@resend.dev>' }),
});

if (require.main === module) {
  const PORT = env.PORT || 3000;
  app.listen(PORT, () => console.log(`Reading Club on http://localhost:${PORT}`));
}

module.exports = app;
