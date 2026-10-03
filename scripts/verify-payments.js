'use strict';
// Read-only configuration audit. Never prints a secret or creates a charge.
const Stripe = require('stripe');
const { loadLocalEnv, resolveSiteUrl } = require('../config');
const { loadProgram } = require('../lib/app');
const { expectedPrices, priceProblem } = require('../lib/ledger-stripe');
loadLocalEnv();
const env = process.env;
const checks = [];
const check = (name, ok, detail) => checks.push({ check: name, pass: Boolean(ok), detail });
async function main() {
  const required = ['STRIPE_SECRET_KEY', 'MEMBER_PRICE_ID', 'DROPIN_PRICE_ID', 'STRIPE_WEBHOOK_SECRET', 'LOGIN_SECRET', 'RESEND_API_KEY', 'MAIL_FROM'];
  for (const key of required) check(key, env[key], env[key] ? 'configured' : 'missing');
  let base;
  try { base = resolveSiteUrl({ ...env, NODE_ENV: 'production' }); check('Public origin', true, base); }
  catch (e) { check('Public origin', false, e.message); }
  if (env.STRIPE_SECRET_KEY) {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { timeout: 15000, maxNetworkRetries: 1 });
    const account = await stripe.accounts.retrieve();
    check('Stripe account', account.id === 'acct_1TDSFELFXIBpLlZr', account.id);
    check('Charges enabled', account.charges_enabled, String(account.charges_enabled));
    check('Payouts enabled', account.payouts_enabled, String(account.payouts_enabled));
    const expected = expectedPrices(loadProgram());
    const live = /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY);
    for (const [plan, id] of Object.entries({ member: env.MEMBER_PRICE_ID, dropin: env.DROPIN_PRICE_ID })) {
      if (!id) continue;
      const price = await stripe.prices.retrieve(id);
      const problem = priceProblem(price, expected[plan]);
      check(`${plan} price`, !problem, problem || `${price.unit_amount / 100} ${price.currency}, ${price.type}`);
      check(`${plan} mode`, price.livemode === live, live ? 'live' : 'test');
    }
    if (base) {
      const hooks = [];
      for await (const hook of stripe.webhookEndpoints.list({ limit: 100 })) hooks.push(hook);
      const hook = hooks.find((h) => h.url === `${base}/webhooks/stripe` && h.status === 'enabled' && h.livemode === live);
      check('Payment webhook', hook && ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].every((e) => hook.enabled_events.includes(e) || hook.enabled_events.includes('*')), hook ? hook.url : 'missing or incomplete');
    }
    const portals = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
    const portal = portals.data.find((p) => p.is_default);
    check('Billing portal cancellation', portal?.features?.subscription_cancel?.enabled, 'default portal must allow cancellation');
  }
}
main().catch((error) => { check('API access', false, `${error.type || 'Error'}: verification could not complete`); }).finally(() => {
  console.table(checks);
  console.log('This audit does not prove payment success. Complete Stripe test checkout, decline, authentication, webhook retry and billing cancellation checks before live sales.');
  if (checks.some((c) => !c.pass)) process.exitCode = 1;
});
