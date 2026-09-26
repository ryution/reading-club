'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const Stripe = require('stripe');
const { loadLocalEnv, validateConfig, missingDetails } = require('./config');
const defaultDetails = require('./club-details.json');

// The one product this site sells. The server refuses to open Checkout unless
// the configured Stripe Price matches these values exactly.
const EXPECTED_PRICE = { unit_amount: 45000, currency: 'usd', type: 'one_time' };

// Tags every Checkout Session so enrollments for this term can be counted.
// Change this for the next term so the seat count starts over.
const PROGRAM = 'reading-club-good-life-2026';
const DEFAULT_CAPACITY = 60;

const PAGES = path.join(__dirname, 'pages');
const read = (name) => fs.readFileSync(path.join(PAGES, name), 'utf8');
const TEMPLATES = { index: read('index.html'), result: read('result.html') };

const NOTICES = {
  canceled: 'You returned from checkout. If you did not finish paying, you can try again. If you already paid, check your email for a receipt before trying again.',
  full: 'All places are enrolled or currently held in checkout. If a place becomes available, you can try again later.',
  unavailable: 'Online enrollment is not available right now. Please try again later.',
  pending: 'Enrollment opens once the class details are confirmed. Please check back soon.',
  busy: 'Another checkout is opening. Please wait a few seconds, then try again.',
};

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function renderIndex(noticeKey, details, ready) {
  const text = NOTICES[noticeKey];
  const notice = text ? `<p class="notice" role="status">${text}</p>` : '';
  const values = {
    START_DATE: escapeHtml(details.startDate),
    LECTURE: escapeHtml(details.lectureSchedule || 'Schedule to be announced.'),
    GROUPS: escapeHtml(details.smallGroupSchedule || 'Schedule to be announced.'),
    LOCATION: escapeHtml(details.location || 'Location or online format to be announced.'),
    REFUNDS: escapeHtml(details.refundPolicy || 'Refund policy will be published before enrollment opens.'),
    CONTACT: missingDetails(details).includes('contactEmail') ? '' : `<p>Questions? <a href="mailto:${escapeHtml(details.contactEmail)}">${escapeHtml(details.contactEmail)}</a></p>`,
    BUTTON: ready ? 'Enroll in Reading Club' : 'Enrollment opens soon',
    DISABLED: ready ? '' : 'disabled',
  };
  // A replacement callback keeps dollar signs in organizer-supplied text literal.
  return TEMPLATES.index.replace('<!--NOTICE-->', () => notice)
    .replace(/<!--(START_DATE|LECTURE|GROUPS|LOCATION|REFUNDS|CONTACT|BUTTON|DISABLED)-->/g, (_, key) => values[key]);
}

function renderResult({ title, body }) {
  return TEMPLATES.result.replace('<!--TITLE-->', title).replace('<!--BODY-->', body);
}

const CONFIRMED = renderResult({
  title: 'You’re in',
  body: `
    <h1>You’re in.</h1>
    <p class="lead">Welcome to Reading Club: The Good Life.</p>
    <p>We begin <!--START_DATE-->.</p>
    <p>The club team will email you the readings and small-group joining details before the first class.</p>
    <!--CONTACT-->
    <p>We look forward to reading with you.</p>`,
});

// Bank payments finish checkout before the money arrives.
const PROCESSING = renderResult({
  title: 'Payment processing',
  body: `
    <h1>Your payment is processing.</h1>
    <p class="lead">Your payment is still processing.</p>
    <p>Your enrollment is confirmed once payment clears. Please check your receipt or contact the club team before paying again.</p>
    <!--CONTACT-->`,
});

const NOT_CONFIRMED = renderResult({
  title: 'Payment not confirmed',
  body: `
    <h1>We could not confirm your payment.</h1>
    <p>If you tried to pay, check your email for a receipt or contact the club team before paying again.</p>
    <!--CONTACT-->
    <p><a href="/">Return to Reading Club</a></p>`,
});

function priceProblem(price) {
  if (!price.active) return 'price is archived';
  for (const [key, want] of Object.entries(EXPECTED_PRICE)) {
    if (price[key] !== want) return `${key} is ${JSON.stringify(price[key])}, expected ${JSON.stringify(want)}`;
  }
  return null;
}

function checkoutParams(priceId, base) {
  return {
    mode: 'payment', // one-time charge, never a subscription
    payment_method_types: ['card'],
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    line_items: [{ price: priceId, quantity: 1 }],
    custom_fields: [
      { key: 'full_name', label: { type: 'custom', custom: 'Full name' }, type: 'text' },
    ],
    customer_creation: 'always', // saves name/email on a Stripe Customer
    submit_type: 'pay',
    metadata: { program: PROGRAM },
    payment_intent_data: {
      description: 'Reading Club: The Good Life (six-week term)',
      metadata: { program: PROGRAM },
    },
    success_url: `${base}/enrolled?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/?canceled=1`,
  };
}

// Every completed checkout for this term, newest first. Stripe is the record.
async function* listEnrollments(stripe) {
  for await (const s of stripe.checkout.sessions.list({ status: 'complete', limit: 100 })) {
    if (s.metadata && s.metadata.program === PROGRAM) yield s;
  }
}

// Include open checkouts: visitors already paying need to occupy a place too.
async function countReservedSeats(stripe) {
  let n = 0;
  for await (const s of stripe.checkout.sessions.list({ limit: 100 })) {
    if (s.metadata?.program === PROGRAM && (s.status === 'complete' ||
        (s.status === 'open' && s.expires_at > Date.now() / 1000))) n++;
  }
  return n;
}

async function countEnrollments(stripe) {
  let n = 0;
  for await (const _ of listEnrollments(stripe)) n++; // eslint-disable-line no-unused-vars
  return n;
}

function createApp({ stripe, priceId, siteUrl, capacity = DEFAULT_CAPACITY, details = defaultDetails, enrollmentOpen = false, production = false, log = console }) {
  siteUrl = validateConfig({ siteUrl, capacity, production });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // correct https return links behind a hosting proxy

  const ready = enrollmentOpen && missingDetails(details).length === 0 && Boolean(stripe && priceId);
  const result = (html) => html.replace('<!--START_DATE-->', () => escapeHtml(details.startDate))
    .replace('<!--CONTACT-->', () => missingDetails(details).includes('contactEmail') ? '' :
      `<p>Questions? <a href="mailto:${escapeHtml(details.contactEmail)}">${escapeHtml(details.contactEmail)}</a></p>`);
  // Serialize count + create within this process. Keep the deployment at one instance.
  let checkoutBusy = false;

  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'none'" });
    next();
  });

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  app.get('/', (req, res) => {
    const q = req.query;
    const key = q.canceled ? 'canceled' : q.full ? 'full' : q.error === 'busy' ? 'busy' : q.error ? 'unavailable' : !ready ? 'pending' : null;
    res.set('Cache-Control', 'no-store').type('html').send(renderIndex(key, details, ready));
  });

  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', index: false }));
  app.use('/fonts', express.static(path.join(__dirname, 'node_modules/@fontsource/eb-garamond/files'), { maxAge: '30d' }));

  app.post('/checkout', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!stripe || !priceId) {
      log.error('[checkout] Stripe is not configured: set STRIPE_SECRET_KEY and STRIPE_PRICE_ID.');
      return res.redirect(303, '/?error=config');
    }
    if (!ready) return res.redirect(303, '/');
    if (checkoutBusy) return res.redirect(303, '/?error=busy');
    checkoutBusy = true;
    const base = siteUrl || `${req.protocol}://${req.get('host')}`;
    try {
      const problem = priceProblem(await stripe.prices.retrieve(priceId));
      if (problem) {
        log.error(`[checkout] STRIPE_PRICE_ID ${priceId} is not a $450 one-time USD price (${problem}). Refusing to open Checkout.`);
        return res.redirect(303, '/?error=price');
      }
      const enrolled = await countReservedSeats(stripe);
      if (enrolled >= capacity) {
        log.warn(`[checkout] Full: ${enrolled} of ${capacity} places taken.`);
        return res.redirect(303, '/?full=1');
      }
      const session = await stripe.checkout.sessions.create(checkoutParams(priceId, base));
      return res.redirect(303, session.url);
    } catch (err) {
      log.error('[checkout] Stripe error:', err.message);
      return res.redirect(303, '/?error=stripe');
    } finally {
      checkoutBusy = false;
    }
  });

  // Only show "You're in" after Stripe confirms this session.
  app.get('/enrolled', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.query.session_id || '');
    if (!stripe || !/^cs_[A-Za-z0-9_]+$/.test(id)) {
      return res.status(400).type('html').send(result(NOT_CONFIRMED));
    }
    try {
      const session = await stripe.checkout.sessions.retrieve(id);
      const belongsToClub = session.metadata?.program === PROGRAM && session.mode === 'payment' &&
        session.amount_total === EXPECTED_PRICE.unit_amount && session.currency === EXPECTED_PRICE.currency;
      if (!belongsToClub || session.status !== 'complete') return res.status(402).type('html').send(result(NOT_CONFIRMED));
      if (session.payment_status === 'paid') return res.type('html').send(result(CONFIRMED));
      if (session.payment_status === 'unpaid') return res.type('html').send(result(PROCESSING));
      return res.status(402).type('html').send(result(NOT_CONFIRMED));
    } catch (err) {
      log.error('[enrolled] Could not retrieve session:', err.message);
      return res.status(400).type('html').send(result(NOT_CONFIRMED));
    }
  });

  app.use((req, res) => res.status(404).type('html').send(renderResult({
    title: 'Page not found',
    body: '<h1>Page not found.</h1><p><a href="/">Return to Reading Club</a></p>',
  })));

  return app;
}

if (require.main === module) {
  loadLocalEnv();
  const { STRIPE_SECRET_KEY, STRIPE_PRICE_ID, SITE_URL, PORT = 3000, NODE_ENV, ENROLLMENT_CAPACITY } = process.env;
  const missing = ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.warn(`[config] Missing ${missing.join(', ')}. The page will load with enrollment closed.`);
  }
  if (STRIPE_SECRET_KEY && /^(sk|rk)_live_/.test(STRIPE_SECRET_KEY) && NODE_ENV !== 'production') {
    console.warn('[config] A LIVE Stripe key is set outside production. Use an sk_test_ key for development.');
  }
  const missingContent = missingDetails(defaultDetails);
  if (missingContent.length) console.warn(`[config] Enrollment closed until club-details.json is complete: ${missingContent.join(', ')}.`);
  const capacity = ENROLLMENT_CAPACITY ? Number(ENROLLMENT_CAPACITY) : DEFAULT_CAPACITY;
  const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
  createApp({ stripe, priceId: STRIPE_PRICE_ID, siteUrl: SITE_URL, capacity,
    enrollmentOpen: process.env.ENROLLMENT_OPEN === 'true', production: NODE_ENV === 'production' })
    .listen(PORT, () => console.log(`Reading Club running on http://localhost:${PORT} (capacity ${capacity})`));
}

module.exports = { createApp, checkoutParams, priceProblem, listEnrollments, countEnrollments, countReservedSeats, EXPECTED_PRICE, PROGRAM };
