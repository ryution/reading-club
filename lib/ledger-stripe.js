'use strict';
// Stripe as the record: memberships are subscriptions billed every term,
// drop-ins are one-time payments that save the card. Turned on by setting
// STRIPE_SECRET_KEY, MEMBER_PRICE_ID and DROPIN_PRICE_ID.

// Subscriptions in these states hold a seat in their section.
const SEAT_HOLDING = new Set(['active', 'trialing', 'past_due', 'incomplete', 'unpaid']);

function expectedPrices(program) {
  return {
    member: { unit_amount: program.memberPrice * 100, currency: 'usd', type: 'recurring', interval: 'week', interval_count: program.weeks },
    dropin: { unit_amount: program.dropInPrice * 100, currency: 'usd', type: 'one_time' },
  };
}

function priceProblem(price, want) {
  if (!price.active) return 'price is archived';
  const got = { ...price, interval: price.recurring && price.recurring.interval, interval_count: price.recurring && price.recurring.interval_count };
  for (const [key, value] of Object.entries(want)) {
    if (got[key] !== value) return `${key} is ${JSON.stringify(got[key])}, expected ${JSON.stringify(value)}`;
  }
  return null;
}

function checkoutParams({ program, plan, section, date, source, priceId, promo, email, base }) {
  const metadata = { program: program.program, plan, section: section.id, source };
  if (plan === 'dropin') metadata.date = date;
  const common = {
    line_items: [{ price: priceId, quantity: 1 }],
    custom_fields: [{ key: 'full_name', label: { type: 'custom', custom: 'Full name' }, type: 'text' }],
    metadata,
    success_url: `${base}/welcome?id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/join?plan=${plan}&section=${section.id}&canceled=1`,
  };
  if (email) common.customer_email = email;
  if (promo) common.discounts = [{ promotion_code: promo }];
  else common.allow_promotion_codes = true;

  if (plan === 'member') {
    return { ...common, mode: 'subscription', subscription_data: { description: `${program.name}: ${section.name} membership`, metadata } };
  }
  return {
    ...common,
    mode: 'payment',
    customer_creation: 'always',
    submit_type: 'pay',
    payment_intent_data: {
      description: `${program.name}: drop-in, ${section.name}, ${date}`,
      metadata,
      setup_future_usage: 'off_session', // keeps the card on file for next time
    },
  };
}

function createStripeLedger({ stripe, program, prices, sourcePromos = {}, log = console }) {
  const verified = {};

  return {
    mode: 'stripe',
    cacheMs: 20000,

    async counts() {
      const members = Object.fromEntries(program.sections.map((s) => [s.id, 0]));
      const dropins = {};
      for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100 })) {
        const md = sub.metadata || {};
        if (md.program === program.program && SEAT_HOLDING.has(sub.status) && md.section in members) members[md.section]++;
      }
      // Drop-ins are sold for this term, so look back far enough to cover sales before it opened.
      const since = Math.floor(new Date(`${program.termStarts}T00:00:00Z`).getTime() / 1000) - 120 * 86400;
      for await (const s of stripe.checkout.sessions.list({ status: 'complete', created: { gte: since }, limit: 100 })) {
        const md = s.metadata || {};
        if (md.program === program.program && md.plan === 'dropin') {
          const k = `${md.section}|${md.date}`;
          dropins[k] = (dropins[k] || 0) + 1;
        }
      }
      return { members, dropins };
    },

    async enrollmentsFor(email) {
      const out = [];
      for await (const c of stripe.customers.list({ email, limit: 100 })) {
        for await (const sub of stripe.subscriptions.list({ customer: c.id, status: 'all', limit: 100 })) {
          const md = sub.metadata || {};
          if (md.program === program.program && SEAT_HOLDING.has(sub.status)) out.push({ plan: 'member', section: md.section, source: md.source });
        }
        for await (const s of stripe.checkout.sessions.list({ customer: c.id, status: 'complete', limit: 100 })) {
          const md = s.metadata || {};
          if (md.program === program.program && md.plan === 'dropin') out.push({ plan: 'dropin', section: md.section, date: md.date, source: md.source });
        }
      }
      return out;
    },

    async receipt(id) {
      if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return null;
      const s = await stripe.checkout.sessions.retrieve(id);
      if (!s.metadata || s.metadata.program !== program.program || s.status !== 'complete') return null;
      const name = (s.custom_fields || []).find((f) => f.key === 'full_name');
      return {
        email: s.customer_details && s.customer_details.email,
        name: name && name.text ? name.text.value : '',
        md: s.metadata,
        processing: s.payment_status === 'unpaid',
      };
    },

    async saveLead({ email, name, section, source, lead }) {
      await stripe.customers.create({ email, name: name || undefined, metadata: { program: program.program, lead, section: section || '', source } });
    },

    async begin({ plan, section, date, source, code, email, base }) {
      const priceId = prices[plan];
      if (!priceId) { log.error(`[checkout] ${plan} price id is not set.`); return { error: 'unavailable' }; }
      if (!verified[plan]) {
        const problem = priceProblem(await stripe.prices.retrieve(priceId), expectedPrices(program)[plan]);
        if (problem) {
          log.error(`[checkout] ${plan} price ${priceId} does not match program.json (${problem}). Refusing to open Checkout.`);
          return { error: 'unavailable' };
        }
        verified[plan] = true;
      }
      // A typed or linked code wins over the list's automatic code.
      let promo = sourcePromos[source];
      if (code) {
        const found = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
        if (!found.data.length) return { error: 'badcode' };
        promo = found.data[0].id;
      }
      const session = await stripe.checkout.sessions.create(checkoutParams({ program, plan, section, date, source, priceId, promo, email, base }));
      return { redirect: session.url };
    },
  };
}

// Every completed signup for this program, newest first (for the roster export).
async function* listSignups(stripe, program) {
  for await (const s of stripe.checkout.sessions.list({ status: 'complete', limit: 100 })) {
    if (s.metadata && s.metadata.program === program.program) yield s;
  }
}

module.exports = { createStripeLedger, checkoutParams, priceProblem, expectedPrices, listSignups, SEAT_HOLDING };
