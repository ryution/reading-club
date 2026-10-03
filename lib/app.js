'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { termDates, todayIn } = require('./schedule');
const { buildIcs } = require('./calendar');
const { makeToken, readToken, resendMailer } = require('./login');
const { createLocalLedger } = require('./ledger-local');
const { createStripeLedger } = require('./ledger-stripe');
const pages = require('./pages');

// require() (not a file read) so hosts that bundle the app, like Vercel, include program.json.
const loadProgram = () => JSON.parse(JSON.stringify(require('../program.json')));
// Zoom links and addresses: private.json on a server, or the PRIVATE_JSON env var on Vercel.
// Never served as a file.
function loadPrivate(env = process.env) {
  if (env.PRIVATE_JSON) return JSON.parse(env.PRIVATE_JSON);
  for (const file of [path.join(__dirname, '..', 'private.json'), '/etc/secrets/private.json']) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return {};
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

// ---------- small helpers ----------

function sectionById(program, id) { return program.sections.find((s) => s.id === id) || null; }
function sectionDates(program, section) { return termDates(program.termStarts, program.weeks, section.weekdays); }
function lectureDates(program) { return termDates(program.termStarts, program.weeks, [program.lecture.weekday]); }

// Where a visitor came from: ?src=journal, ?src=222, ?src=luma ...
function cleanSource(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[a-z0-9_-]{1,40}$/.test(s) ? s : '';
}

// A promo code typed or shared as a link: /?code=SPRING
function cleanCode(v) {
  const s = String(v || '').trim().toUpperCase();
  return /^[A-Z0-9_-]{2,40}$/.test(s) ? s : '';
}

function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ }
    }
  }
  return out;
}

// Open seats per section and per upcoming date. A new member needs a seat on every date.
function availability(program, counts, today) {
  const out = {};
  for (const sec of program.sections) {
    const upcoming = sectionDates(program, sec).filter((d) => d >= today);
    const dates = upcoming.map((d) => ({ date: d, left: Math.max(0, sec.capacity - counts.members[sec.id] - (counts.dropins[`${sec.id}|${d}`] || 0)) }));
    const busiest = upcoming.reduce((m, d) => Math.max(m, counts.dropins[`${sec.id}|${d}`] || 0), 0);
    out[sec.id] = { memberLeft: upcoming.length ? Math.max(0, sec.capacity - counts.members[sec.id] - busiest) : 0, dates };
  }
  return out;
}

// ---------- app ----------

function createApp({
  ledger, program = loadProgram(), privateInfo = {}, siteUrl, portalUrl, loginSecret, mailer, notifyEmail,
  enrollmentOpen = true, log = console, now = () => new Date(),
  stripe, webhookSecret, mailAvailable = Boolean(mailer),
}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const send = mailer || resendMailer({ log });
  const baseUrl = (req) => siteUrl || `${req.protocol}://${req.get('host')}`;
  const today = () => todayIn(program.timezone, now());
  const loginAvailable = Boolean(loginSecret && mailAvailable);
  let checkoutBusy = false;
  const sending = new Map();

  // Webhooks work even when the customer closes their browser after paying.
  async function fulfill(id) {
    if (sending.has(id)) return sending.get(id);
    const job = (async () => {
      const r = await ledger.receipt(id);
      if (!r || r.processing || r.pending || r.notified) return;
      if (!mailAvailable || !siteUrl || !loginSecret || !r.email) throw new Error('Payment email configuration is incomplete.');
      const section = sectionById(program, r.md.section);
      if (!section) throw new Error('Unknown section on payment.');
      await send({ to: r.email, subject: `You’re in: ${program.name}`,
        text: `Your ${r.md.plan === 'member' ? 'membership' : 'drop-in'} in ${section.name} is confirmed.\n\nYour schedule and joining details:\n${siteUrl}/my?t=${makeToken(r.email, loginSecret)}\n\n${program.org}`,
        idempotencyKey: `welcome/${id}` });
      await ledger.markNotified(id);
    })();
    sending.set(id, job);
    try { return await job; } finally { sending.delete(id); }
  }

  app.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    if (!stripe || !webhookSecret || ledger.mode !== 'stripe') return res.sendStatus(503);
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), webhookSecret); }
    catch { return res.status(400).send('Invalid signature'); }
    try {
      if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
        await fulfill(event.data.object.id);
      }
      forget();
      return res.json({ received: true });
    } catch (err) {
      log.error('[webhook]', err.message);
      return res.sendStatus(500); // Stripe retries; never acknowledge a failed delivery.
    }
  });
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));

  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; script-src 'none'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com; frame-ancestors 'none'; base-uri 'none'",
    });
    // ?code= and ?src= on any link are remembered for 30 days.
    const cookies = readCookies(req);
    const code = cleanCode(req.query.code);
    const src = cleanSource(req.query.src);
    const opts = { maxAge: 30 * 86400000, httpOnly: true, sameSite: 'lax', secure: req.secure };
    if (code) res.cookie('rc_code', code, opts);
    if (src && !cookies.rc_src) res.cookie('rc_src', src, opts); // first touch wins
    req.promoCode = code || cleanCode(cookies.rc_code);
    req.source = cleanSource(cookies.rc_src) || src || 'direct';
    next();
  });

  // Bound abuse without storing email addresses or other personal data.
  const attempts = new Map();
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const timestamp = Date.now();
    for (const [key, entry] of attempts) if (entry.until <= timestamp) attempts.delete(key);
    const key = `${req.ip}:${req.path}`;
    const entry = attempts.get(key) || { count: 0, until: timestamp + 600000 };
    entry.count++;
    attempts.set(key, entry);
    if (entry.count > (req.path === '/login' ? 8 : 30)) return res.status(429).set('Retry-After', '600').send('Too many attempts. Please try again in 10 minutes.');
    next();
  });

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d', index: false }));

  let cache = null;
  async function seats() {
    if (cache && Date.now() - cache.at < ledger.cacheMs) return cache.value;
    const value = availability(program, await ledger.counts(), today());
    cache = { at: Date.now(), value };
    return value;
  }
  const forget = () => { cache = null; };

  const ctx = (req) => ({ program, mode: ledger.mode, enrollmentOpen, code: req.promoCode });

  app.get('/', async (req, res) => {
    let avail = null;
    try { avail = await seats(); } catch (err) { log.error('[seats]', err.message); }
    res.set('Cache-Control', 'no-store').type('html').send(pages.landing({ ...ctx(req), avail, notice: req.query.error ? 'unavailable' : null }));
  });

  app.get('/join', async (req, res) => {
    const plan = req.query.plan === 'dropin' ? 'dropin' : 'member';
    const q = req.query;
    const notice = q.canceled ? 'canceled' : q.full ? 'full' : q.badcode ? 'badcode' : q.busy ? 'busy' : q.details ? 'details' : q.closed ? 'closed' : q.error ? 'unavailable' : null;
    const extra = { plan, notice, preselect: String(q.section || ''), slot: String(q.slot || '') };
    res.set('Cache-Control', 'no-store');
    try {
      res.type('html').send(pages.join({ ...ctx(req), ...extra, avail: await seats() }));
    } catch (err) {
      log.error('[join] Could not count seats:', err.message);
      res.type('html').send(pages.join({ ...ctx(req), ...extra, avail: null, notice: 'unavailable' }));
    }
  });

  app.post('/checkout', async (req, res) => {
    const body = req.body || {};
    const plan = body.plan === 'dropin' ? 'dropin' : 'member';
    // Drop-in forms send slot="section|date"; membership forms send section.
    const [slotSection, slotDate] = String(body.slot || '').split('|');
    const section = sectionById(program, String(body.section || slotSection || ''));
    const date = plan === 'dropin' ? String(body.date || slotDate || '') : undefined;
    const back = (flag) => res.redirect(303, `/join?plan=${plan}${section ? `&section=${section.id}` : ''}${date && section ? `&slot=${encodeURIComponent(`${section.id}|${date}`)}` : ''}&${flag}=1`);
    if (!enrollmentOpen) return back('closed');
    if (!section) return back('error');
    if (plan === 'dropin' && !sectionDates(program, section).includes(date)) return back('error');
    const name = String(body.name || '').trim().slice(0, 120);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
    if (ledger.mode === 'local' && (!name || !EMAIL.test(email))) return back('details');
    const code = Object.hasOwn(body, 'code') ? cleanCode(body.code) : req.promoCode;
    if (body.code && !code) return back('badcode');
    if (Object.hasOwn(body, 'code') && !code) res.clearCookie('rc_code', { path: '/' });
    if (checkoutBusy) return back('busy');
    checkoutBusy = true;

    try {
      forget();
      const avail = (await seats())[section.id];
      const left = plan === 'member' ? avail.memberLeft : ((avail.dates.find((d) => d.date === date) || { left: 0 }).left);
      if (left <= 0) return back('full');
      const result = await ledger.begin({
        plan, section, date, source: req.source, code, name, email: EMAIL.test(email) ? email : '', base: baseUrl(req),
        checkoutId: /^[a-f0-9-]{36}$/.test(body.checkoutId || '') ? body.checkoutId : undefined,
      });
      forget();
      if (result.error) return back(result.error);
      if (result.reservation && !result.existing) await confirmReservation(req, result.reservation, section);
      return res.redirect(303, result.redirect);
    } catch (err) {
      log.error('[checkout]', err.message);
      return back('error');
    } finally {
      checkoutBusy = false;
    }
  });

  // Placeholder mode: tell the student their seat is held, and tell the organizers.
  async function confirmReservation(req, r, section) {
    const link = loginSecret ? `${baseUrl(req)}/my?t=${makeToken(r.email, loginSecret)}` : `${baseUrl(req)}/login`;
    const what = r.plan === 'member' ? `a membership seat in ${section.name}` : `a drop-in seat on ${r.date}`;
    try {
      await send({
        to: r.email,
        subject: `Your seat in ${program.name} is held`,
        text: `Hi ${r.name.split(' ')[0]},\n\nYou have ${what}. We will email you a secure payment link before the term begins, and your seat stays held until then.\n\nYour schedule and joining details:\n${link}\n\n${program.org}`,
      });
      if (notifyEmail) {
        await send({ to: notifyEmail, subject: `New ${r.plan === 'member' ? 'membership' : 'drop-in'}: ${r.name}`, text: `${r.name} <${r.email}>\n${what}\nSource: ${r.source}${r.code ? `\nCode: ${r.code}` : ''}` });
      }
    } catch (err) {
      log.error('[mail]', err.message);
    }
  }

  app.post('/interest', async (req, res) => {
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
    const name = String(body.name || '').trim().slice(0, 120);
    const section = sectionById(program, String(body.section || ''));
    if (body.website) return res.type('html').send(pages.interestThanks({ program, section })); // bots fill the hidden field
    if (!EMAIL.test(email)) return res.redirect(303, section ? `/join?section=${section.id}&details=1#waitlist` : '/?error=1#interest');
    try {
      await ledger.saveLead({ email, name, section: section ? section.id : '', source: req.source, lead: section ? 'waitlist' : 'interest' });
      return res.type('html').send(pages.interestThanks({ program, section }));
    } catch (err) {
      log.error('[interest]', err.message);
      return res.redirect(303, '/?error=1#interest');
    }
  });

  function eventsFor(md) {
    const section = sectionById(program, md.section);
    if (!section) return [];
    const title = `${program.shortName}: ${section.name}`;
    if (md.plan === 'dropin') {
      return [{ uid: `${md.section}-${md.date}@nyphilosophy-reading-club`, date: md.date, time: section.time, minutes: section.minutes, title, where: section.where }];
    }
    const t = today();
    const small = sectionDates(program, section).filter((d) => d >= t)
      .map((d) => ({ uid: `${section.id}-${d}@nyphilosophy-reading-club`, date: d, time: section.time, minutes: section.minutes, title, where: section.where }));
    const lec = program.lecture;
    const lectures = lectureDates(program).filter((d) => d >= t)
      .map((d) => ({ uid: `lecture-${d}@nyphilosophy-reading-club`, date: d, time: lec.time, minutes: lec.minutes, title: `${program.shortName}: ${lec.label}`, where: lec.where }));
    return [...lectures, ...small].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  }

  async function receiptFor(req) {
    const id = String(req.query.id || req.query.session_id || '');
    if (!id || id.length > 200) return null;
    return ledger.receipt(id);
  }

  app.get('/welcome', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const r = await receiptFor(req);
      const section = r && sectionById(program, r.md.section);
      if (!r || !section) return res.status(404).type('html').send(pages.notConfirmed({ program }));
      if (!r.processing && ledger.mode === 'stripe') {
        try { await fulfill(String(req.query.id || req.query.session_id)); }
        catch (err) { log.error('[welcome email]', err.message); }
      }
      const memberLink = !r.processing && loginSecret && r.email ? `/my?t=${makeToken(r.email, loginSecret)}` : null;
      return res.type('html').send(pages.welcome({
        program, r, section, events: eventsFor(r.md), calendarHref: `/calendar.ics?id=${encodeURIComponent(String(req.query.id || req.query.session_id))}`, memberLink,
      }));
    } catch (err) {
      log.error('[welcome]', err.message);
      return res.status(404).type('html').send(pages.notConfirmed({ program }));
    }
  });

  const sendIcs = (res, events) => {
    const unique = [...new Map(events.map((e) => [e.uid, e])).values()];
    res.set({ 'Content-Disposition': 'attachment; filename="reading-club.ics"', 'Cache-Control': 'no-store' });
    return res.type('text/calendar').send(buildIcs({ timeZone: program.timezone, calendarName: program.name, events: unique }));
  };

  app.get('/calendar.ics', async (req, res) => {
    try {
      const r = await receiptFor(req);
      if (!r || r.processing) return res.status(404).send('Not found');
      return sendIcs(res, eventsFor(r.md));
    } catch (err) {
      log.error('[calendar]', err.message);
      return res.status(404).send('Not found');
    }
  });

  // ---------- member sign-in: email in, link out, no passwords ----------

  app.get('/login', (req, res) => {
    res.type('html').send(pages.login({ program, sent: false, expired: Boolean(req.query.expired), invalid: Boolean(req.query.invalid), available: loginAvailable }));
  });

  app.post('/login', async (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase().slice(0, 200);
    if (!loginAvailable) return res.redirect(303, '/login');
    if (!EMAIL.test(email)) return res.redirect(303, '/login?invalid=1');
    try {
      const found = await ledger.enrollmentsFor(email);
      if (found.length || (ledger.hasBilling && await ledger.hasBilling(email))) {
        const link = `${baseUrl(req)}/my?t=${makeToken(email, loginSecret)}`;
        await send({
          to: email,
          subject: `Your ${program.shortName} link`,
          text: `Here is your link to ${program.name}. It shows your section, your schedule, and how to join each session.\n\n${link}\n\nThe link works for 60 days. You can always get a new one at ${baseUrl(req)}/login.\n\n${program.org}`,
        });
      }
    } catch (err) {
      log.error('[login]', err.message);
      return res.status(503).type('html').send(pages.problem({ program }));
    }
    // Same answer either way, so the form can't be used to check who signed up.
    return res.type('html').send(pages.login({ program, sent: true, available: true }));
  });

  app.get('/my', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const email = readToken(req.query.t, loginSecret, now().getTime());
    if (!email) return res.redirect(303, '/login?expired=1');
    try {
      const t = today();
      const found = (await ledger.enrollmentsFor(email)).filter((e) => e.plan === 'member' || e.date >= t);
      const items = found.map((e) => ({ ...e, sectionInfo: sectionById(program, e.section), events: eventsFor(e) })).filter((e) => e.sectionInfo);
      return res.type('html').send(pages.member({ program, mode: ledger.mode, email, items, privateInfo, portalUrl, token: String(req.query.t) }));
    } catch (err) {
      log.error('[my]', err.message);
      return res.status(500).type('html').send(pages.problem({ program }));
    }
  });

  app.get('/my/calendar.ics', async (req, res) => {
    const email = readToken(req.query.t, loginSecret, now().getTime());
    if (!email) return res.status(404).send('Not found');
    try {
      return sendIcs(res, (await ledger.enrollmentsFor(email)).flatMap(eventsFor));
    } catch (err) {
      log.error('[my calendar]', err.message);
      return res.status(404).send('Not found');
    }
  });

  app.post('/billing', async (req, res) => {
    const token = String(req.body?.t || '');
    const email = readToken(token, loginSecret, now().getTime());
    if (!email) return res.redirect(303, '/login?expired=1');
    if (!ledger.billingPortal) return res.status(503).type('html').send(pages.problem({ program }));
    try {
      const url = await ledger.billingPortal(email, `${baseUrl(req)}/my?t=${encodeURIComponent(token)}`);
      if (!url || !url.startsWith('https://billing.stripe.com/')) return res.status(404).type('html').send(pages.notFound({ program }));
      return res.redirect(303, url);
    } catch (err) {
      log.error('[billing]', err.message);
      return res.status(503).type('html').send(pages.problem({ program }));
    }
  });

  app.use((req, res) => res.status(404).type('html').send(pages.notFound({ program })));

  return app;
}

module.exports = { createApp, availability, cleanSource, cleanCode, loadProgram, loadPrivate, sectionDates, lectureDates };
