'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const Stripe = require('stripe');
const { createApp, checkoutParams, listEnrollments, countReservedSeats, PROGRAM } = require('../server');
const { validateConfig } = require('../config');
const { csv } = require('../scripts/roster');
const enrollment = (extra = {}) => ({ mode: 'payment', amount_total: 45000, currency: 'usd', status: 'complete', payment_status: 'paid', metadata: { program: PROGRAM }, ...extra });
const details = { startDate: 'October 15', lectureSchedule: 'Thursday 6pm ET', smallGroupSchedule: 'Monday and Wednesday 6pm ET', location: 'Online', contactEmail: 'club@example.com', refundPolicy: 'Test refund policy' };

const PRICE_ID = 'price_test_450';
const GOOD_PRICE = { id: PRICE_ID, active: true, unit_amount: 45000, currency: 'usd', type: 'one_time' };
const quietLog = { error() {}, warn() {}, log() {} };

function fakeStripe({ price = GOOD_PRICE, session, createError, retrieveError, completed = [] } = {}) {
  const calls = { create: [], retrieve: [], list: [] };
  return {
    calls,
    prices: { retrieve: async () => price },
    checkout: {
      sessions: {
        list: (params) => {
          calls.list.push(params);
          return (async function* () { yield* completed; })();
        },
        create: async (params) => {
          calls.create.push(params);
          if (createError) throw createError;
          return { id: 'cs_test_abc', url: 'https://checkout.stripe.com/c/pay/cs_test_abc' };
        },
        retrieve: async (id) => {
          calls.retrieve.push(id);
          if (retrieveError) throw retrieveError;
          return session;
        },
      },
    },
  };
}

async function serve(opts) {
  const server = createApp({ priceId: PRICE_ID, details, enrollmentOpen: true, log: quietLog, ...opts }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, init) => fetch(base + p, { redirect: 'manual', ...init });
  return { server, base, get, post: (p) => get(p, { method: 'POST' }) };
}

describe('landing page', () => {
  let s;
  before(async () => { s = await serve({ stripe: fakeStripe() }); });
  after(() => s.server.close());

  test('contains the supplied copy, pricing, and one action', async () => {
    const res = await s.get('/');
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    for (const text of [
      'Reading Club: The&nbsp;Good&nbsp;Life',
      'Six weeks. Six traditions. One question: How should we live?',
      'That is what Reading Club is for.',
      'Aristotle', 'Confucius', 'Laozi', 'Proverbs', 'Bhagavad Gita', 'Dhammapada',
      'It is a reading community built around serious study, conversation, and reflection.',
      'October 15', '6 weeks', '60 people',
      'Tuition: $25 per class hour.',
      'Tuition covers the weekly lecture and two small-group reading sessions.',
      '$450 for the complete <span class="nowrap">six-week term.</span>',
      'Read the Great Books. Find people to think with. Build a philosophy of your own.',
    ]) assert.ok(html.includes(text), `missing: ${text}`);
    const actions = [...html.matchAll(/<form method="post" action="([^"]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual([...new Set(actions)], ['/checkout'], 'every CTA goes to /checkout');
    assert.strictEqual((html.match(/>Enroll in Reading Club</g) || []).length, 2);
    assert.ok(!html.includes('sk_'), 'no secret key in page');
  });

  test('stylesheet and fonts load (no broken links)', async () => {
    const html = await (await s.get('/')).text();
    const css = await (await s.get('/styles.css')).text();
    const refs = [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g), ...css.matchAll(/url\((\/[^)]+)\)/g)].map((m) => m[1]);
    assert.ok(refs.length >= 4);
    for (const ref of new Set(refs)) {
      assert.strictEqual((await s.get(ref)).status, 200, `broken: ${ref}`);
    }
  });

  test('cancel return avoids claiming payment status without checking Stripe', async () => {
    const html = await (await s.get('/?canceled=1')).text();
    assert.ok(html.includes('You returned from checkout.'));
    assert.ok(html.includes('check your email for a receipt before trying again'));
  });

  test('unknown pages 404 with a way back', async () => {
    const res = await s.get('/nope');
    assert.strictEqual(res.status, 404);
    assert.ok((await res.text()).includes('href="/"'));
  });
});

describe('checkout', () => {
  test('creates a one-time $450 session and redirects to Stripe', async () => {
    const stripe = fakeStripe();
    const s = await serve({ stripe, siteUrl: 'https://club.example' });
    const res = await s.post('/checkout');
    s.server.close();
    assert.strictEqual(res.status, 303);
    assert.strictEqual(res.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_test_abc');
    const p = stripe.calls.create[0];
    assert.strictEqual(p.mode, 'payment');
    assert.deepStrictEqual(p.line_items, [{ price: PRICE_ID, quantity: 1 }]);
    assert.strictEqual(p.custom_fields[0].key, 'full_name');
    assert.strictEqual(p.success_url, 'https://club.example/enrolled?session_id={CHECKOUT_SESSION_ID}');
    assert.strictEqual(p.cancel_url, 'https://club.example/?canceled=1');
  });

  test('missing environment variables: page loads, checkout shows unavailable', async () => {
    const s = await serve({ stripe: null, priceId: undefined });
    assert.strictEqual((await s.get('/')).status, 200);
    const res = await s.post('/checkout');
    assert.strictEqual(res.status, 303);
    assert.strictEqual(res.headers.get('location'), '/?error=config');
    const html = await (await s.get('/?error=config')).text();
    s.server.close();
    assert.ok(html.includes('Online enrollment is not available right now.'));
  });

  for (const [label, price] of [
    ['recurring price', { ...GOOD_PRICE, type: 'recurring' }],
    ['wrong amount', { ...GOOD_PRICE, unit_amount: 2500 }],
    ['archived price', { ...GOOD_PRICE, active: false }],
  ]) {
    test(`refuses to open Checkout for a misconfigured price (${label})`, async () => {
      const stripe = fakeStripe({ price });
      const s = await serve({ stripe });
      const res = await s.post('/checkout');
      s.server.close();
      assert.strictEqual(res.headers.get('location'), '/?error=price');
      assert.strictEqual(stripe.calls.create.length, 0);
    });
  }

  test('tags the session so this term\'s enrollments can be counted', async () => {
    const stripe = fakeStripe();
    const s = await serve({ stripe });
    await s.post('/checkout');
    s.server.close();
    const p = stripe.calls.create[0];
    assert.strictEqual(p.metadata.program, PROGRAM);
    assert.strictEqual(p.payment_intent_data.metadata.program, PROGRAM);
    assert.strictEqual(stripe.calls.list[0].status, undefined, 'counts open checkouts as well as completed ones');
  });

  test('capacity: seat 60 can still be sold', async () => {
    const stripe = fakeStripe({ completed: Array.from({ length: 59 }, () => enrollment()) });
    const s = await serve({ stripe });
    const res = await s.post('/checkout');
    s.server.close();
    assert.strictEqual(res.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_test_abc');
  });

  test('capacity: at 60 enrolled, Checkout does not open and the page says full', async () => {
    const stripe = fakeStripe({ completed: Array.from({ length: 60 }, () => enrollment()) });
    const s = await serve({ stripe });
    const res = await s.post('/checkout');
    const html = await (await s.get(res.headers.get('location'))).text();
    s.server.close();
    assert.strictEqual(res.headers.get('location'), '/?full=1');
    assert.strictEqual(stripe.calls.create.length, 0);
    assert.ok(html.includes('All places are enrolled or currently held in checkout.'));
  });

  test('capacity: other Stripe sales on the account are not counted', async () => {
    const other = Array.from({ length: 80 }, () => enrollment({ metadata: { program: 'something-else' } }));
    const noTag = Array.from({ length: 10 }, () => enrollment({ metadata: {} }));
    const stripe = fakeStripe({ completed: [...other, ...noTag, enrollment()] });
    let n = 0; for await (const _ of listEnrollments(stripe)) n++; // eslint-disable-line no-unused-vars
    assert.strictEqual(n, 1);
  });

  test('capacity check failing closes enrollment rather than overselling', async () => {
    const stripe = fakeStripe();
    stripe.checkout.sessions.list = () => (async function* () { throw new Error('Stripe down'); })();
    const s = await serve({ stripe });
    const res = await s.post('/checkout');
    s.server.close();
    assert.strictEqual(res.headers.get('location'), '/?error=stripe');
    assert.strictEqual(stripe.calls.create.length, 0);
  });

  test('behind an https proxy, return links use https', async () => {
    const stripe = fakeStripe();
    const s = await serve({ stripe });
    await s.get('/checkout', { method: 'POST', headers: { 'X-Forwarded-Proto': 'https' } });
    s.server.close();
    assert.ok(stripe.calls.create[0].success_url.startsWith('https://'));
  });

  test('Stripe API error returns the user to the page with a notice', async () => {
    const s = await serve({ stripe: fakeStripe({ createError: new Error('boom') }) });
    const res = await s.post('/checkout');
    s.server.close();
    assert.strictEqual(res.headers.get('location'), '/?error=stripe');
  });
});

describe('confirmation page', () => {
  test('paid session shows the confirmation copy', async () => {
    const s = await serve({ stripe: fakeStripe({ session: enrollment() }) });
    const res = await s.get('/enrolled?session_id=cs_test_abc');
    s.server.close();
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    for (const text of [
      'You’re in.', 'Welcome to Reading Club: The Good Life.', 'We begin October 15.',
      'The club team will email you the readings and small-group joining details before the first class.',
      'We look forward to reading with you.',
    ]) assert.ok(html.includes(text), `missing: ${text}`);
  });

  test('bank payment still clearing: place held, not an error', async () => {
    const s = await serve({ stripe: fakeStripe({ session: enrollment({ payment_status: 'unpaid' }) }) });
    const res = await s.get('/enrolled?session_id=cs_test_abc');
    s.server.close();
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Your payment is processing.'));
    assert.ok(!html.includes('could not confirm'));
  });

  test('checkout not finished (e.g. card declined, tab closed) is not confirmed', async () => {
    const s = await serve({ stripe: fakeStripe({ session: { status: 'open', payment_status: 'unpaid' } }) });
    const res = await s.get('/enrolled?session_id=cs_test_abc');
    s.server.close();
    assert.strictEqual(res.status, 402);
    assert.ok(!(await res.text()).includes('You’re in.'));
  });

  test('visiting /enrolled directly or with a forged id does not confirm', async () => {
    const stripe = fakeStripe({ retrieveError: new Error('No such checkout.session') });
    const s = await serve({ stripe });
    for (const q of ['', '?session_id=', '?session_id=<script>', '?session_id=cs_test_forged']) {
      const res = await s.get('/enrolled' + q);
      assert.strictEqual(res.status, 400, q);
      assert.ok(!(await res.text()).includes('You’re in.'));
    }
    s.server.close();
    assert.deepStrictEqual(stripe.calls.retrieve, ['cs_test_forged'], 'malformed ids never reach Stripe');
  });
});

describe('launch safeguards', () => {
  test('pending class details or a closed enrollment flag block checkout even with keys', async () => {
    for (const opts of [{ details: { ...details, location: '' } }, { enrollmentOpen: false }]) {
      const stripe = fakeStripe();
      const s = await serve({ stripe, ...opts });
      try {
        const html = await (await s.get('/')).text();
        assert.ok(html.includes('Enrollment opens soon'));
        assert.strictEqual((await s.post('/checkout')).headers.get('location'), '/');
        assert.strictEqual(stripe.calls.create.length, 0);
      } finally { s.server.close(); }
    }
  });

  test('published details are escaped, including literal dollar substitutions', async () => {
    const s = await serve({ stripe: fakeStripe(), details: { ...details, location: '<script>alert(1)</script> $&' } });
    try {
      const html = await (await s.get('/')).text();
      assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; $&amp;'));
      assert.ok(!html.includes('<!--LOCATION-->'));
    } finally { s.server.close(); }
  });

  test('wrong program, amount, currency, mode and incomplete payments cannot confirm enrollment', async () => {
    for (const extra of [{ metadata: {} }, { metadata: { program: 'other' } }, { amount_total: 100 },
      { currency: 'eur' }, { mode: 'subscription' }, { status: 'open' }, { payment_status: 'no_payment_required' }]) {
      const s = await serve({ stripe: fakeStripe({ session: enrollment(extra) }) });
      try {
        const res = await s.get('/enrolled?session_id=cs_test_abc');
        assert.strictEqual(res.status, 402);
        assert.strictEqual(res.headers.get('cache-control'), 'no-store');
        assert.ok(!(await res.text()).includes('You’re in.'));
      } finally { s.server.close(); }
    }
  });

  test('open reservations count, expired and unrelated checkouts do not', async () => {
    const stripe = fakeStripe({ completed: [enrollment(),
      enrollment({ status: 'open', expires_at: Date.now() / 1000 + 600 }),
      enrollment({ status: 'open', expires_at: Date.now() / 1000 - 1 }),
      enrollment({ status: 'expired' }), enrollment({ metadata: { program: 'other' } })] });
    assert.strictEqual(await countReservedSeats(stripe), 2);
  });

  test('an open checkout for the final seat blocks another sale', async () => {
    const stripe = fakeStripe({ completed: [enrollment({ status: 'open', expires_at: Date.now() / 1000 + 600 })] });
    const s = await serve({ stripe, capacity: 1 });
    try {
      assert.strictEqual((await s.post('/checkout')).headers.get('location'), '/?full=1');
      assert.strictEqual(stripe.calls.create.length, 0);
    } finally { s.server.close(); }
  });

  test('concurrent requests cannot both create a checkout in one process', async () => {
    const stripe = fakeStripe();
    let release;
    let entered;
    const didEnter = new Promise((resolve) => { entered = resolve; });
    stripe.prices.retrieve = async () => { entered(); await new Promise((resolve) => { release = resolve; }); return GOOD_PRICE; };
    const s = await serve({ stripe, capacity: 1 });
    try {
      const first = s.post('/checkout');
      await didEnter;
      assert.strictEqual((await s.post('/checkout')).headers.get('location'), '/?error=busy');
      release();
      assert.ok((await first).headers.get('location').startsWith('https://checkout.stripe.com'));
      assert.strictEqual(stripe.calls.create.length, 1);
    } finally { release?.(); s.server.close(); }
  });

  test('a price archived after an earlier checkout is rejected', async () => {
    const stripe = fakeStripe();
    const s = await serve({ stripe });
    try {
      await s.post('/checkout');
      stripe.prices.retrieve = async () => ({ ...GOOD_PRICE, active: false });
      assert.strictEqual((await s.post('/checkout')).headers.get('location'), '/?error=price');
      assert.strictEqual(stripe.calls.create.length, 1);
    } finally { s.server.close(); }
  });

  test('checkout only accepts cards and expires abandoned sessions', () => {
    const params = checkoutParams(PRICE_ID, 'https://example.com');
    assert.deepStrictEqual(params.payment_method_types, ['card']);
    assert.ok(params.expires_at > Date.now() / 1000 + 1800);
    assert.ok(params.expires_at <= Date.now() / 1000 + 1860);
  });

  test('production requires a trusted HTTPS origin and a valid capacity', () => {
    for (const siteUrl of [undefined, 'http://example.com', 'https://example.com/path', 'https://a:b@example.com', 'https://example.com/?x=1']) {
      assert.throws(() => validateConfig({ siteUrl, capacity: 60, production: true }));
    }
    for (const capacity of [NaN, 0, -1, 1.5, Infinity]) assert.throws(() => validateConfig({ capacity }));
    assert.strictEqual(validateConfig({ siteUrl: 'https://example.com/', capacity: 60, production: true }), 'https://example.com');
  });

  test('roster cells cannot become spreadsheet formulas', () => {
    for (const input of ['=1+1', '+cmd', '-1', '@SUM(A1)', '  =1', '\t=1']) {
      assert.ok(csv(input).startsWith('"\''));
    }
    assert.strictEqual(csv('Jane "J" Doe'), '"Jane ""J"" Doe"');
  });
});

// Real Stripe SDK against stripe-mock (Stripe's official API mock), which
// validates requests against Stripe's OpenAPI spec. Skipped if not running.
describe('Stripe API contract (stripe-mock)', () => {
  const mock = new Stripe('sk_test_123', { host: 'localhost', port: 12111, protocol: 'http' });
  let up = false;
  before(async () => { up = await fetch('http://localhost:12111/v1/prices', { headers: { Authorization: 'Bearer sk_test_123' } }).then(() => true, () => false); });

  test('Checkout Session params are accepted by the Stripe API', async (t) => {
    if (!up) return t.skip('stripe-mock not running');
    const session = await mock.checkout.sessions.create(checkoutParams('price_1234', 'https://club.example'));
    assert.strictEqual(session.object, 'checkout.session');
  });

  test('a bad parameter is rejected (the mock really validates)', async (t) => {
    if (!up) return t.skip('stripe-mock not running');
    await assert.rejects(mock.checkout.sessions.create({ ...checkoutParams('price_1234', 'https://x'), mode: 'monthly' }));
  });

  test('the enrollment count query is valid', async (t) => {
    if (!up) return t.skip('stripe-mock not running');
    let n = 0; for await (const _ of listEnrollments(mock)) n++; // eslint-disable-line no-unused-vars
    assert.ok(n >= 0);
  });

  test('Price and Session retrieval calls are valid', async (t) => {
    if (!up) return t.skip('stripe-mock not running');
    assert.strictEqual((await mock.prices.retrieve('price_1234')).object, 'price');
    const s = await mock.checkout.sessions.retrieve('cs_test_abc');
    assert.ok(['paid', 'unpaid', 'no_payment_required'].includes(s.payment_status));
  });
});
