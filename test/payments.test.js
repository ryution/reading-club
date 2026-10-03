'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const { createApp, loadProgram } = require('../lib/app');
const { createStripeLedger, checkoutParams } = require('../lib/ledger-stripe');
const { resolveSiteUrl } = require('../config');
const { readToken, makeToken } = require('../lib/login');
const { fakeStripe } = require('./fake-stripe');
const program = loadProgram();
delete program.billing; // Legacy purchases keep their original subscription terms.
const quiet = { error() {}, warn() {}, log() {} };
const prices = { member: 'price_member', dropin: 'price_dropin' };
const secret = 'payment-tests-only';
const date = '2026-10-19';
function session(extra = {}) {
  return { id: 'cs_test_paid', status: 'complete', payment_status: 'paid', mode: 'payment', currency: 'usd', amount_total: 4000,
    metadata: { program: program.program, section: 'a', plan: 'dropin', date }, customer: 'cus_1',
    customer_details: { email: 'reader@example.com' }, line_items: { data: [{ price: { id: prices.dropin }, quantity: 1 }] }, ...extra };
}
function setup(sessions = [], subs = [], options = {}) {
  const stripe = fakeStripe({ program, sessions, subs, customers: [{ id: 'cus_1', email: 'reader@example.com' }] });
  stripe.webhooks = new Stripe('sk_test_fake').webhooks;
  const ledger = createStripeLedger({ stripe, program, prices, log: quiet, ...options });
  return { stripe, ledger };
}
async function serve(t, opts) {
  const sent = [];
  const app = createApp({ program, loginSecret: secret, siteUrl: 'https://club.example.com', webhookSecret: 'whsec_test',
    now: () => new Date('2026-10-01T15:00:00Z'), log: quiet, mailer: async (m) => sent.push(m), ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const get = (url, options) => fetch(`http://127.0.0.1:${server.address().port}${url}`, { redirect: 'manual', ...options });
  return { sent, get, post: (form, headers) => get('/checkout', { method: 'POST', body: new URLSearchParams(form), headers }) };
}

test('unpaid checkout cannot reveal a member link or calendar or appear as enrollment', async (t) => {
  const env = setup([session({ payment_status: 'unpaid' })]);
  const s = await serve(t, env);
  const welcome = await (await s.get('/welcome?id=cs_test_paid')).text();
  assert.match(welcome, /payment is processing/);
  assert.doesNotMatch(welcome, /\/my\?t=|Add to my calendar|You’re in/);
  assert.equal((await s.get('/calendar.ics?id=cs_test_paid')).status, 404);
  assert.deepEqual(await env.ledger.enrollmentsFor('reader@example.com'), []);
  assert.equal(s.sent.length, 0);
});

test('wrong product, wrong currency, refunded, disputed and canceled memberships cannot confirm', async () => {
  const cases = [session({ currency: 'eur' }), session({ line_items: { data: [{ price: { id: 'other' }, quantity: 1 }] } }),
    session({ payment_intent: { latest_charge: { refunded: true } } }), session({ payment_intent: { latest_charge: { disputed: true } } }),
    session({ mode: 'subscription', metadata: { program: program.program, plan: 'member', section: 'a' }, subscription: { status: 'canceled' }, line_items: { data: [{ price: { id: prices.member }, quantity: 1 }] } })];
  for (const s of cases) assert.equal(await setup([s]).ledger.receipt(s.id), null);
});

test('a valid full discount can confirm without requiring a card charge', async () => {
  const s = session({ payment_status: 'no_payment_required', amount_total: 0 });
  assert.equal((await setup([s]).ledger.receipt(s.id)).processing, false);
});

test('open checkout holds seats, expired checkout frees them, subscriptions are not double counted', async () => {
  const future = Math.floor(Date.now() / 1000) + 1200;
  const md = { program: program.program, plan: 'member', section: 'a' };
  const { ledger } = setup([
    session({ id: 'cs_open', status: 'open', expires_at: future, metadata: md }),
    session({ id: 'cs_old', status: 'open', expires_at: 1, metadata: md }),
    session({ id: 'cs_sub', subscription: 'sub_1', metadata: md }),
    session({ id: 'cs_drop', status: 'open', expires_at: future }),
  ], [{ id: 'sub_1', status: 'active', metadata: md }]);
  const counts = await ledger.counts();
  assert.equal(counts.members.a, 2);
  assert.equal(counts.dropins[`a|${date}`], 1);
});

test('past due and unpaid subscriptions hold capacity but cannot access private member details', async () => {
  const subs = ['past_due', 'unpaid', 'incomplete'].map((status) => ({ customer: 'cus_1', status, metadata: { program: program.program, plan: 'member', section: 'a' } }));
  const { ledger } = setup([], subs);
  assert.equal((await ledger.counts()).members.a, 3);
  assert.deepEqual(await ledger.enrollmentsFor('reader@example.com'), []);
});

test('simultaneous checkout requests cannot both pass the capacity check', async (t) => {
  const env = setup();
  let release;
  const pending = new Promise((r) => { release = r; });
  let started;
  const entered = new Promise((r) => { started = r; });
  env.ledger.begin = async () => { started(); await pending; return { redirect: 'https://checkout.stripe.com/c/pay/test' }; };
  const s = await serve(t, env);
  const first = s.post({ plan: 'member', section: 'a' });
  await entered;
  const second = await s.post({ plan: 'member', section: 'a' });
  release();
  assert.match(second.headers.get('location'), /busy=1/);
  assert.match((await first).headers.get('location'), /checkout.stripe.com/);
});

test('clearing a shared code removes it rather than silently reapplying it', async (t) => {
  const env = setup();
  const s = await serve(t, env);
  const res = await s.post({ plan: 'member', section: 'a', code: '' }, { Cookie: 'rc_code=INVALID' });
  assert.match(res.headers.get('location'), /checkout.stripe.com/);
  assert.match(res.headers.get('set-cookie'), /rc_code=;/);
  assert.equal(env.stripe.calls.create[0].discounts, undefined);
});

test('webhook validates signatures, sends once across retries, and retries mail failure', async (t) => {
  const env = setup([session()]);
  let fail = true;
  const sent = [];
  const s = await serve(t, { ...env, mailer: async (m) => { if (fail) throw new Error('mail unavailable'); sent.push(m); } });
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_paid' } } });
  const headers = { 'content-type': 'application/json', 'stripe-signature': env.stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' }) };
  assert.equal((await s.get('/webhooks/stripe', { method: 'POST', body: payload, headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await s.get('/webhooks/stripe', { method: 'POST', body: payload, headers })).status, 500);
  fail = false;
  for (let i = 0; i < 2; i++) assert.equal((await s.get('/webhooks/stripe', { method: 'POST', body: payload, headers })).status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].idempotencyKey, 'welcome/cs_test_paid');
  assert.match(sent[0].text, /\/my\?t=/);
});

test('production never falls back to an attacker-controlled host for login links', () => {
  assert.throws(() => resolveSiteUrl({ NODE_ENV: 'production' }), /SITE_URL/);
  assert.throws(() => resolveSiteUrl({ NODE_ENV: 'production', SITE_URL: 'https://wrong.com/path' }), /SITE_URL/);
  assert.equal(resolveSiteUrl({ NODE_ENV: 'production', RENDER_EXTERNAL_URL: 'https://reading-club-d7if.onrender.com' }), 'https://reading-club-d7if.onrender.com');
});

test('on-page delivery gives only paid customers a private access file and remembered browser', async (t) => {
  const env = setup([session(), session({ id: 'cs_unpaid', payment_status: 'unpaid' })]);
  const s = await serve(t, { ...env, mailAvailable: false, onPageDelivery: true });
  const unpaid = await s.get('/welcome?id=cs_unpaid');
  assert.equal(unpaid.headers.get('set-cookie'), null);
  assert.equal((await s.get('/access-pass?id=cs_unpaid')).status, 404);
  const welcome = await s.get('/welcome?id=cs_test_paid', { headers: { 'x-forwarded-proto': 'https' } });
  const cookie = welcome.headers.get('set-cookie');
  assert.match(cookie, /rc_member=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(await welcome.text(), /Save my access link/);
  const pass = await s.get('/access-pass?id=cs_test_paid');
  assert.match(pass.headers.get('content-disposition'), /attachment/);
  assert.match(await pass.text(), /https:\/\/club.example.com\/welcome\?id=cs_test_paid/);
  const headers = { cookie: cookie.split(';')[0] };
  assert.equal((await s.get('/login', { headers })).headers.get('location'), '/my');
  assert.equal((await s.get('/my', { headers })).status, 200);
  assert.match((await s.get('/logout', { method: 'POST', headers })).headers.get('set-cookie'), /rc_member=;/);
  assert.equal(s.sent.length, 0);
});

test('explicit on-page mode acknowledges signed payment events without pretending to send email', async (t) => {
  const env = setup([session()]);
  const s = await serve(t, { ...env, mailAvailable: false, onPageDelivery: true });
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_paid' } } });
  const headers = { 'content-type': 'application/json', 'stripe-signature': env.stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' }) };
  assert.equal((await s.get('/webhooks/stripe', { method: 'POST', body: payload, headers })).status, 200);
  assert.equal(s.sent.length, 0);
  assert.equal((await env.ledger.receipt('cs_test_paid')).notified, false);
});

test('only an authenticated member can open their own billing portal, including past due members', async (t) => {
  const env = setup([], [{ customer: 'cus_1', status: 'past_due', metadata: { program: program.program, plan: 'member', section: 'a' } }], { portalConfiguration: 'bpc_reading_club' });
  env.stripe.billingPortal = { sessions: { create: async ({ customer, configuration }) => { assert.equal(customer, 'cus_1'); assert.equal(configuration, 'bpc_reading_club'); return { url: 'https://billing.stripe.com/p/session/test' }; } } };
  const s = await serve(t, env);
  const req = (token) => s.get('/billing', { method: 'POST', body: new URLSearchParams({ t: token }) });
  assert.match((await req('forged')).headers.get('location'), /login/);
  assert.match((await req(makeToken('reader@example.com', secret))).headers.get('location'), /billing.stripe.com/);
  assert.equal((await req(makeToken('other@example.com', secret))).status, 404);
  assert.equal(await env.ledger.hasBilling('reader@example.com'), true);
  assert.deepEqual(await env.ledger.enrollmentsFor('reader@example.com'), []);
});

test('malformed Unicode login signatures are rejected without crashing', () => {
  assert.equal(readToken(`payload.${'é'.repeat(43)}`, secret), null);
});

test('checkout accepts only cards, holds seats for 31 minutes and preserves drop-in selection on return', () => {
  const p = checkoutParams({ program, plan: 'dropin', section: program.sections[0], date, source: 'direct', priceId: prices.dropin, base: 'https://club.example.com' });
  assert.deepEqual(p.payment_method_types, ['card']);
  assert.ok(p.expires_at > Date.now() / 1000 + 1800);
  assert.match(p.cancel_url, /slot=a%7C2026-10-19/);
});

test('repeating a checkout form reuses the exact Stripe request and idempotency key', async () => {
  const { ledger, stripe } = setup();
  const calls = [];
  stripe.checkout.sessions.create = async (params, options) => { calls.push({ params, options }); return { url: 'https://checkout.stripe.com/c/pay/test' }; };
  const input = { plan: 'member', section: program.sections[0], source: 'direct', base: 'https://club.example.com', checkoutId: '5f8b0ace-f6e1-4b3b-a4d6-0f6b7307f1e2' };
  await ledger.begin(input);
  await ledger.begin(input);
  assert.deepEqual(calls[0], calls[1]);
  assert.match(calls[0].options.idempotencyKey, /^reading-club\//);
  await ledger.begin({ ...input, section: program.sections[1] });
  assert.notEqual(calls[0].options.idempotencyKey, calls[2].options.idempotencyKey);
});
