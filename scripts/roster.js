'use strict';
// Prints everyone who has enrolled this term as CSV, straight from Stripe.
// Usage: node --env-file=.env scripts/roster.js > roster.csv
const Stripe = require('stripe');
const { listEnrollments } = require('../server');
const { loadLocalEnv } = require('../config');
loadLocalEnv();

// Quoting alone does not stop spreadsheet formulas in names or email addresses.
const csv = (v) => {
  let value = String(v ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(value) || /^[\t\r\n]/.test(value)) value = "'" + value;
  return `"${value.replace(/"/g, '""')}"`;
};

async function main() {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('Set STRIPE_SECRET_KEY first.');
    process.exit(1);
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const rows = [];
  for await (const s of listEnrollments(stripe)) {
    const name = (s.custom_fields || []).find((f) => f.key === 'full_name');
    rows.push([
      s.id,
      name && name.text ? name.text.value : '',
      s.customer_details ? s.customer_details.email : '',
      (s.amount_total / 100).toFixed(2),
      s.payment_status,
      new Date(s.created * 1000).toISOString().slice(0, 10),
    ]);
  }
  rows.reverse(); // oldest first
  console.log(['session_id', 'name', 'email', 'amount_usd', 'payment_status', 'enrolled_on'].join(','));
  for (const r of rows) console.log(r.map(csv).join(','));
  console.error(`${rows.length} enrolled.`);
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1); });
module.exports = { csv };
