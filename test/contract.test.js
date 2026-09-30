'use strict';
// Sends the real Stripe library's requests to stripe-mock (port 12111), which
// rejects any parameter the Stripe API would reject. Skipped if it isn't running.
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const Stripe = require('stripe');
const { loadProgram } = require('../lib/app');
const { createStripeLedger, checkoutParams } = require('../lib/ledger-stripe');

const program = loadProgram();
const up = () => new Promise((r) => {
  const s = net.connect(12111, '127.0.0.1');
  s.setTimeout(500, () => { s.destroy(); r(false); });
  s.on('connect', () => { s.end(); r(true); });
  s.on('error', () => r(false));
});

test('Stripe accepts every request the site sends', async (t) => {
  if (!(await up())) return t.skip('stripe-mock not running');
  const stripe = new Stripe('sk_test_123', { host: '127.0.0.1', port: 12111, protocol: 'http' });
  const section = program.sections[0];
  const base = 'https://example.org';
  for (const p of [
    checkoutParams({ program, plan: 'member', section, source: 'journal', priceId: 'price_1', email: 'a@b.co', base }),
    checkoutParams({ program, plan: 'member', section, source: 'journal', priceId: 'price_1', promo: 'promo_1', base }),
    checkoutParams({ program, plan: 'dropin', section, date: '2026-10-19', source: 'direct', priceId: 'price_1', base }),
  ]) assert.ok((await stripe.checkout.sessions.create(p)).id);
  const ledger = createStripeLedger({ stripe, program, prices: { member: 'price_1', dropin: 'price_1' } });
  await ledger.saveLead({ email: 'a@b.co', name: 'A', section: '', source: '222', lead: 'interest' });
  await ledger.enrollmentsFor('a@b.co');
  assert.ok((await ledger.counts()).members);
  await stripe.promotionCodes.list({ code: 'JOURNAL', active: true, limit: 1 });
  await stripe.prices.create({ currency: 'usd', unit_amount: 45000, recurring: { interval: 'week', interval_count: 6 }, product: 'prod_1' });
});
