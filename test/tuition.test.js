'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const { createApp, loadProgram } = require('../lib/app');
const { createStripeLedger, checkoutParams } = require('../lib/ledger-stripe');
const { fakeStripe } = require('./fake-stripe');
const program = loadProgram();
const prices = { member: 'price_member', tuition: 'price_tuition', dropin: 'price_dropin' };
const quiet = { log() {}, error() {}, warn() {} };
function session(extra = {}) {
  return { id: 'cs_test_tuition', customer: 'cus_reader', mode: 'payment', status: 'complete', payment_status: 'paid', currency: 'usd', amount_total: 45000,
    metadata: { program: program.program, plan: 'member', section: 'a', source: 'direct', billing: 'upfront-450-v1', term_start: '2026-10-18', term_end: '2026-11-28' },
    customer_details: { email: 'reader@example.com' }, custom_fields: [{ key: 'full_name', text: { value: 'Reader' } }],
    line_items: { data: [{ price: { id: prices.tuition }, quantity: 1 }] }, ...extra };
}
function setup(sessions = []) {
  const stripe = fakeStripe({ program, sessions, customers: [{ id: 'cus_reader', email: 'reader@example.com' }] });
  const retrieve = stripe.prices.retrieve;
  stripe.prices.retrieve = async id => id === prices.tuition ? { id, active: true, unit_amount: 45000, currency: 'usd', type: 'one_time', recurring: null } : retrieve(id);
  stripe.webhooks = new Stripe('sk_test_fake').webhooks;
  return { stripe, ledger: createStripeLedger({ stripe, program, prices, log: quiet }) };
}
async function serve(t, env) {
  const app = createApp({ program, ...env, loginSecret: 'test-tuition-secret', siteUrl: 'https://example.com', stripe: env.stripe,
    webhookSecret: 'whsec_tuition', onPageDelivery: true, log: quiet, now: () => new Date('2026-10-03T12:00:00Z') });
  const server = app.listen(0); await new Promise(r => server.once('listening', r)); t.after(() => server.close());
  return `http://localhost:${server.address().port}`;
}

test('tuition checkout is one $450 payment with no subscription or future-charge authorization', async () => {
  const f = setup();
  const args = { program, plan: 'member', section: program.sections[0], source: 'direct', priceId: prices.tuition, base: 'https://example.com' };
  const p = checkoutParams(args);
  assert.equal(p.mode, 'payment');
  assert.deepEqual(p.line_items, [{ price: prices.tuition, quantity: 1 }]);
  assert.equal(p.subscription_data, undefined);
  assert.equal(p.setup_intent_data, undefined);
  assert.equal(p.payment_intent_data.setup_future_usage, undefined);
  assert.match(p.custom_text.submit.message, /\$450 paid once/);
  assert.equal(p.metadata.term_end, '2026-11-28');
  await f.ledger.begin({ ...args, checkoutId: '1109f2ca-5e99-4311-bf32-9ec1d97866fb' });
  assert.equal(f.stripe.calls.create[0].mode, 'payment');
  assert.equal(f.stripe.calls.create[0].line_items[0].price, prices.tuition);
});
test('wrong amount or a recurring price cannot be used for upfront tuition', async () => {
  for (const price of [{ active: true, unit_amount: 2500, currency: 'usd', type: 'one_time' }, { active: true, unit_amount: 45000, currency: 'usd', type: 'recurring' }]) {
    const f = setup(); f.stripe.prices.retrieve = async () => price;
    assert.deepEqual(await f.ledger.begin({ plan: 'member', section: program.sections[0], source: 'direct', base: 'https://example.com' }), { error: 'unavailable' });
    assert.equal(f.stripe.calls.create.length, 0);
  }
});
test('paid one-time tuition grants course access and one seat without any subscription', async () => {
  const f = setup([session()]);
  const receipt = await f.ledger.receipt('cs_test_tuition');
  assert.equal(receipt.upfront, true);
  assert.equal(receipt.processing, false);
  assert.equal((await f.ledger.enrollmentsFor('reader@example.com')).length, 1);
  assert.equal((await f.ledger.counts()).members.a, 1);
});
test('unpaid, refunded, disputed, wrong-price and wrong-term tuition do not unlock a course', async () => {
  for (const s of [session({ payment_status: 'unpaid' }), session({ payment_intent: { latest_charge: { refunded: true } } }),
    session({ payment_intent: { latest_charge: { disputed: true } } }), session({ line_items: { data: [{ price: { id: prices.member }, quantity: 1 }] } }),
    session({ metadata: { ...session().metadata, term_start: '2026-01-01' } })]) {
    const f = setup([s]);
    assert.deepEqual(await f.ledger.enrollmentsFor('reader@example.com'), []);
    assert.equal((await f.ledger.counts()).members.a, 0);
  }
});
test('signed one-time checkout confirmation delivers member access and course calendar', async t => {
  const f = setup([session()]); const base = await serve(t, f);
  const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_tuition' } } });
  const signature = f.stripe.webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_tuition' });
  const hook = await fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature }, body });
  assert.equal(hook.status, 200);
  const welcome = await (await fetch(`${base}/welcome?id=cs_test_tuition`)).text();
  assert.match(welcome, /Your payment is confirmed/);
  assert.match(welcome, /\/my\?t=/);
  const calendar = await fetch(`${base}/calendar.ics?id=cs_test_tuition`);
  assert.equal(calendar.status, 200);
  assert.equal(((await calendar.text()).match(/BEGIN:VEVENT/g) || []).length, 18);
});
test('advertised equivalent rate discloses full upfront cost and 18-session breakdown', async t => {
  const base = await serve(t, setup());
  for (const path of ['/', '/join', '/join?plan=dropin']) {
    const html = await (await fetch(base + path)).text();
    assert.doesNotMatch(html, /every Monday|18 weekly payments|\$25 \/ week|Save my card &amp; enroll/);
    if (!path.includes('dropin')) {
      assert.match(html, /\$450 paid once for six weeks/);
      assert.match(html, /6 lectures, 6 small-group meetings, and 6 optional office hours/);
      assert.match(html, /per included session/);
    }
  }
  assert.match(await (await fetch(base + '/join')).text(), /Continue to \$450 checkout/);
});
