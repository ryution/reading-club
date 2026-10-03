'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createInstallments, nextMonday, scheduleParams, VERSION, WEEK } = require('../lib/installments');
const { createStripeLedger } = require('../lib/ledger-stripe');
const { createApp, loadProgram } = require('../lib/app');
const { fakeStripe } = require('./fake-stripe');
const program = loadProgram();
const future = nextMonday(program.timezone);
function fixture() {
  const sessions = [{ id: 'cs_test_setup', customer: 'cus_1', mode: 'setup', status: 'complete',
    customer_details: { email: 'reader@example.com' }, setup_intent: { customer: 'cus_1', status: 'succeeded', payment_method: 'pm_card' },
    metadata: { program: program.program, plan: 'member', section: 'a', source: 'direct', billing: VERSION, terms_version: VERSION,
      installment_price: 'price_weekly', first_charge: String(future), term_start: program.termStarts, term_end: '2026-11-25' } }];
  const schedules = [];
  const customers = [{ id: 'cus_1', email: 'reader@example.com' }];
  const stripe = fakeStripe({ program, sessions, customers });
  const basePrice = stripe.prices.retrieve;
  stripe.prices.retrieve = async id => id === 'price_weekly' ? { id, active: true, type: 'recurring', currency: 'usd', unit_amount: 2500, recurring: { interval: 'week', interval_count: 1 } } : basePrice(id);
  stripe.customers.update = async (id, params) => { Object.assign(customers.find(c => c.id === id), params); };
  stripe.subscriptionSchedules = {
    list: ({ customer }) => (async function* () { yield* schedules.filter(s => !customer || s.customer === customer); })(),
    create: async (params, options) => { const s = { ...params, id: `sub_sched_${schedules.length}`, status: 'not_started', options }; schedules.push(s); return s; },
  };
  stripe.subscriptions.retrieve = async () => ({ status: 'active' });
  stripe.billingPortal = { sessions: { create: async p => ({ url: `https://billing.stripe.com/${p.configuration}` }) } };
  const ledger = createStripeLedger({ stripe, program, prices: { member: 'price_member', dropin: 'price_dropin', installment: 'price_weekly' }, portalConfiguration: 'bpc_legacy', installmentPortalConfiguration: 'bpc_installments' });
  const core = createInstallments({ stripe, program, priceId: 'price_weekly' });
  return { stripe, ledger, core, sessions, schedules, customers };
}
test('Monday billing stays on Monday across DST; Monday signups begin next Monday', () => {
  assert.equal(new Date(nextMonday(program.timezone, new Date('2026-10-03T16:00:00Z')) * 1000).toISOString(), '2026-10-05T13:00:00.000Z');
  assert.equal(new Date(nextMonday(program.timezone, new Date('2026-10-05T00:00:00-04:00')) * 1000).toISOString(), '2026-10-12T13:00:00.000Z');
  assert.equal(new Date(nextMonday(program.timezone, new Date('2026-10-31T16:00:00Z')) * 1000).toISOString(), '2026-11-02T14:00:00.000Z');
});
test('one native Stripe schedule bills exactly 18 weekly cycles and ends instead of renewing', () => {
  const f = fixture();
  const p = scheduleParams({ session: f.sessions[0] });
  assert.equal(p.end_behavior, 'cancel');
  assert.deepEqual(p.phases[0].duration, { interval: 'week', interval_count: 18 });
  assert.deepEqual(p.phases[0].items, [{ price: 'price_weekly', quantity: 1 }]);
  assert.equal(p.phases.length, 1);
  assert.equal(p.phases[0].proration_behavior, 'none');
  assert.equal(18 * 2500, 45000);
  const dates = Array.from({ length: 18 }, (_, i) => todayDate(p.start_date + i * WEEK));
  assert.equal(new Set(dates).size, 18);
  assert.ok(dates.every(d => new Date(`${d}T12:00Z`).getUTCDay() === 1));
});
function todayDate(t) { return new Intl.DateTimeFormat('en-CA', { timeZone: program.timezone }).format(t * 1000); }
test('duplicate delivery, concurrent confirmation and fresh processes reuse the stored schedule', async () => {
  const f = fixture();
  const results = await Promise.all([f.core.receipt('cs_test_setup'), f.core.receipt('cs_test_setup')]);
  assert.equal(f.schedules.length, 1);
  assert.equal(results[0].scheduleId, results[1].scheduleId);
  const restarted = createInstallments({ stripe: f.stripe, program, priceId: 'price_weekly' });
  await restarted.receipt('cs_test_setup');
  assert.equal(f.schedules.length, 1);
  assert.equal(f.customers[0].invoice_settings.default_payment_method, 'pm_card');
  assert.match(f.schedules[0].options.idempotencyKey, /cs_test_setup/);
});
test('incomplete, foreign-customer and unconsented setups cannot schedule charges', async () => {
  for (const change of [s => s.setup_intent.status = 'requires_action', s => s.setup_intent.customer = 'cus_other', s => s.metadata.terms_version = '', s => s.metadata.installment_price = 'wrong']) {
    const f = fixture(); change(f.sessions[0]);
    assert.equal(await f.core.receipt('cs_test_setup'), null);
    assert.equal(f.schedules.length, 0);
  }
});
test('a setup arriving after its agreed start date does not create catch-up charges', async () => {
  const f = fixture();
  f.sessions[0].metadata.first_charge = '1';
  await assert.rejects(f.core.receipt('cs_test_setup'), /start date passed/);
  assert.equal(f.schedules.length, 0);
});
test('one email cannot acquire a second $450 plan by completing another checkout', async () => {
  const f = fixture();
  f.customers.push({ id: 'cus_other', email: 'reader@example.com' });
  f.schedules.push({ customer: 'cus_other', status: 'active', metadata: { ...f.sessions[0].metadata, enrollment: 'cs_other' } });
  await assert.rejects(f.core.receipt('cs_test_setup'), /already exists/);
  assert.equal(f.schedules.length, 1);
});
test('delinquent members keep billing recovery but cannot download class calendars', async t => {
  const f = fixture();
  await f.core.receipt('cs_test_setup');
  Object.assign(f.schedules[0], { status: 'active', subscription: 'sub_1' });
  f.stripe.subscriptions.retrieve = async () => ({ status: 'past_due' });
  assert.equal((await f.ledger.receipt('cs_test_setup')).billingOnly, true);
  assert.deepEqual(await f.ledger.enrollmentsFor('reader@example.com'), []);
  assert.equal(await f.ledger.billingPortal('reader@example.com', 'https://example.com'), 'https://billing.stripe.com/bpc_installments');
  const app = createApp({ program, ledger: f.ledger, loginSecret: 'test-secret', onPageDelivery: true });
  const server = app.listen(0); await new Promise(r => server.once('listening', r)); t.after(() => server.close());
  const response = await fetch(`http://localhost:${server.address().port}/calendar.ics?id=cs_test_setup`);
  assert.equal(response.status, 404);
});
test('checkout requires commitment consent and explicitly shows zero upfront and fixed total', async () => {
  const f = fixture();
  const args = { plan: 'member', section: program.sections[0], email: 'new@example.com', source: 'direct', base: 'https://example.com', checkoutId: 'a0f13375-7e27-4480-82f5-80c24d8ac5f2' };
  assert.deepEqual(await f.ledger.begin(args), { error: 'terms' });
  const result = await f.ledger.begin({ ...args, termsAccepted: true });
  assert.match(result.redirect, /checkout.stripe.com/);
  const request = f.stripe.calls.create[0];
  assert.equal(request.mode, 'setup');
  assert.equal(request.line_items, undefined);
  assert.match(request.custom_text.submit.message, /18 weekly card payments of \$25/);
  assert.match(request.custom_text.submit.message, /after the course ends/);
  assert.equal(request.metadata.terms_version, VERSION);
});
test('public pages disclose 18 weeks of payments for a six-week course and require consent', async t => {
  const f = fixture();
  const app = createApp({ program, ledger: f.ledger, loginSecret: 'test-secret' });
  const server = app.listen(0); await new Promise(r => server.once('listening', r)); t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const home = await (await fetch(base)).text();
  assert.match(home, /18 weekly payments · \$450 total tuition/);
  assert.match(home, /Payments continue on Mondays after the course ends/);
  assert.doesNotMatch(home, /\$450 every 6 weeks|\$450 at checkout/);
  assert.match(home, /Stay with the question/);
  const join = await (await fetch(`${base}/join`)).text();
  assert.match(join, /name="terms" value="weekly-25-v1" required/);
  assert.match(join, /No charge today/);
  assert.match(join, /18 weekly card payments/);
  const res = await fetch(`${base}/checkout`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ plan: 'member', section: 'a', email: 'new@example.com' }) });
  assert.match(res.headers.get('location'), /terms=1/);
  assert.equal(f.stripe.calls.create.length, 0);
});

test('course calendar starts October 18 and moves Thanksgiving office hours to Wednesday', async t => {
  const ledger = { mode: 'stripe', receipt: async () => ({ md: { plan: 'member', section: 'a' } }) };
  const app = createApp({ program, ledger, now: () => new Date('2026-10-03T12:00:00Z') });
  const server = app.listen(0); await new Promise(r => server.once('listening', r)); t.after(() => server.close());
  const res = await fetch(`http://localhost:${server.address().port}/calendar.ics?id=cs_test_calendar`);
  assert.equal(res.status, 200);
  const calendar = (await res.text()).replace(/\r\n /g, '');
  assert.equal((calendar.match(/BEGIN:VEVENT/g) || []).length, 18);
  assert.equal((calendar.match(/UID:office-/g) || []).length, 6);
  assert.match(calendar, /DTSTART;TZID=America\/New_York:20261018T110000/);
  assert.match(calendar, /DTEND;TZID=America\/New_York:20261018T123000/);
  assert.match(calendar, /UID:office-2026-11-25/);
  assert.doesNotMatch(calendar, /20261126T/);
});
