# Reading Club: The Good Life

Express signup and member portal for the New York Philosophy Club. Deployed on Render from `ryution/reading-club`, branch `main`.

## Offer and payment behavior

- Membership: $450 USD at checkout, recurring every six weeks from purchase.
- Drop-in: $40 USD for a selected session, with the card saved by Stripe.
- Stripe hosts payment entry. This app never receives card details.
- `program.json` defines the course, sections, prices and public details. Private joining links belong in `PRIVATE_JSON`, `private.json`, or Render's `/etc/secrets/private.json`.
- `ENROLLMENT_OPEN` must be exactly `true`. Missing or partial payment/email configuration keeps Stripe enrollment closed.

Without Stripe configuration, the app stores unpaid reservations in a local persistent file or Redis. These are reservations, not paid enrollments. Before switching to Stripe, reconcile existing reservations and their capacity; they are not automatically migrated.

## Local development

Use Node 22.16 or later. Run `npm ci`, then `npm run demo` for a sample-data preview. `npm start` loads an ignored `.env` file if present. Do not put live credentials in source control.

Run `npm test`. Tests cover enrollment, calendar, waitlists, promo codes, private access, concurrency, billing authorization, price checks and signed webhook retries. The optional stripe-mock contract test skips when its server is absent. Mocked tests do not prove a real payment succeeded.

## Render and Stripe setup

Render service: https://reading-club-d7if.onrender.com

1. Keep `ENROLLMENT_OPEN=false` while configuring. Use one Render instance with the persistent disk in `render.yaml`.
2. Set `SITE_URL` to the HTTPS origin. When absent, the app uses Render's trusted `RENDER_EXTERNAL_URL`; production rejects invalid URLs and never uses a visitor-supplied Host header.
3. Set matching Stripe environment values: `STRIPE_SECRET_KEY`, `MEMBER_PRICE_ID`, and `DROPIN_PRICE_ID`. Membership must be $450 USD recurring every six weeks; drop-in must be $40 USD one-time. Every checkout revalidates the price.
4. Create an event destination at `https://reading-club-d7if.onrender.com/webhooks/stripe`, subscribing to `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Store its signing secret as `STRIPE_WEBHOOK_SECRET` on Render.
5. Set a long random `LOGIN_SECRET`, `RESEND_API_KEY`, and `MAIL_FROM` using a verified sending domain. Sign-in is unavailable without email delivery. Tokens and email contents are never logged as a fallback.
6. Enable Stripe's default customer portal with payment-method updates and cancellation at the end of the billing period. The app creates an authenticated portal session for the member's Stripe Customer.
7. Fill in `contactEmail` and the approved `refundPolicy` in `program.json`, and the private joining links. Configure the journal promotion only once its amount and duration are confirmed. `SOURCE_PROMOS=journal=promo_...` applies a source discount automatically; typed/shared codes override it.
8. Run `npm run verify:payments` in the configured environment. This is read-only: it checks account identity, charge/payout capability, matching prices, webhook registration and cancellation configuration without printing credentials or creating charges.
9. Exercise the full flow with Stripe test credentials and test prices first: successful payment, decline, authentication, invalid code, full discount, cancel/return, webhook retry, member email, calendar and billing cancellation. Test email delivery using an address controlled by the organizer.
10. Switch to matching live credentials/prices after those checks. The account owner should complete the authorized real-payment check. Open enrollment only when the whole flow and program details are ready.

Live catalog entries created October 3, 2026 in account `acct_1TDSFELFXIBpLlZr`:

| Plan | Product | Price |
| --- | --- | --- |
| Membership | `prod_VNF5oRCW7gXv9f` | `price_1UMUbDLFXIBpLlZr6NotQtj6` |
| Drop-in | `prod_VNFES34KNTiSy6` | `price_1UMUkALFXIBpLlZrSLMHq2aK` |

Creating these products does not connect Render or demonstrate successful checkout.

## Payment confirmation and capacity

Completed checkout is not sufficient for member access. Confirmation checks the actual price, quantity, currency, payment mode, program and payment status. Unpaid checkouts show processing without member links or calendar access. Refunded or disputed drop-ins are denied access. Active/trialing subscriptions grant access; past-due/unpaid subscriptions can still reach billing to resolve payment, but not private class links.

Signed Stripe webhooks deliver confirmation emails even if a customer closes the browser after paying. Delivery uses a stable Resend idempotency key and a durable sent marker on the Checkout Session. Failed deliveries return a retryable error to Stripe. Resend's idempotency window is finite; a prolonged failure between delivery and marking the session needs manual reconciliation.

Checkout requests are serialized within one process, and open Stripe Checkout Sessions reserve seats for 31 minutes. Repeated submissions of the same form reuse the same Stripe idempotency key and request while the process is alive. Capacity is still an operational limit, not a distributed transaction: overlapping instances, deploys, API list visibility and another selling application can oversell. Do not horizontally scale without a transactional shared reservation store. Completed canceled/refunded purchases can conservatively hold capacity until manually reconciled. Run one instance and close enrollment during migration/deployment near capacity.

Membership billing repeats from purchase; the displayed class schedule covers the configured six-week course only. Publish the next course's schedule and reconcile subscription seats before a term rollover. Refunding a subscription payment does not cancel the subscription; use Stripe cancellation when revoking membership.

## Sources, codes and operations

`?src=journal`, `?src=222`, etc. persist first-touch attribution for 30 days. `?code=JOURNAL` prefills a code for validation at checkout. Clearing the field clears the linked code. Invalid codes are not silently charged at full price.

`npm run --silent roster > roster.csv` exports the selected ledger. The CSV is private and ignored by Git. Reconcile payment and refund state in Stripe before using the roster. Waitlist notifications, course materials, reminder emails and term rollover remain organizer operations.

`/healthz` checks the process only. Use the payment audit and a real Stripe test-mode signup to assess checkout readiness.

References: [Stripe fulfillment](https://docs.stripe.com/checkout/fulfillment), [Stripe Checkout](https://docs.stripe.com/api/checkout/sessions/create), [Render environment variables](https://render.com/docs/environment-variables).
