'use strict';
// In-memory stand-in for the parts of the Stripe client the portal uses.

function fakeStripe({ program, subs = [], sessions = [], prices, createError, customers = [], promos = {} } = {}) {
  const calls = { create: [], customers: [] };
  const iter = (arr) => (async function* () { yield* arr; })();
  const PRICES = prices || {
    price_member: { id: 'price_member', active: true, unit_amount: program.memberPrice * 100, currency: 'usd', type: 'recurring', recurring: { interval: 'week', interval_count: program.weeks } },
    price_dropin: { id: 'price_dropin', active: true, unit_amount: program.dropInPrice * 100, currency: 'usd', type: 'one_time', recurring: null },
  };
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
  return {
    calls,
    prices: { retrieve: async (id) => { if (!PRICES[id]) throw new Error('No such price'); return PRICES[id]; } },
    subscriptions: { list: (p = {}) => iter(subs.filter((x) => !p.customer || x.customer === p.customer)) },
    customers: {
      create: async (p) => { calls.customers.push(p); return { id: 'cus_1', ...p }; },
      list: (p = {}) => iter(customers.filter((c) => !p.email || c.email === p.email)),
    },
    promotionCodes: { list: async ({ code }) => ({ data: promos[code] ? [{ id: promos[code], code }] : [] }) },
    checkout: {
      sessions: {
        list: (p = {}) => iter(sessions.filter((x) => !p.customer || x.customer === p.customer)),
        create: async (p) => {
          calls.create.push(p);
          if (createError) throw createError;
          return { id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new' };
        },
        retrieve: async (id) => { if (!byId[id]) throw new Error('No such session'); return byId[id]; },
        update: async (id, { metadata }) => { Object.assign(byId[id].metadata, metadata); return byId[id]; },
      },
    },
  };
}

const member = (program, section, status = 'active') => ({ status, metadata: { program: program.program, plan: 'member', section } });
const dropin = (program, section, date, extra = {}) => ({
  id: `cs_test_${section}_${date.replace(/-/g, '')}_${Math.random().toString(36).slice(2, 7)}`,
  status: 'complete', payment_status: 'paid', metadata: { program: program.program, plan: 'dropin', section, date, source: 'direct' }, ...extra,
});

module.exports = { fakeStripe, member, dropin };
