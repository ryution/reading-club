'use strict';
const { todayIn, addDays } = require('./schedule');
const VERSION = 'weekly-25-v1';
const WEEK = 7 * 86400;

// Convert a local date and hour using the program's timezone, including DST.
function localTimestamp(date, hour, timeZone) {
  const target = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  let value = target;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(value).map(x => [x.type, x.value]));
    value += target - Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
  }
  return Math.floor(value / 1000);
}
function nextMonday(timeZone, now = new Date()) {
  const today = todayIn(timeZone, now);
  const day = new Date(`${today}T12:00:00Z`).getUTCDay();
  return localTimestamp(addDays(today, ((8 - day) % 7) || 7), 9, timeZone);
}
function installmentTerms(first, timeZone) {
  const date = new Intl.DateTimeFormat('en-US', { timeZone, month: 'long', day: 'numeric', year: 'numeric' }).format(first * 1000);
  return `I commit to the $450 tuition for this six-week course and authorize 18 weekly card payments of $25, starting Monday, ${date}. Payments continue on Mondays after the course ends and stop after 18 installments. This is a fixed tuition commitment, not a cancel-anytime weekly membership. No automatic enrollment in a new term.`;
}
function scheduleParams({ session }) {
  const md = session.metadata;
  const metadata = { program: md.program, plan: 'member', section: md.section, source: md.source, billing: VERSION,
    enrollment: session.id, term_start: md.term_start, term_end: md.term_end, commitment: '45000', installment_count: '18' };
  return {
    customer: session.customer, start_date: Number(md.first_charge), end_behavior: 'cancel', metadata,
    default_settings: { collection_method: 'charge_automatically', description: 'Reading Club tuition: 18 weekly payments of $25; $450 total' },
    phases: [{ items: [{ price: md.installment_price, quantity: 1 }],
      duration: { interval: 'week', interval_count: 18 }, proration_behavior: 'none', metadata }],
  };
}
function createInstallments({ stripe, program, priceId, now = () => new Date() }) {
  const jobs = new Map();
  const tagged = md => md?.program === program.program && md.billing === VERSION;
  async function schedules(customer) {
    const out = [];
    for await (const s of stripe.subscriptionSchedules.list({ customer, limit: 100 })) if (tagged(s.metadata)) out.push(s);
    return out;
  }
  async function verify(id) {
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return null;
    const s = await stripe.checkout.sessions.retrieve(id, { expand: ['setup_intent'] });
    if (!tagged(s.metadata) || s.metadata.plan !== 'member' || s.mode !== 'setup' || s.status !== 'complete' ||
      s.setup_intent?.status !== 'succeeded' || s.setup_intent.customer !== s.customer || !s.customer ||
      !s.setup_intent.payment_method || !program.sections.some(x => x.id === s.metadata.section) ||
      s.metadata.terms_version !== VERSION || s.metadata.installment_price !== priceId) return null;
    return s;
  }
  async function ensure(s) {
    const lock = s.customer_details?.email?.toLowerCase() || s.customer;
    if (jobs.has(lock)) { await jobs.get(lock); return ensure(s); }
    const work = (async () => {
      const existing = (await schedules(s.customer)).filter(x => x.metadata.enrollment === s.id);
      if (existing.length > 1) throw new Error('Duplicate installment schedules require review.');
      if (existing.length) return existing[0];
      // Two browser tabs can finish setup with different Customer IDs. A second
      // enrollment must not silently create a second $450 obligation.
      if (s.customer_details?.email) {
        for await (const customer of stripe.customers.list({ email: s.customer_details.email.toLowerCase(), limit: 100 })) {
          if (customer.id === s.customer) continue;
          if ((await schedules(customer.id)).some(x => x.metadata.term_start === s.metadata.term_start && !['canceled', 'released'].includes(x.status))) throw new Error('An installment plan already exists for this email; contact the club.');
        }
      }
      const start = Number(s.metadata.first_charge);
      if (!Number.isSafeInteger(start) || start <= now().getTime() / 1000) throw new Error('Installment start date passed before setup completed; contact the club.');
      const price = await stripe.prices.retrieve(priceId);
      if (!price.active || price.unit_amount !== 2500 || price.currency !== 'usd' || price.recurring?.interval !== 'week' || price.recurring?.interval_count !== 1) throw new Error('Installment price must be $25 USD weekly.');
      // Customer-level default lets the billing portal replace a failed card later.
      await stripe.customers.update(s.customer, { invoice_settings: { default_payment_method: s.setup_intent.payment_method } });
      return stripe.subscriptionSchedules.create(scheduleParams({ session: s }), { idempotencyKey: `reading-club/installments/${s.id}` });
    })();
    jobs.set(lock, work);
    try { return await work; } finally { jobs.delete(lock); }
  }
  async function receipt(id) {
    const s = await verify(id);
    if (!s) return null;
    const schedule = await ensure(s);
    if (['canceled', 'released'].includes(schedule.status)) return null;
    let billingOnly = s.metadata.term_end < todayIn(program.timezone, now());
    if (schedule.subscription && schedule.status === 'active') {
      const sub = await stripe.subscriptions.retrieve(typeof schedule.subscription === 'string' ? schedule.subscription : schedule.subscription.id);
      billingOnly ||= !['active', 'trialing'].includes(sub.status);
    }
    return { email: s.customer_details?.email, name: s.metadata.member_name || s.customer_details?.name || '',
      md: s.metadata, processing: false, notified: s.metadata.welcome_sent === 'true', installments: true,
      firstCharge: Number(s.metadata.first_charge), scheduleId: schedule.id, billingOnly };
  }
  return { tagged, schedules, receipt, verify, ensure, nextMonday: () => nextMonday(program.timezone, now()) };
}
module.exports = { VERSION, WEEK, localTimestamp, nextMonday, installmentTerms, scheduleParams, createInstallments };
