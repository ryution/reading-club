# Reading Club: The Good Life

The signup site for the New York Philosophy Club's paid Reading Club. Visitors read about the program, pick a membership section or a single drop-in session, sign up, and get a schedule, a calendar file and a member page with their joining details.

It matches nyphilosophy.org: same cream paper, navy ink, terracotta accent, Libre Baskerville and Newsreader type, rounded outline buttons, logo and footer.

## Payments: placeholder for now

Stripe is built but switched off. Until the Stripe keys are set, signing up **reserves a seat** instead of charging a card:

- The student enters name and email, and the seat counts toward the section's cap right away.
- They get a confirmation email with their schedule and member page link. The page says clearly that no payment is due today and a payment link will follow before the term.
- Organizers get a note for every signup (`NOTIFY_EMAIL`), and `npm run --silent roster > roster.csv` exports every reservation with its list source and code.

When Stripe is ready, set `STRIPE_SECRET_KEY`, `MEMBER_PRICE_ID` and `DROPIN_PRICE_ID` and restart. The same pages switch to Stripe Checkout:

- Membership is a subscription, $450 every 6 weeks ($25 per class hour).
- Drop-in is $40 once, and the card is saved for next time.
- Seats are then counted from Stripe, and codes are checked against Stripe promotion codes.

Reservations made before the switch stay in `DATA_DIR`. Send those people payment links from Stripe.

## Pages

| Path | What it is |
| --- | --- |
| `/` | The offer: the reading, how a week works, who teaches, sections with seats left and an Enroll button each, tuition, questions, and a "keep me posted" form |
| `/join?plan=member&section=b` | Pick a section, then add your details and an optional code. Full sections show a waitlist |
| `/join?plan=dropin` | Pick one session. Only open dates are shown, four per section |
| `/welcome?id=...` | Confirmation, what happens next, schedule, add-to-calendar, member page link |
| `/login` | Member sign in: enter email, get a link. No passwords |
| `/my?t=...` | Member page: section, Zoom link, lecture location, readings, upcoming dates, calendar |
| `/healthz` | Health check for the host |

The site sends no JavaScript to the browser. Every step is a plain link or form, so it works on any phone, with scripts blocked, and with screen readers.

## Tracking lists and codes

- **Sources:** add `?src=` to every link you send out, like `?src=journal`, `?src=222` or `?src=luma`. The first source a visitor arrives with is kept for 30 days and saved on their signup.
- **Codes:** share a code as a link (`/?code=JOURNAL`) and it is remembered and filled in. People can also type one under "Have a code?".
  - While Stripe is off, codes are recorded on the reservation so you can honor them on the payment link.
  - Once Stripe is on, codes are checked live, and a bad code sends people back with a note.
  - With Stripe on, `SOURCE_PROMOS=journal=promo_...` applies a code automatically to everyone from `?src=journal`.

## What to edit

- **`program.json`:** term start, weeks, prices, the six texts, lecture day and time, sections (days, time, capacity, facilitator), the teacher bio, contact email and refund policy.
  - Weekdays are numbered 0 = Sunday through 6 = Saturday, and times are 24-hour Eastern.
  - The refund policy shows up in the Questions list only once it is filled in.
  - **The section times are placeholders. Confirm them with Cole before opening signups.**
- **Teacher photo:** put it in `public/img/`, then set `teacher.photo` to `/img/cole.jpg`.
- **`private.json`** (copy from `private.example.json`): Zoom links per section, the lecture address or stream, and a readings link. These are only ever shown to signed-in members. Anything left empty shows "Coming by email."

## Run it

```powershell
npm ci
npm run demo      # full click-through with sample signups, nothing saved
npm start         # the real thing; copy .env.example to .env first
npm test
```

`npm test` includes Stripe contract tests that run against [stripe-mock](https://github.com/stripe/stripe-mock) on port 12111. They are skipped if it isn't running.

## Deploy on Vercel (current)

The site is live at reading-club-rho.vercel.app. Vercel runs `server.js` as a function and serves `public/` directly.

Vercel can't keep files between requests, so reservations need a database. Until one is connected, the site loads but signups stay closed ("Signups open soon").

1. In the Vercel project, open **Storage**, choose **Upstash for Redis** (free tier is plenty), and connect it to this project. That adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.
2. Under **Settings → Environment Variables**, add:
   - `LOGIN_SECRET`: any long random string
   - `RESEND_API_KEY` and `MAIL_FROM`, for confirmation and sign-in emails
   - `NOTIFY_EMAIL`, optional: gets a note for every signup
   - `PRIVATE_JSON`: the contents of `private.json` (Zoom links and so on), pasted as one line
   - `ENROLLMENT_OPEN=false` until Cole confirms the section times, then remove it or set it to `true`
3. Redeploy.

Set `SITE_URL` once there's a custom domain. Until then, emailed links use the Vercel production address.

## Deploy on Render (alternative)

`render.yaml` sets up one web service with a 1 GB disk at `/var/data`, which keeps reservations as a file. Create a Blueprint from this repository, set `SITE_URL`, the Resend variables and `ENROLLMENT_OPEN`, and run exactly one instance.

## Files

- `server.js`: reads settings and starts the site (or hands it to Vercel)
- `lib/app.js`: routes
- `config.js`: env loading and checks
- `lib/pages.js`: every page
- `public/styles.css`: the design
- `lib/ledger-local.js`: seat reservations while Stripe is off, stored in Redis or a file
- `lib/ledger-stripe.js`: Stripe Checkout, subscriptions and seat counts
- `lib/login.js`: sign-in links and email
- `lib/schedule.js` and `lib/calendar.js`: dates and .ics files
- `scripts/roster.js`: CSV export
- `scripts/demo.js`: sample-data demo
- `WELCOME-EMAIL.md`: the longer welcome email to send before week one
