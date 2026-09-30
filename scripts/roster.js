'use strict';
// Exports signups (or the interest list) as CSV.
//   npm run --silent roster > roster.csv
//   npm run --silent roster -- --leads > leads.csv
// Reads Stripe when STRIPE_SECRET_KEY is set, otherwise the local reservations file.
const path = require('path');
const { loadLocalEnv } = require('../config');
const { loadProgram } = require('../lib/app');

loadLocalEnv();
// Cells starting with = + - @ are escaped so spreadsheets don't run them as formulas.
const csv = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
const out = (head, rows) => { console.log(head.join(',')); for (const r of rows) console.log(r.map(csv).join(',')); console.error(`${rows.length} rows.`); };
const leads = process.argv.includes('--leads');
const program = loadProgram();

(async () => {
  if (process.env.STRIPE_SECRET_KEY) {
    const Stripe = require('stripe');
    const { listSignups } = require('../lib/ledger-stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
    const rows = [];
    if (leads) {
      for await (const c of stripe.customers.search({ query: `metadata['program']:'${program.program}'`, limit: 100 })) {
        if (c.metadata.lead) rows.push([c.name, c.email, c.metadata.lead, c.metadata.section, c.metadata.source, day(c.created)]);
      }
      return out(['name', 'email', 'type', 'section', 'source', 'joined_on'], rows.reverse());
    }
    for await (const s of listSignups(stripe, program)) {
      const md = s.metadata;
      const name = (s.custom_fields || []).find((f) => f.key === 'full_name');
      rows.push([name && name.text ? name.text.value : '', s.customer_details ? s.customer_details.email : '', md.plan, md.section, md.date || '', md.source,
        (s.amount_total / 100).toFixed(2), s.payment_status === 'unpaid' ? 'processing' : 'paid', day(s.created)]);
    }
    return out(['name', 'email', 'plan', 'section', 'dropin_date', 'source', 'amount_usd', 'status', 'signed_up'], rows.reverse());
  }
  const { createFileStore, createRedisStore } = require('../lib/ledger-local');
  const e = process.env;
  const url = e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL;
  const token = e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN;
  const db = await (url && token ? createRedisStore({ url, token }) : createFileStore(e.DATA_DIR || path.join(__dirname, '..', 'data'))).load();
  if (leads) return out(['name', 'email', 'type', 'section', 'source', 'joined_on'], db.leads.map((l) => [l.name, l.email, l.lead, l.section, l.source, l.createdAt.slice(0, 10)]));
  return out(['name', 'email', 'plan', 'section', 'dropin_date', 'source', 'code', 'amount_due_usd', 'status', 'reserved_on'],
    db.reservations.filter((r) => r.program === program.program).map((r) => [r.name, r.email, r.plan, r.section, r.date || '', r.source, r.code || '', r.amount, r.status, r.createdAt.slice(0, 10)]));
})().catch((err) => { console.error(err.message); process.exit(1); });
