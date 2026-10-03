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
  const required = ['STRIPE_SECRET_KEY', 'MEMBER_PRICE_ID', 'DROPIN_PRICE_ID', 'STRIPE_WEBHOOK_SECRET', 'LOGIN_SECRET', 'BILLING_PORTAL_CONFIG_ID'];
  if (loadProgram().billing?.model === 'weekly-25-v1') required.push('INSTALLMENT_PRICE_ID', 'INSTALLMENT_PORTAL_CONFIG_ID');
  if (loadProgram().billing?.model === 'upfront-450-v1') required.push('TUITION_PRICE_ID');
  if (env.EMAIL_DELIVERY_MODE !== 'on_page') required.push('RESEND_API_KEY', 'MAIL_FROM');
  check('Access delivery', true, env.EMAIL_DELIVERY_MODE === 'on_page' ? 'on confirmation page; email recovery unavailable' : 'email');
  for (const key of required) check(key, env[key], env[key] ? 'configured' : 'missing');
  let base;
  try { base = resolveSiteUrl({ ...env, NODE_ENV: 'production' }); check('Public origin', true, base); }
  catch (e) { check('Public origin', false, e.message); }
  if (env.STRIPE_SECRET_KEY) {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { timeout: 15000, maxNetworkRetries: 1 });
    try {
      const account = await stripe.accounts.retrieve();
      check('Stripe account', account.id === 'acct_1TDSFELFXIBpLlZr', account.id);
      check('Charges enabled', account.charges_enabled, String(account.charges_enabled));
      check('Payouts enabled', account.payouts_enabled, String(account.payouts_enabled));
    } catch (error) {
      check('Stripe account status', false, `${error.type || 'Error'}: confirm account and charges/payouts in Dashboard`);
    }
    const expected = expectedPrices(loadProgram());
    const live = /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY);
    for (const [plan, id] of Object.entries({ ...(loadProgram().billing?.model === 'upfront-450-v1' ? { tuition: env.TUITION_PRICE_ID } : { member: env.MEMBER_PRICE_ID }), dropin: env.DROPIN_PRICE_ID })) {
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
    const portal = env.BILLING_PORTAL_CONFIG_ID
      ? await stripe.billingPortal.configurations.retrieve(env.BILLING_PORTAL_CONFIG_ID)
      : portals.data.find((p) => p.is_default);
    check('Billing portal cancellation', portal?.active && portal?.features?.subscription_cancel?.enabled, portal?.id || 'missing configuration');
    check('Billing portal card updates', portal?.features?.payment_method_update?.enabled, portal?.id || 'missing configuration');
    if (env.INSTALLMENT_PRICE_ID && loadProgram().billing?.model === 'weekly-25-v1') {
      const p = await stripe.prices.retrieve(env.INSTALLMENT_PRICE_ID);
      const problem = priceProblem(p, { unit_amount: 2500, currency: 'usd', type: 'recurring', interval: 'week', interval_count: 1 });
      check('Weekly installment price', !problem && p.livemode === live, problem || '$25 weekly; schedule limits to 18 cycles');
      await stripe.subscriptionSchedules.list({ limit: 1 });
      check('Schedule read access', true, 'available');
    }
    if (env.INSTALLMENT_PORTAL_CONFIG_ID && loadProgram().billing?.model === 'weekly-25-v1') {
      const p = await stripe.billingPortal.configurations.retrieve(env.INSTALLMENT_PORTAL_CONFIG_ID);
      check('Fixed commitment portal', p.active && !p.features.subscription_cancel.enabled && !p.features.subscription_update.enabled && p.features.payment_method_update.enabled && p.features.invoice_history.enabled, p.id);
    }
  }
}
main().catch((error) => { check('API access', false, `${error.type || 'Error'}: verification could not complete`); }).finally(() => {
  console.table(checks);
  console.log('This audit does not prove payment success. Complete Stripe test checkout, decline, authentication, webhook retry and billing cancellation checks before live sales.');
  if (checks.some((c) => !c.pass)) process.exitCode = 1;
});
