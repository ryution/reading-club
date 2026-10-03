# Reading Club: The Good Life

Express signup and member portal for the New York Philosophy Club. Deployed on Render from `ryution/reading-club`, branch `main`.

## Offer and payment behavior

- Membership: $450 USD paid once at checkout for the six-week course, with no automatic renewal. The advertised $25 rate is the equivalent across 18 included sessions (6 lectures, 6 small-group meetings, 6 optional office hours), not a separate charge.
- Drop-in: $40 USD for a selected session, with the card saved by Stripe.
- Stripe hosts payment entry. This app never receives card details.
- `program.json` defines the course, sections, prices and public details. Private joining links belong in `PRIVATE_JSON`, `private.json`, or Render's `/etc/secrets/private.json`.
- `ENROLLMENT_OPEN` must be exactly `true`. Missing or partial payment configuration keeps Stripe enrollment closed. Email is required unless the owner explicitly sets `EMAIL_DELIVERY_MODE=on_page`.

Without Stripe configuration, the app stores unpaid reservations in a local persistent file or Redis. These are reservations, not paid enrollments. Before switching to Stripe, reconcile existing reservations and their capacity; they are not automatically migrated.

## Local development

Use Node 22.16 or later. Run `npm ci`, then `npm run demo` for a sample-data preview. `npm start` loads an ignored `.env` file if present. Do not put live credentials in source control.

Run `npm test`. Tests cover enrollment, calendar, waitlists, promo codes, private access, concurrency, billing authorization, price checks and signed webhook retries. The optional stripe-mock contract test skips when its server is absent. Mocked tests do not prove a real payment succeeded.

## Render and Stripe setup

Render service: https://reading-club-d7if.onrender.com

1. Keep `ENROLLMENT_OPEN=false` while configuring. Use one Render instance with the persistent disk in `render.yaml`.
2. Set `SITE_URL` to the HTTPS origin. When absent, the app uses Render's trusted `RENDER_EXTERNAL_URL`; production rejects invalid URLs and never uses a visitor-supplied Host header.
3. Set matching Stripe environment values: `STRIPE_SECRET_KEY`, `TUITION_PRICE_ID`, and `DROPIN_PRICE_ID`. Tuition must be $450 USD one-time; drop-in must be $40 USD one-time. Retain `MEMBER_PRICE_ID` for legacy recurring receipts. Every checkout revalidates the price and refuses recurring prices for current membership.
4. Create an event destination at `https://reading-club-d7if.onrender.com/webhooks/stripe`, subscribing to `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Store its signing secret as `STRIPE_WEBHOOK_SECRET` on Render.
5. Set a long random `LOGIN_SECRET`. Normally set `RESEND_API_KEY` and `MAIL_FROM` using a verified sending domain. To launch without email, explicitly set `EMAIL_DELIVERY_MODE=on_page`: verified payment opens the member page, sets an HttpOnly secure browser cookie, and offers a downloadable private access file. Members must keep that file; email recovery is unavailable. A valid member link remembers the browser for another 60 days. Payment confirmation can renew access while enrollment remains active. Lost-link recovery requires organizer identity/payment verification. Tokens and email contents are never logged as a fallback.
6. Retain `BILLING_PORTAL_CONFIG_ID` for legacy recurring memberships. Current one-time course purchases do not create subscriptions and do not need a recurring billing portal.
7. Fill in `contactEmail` and the approved `refundPolicy` in `program.json`, and the private joining links. Configure the journal promotion only once its amount and duration are confirmed. `SOURCE_PROMOS=journal=promo_...` applies a source discount automatically; typed/shared codes override it.
8. Run `npm run verify:payments` in the configured environment. This is read-only: it checks account identity, charge/payout capability, matching prices, webhook registration and cancellation configuration without printing credentials or creating charges.
9. Exercise the full flow with Stripe test credentials and test prices first: successful payment, decline, authentication, invalid code, full discount, cancel/return, webhook retry, member email, calendar and billing cancellation. Test email delivery using an address controlled by the organizer.
10. Switch to matching live credentials/prices after those checks. The account owner should complete the authorized real-payment check. Open enrollment only when the whole flow and program details are ready.

Live catalog entries created October 3, 2026 in account `acct_1TDSFELFXIBpLlZr`:

| Plan | Product | Price |
| --- | --- | --- |
| Membership, paid once | `prod_VNF5oRCW7gXv9f` | `price_1UMZcCLFXIBpLlZrS69HDvil` |
| Drop-in | `prod_VNFES34KNTiSy6` | `price_1UMUkALFXIBpLlZrSLMHq2aK` |

The live products, restricted server key, webhook, and dedicated portal `bpc_1UMVAqLFXIBpLlZrWmlZROPV` were connected to Render on October 3. Both live checkout types were created with the correct totals and expired without payment. This does not demonstrate a successfully settled charge.

## Payment confirmation and capacity

Completed checkout is not sufficient for member access. Confirmation checks the actual price, quantity, currency, payment mode, program, course dates and payment status. Unpaid checkouts show processing without member links or calendar access. Refunded or disputed one-time purchases are denied access. Paid upfront memberships grant access through the course end date. Legacy active/trialing subscriptions grant access; past-due/unpaid subscriptions can still reach billing to resolve payment, but not private class links.

With email configured, signed Stripe webhooks deliver confirmation emails even if a customer closes the browser after paying. Delivery uses a stable Resend idempotency key and a durable sent marker on the Checkout Session. Failed deliveries return a retryable error to Stripe. Resend's idempotency window is finite; a prolonged failure between delivery and marking the session needs manual reconciliation. In explicit on-page mode without mail, webhooks validate the payment and acknowledge it; Stripe is the enrollment record and the verified success page delivers access. Customers who close checkout before returning need their saved access file or organizer assistance. No email-sent marker is recorded when no email was sent.

Checkout requests are serialized within one process, and open Stripe Checkout Sessions reserve seats for 31 minutes. Repeated submissions of the same form reuse the same Stripe idempotency key and request while the process is alive. Capacity is still an operational limit, not a distributed transaction: overlapping instances, deploys, API list visibility and another selling application can oversell. Do not horizontally scale without a transactional shared reservation store. Completed canceled/refunded purchases can conservatively hold capacity until manually reconciled. Run one instance and close enrollment during migration/deployment near capacity.

Legacy membership billing repeats from purchase; the displayed class schedule covers the configured six-week course only. Publish the next course's schedule and reconcile subscription seats before a term rollover. Refunding a subscription payment does not cancel the subscription; use Stripe cancellation when revoking membership.

## Sources, codes and operations

`?src=journal`, `?src=222`, etc. persist first-touch attribution for 30 days. `?code=JOURNAL` prefills a code for validation at checkout. Clearing the field clears the linked code. Invalid codes are not silently charged at full price.

`npm run --silent roster > roster.csv` exports the selected ledger. The CSV is private and ignored by Git. Reconcile payment and refund state in Stripe before using the roster. Waitlist notifications, course materials, reminder emails and term rollover remain organizer operations.

`/healthz` checks the process only. Use the payment audit and a real Stripe test-mode signup to assess checkout readiness.

References: [Stripe fulfillment](https://docs.stripe.com/checkout/fulfillment), [Stripe Checkout](https://docs.stripe.com/api/checkout/sessions/create), [Render environment variables](https://render.com/docs/environment-variables).
## Historical installment implementation (superseded October 3, 2026)

The briefly published installment offer was superseded by the owner's clarification: one $450 charge, with $25 shown only as an equivalent session rate. A read-only Stripe check before the change found no completed Reading Club checkouts and no installment schedules. Compatibility code remains for previously issued receipts; `program.json` selects `upfront-450-v1`, so new enrollments cannot create installment schedules. The following notes apply only to the historical installment implementation.

Set `INSTALLMENT_PRICE_ID` to a live $25 USD weekly recurring price and `INSTALLMENT_PORTAL_CONFIG_ID` to a separate portal with invoice history/card updates enabled and subscription cancellation/plan switching disabled. Retain the original `MEMBER_PRICE_ID` and `BILLING_PORTAL_CONFIG_ID` for legacy receipts and purchases. Do not migrate existing customers without their agreement.

The restricted server key additionally needs **Setup Intents: Read** and **Subscriptions: Write**. Setup Checkout collects a card; the verified completion webhook creates the finite Stripe schedule. The webhook must be configured before sales open. It returns an error for incomplete scheduling so Stripe retries. Repeated webhooks and confirmation-page visits reuse the schedule using both Stripe metadata lookup and an idempotency key. Run one app instance; in-process enrollment locks do not support multiple instances.

The checkbox and Stripe confirmation text disclose the full commitment, first payment date, and duration. Membership discounts are not applied to this fixed plan; contact the club to arrange a separately agreed offer. Drop-in promotions continue to work. New full-term enrollment closes when the course starts. Card failures restrict course access but preserve access to billing. Class attendance does not trigger or skip installments.

Operations: approved refunds/cancellations must cancel the **subscription schedule**, and separately handle any agreed refund or open invoice in Stripe. Do not merely refund one charge while leaving future installments active. Review failed webhook deliveries and past-due subscriptions in Stripe. A delayed setup whose agreed start date has already passed is flagged for review rather than backdating a charge. Customer support and card-authentication recovery must be monitored; no Resend service is configured.

Validation: `npm test` includes schedule duration/end behavior, DST/Monday dates, duplicate enrollment, consent, legacy compatibility and delinquent-member recovery. Mock/unit success does not prove real issuer approval or settlement. `npm run verify:payments` audits the production price, mode, webhook and portal. Before claiming end-to-end collection, verify a test-mode completed setup and scheduled invoice with Stripe test clocks, including authentication and decline handling.
