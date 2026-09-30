'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp, availability, cleanSource, cleanCode, loadProgram, sectionDates } = require('../server');
const { parseSourcePromos, validateConfig } = require('../config');
const { createLocalLedger } = require('../lib/ledger-local');
const { createStripeLedger, checkoutParams, priceProblem, expectedPrices } = require('../lib/ledger-stripe');
const { termDates, formatDays } = require('../lib/schedule');
const { buildIcs } = require('../lib/calendar');
const { makeToken, readToken } = require('../lib/login');
const { fakeStripe } = require('./fake-stripe');

const program = loadProgram();
const quietLog = { error() {}, warn() {}, log() {} };
const BEFORE_TERM = () => new Date('2026-10-01T15:00:00Z');
const SECRET = 'test-secret';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-test-'));

function seeded(rows = [], leads = []) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'reservations.json'), JSON.stringify({ reservations: rows.map((r, i) => ({ id: `r_${i}`, program: program.program, status: 'reserved', name: 'X', email: `x${i}@e.co`, source: 'direct', ...r })), leads }));
  return createLocalLedger({ program, dataDir: dir });
}
const members = (section, n) => Array.from({ length: n }, () => ({ plan: 'member', section }));

async function serve(opts = {}) {
  const sent = [];
  const server = createApp({ program, log: quietLog, now: BEFORE_TERM, loginSecret: SECRET, mailer: async (m) => { sent.push(m); }, ledger: seeded(), ...opts }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, init) => fetch(base + p, { redirect: 'manual', ...init });
  const post = (p, form, headers = {}) => get(p, { method: 'POST', body: new URLSearchParams(form), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
  const html = async (p, init) => (await get(p, init)).text();
  return { get, post, html, sent, close: () => server.close() };
}

describe('schedule and helpers', () => {
  test('term dates land on the right weekdays for six weeks', () => {
    assert.deepStrictEqual(termDates('2026-10-15', 6, [4]), ['2026-10-15', '2026-10-22', '2026-10-29', '2026-11-05', '2026-11-12', '2026-11-19']);
    assert.strictEqual(sectionDates(program, program.sections[0]).length, 12);
    assert.strictEqual(formatDays([1, 3]), 'Mondays and Wednesdays');
  });

  test('membership price is $25 per class hour', () => {
    assert.strictEqual(program.memberPrice, 25 * program.hoursPerWeek * program.weeks);
  });

  test('ics has correct New York times and folded lines', () => {
    const ics = buildIcs({ timeZone: 'America/New_York', calendarName: 'RC', events: [{ uid: 'x@y', date: '2026-10-19', time: '19:00', minutes: 60, title: 'A, b; c', where: 'Zoom' }] });
    assert.ok(ics.includes('DTSTART;TZID=America/New_York:20261019T190000'));
    assert.ok(ics.includes('DTEND;TZID=America/New_York:20261019T200000'));
    assert.ok(ics.includes('SUMMARY:A\\, b\\; c'));
    assert.ok(ics.split('\r\n').every((l) => l.length <= 75));
  });

  test('inputs are cleaned', () => {
    assert.strictEqual(cleanSource('Journal'), 'journal');
    assert.strictEqual(cleanSource('<x>'), '');
    assert.strictEqual(cleanCode(' spring '), 'SPRING');
    assert.strictEqual(cleanCode('a b'), '');
    assert.deepStrictEqual(parseSourcePromos('journal=promo_1, 222=promo_2,bad=coupon_x'), { journal: 'promo_1', 222: 'promo_2' });
  });

  test('SITE_URL must be a bare https origin in production', () => {
    assert.strictEqual(validateConfig({ siteUrl: 'https://club.org', production: true }), 'https://club.org');
    assert.throws(() => validateConfig({ siteUrl: 'http://club.org', production: true }));
    assert.throws(() => validateConfig({ siteUrl: 'https://club.org/x', production: true }));
    assert.throws(() => validateConfig({ production: true }));
  });

  test('availability: members take every date, drop-ins take one', () => {
    const av = availability(program, { members: { a: 18, b: 20, c: 0 }, dropins: { 'a|2026-10-19': 2, 'a|2026-10-21': 1 } }, '2026-10-01');
    assert.strictEqual(av.a.dates.find((d) => d.date === '2026-10-19').left, 0);
    assert.strictEqual(av.a.dates.find((d) => d.date === '2026-10-21').left, 1);
    assert.strictEqual(av.a.memberLeft, 0);
    assert.strictEqual(av.c.memberLeft, 20);
    const later = availability(program, { members: { a: 0, b: 0, c: 0 }, dropins: {} }, '2026-11-01');
    assert.ok(later.a.dates.every((d) => d.date >= '2026-11-01'));
  });
});

describe('pages', () => {
  test('landing has the offer, teacher, sections with enroll buttons, tuition, and questions', async () => {
    const s = await serve();
    const h = await s.html('/');
    for (const t of ['Reading Club: The&nbsp;Good&nbsp;Life', 'Six weeks. Six traditions. One question: How should we live?', 'Aristotle', 'Dhammapada',
      'How should we&nbsp;live?', 'Who teaches', 'Plato and Aristotle', 'Sections this term', '$25<span> per class hour</span>', '$40<span> per session</span>',
      'Questions', 'Registered 501(c)(3) public charity']) assert.ok(h.includes(t), `missing ${t}`);
    for (const id of ['a', 'b', 'c']) assert.ok(h.includes(`/join?plan=member&amp;section=${id}`));
    assert.ok(!h.includes('—'), 'no em dashes');
    assert.ok(!/<script/i.test(h), 'no scripts');
    assert.strictEqual((h.match(/<h1/g) || []).length, 1, 'one h1');
    s.close();
  });

  test('every page links only to assets that exist, and sends security headers', async () => {
    const s = await serve();
    for (const p of ['/', '/join', '/join?plan=dropin', '/login', '/nope']) {
      const res = await s.get(p);
      assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      const h = await res.text();
      const refs = [...h.matchAll(/(?:href|src|srcset)="(\/[^"#?]*\.(?:css|woff2|png|jpg|webp))"/g)].map((m) => m[1]);
      for (const ref of new Set(refs)) assert.strictEqual((await s.get(ref)).status, 200, `broken ${ref} on ${p}`);
    }
    const css = await s.html('/styles.css');
    for (const [, ref] of css.matchAll(/url\((\/[^)]+)\)/g)) assert.strictEqual((await s.get(ref)).status, 200, `broken ${ref}`);
    assert.strictEqual((await s.get('/healthz')).status, 200);
    assert.strictEqual((await s.get('/nope')).status, 404);
    s.close();
  });

  test('join marks full sections, preselects the chosen one, and offers a waitlist', async () => {
    const s = await serve({ ledger: seeded(members('a', 20)) });
    const h = await s.html('/join?section=c');
    assert.match(h, /value="a" disabled/);
    assert.match(h, /value="c" checked/);
    assert.ok(h.includes('Section A is full'));
    assert.ok(h.includes('Reserve my seat'));
    assert.ok(h.includes('No payment today'));
    s.close();
  });

  test('drop-in page hides full dates and keeps the page short', async () => {
    const s = await serve({ ledger: seeded(Array.from({ length: 20 }, () => ({ plan: 'dropin', section: 'a', date: '2026-10-19' }))) });
    const h = await s.html('/join?plan=dropin');
    assert.ok(!h.includes('value="a|2026-10-19"'));
    assert.ok(h.includes('value="a|2026-10-21"'));
    assert.ok((h.match(/name="slot"/g) || []).length <= 12);
    s.close();
  });

  test('closed enrollment shows notify forms instead of signup', async () => {
    const s = await serve({ enrollmentOpen: false });
    const h = await s.html('/join');
    assert.ok(h.includes('Signups open soon'));
    assert.ok(!h.includes('action="/checkout"'));
    const res = await s.post('/checkout', { plan: 'member', section: 'a', name: 'A', email: 'a@b.co' });
    assert.match(res.headers.get('location'), /closed=1/);
    s.close();
  });
});

describe('reserve a seat (no Stripe yet)', () => {
  test('a membership reservation holds a seat, emails the student, and shows the schedule', async () => {
    const ledger = seeded();
    const s = await serve({ ledger, notifyEmail: 'team@club.org' });
    const res = await s.post('/checkout', { plan: 'member', section: 'b', name: 'Ada Lovelace', email: 'Ada@Example.com', code: 'journal' }, { cookie: 'rc_src=222' });
    assert.strictEqual(res.status, 303);
    const loc = res.headers.get('location');
    assert.match(loc, /^\/welcome\?id=r_/);
    await ledger.flush();
    const r = ledger.all().reservations[0];
    assert.deepStrictEqual([r.plan, r.section, r.email, r.source, r.code], ['member', 'b', 'ada@example.com', '222', 'JOURNAL']);
    const h = await s.html(loc);
    assert.ok(h.includes('Your seat is held.'));
    assert.ok(h.includes('Ada, you have a membership seat in <strong>Section B</strong>'));
    assert.ok(h.includes('Open my member page'));
    const ics = await (await s.get(`/calendar.ics?${loc.split('?')[1]}`)).text();
    assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, 18, '12 sessions + 6 lectures');
    assert.deepStrictEqual(s.sent.map((m) => m.to), ['ada@example.com', 'team@club.org']);
    s.close();
  });

  test('reservations count toward capacity', async () => {
    const s = await serve({ ledger: seeded(members('a', 19)) });
    let res = await s.post('/checkout', { plan: 'member', section: 'a', name: 'A', email: 'a@b.co' });
    assert.match(res.headers.get('location'), /welcome/);
    res = await s.post('/checkout', { plan: 'member', section: 'a', name: 'B', email: 'b@b.co' });
    assert.match(res.headers.get('location'), /full=1/);
    s.close();
  });

  test('signing up twice returns the same seat', async () => {
    const ledger = seeded();
    const s = await serve({ ledger });
    const a = await s.post('/checkout', { plan: 'member', section: 'a', name: 'A', email: 'a@b.co' });
    const b = await s.post('/checkout', { plan: 'member', section: 'a', name: 'A', email: 'a@b.co' });
    assert.strictEqual(a.headers.get('location'), b.headers.get('location'));
    assert.strictEqual(ledger.all().reservations.length, 1);
    s.close();
  });

  test('missing details, bad section and bad date go back with a note', async () => {
    const s = await serve();
    for (const [form, flag] of [
      [{ plan: 'member', section: 'a', name: '', email: 'a@b.co' }, 'details'],
      [{ plan: 'member', section: 'a', name: 'A', email: 'nope' }, 'details'],
      [{ plan: 'member', section: 'zzz', name: 'A', email: 'a@b.co' }, 'error'],
      [{ plan: 'dropin', slot: 'a|2026-10-20', name: 'A', email: 'a@b.co' }, 'error'],
    ]) {
      const res = await s.post('/checkout', form);
      assert.match(res.headers.get('location'), new RegExp(`${flag}=1`));
    }
    const h = await s.html('/join?details=1');
    assert.ok(h.includes('Please add your name and a valid email'));
    s.close();
  });

  test('reservations survive a restart', async () => {
    const dir = tmp();
    const one = createLocalLedger({ program, dataDir: dir });
    await one.begin({ plan: 'dropin', section: program.sections[2], date: '2026-10-18', source: 'direct', name: 'D', email: 'd@e.co' });
    await one.flush();
    const two = createLocalLedger({ program, dataDir: dir });
    assert.strictEqual((await two.counts()).dropins['c|2026-10-18'], 1);
  });

  test('interest and waitlist are saved; bots are dropped', async () => {
    const ledger = seeded();
    const s = await serve({ ledger });
    assert.ok((await (await s.post('/interest', { email: 'a@b.co', name: 'A' })).text()).includes('Thank you.'));
    assert.ok((await (await s.post('/interest', { email: 'c@d.co', section: 'a' })).text()).includes('waitlist'));
    await s.post('/interest', { email: 'bot@x.co', website: 'spam' });
    await ledger.flush();
    assert.deepStrictEqual(ledger.all().leads.map((l) => l.lead), ['interest', 'waitlist']);
    s.close();
  });
});

describe('codes and sources', () => {
  test('a code link is remembered, shown, and prefilled', async () => {
    const s = await serve();
    const res = await s.get('/?code=spring&src=journal');
    const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    assert.ok((await res.text()).includes('Code <strong>SPRING</strong> will be applied'));
    assert.ok((await s.html('/join', { headers: { cookie: cookies } })).includes('value="SPRING"'));
    s.close();
  });
});

describe('member sign-in', () => {
  const rows = [{ plan: 'member', section: 'a', email: 'ann@x.co' }, { plan: 'dropin', section: 'c', date: '2026-10-18', email: 'dan@x.co' }];
  const privateInfo = { sections: { a: { zoom: 'https://zoom.us/j/111' } }, lecture: { address: '123 Example St' } };

  test('tokens verify, expire, and reject tampering', () => {
    const tok = makeToken('Ann@X.co', SECRET, 1, 0);
    assert.strictEqual(readToken(tok, SECRET, 1000), 'ann@x.co');
    assert.strictEqual(readToken(tok, SECRET, 2 * 86400000), null);
    assert.strictEqual(readToken(tok, 'other', 1000), null);
    assert.strictEqual(readToken(`${tok}x`, SECRET, 1000), null);
  });

  test('only emails with a seat get a link, and the reply is identical either way', async () => {
    const s = await serve({ ledger: seeded(rows) });
    const a = await (await s.post('/login', { email: 'ANN@x.co' })).text();
    const b = await (await s.post('/login', { email: 'nobody@x.co' })).text();
    assert.strictEqual(a, b);
    assert.strictEqual(s.sent.length, 1);
    assert.match(s.sent[0].text, /\/my\?t=/);
    assert.match((await s.post('/login', { email: 'bad' })).headers.get('location'), /invalid=1/);
    s.close();
  });

  test('member page shows only their own private links', async () => {
    const s = await serve({ ledger: seeded(rows), privateInfo });
    const ann = await s.html(`/my?t=${makeToken('ann@x.co', SECRET)}`);
    assert.ok(ann.includes('Section A') && ann.includes('zoom.us/j/111') && ann.includes('123 Example St'));
    const dan = await s.html(`/my?t=${makeToken('dan@x.co', SECRET)}`);
    assert.ok(dan.includes('Drop-in') && dan.includes('Coming by email'));
    assert.ok(!dan.includes('zoom.us/j/111'));
    const ics = await s.html(`/my/calendar.ics?t=${makeToken('ann@x.co', SECRET)}`);
    assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, 18);
    assert.match((await s.get('/my?t=forged.x')).headers.get('location'), /expired=1/);
    s.close();
  });
});

describe('Stripe mode (for when keys are added)', () => {
  const section = program.sections[0];
  const base = 'https://x.org';

  test('checkout params: subscription for members, saved card for drop-ins, one discount rule', () => {
    const m = checkoutParams({ program, plan: 'member', section, source: 'journal', priceId: 'p', base });
    assert.strictEqual(m.mode, 'subscription');
    assert.strictEqual(m.subscription_data.metadata.section, 'a');
    assert.strictEqual(m.allow_promotion_codes, true);
    const d = checkoutParams({ program, plan: 'dropin', section, date: '2026-10-19', source: 'direct', priceId: 'p', promo: 'promo_1', base });
    assert.strictEqual(d.payment_intent_data.setup_future_usage, 'off_session');
    assert.deepStrictEqual(d.discounts, [{ promotion_code: 'promo_1' }]);
    assert.strictEqual(d.allow_promotion_codes, undefined);
  });

  test('price checks catch a wrong amount or interval', () => {
    const want = expectedPrices(program);
    const good = { active: true, unit_amount: 45000, currency: 'usd', type: 'recurring', recurring: { interval: 'week', interval_count: 6 } };
    assert.strictEqual(priceProblem(good, want.member), null);
    assert.match(priceProblem({ ...good, recurring: { interval: 'month', interval_count: 1 } }, want.member), /interval/);
    assert.match(priceProblem({ ...good, unit_amount: 1 }, want.member), /unit_amount/);
  });

  test('the same site runs on Stripe: seats from subscriptions, codes looked up, redirect to checkout', async () => {
    const stripe = fakeStripe({ program, subs: Array.from({ length: 20 }, () => ({ status: 'active', metadata: { program: program.program, plan: 'member', section: 'a' } })), promos: { SPRING: 'promo_S' } });
    const ledger = createStripeLedger({ stripe, program, prices: { member: 'price_member', dropin: 'price_dropin' }, log: quietLog });
    const s = await serve({ ledger });
    const h = await s.html('/join');
    assert.match(h, /value="a" disabled/);
    assert.ok(h.includes('Continue to payment') && !h.includes('id="j-email"'));
    let res = await s.post('/checkout', { plan: 'member', section: 'b', code: 'SPRING' });
    assert.match(res.headers.get('location'), /checkout\.stripe\.com/);
    assert.deepStrictEqual(stripe.calls.create[0].discounts, [{ promotion_code: 'promo_S' }]);
    res = await s.post('/checkout', { plan: 'member', section: 'b', code: 'NOPE' });
    assert.match(res.headers.get('location'), /badcode=1/);
    s.close();
  });
});
