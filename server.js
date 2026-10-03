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
const paymentKeys = ['STRIPE_SECRET_KEY', 'MEMBER_PRICE_ID', 'DROPIN_PRICE_ID'];
const partialStripe = paymentKeys.some((key) => env[key]) && !paymentKeys.every((key) => env[key]);
const stripe = env.STRIPE_SECRET_KEY ? new (require('stripe'))(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 15000 }) : null;
if (partialStripe) console.error('[payments] Incomplete Stripe configuration. Enrollment is closed.');

function pickLedger() {
  if (env.STRIPE_SECRET_KEY && env.MEMBER_PRICE_ID && env.DROPIN_PRICE_ID) {
    console.log('[payments] Stripe checkout is on.');
    return createStripeLedger({
      stripe, program,
      prices: { member: env.MEMBER_PRICE_ID, dropin: env.DROPIN_PRICE_ID },
      portalConfiguration: env.BILLING_PORTAL_CONFIG_ID,
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
  const dataDir = env.DATA_DIR || (onVercel ? path.join(require('os').tmpdir(), 'reading-club') : path.join(__dirname, 'data'));
  if (onVercel) console.warn('[storage] No Redis connected. Reservations go to /tmp and WILL be lost. Signups stay closed until Redis is added.');
  return createLocalLedger({ program, store: createFileStore(dataDir) });
}

const ledger = pickLedger();
// Never take real signups somewhere they'd be lost.
const durable = ledger.mode === 'stripe' || ledger.storage === 'redis' || !onVercel;
const mailAvailable = Boolean(env.RESEND_API_KEY && env.MAIL_FROM);
const onPageDelivery = env.EMAIL_DELIVERY_MODE === 'on_page';
const paymentReady = ledger.mode !== 'stripe' || Boolean(env.STRIPE_WEBHOOK_SECRET && env.LOGIN_SECRET && (mailAvailable || onPageDelivery));
const enrollmentOpen = durable && !partialStripe && paymentReady && env.ENROLLMENT_OPEN === 'true';
if (!env.LOGIN_SECRET) console.warn('[config] LOGIN_SECRET is not set. Member sign-in is off.');

const app = createApp({
  ledger, program,
  siteUrl: resolveSiteUrl(env),
  privateInfo: loadPrivate(env),
  portalUrl: env.BILLING_PORTAL_URL,
  loginSecret: env.LOGIN_SECRET,
  notifyEmail: env.NOTIFY_EMAIL,
  stripe, webhookSecret: env.STRIPE_WEBHOOK_SECRET, mailAvailable, onPageDelivery,
  enrollmentOpen,
  mailer: resendMailer({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM }),
});

if (require.main === module) {
  const PORT = env.PORT || 3000;
  app.listen(PORT, () => console.log(`Reading Club on http://localhost:${PORT}`));
}

module.exports = app;
