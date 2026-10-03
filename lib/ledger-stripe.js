'use strict';
// Stripe is the enrollment record. New memberships use fixed tuition schedules;
// legacy recurring memberships and one-time drop-ins retain their original flow.

// Subscriptions in these states hold a seat in their section.
const SEAT_HOLDING = new Set(['active', 'trialing', 'past_due', 'incomplete', 'unpaid']);
const ACCESS = new Set(['active', 'trialing']);
const paid = (s) => s.payment_status === 'paid' || (s.payment_status === 'no_payment_required' && s.amount_total === 0);
const { createInstallments, installmentTerms, VERSION } = require('./installments');
const { addDays, todayIn } = require('./schedule');

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
    payment_method_types: ['card'],
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    line_items: [{ price: priceId, quantity: 1 }],
    custom_fields: [{ key: 'full_name', label: { type: 'custom', custom: 'Full name' }, type: 'text' }],
    metadata,
    success_url: `${base}/welcome?id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/join?plan=${plan}&section=${section.id}${date ? `&slot=${encodeURIComponent(`${section.id}|${date}`)}` : ''}&canceled=1`,
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

function createStripeLedger({ stripe, program, prices, portalConfiguration, installmentPortalConfiguration, sourcePromos = {}, log = console }) {
  const installments = prices.installment ? createInstallments({ stripe, program, priceId: prices.installment }) : null;
  // Retain the exact request across network retries and repeated form submissions.
  const checkoutAttempts = new Map();
  const validMetadata = (md) => md?.program === program.program && ['member', 'dropin'].includes(md.plan) && program.sections.some((s) => s.id === md.section);
  async function billingCustomer(email) {
    for await (const customer of stripe.customers.list({ email, limit: 100 })) {
      if (installments && (await installments.schedules(customer.id)).length) return { id: customer.id, installment: true };
      for await (const sub of stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 100 })) {
        if (validMetadata(sub.metadata) && SEAT_HOLDING.has(sub.status)) return { id: customer.id };
      }
    }
    return null;
  }

  async function verifiedSession(id) {
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return null;
    const s = await stripe.checkout.sessions.retrieve(id, { expand: ['line_items', 'subscription', 'payment_intent.latest_charge'] });
    const md = s.metadata;
    if (!validMetadata(md) || s.status !== 'complete' || s.currency !== 'usd' || s.mode !== (md.plan === 'member' ? 'subscription' : 'payment')) return null;
    const lines = s.line_items?.data;
    if (!lines || lines.length !== 1 || lines[0].price?.id !== prices[md.plan] || lines[0].quantity !== 1) return null;
    const charge = s.payment_intent?.latest_charge;
    if (charge?.refunded || charge?.disputed) return null;
    return s;
  }

  return {
    mode: 'stripe',
    cacheMs: 20000,

    async counts() {
      const members = Object.fromEntries(program.sections.map((s) => [s.id, 0]));
      const dropins = {};
      const countedSubscriptions = new Set();
      for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100 })) {
        const md = sub.metadata || {};
        if (md.program === program.program && md.billing !== VERSION && SEAT_HOLDING.has(sub.status) && md.section in members) {
          members[md.section]++;
          if (sub.id) countedSubscriptions.add(sub.id);
        }
      }
      // Drop-ins are sold for this term, so look back far enough to cover sales before it opened.
      for await (const s of stripe.checkout.sessions.list({ limit: 100 })) {
        const md = s.metadata || {};
        const open = s.status === 'open' && s.expires_at > Date.now() / 1000;
        if (!validMetadata(md) || (!open && s.status !== 'complete')) continue;
        if (md.plan === 'member') {
          if (md.billing === VERSION) {
            if (open) members[md.section]++;
            else if (installments) {
              const schedules = await installments.schedules(s.customer);
              if (!schedules.length || schedules.some(x => x.metadata.enrollment === s.id && !['canceled', 'released'].includes(x.status))) members[md.section]++;
            }
            continue;
          }
          const subId = typeof s.subscription === 'string' ? s.subscription : s.subscription?.id;
          if (open || (paid(s) && !countedSubscriptions.has(subId))) members[md.section]++;
        } else {
          const k = `${md.section}|${md.date}`;
          dropins[k] = (dropins[k] || 0) + 1;
        }
      }
      return { members, dropins };
    },

    async enrollmentsFor(email) {
      const out = [];
      for await (const c of stripe.customers.list({ email, limit: 100 })) {
        if (installments) {
          for (const schedule of await installments.schedules(c.id)) {
            const md = schedule.metadata;
            if (['not_started', 'active', 'completed'].includes(schedule.status) && md.term_end >= todayIn(program.timezone)) {
              let current = true;
              if (schedule.subscription) {
                const sub = await stripe.subscriptions.retrieve(typeof schedule.subscription === 'string' ? schedule.subscription : schedule.subscription.id);
                current = ACCESS.has(sub.status);
              }
              if (current) out.push({ ...md, plan: 'member', installments: true });
            }
          }
        }
        for await (const sub of stripe.subscriptions.list({ customer: c.id, status: 'all', limit: 100 })) {
          const md = sub.metadata || {};
          if (validMetadata(md) && md.billing !== VERSION && ACCESS.has(sub.status)) out.push({ plan: 'member', section: md.section, source: md.source });
        }
        for await (const s of stripe.checkout.sessions.list({ customer: c.id, status: 'complete', limit: 100 })) {
          const md = s.metadata || {};
          if (validMetadata(md) && md.plan === 'dropin' && paid(s)) {
            const verified = await verifiedSession(s.id);
            if (verified && paid(verified)) out.push({ plan: 'dropin', section: md.section, date: md.date, source: md.source });
          }
        }
      }
      return out;
    },

    async receipt(id) {
      if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return null;
      if (installments) {
        const r = await installments.receipt(id);
        if (r) return r;
      }
      const s = await verifiedSession(id);
      if (!s) return null;
      if (s.metadata.plan === 'member' && paid(s) && !ACCESS.has(s.subscription?.status)) return null;
      const name = (s.custom_fields || []).find((f) => f.key === 'full_name');
      return {
        email: s.customer_details && s.customer_details.email,
        name: name && name.text ? name.text.value : '',
        md: s.metadata,
        processing: !paid(s),
        notified: s.metadata.welcome_sent === 'true',
      };
    },

    async markNotified(id) {
      await stripe.checkout.sessions.update(id, { metadata: { welcome_sent: 'true' } });
    },

    async billingPortal(email, returnUrl) {
      const customer = await billingCustomer(email);
      const configuration = customer?.installment ? installmentPortalConfiguration : portalConfiguration;
      if (customer?.installment && !configuration) throw new Error('Installment billing portal is not configured.');
      return customer ? (await stripe.billingPortal.sessions.create({ customer: customer.id, return_url: returnUrl,
        ...(configuration ? { configuration } : {}) })).url : null;
    },

    async hasBilling(email) { return Boolean(await billingCustomer(email)); },

    async saveLead({ email, name, section, source, lead }) {
      await stripe.customers.create({ email, name: name || undefined, metadata: { program: program.program, lead, section: section || '', source } });
    },

    async begin({ plan, section, date, source, code, name, email, base, checkoutId, termsAccepted }) {
      for (const [id, attempt] of checkoutAttempts) if (attempt.expires_at <= Date.now() / 1000) checkoutAttempts.delete(id);
      if (plan === 'member' && program.billing?.model === VERSION) {
        if (!installments || !installmentPortalConfiguration) return { error: 'unavailable' };
        if (!termsAccepted || !email) return { error: 'terms' };
        if (code) return { error: 'installmentcode' };
        if (todayIn(program.timezone) >= program.termStarts) return { error: 'termstarted' };
        if (await billingCustomer(email)) return { error: 'alreadyenrolled' };
        const price = await stripe.prices.retrieve(prices.installment);
        if (priceProblem(price, { unit_amount: 2500, currency: 'usd', type: 'recurring', interval: 'week', interval_count: 1 })) return { error: 'unavailable' };
        const fingerprint = require('node:crypto').createHash('sha256').update(JSON.stringify({ section: section.id, email, source, term: program.termStarts })).digest('hex');
        const key = `reading-club/setup/${checkoutId || require('node:crypto').randomUUID()}/${fingerprint}`;
        let params = checkoutAttempts.get(key);
        if (!params) {
          const first = installments.nextMonday();
          const customer = await stripe.customers.create({ email, name: name || undefined, metadata: { program: program.program } }, { idempotencyKey: `${key}/customer` });
          const metadata = { program: program.program, plan, section: section.id, source, billing: VERSION, member_name: name || '',
            terms_version: VERSION, consent_at: String(Math.floor(Date.now() / 1000)), first_charge: String(first),
            term_start: program.termStarts, term_end: addDays(program.termStarts, program.weeks * 7 - 1), installment_price: prices.installment };
          params = { mode: 'setup', currency: 'usd', customer: customer.id, payment_method_types: ['card'], metadata,
            setup_intent_data: { metadata }, expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
            custom_text: { submit: { message: installmentTerms(first, program.timezone) } },
            success_url: `${base}/welcome?id={CHECKOUT_SESSION_ID}`, cancel_url: `${base}/join?plan=member&section=${section.id}&canceled=1` };
          checkoutAttempts.set(key, params);
        }
        const session = await stripe.checkout.sessions.create(params, { idempotencyKey: key });
        if (!session.url?.startsWith('https://checkout.stripe.com/')) throw new Error('Missing secure Stripe checkout URL.');
        return { redirect: session.url };
      }
      const priceId = prices[plan];
      if (!priceId) { log.error(`[checkout] ${plan} price id is not set.`); return { error: 'unavailable' }; }
      {
        const problem = priceProblem(await stripe.prices.retrieve(priceId), expectedPrices(program)[plan]);
        if (problem) {
          log.error(`[checkout] ${plan} price ${priceId} does not match program.json (${problem}). Refusing to open Checkout.`);
          return { error: 'unavailable' };
        }
      }
      // A typed or linked code wins over the list's automatic code.
      let promo = sourcePromos[source];
      if (code) {
        const found = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
        if (!found.data.length) return { error: 'badcode' };
        promo = found.data[0].id;
      }
      const params = checkoutParams({ program, plan, section, date, source, priceId, promo, email, base });
      let request = params;
      let key;
      if (checkoutId) {
        const fingerprint = require('node:crypto').createHash('sha256').update(JSON.stringify({ plan, section: section.id, date, source, priceId, promo, email, base })).digest('hex');
        key = `reading-club/${checkoutId}/${fingerprint}`;
        if (!checkoutAttempts.has(key)) checkoutAttempts.set(key, params);
        request = checkoutAttempts.get(key);
      }
      const session = await stripe.checkout.sessions.create(request, key ? { idempotencyKey: key } : undefined);
      if (!session.url || !session.url.startsWith('https://checkout.stripe.com/')) throw new Error('Stripe did not return a hosted checkout URL.');
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
