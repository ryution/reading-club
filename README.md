# Reading Club: The Good Life

An enrollment page for the New York Philosophy Club. Tuition is a single
$450 USD payment for the six-week term. Stripe hosts checkout and stores
the enrollment records; this app never receives card details.

## Current status

The code runs locally and includes a Render deployment configuration.
Enrollment is closed by default. No Stripe credentials are included,
and the site has not been deployed or tested with real Stripe payments.

Before accepting payments, complete `club-details.json` with the confirmed
start date (including year), lecture and small-group times with timezone,
location or online format, contact email, and approved refund policy.
The original start date was October 15; confirm it with the organizer.
Do not put private meeting links in this public file; email those to students.

## Run locally

Use Node.js 22.16 or newer (the deployment uses Node 22).

```powershell
npm ci
Copy-Item .env.example .env
npm start
```

Open http://localhost:3000. The page works without Stripe credentials.
`npm start` and `npm run roster` automatically load `.env`; hosting environment
variables take precedence. Keep `.env` private: it is excluded from Git.

To enable test checkout:

1. In the **NYPS Stripe account's test environment**, create
   `Reading Club: The Good Life` with a one-off $450 USD price.
2. Set `STRIPE_SECRET_KEY` and `STRIPE_PRICE_ID` in `.env` using test values.
3. Complete `club-details.json` and set `ENROLLMENT_OPEN=true` in `.env`.
4. Restart the app. Use `SITE_URL=http://localhost:3000` for local testing.
5. Test success (`4242 4242 4242 4242`), decline (`4000 0000 0000 0002`),
   authentication (`4000 0025 0000 3155`), and returning without paying.
   Use a future expiry date and any valid-format CVC and ZIP.
6. Confirm the successful payment appears in the roster and shows “You're in.”

## Payment checks

- Before each checkout, validate the Stripe price is active, one-time,
  $450, and USD. An archived or incorrect price cannot open checkout.
- Accept cards and eligible wallets through Stripe. New bank payments are
  disabled to avoid enrolling students before delayed payments clear.
- Confirm enrollment only for a completed, paid session tagged for this
  program with the expected amount, currency, and payment mode.
- Require a configured HTTPS `SITE_URL` in production. Return URLs do not
  depend on an untrusted incoming Host header there.
- Keep confirmation responses out of browser caches and avoid leaking their
  session IDs through referrer headers.

## Capacity: operational limit, not guaranteed inventory

The default is 60 places. The server counts this program's completed
sessions **and unexpired open checkouts** before creating another checkout.
Open sessions expire after about 31 minutes, including sessions abandoned
via the back button. Visitors can pay through an existing open checkout
during that window. Simultaneous creation requests within one server
process receive a retry message while one is in progress.

Run **one server instance**. Stripe list calls and session creation are not
one atomic transaction. Overlapping deployments, another app using the same
program tag, or delays in Stripe list visibility can still oversell. There
is no “at most one or two extras” guarantee. If exactly 60 is a hard limit,
use a transactional reservation database and payment webhooks before launch.
Monitor the roster near capacity and close enrollment before deployments.

Refunded or failed older bank-payment sessions still occupy places because
completed Checkout Sessions do not track refunds or later failures here.
Reconcile those in Stripe. After refunding one real test enrollment, raise
`ENROLLMENT_CAPACITY` to 61 if you still want 60 student places. Do not raise
it just to bypass temporary open-checkout holds.

The program tag is `reading-club-good-life-2026` in `server.js`. Change it for
a new term only after old enrollment closes. All tagged sessions are counted;
there is no rolling lookback that silently frees old seats.

## Deploy with Ren

1. Push this folder's contents to `https://github.com/ryution/reading-club`.
2. In Render, create a Blueprint from the repository using `render.yaml`,
   or a Node web service with build command `npm ci`, start command
   `npm start`, health path `/healthz`, and **one instance**. The Blueprint
   selects the paid Starter plan; review Render's price before creating it.
3. Set the environment variables below. Keep enrollment closed while
   configuring the service and custom domain.
4. Ren connects the domain and sets `SITE_URL` to its HTTPS origin.
5. Verify test checkout on the hosted address before switching to live keys.
6. Complete NYPS activation, branding, and successful-payment receipts
   in Stripe. Create the live one-off $450 price, then set the live key and
   price ID on Render. Prefer a restricted key: the app calls Checkout
   Sessions create/list/retrieve and Prices retrieve. Verify those calls
   with the actual restricted key in test mode before launching.
7. Confirm all class details, prepare the welcome email, then set
   `ENROLLMENT_OPEN=true`. Restart/redeploy after configuration changes.
8. Have the account owner make and refund the real checkout test, then
   reconcile the seat count. Stripe and hosting setup remain Ren's handoff.

| Variable | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY` | NYPS test key locally; live key for live sales |
| `STRIPE_PRICE_ID` | Matching environment's $450 one-time USD price |
| `SITE_URL` | Public origin, e.g. `https://classes.example.org`; no subpath |
| `ENROLLMENT_OPEN` | Exactly `true` to open; defaults to closed |
| `ENROLLMENT_CAPACITY` | Positive integer; defaults to 60 |
| `NODE_ENV` | `production` on Render |
| `PORT` | Supplied by Render; local default 3000 |

Host the app at the root of its domain/subdomain. Link to it from the main
website; its security policy prevents iframe embedding. `/healthz` checks
that the server is running, not that Stripe is configured.

## Welcome emails and roster

There is **no automatic welcome-email delivery**. Customize
`WELCOME-EMAIL.md` with the schedule, first reading, and joining instructions.
Send it to paid students before the first class. Stripe receipts are separate.

```powershell
npm run --silent roster > roster.csv
```

The `--silent` flag keeps npm's banner out of the CSV. Export daily while
enrollment is open. It includes session ID, name, email, amount, payment
status, and date. Use the session ID to track who received a welcome email,
and reconcile refunds in Stripe before sending. The payment status describes
checkout payment, not refund status. Cells are escaped to prevent spreadsheet
formula injection. Roster CSV files are private and ignored by Git.

## Verification

```powershell
npm test
```

Local tests cover the landing page, assets, launch gates, price validation,
capacity holds and concurrent requests, error/cancel paths, confirmation
checks, production configuration, and roster CSV escaping. Four additional
Stripe SDK contract tests require Stripe's `stripe-mock` at port 12111 and
are skipped if it is absent. Mock tests do not replace a real Stripe test
purchase or account activation.

Reference: [Stripe Checkout Sessions](https://docs.stripe.com/api/checkout/sessions/create),
[Checkout Session fields](https://docs.stripe.com/api/checkout/sessions/object),
[Render Blueprint configuration](https://render.com/docs/blueprint-spec).
