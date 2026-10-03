'use strict';
// Server-rendered pages. No client-side JavaScript: every step is a plain link or form,
// so the whole flow works on any phone, with scripts blocked, and with a screen reader.

const { formatTime, formatDate, formatDays, termDates } = require('./schedule');
const { randomUUID } = require('node:crypto');
const { installmentTerms, nextMonday, VERSION } = require('./installments');
const weekly = program => program.billing?.model === VERSION;
const upfront = program => program.billing?.model === 'upfront-450-v1';
const sessionBreakdown = '18 included sessions: 6 lectures, 6 small-group meetings, and 6 optional office hours';
const meetings = program => Math.max(...program.sections.map(s => s.weekdays.length));
const meetingPhrase = program => meetings(program) === 1 ? 'one small-group session' : 'two small-group sessions';
const frequency = program => meetings(program) === 1 ? 'once a week' : 'twice a week';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- icons (stroke, 1.5px, 24 grid) ----------
const icon = (d, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const I = {
  arrow: icon('<path d="M5 12h14M13 6l6 6-6 6"/>', 'i i-arrow'),
  check: icon('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  cal: icon('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
  book: icon('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>'),
  mic: icon('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
  people: icon('<circle cx="8" cy="8.5" r="3"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M2.5 19.5c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5M14 15.2c.8-.3 1.6-.4 2.5-.4 2.2 0 4 1.3 4.8 4.2"/>'),
  mail: icon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/>'),
  video: icon('<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10.5l5-3v9l-5-3"/>'),
  pin: icon('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'),
  lock: icon('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
};

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
const secTime = (sec) => `${formatDays(sec.weekdays)}, ${formatTime(sec.time)}\u00a0ET`;
const firstDate = (program, sec) => termDates(program.termStarts, program.weeks, sec.weekdays)[0];
const seatsLabel = (n) => (n <= 0 ? 'Full' : n === 1 ? '1 seat left' : n <= 5 ? `${n} seats left` : 'Seats open');
const seatsClass = (n) => (n <= 0 ? 'full' : n <= 5 ? 'low' : 'open');
const joinHref = (plan, section) => `/join?plan=${plan}${section ? `&amp;section=${esc(section)}` : ''}`;

// ---------- frame ----------

function layout({ program, title, description, body, noindex = false }) {
  const desc = description || `Six weeks. Six traditions. One question: How should we live? A reading community from ${program.org}.`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <meta name="theme-color" content="#fffdf2">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${esc(program.name)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:image" content="/img/hero.jpg">
  <meta name="twitter:card" content="summary_large_image">
  ${noindex ? '<meta name="robots" content="noindex">' : ''}
  <link rel="icon" href="/favicon.png" type="image/png">
  <link rel="preload" href="/fonts/libre-baskerville-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/styles.css?v=20261003-tuition">
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="wrap bar">
      <a class="brand" href="/" aria-label="${esc(program.shortName)} home">
        <img src="/img/logo.png" alt="" width="400" height="218">
        <span class="brand-sub">${esc(program.shortName)}</span>
      </a>
      <nav class="nav" aria-label="Main">
        <a href="/#how">How it works</a>
        <a href="/#sections">Sections</a>
        <a href="/#tuition">Tuition</a>
        <a href="/#questions">Questions</a>
      </nav>
      <div class="bar-actions">
        <a class="nav-link" href="/login">Sign in</a>
        <a class="btn btn-outline btn-sm" href="/join">Join</a>
      </div>
    </div>
  </header>
  <main id="main" tabindex="-1">
${body}
  </main>
  <footer class="site-footer">
    <div class="wrap">
      <div class="press">
        <p class="eyebrow">Featured in</p>
        <a href="https://www.vogue.com/article/philosophy-club-is-hot-just-ask-these-gen-z-new-yorkers" rel="noopener"><img src="/img/vogue.png" alt="Vogue" width="285" height="160" loading="lazy"></a>
      </div>
      <div class="foot-row">
        <p class="foot-about"><strong>${esc(program.name)}</strong><br>A program of <a href="${esc(program.orgUrl)}">${esc(program.org)}</a>.</p>
        <ul class="foot-links">
          <li><a href="${esc(program.orgUrl)}events">Free weekly events</a></li>
          <li><a href="${esc(program.orgUrl)}journal">Journal</a></li>
          <li><a href="${esc(program.instagram)}" rel="noopener">Instagram</a></li>
          <li>${program.contactEmail ? `<a href="mailto:${esc(program.contactEmail)}">${esc(program.contactEmail)}</a>` : `<a href="${esc(program.orgUrl)}contact">Contact us</a>`}</li>
        </ul>
      </div>
      <p class="legal">New York Philosophical Society Inc.<br>Registered 501(c)(3) public charity | EIN 33-1437268</p>
    </div>
  </footer>
</body>
</html>`;
}

const NOTICES = {
  terms: ['warn', 'Enter your email and acknowledge the $450 tuition commitment to continue.'],
  installmentcode: ['info', 'Discount codes are not available for the $25 installment plan. Remove the code to continue, or contact the club about your offer.'],
  alreadyenrolled: ['info', 'There is already a membership payment plan for this email. Sign in to manage it, or contact the club before enrolling again.'],
  termstarted: ['info', 'Full-term enrollment has closed. You can still choose an available drop-in session.'],
  canceled: ['info', 'You returned from checkout. If you already paid, check your receipt before trying again. Otherwise, you can continue below.'],
  busy: ['info', 'Another checkout is opening. Please wait a moment, then try again.'],
  full: ['warn', 'That seat was just taken. Please pick another section or date.'],
  unavailable: ['warn', 'Something went wrong on our end. Please try again in a minute.'],
  badcode: ['warn', 'That code isn’t valid. Check the spelling, or continue without it.'],
  details: ['warn', 'Please add your name and a valid email so we can hold your seat.'],
  closed: ['info', 'Signups open soon. Leave your email and we’ll send you the link first.'],
};
const notice = (key) => {
  if (!NOTICES[key]) return '';
  const [kind, text] = NOTICES[key];
  return `<p class="notice notice-${kind}" role="${kind === 'warn' ? 'alert' : 'status'}">${text}</p>`;
};

function interestForm({ sections = [], heading, sub, button, id = 'interest' }) {
  let pick = '';
  if (sections.length === 1) pick = `<input type="hidden" name="section" value="${esc(sections[0].id)}">`;
  if (sections.length > 1) {
    pick = `<div class="field"><label for="${id}-section">Section</label><select id="${id}-section" name="section">${sections.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}, ${esc(secTime(s))}</option>`).join('')}</select></div>`;
  }
  return `
      <form class="card form-card" method="post" action="/interest" id="${id}">
        ${heading ? `<h3 class="form-title">${heading}</h3>` : ''}
        ${sub ? `<p class="muted">${sub}</p>` : ''}
        ${pick}
        <div class="hp" aria-hidden="true"><label>Leave empty <input name="website" tabindex="-1" autocomplete="off"></label></div>
        <div class="field-row">
          <div class="field"><label for="${id}-name">Name</label><input id="${id}-name" name="name" autocomplete="name"></div>
          <div class="field"><label for="${id}-email">Email <span class="req" aria-hidden="true">*</span></label><input id="${id}-email" name="email" type="email" required autocomplete="email" inputmode="email"></div>
        </div>
        <button type="submit" class="btn btn-outline">${button} ${I.arrow}</button>
      </form>`;
}

// ---------- landing ----------

function landing({ program, avail, code, enrollmentOpen, notice: n }) {
  const lec = program.lecture;
  const texts = program.texts.map((t, i) => `
          <li><span class="num">${['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'][i] || i + 1}</span><span class="t-name">${esc(t.name)}</span><span class="t-trad">${esc(t.tradition)}${t.work ? ` · <em>${esc(t.work)}</em>` : ''}</span>${t.question ? `<p class="t-question">${esc(t.question)}</p>` : ''}</li>`).join('');

  const rows = program.sections.map((sec) => {
    const left = avail ? avail[sec.id].memberLeft : null;
    const full = left !== null && left <= 0;
    const action = !enrollmentOpen ? `<a class="btn btn-outline btn-sm" href="${joinHref('member', sec.id)}">Get notified</a>`
      : full ? `<a class="btn btn-outline btn-sm" href="${joinHref('member', sec.id)}#waitlist">Waitlist</a>`
        : `<a class="btn btn-primary btn-sm" href="${joinHref('member', sec.id)}">Enroll <span class="vh">in ${esc(sec.name)}</span></a>`;
    return `
          <li class="sec-row">
            <div class="sec-main">
              <p class="sec-name">${esc(sec.name)}</p>
              <p class="sec-when">${esc(secTime(sec))}</p>
            </div>
            <dl class="sec-facts">
              <div><dt>Where</dt><dd>${esc(sec.where)}</dd></div>
              <div><dt>First session</dt><dd>${esc(formatDate(firstDate(program, sec), { weekday: false }))}</dd></div>
              ${sec.facilitator ? `<div><dt>Facilitator</dt><dd>${esc(sec.facilitator)}</dd></div>` : ''}
              ${left === null ? '' : `<div><dt>Seats</dt><dd><span class="pill pill-${seatsClass(left)}">${seatsLabel(left)}</span></dd></div>`}
            </dl>
            <div class="sec-action">${action}</div>
          </li>`;
  }).join('');

  const t = program.teacher;
  const primaryCta = enrollmentOpen ? 'Choose your section' : 'Get notified when signups open';

  const faqs = [
    ['How much time does it take?', `About ${program.hoursPerWeek} class hours a week: the lecture and ${meetingPhrase(program)}, plus reading on your own beforehand.${program.officeHours ? ' There is also an optional one-hour office hour each week.' : ''}`],
    ['Do I need to know any philosophy?', 'No. You need to do the reading and come ready to talk about it. The small groups are built for people reading these texts for the first time.'],
    ['What is the difference between a membership and a drop-in?', `A membership holds your seat in one section for the whole term, including the lecture and ${meetingPhrase(program)} each week${program.officeHours ? ', plus optional office hours' : ''}. A drop-in is a single small-group session for ${money(program.dropInPrice)}, when a section has room.`],
    ['What happens in a small-group session?', 'You study a short passage with a partner: read it aloud, explain it in your own words, and test an interpretation against the text. A facilitator helps when context or terminology gets in the way. You can leave with an unresolved question.'],
    ['Where do sessions happen?', `Small groups meet on Zoom. The lecture is ${lec.where.charAt(0).toLowerCase()}${lec.where.slice(1)}. You get the links on your member page after you sign up.`],
    [upfront(program) ? 'Is membership $25 per session or $450?' : weekly(program) ? 'How do the $25 payments work?' : 'Does membership renew?', upfront(program) ? `Membership is one $450 payment for the full six-week course. The $25 rate is $450 divided by ${sessionBreakdown.toLowerCase()}. It is an equivalent rate when you use all included sessions, not a pay-as-you-go option. There are no weekly charges or automatic renewals. A $40 drop-in buys one small-group meeting.` : weekly(program) ? 'Tuition is $450 for one six-week course, paid in 18 weekly installments of $25. Save your card at signup; the first payment is the following Monday. Payments continue on Mondays after the course ends, then stop automatically after 18 installments. Joining commits you to the full tuition; this is not a cancel-anytime weekly membership. You are not automatically enrolled in another term.' : `Yes. Membership costs ${money(program.memberPrice)} at checkout and renews every ${program.weeks} weeks from your purchase date. Cancel before your next billing date to avoid another charge. Manage billing from your member page.`],
    ['How do I find my section after signing up?', 'After checkout, open your member page and download your private access link. This browser remembers you when you click Sign in. Keep the downloaded link to return from another device.'],
  ];
  if (program.refundPolicy) faqs.push(['What is the refund policy?', program.refundPolicy]);

  const body = `
    <section class="hero" aria-labelledby="hero-title">
      <picture>
        <source srcset="/img/hero.webp" type="image/webp">
        <img class="hero-img" src="/img/hero.jpg" alt="" width="1600" height="726" fetchpriority="high">
      </picture>
      <div class="hero-shade"></div>
      <div class="wrap hero-inner">
        ${notice(n)}
        ${code ? `<p class="code-banner">${I.check} Code <strong>${esc(code)}</strong> is ready to check at checkout.</p>` : ''}
        <p class="eyebrow eyebrow-light">Six-week reading community · Begins ${esc(formatDate(program.termStarts, { weekday: false }))}</p>
        <h1 id="hero-title">Reading Club: The&nbsp;Good&nbsp;Life</h1>
        <p class="hero-lead">Six weeks. Six traditions. One question: How should we live?</p>
        <div class="hero-ctas">
          <a class="btn btn-light" href="${enrollmentOpen ? '/#sections' : '/join'}">${primaryCta} ${I.arrow}</a>
          ${enrollmentOpen ? `<a class="btn btn-ghost-light" href="${joinHref('dropin')}">Drop in for ${money(program.dropInPrice)}</a>` : ''}
        </div>
      </div>
        <div class="hero-details wrap" aria-label="At a glance"><span>${I.book} Six great traditions</span><span>${I.people} Small groups on Zoom</span><span>${I.cal} ${program.hoursPerWeek} class hours a week</span></div>
    </section>

    <section class="section" aria-labelledby="reading-title">
      <div class="wrap narrow">
        <h2 id="reading-title">The reading</h2>
        <p class="lede">Most of us have books we have always meant to read. The hard part is actually reading them, understanding them, and finding people to think with.</p>
        <p>That is what Reading Club is for. Over six weeks, we read selections from six great traditions, and keep coming back to one question.</p>
        <p>You are not expected to finish six whole books. The assigned passages give each conversation a shared starting point; the complete works are there when you want more context.</p>
      </div>
      <div class="wrap">
        <ol class="texts">${texts}
        </ol>
      </div>
    </section>

    <section class="band band-question" aria-label="The question">
      <div class="wrap">
        <p class="question">How should we&nbsp;live?</p>
      </div>
    </section>

    <section class="section" id="how" aria-labelledby="how-title">
      <div class="wrap">
        <div class="split">
          <div>
            <h2 id="how-title">How a week works</h2>
            <ol class="steps">
              <li><span class="step-icon">${I.book}</span><div><h3>Read</h3><p>One short, carefully chosen reading, done on your own before the week’s sessions.</p></div></li>
              <li><span class="step-icon">${I.mic}</span><div><h3>Lecture</h3><p>${esc(formatDays([lec.weekday]))} at ${formatTime(lec.time)} ET. ${esc(lec.where)}.</p></div></li>
              <li><span class="step-icon">${I.people}</span><div><h3>Talk it through</h3><p>Your section meets ${frequency(program)} on Zoom. Work through the reading with a partner and bring a question back to the group.</p></div></li>
              ${program.officeHours ? `<li><span class="step-icon">${I.cal}</span><div><h3>Keep asking</h3><p>Optional office hours: ${esc(formatDays([program.officeHours.weekday]))} at ${formatTime(program.officeHours.time)} ET on Zoom. Thanksgiving week moves to Wednesday, November 25.</p></div></li>` : ''}
            </ol>
            <p class="aside">You, your partner, and the text. Our approach draws on chavruta, the Jewish practice of paired textual study. Help your partner state their strongest idea, point to the words behind your interpretation, and keep the questions you cannot yet answer.</p>
          </div>
          <figure class="photo">
            <img src="/img/reading.webp" alt="People reading together at a New York Philosophy Club event" width="900" height="598" loading="lazy">
          </figure>
        </div>
      </div>
    </section>

    <section class="section section-rule" aria-labelledby="method-title">
      <div class="wrap narrow">
        <p class="eyebrow">How we read</p>
        <h2 id="method-title">Stay with the question.</h2>
        <p class="lede">Understanding matters more than pages covered. No philosophy background required.</p>
        <ol class="reading-method">
          <li><strong>Read slowly.</strong> Choose a short passage. Read it aloud, then try to explain it in plain language.</li>
          <li><strong>Find the difficulty.</strong> Name what is unclear. Build the strongest interpretation the words support.</li>
          <li><strong>Test it together.</strong> Offer an objection, consider a reply, and return to the passage.</li>
          <li><strong>Take something with you.</strong> Record what changed your mind, how it applies to your life, and one question to revisit.</li>
        </ol>
        <p class="muted">Bring the reading, your notes, one genuine question, and one objection. Agreement is optional; attention and reasons are essential.</p>
      </div>
    </section>

    ${t && t.bio ? `
    <section class="section section-rule" aria-labelledby="teacher-title">
      <div class="wrap">
        <div class="teacher">
          <h2 id="teacher-title">Who teaches</h2>
          <div class="teacher-body">
            ${t.photo ? `<img class="teacher-photo" src="${esc(t.photo)}" alt="${esc(t.name)}" width="240" height="300" loading="lazy">` : ''}
            <div>
              <p class="teacher-name">${esc(t.name)}${t.role ? `<span> · ${esc(t.role)}</span>` : ''}</p>
              <p>${esc(t.bio)}</p>
            </div>
          </div>
        </div>
      </div>
    </section>` : ''}

    <section class="band" id="sections" aria-labelledby="sections-title">
      <div class="wrap">
        <div class="head-row">
          <h2 id="sections-title">Sections this term</h2>
          <p class="muted">Pick a time that works for you. Each section is capped at ${Math.max(...program.sections.map((s) => s.capacity))} people and meets ${frequency(program)}. Everyone attends the same lecture.</p>
        </div>
        <ul class="sec-list">${rows}
        </ul>
        ${enrollmentOpen ? `<p class="muted small">Just want to try it? <a href="${joinHref('dropin')}">Drop in for one session</a>.</p>` : ''}
      </div>
    </section>

    <section class="section" id="tuition" aria-labelledby="tuition-title">
      <div class="wrap">
        <h2 id="tuition-title">Tuition</h2>
        <div class="plans">
          <article class="card plan plan-main">
            <p class="eyebrow">Membership</p>
            <p class="price">$25<span>${upfront(program) ? ' per included session' : weekly(program) ? ' every Monday' : ' per class hour'}</span></p>
            <p class="price-sub">${upfront(program) ? '$450 paid once for six weeks' : weekly(program) ? '18 weekly payments · $450 total tuition' : `${money(program.memberPrice)} every ${program.weeks} weeks`}</p>
            <ul class="ticks">
              <li>${I.check}Your seat in one section, all term</li>
              <li>${I.check}The weekly lecture and ${meetingPhrase(program)}${program.officeHours ? ', plus optional office hours' : ''}</li>
              <li>${I.check}${upfront(program) ? 'One payment. No automatic renewal' : weekly(program) ? 'Fixed tuition commitment. Stops after 18 payments' : 'Renews every six weeks. Cancel before your next billing date'}</li>
            </ul>
            ${weekly(program) ? '<p class="help">Six weeks of classes, paid over 18 weeks. No charge at signup. Payments begin the following Monday and continue after the course ends.</p>' : ''}
            ${upfront(program) ? `<p class="help">${sessionBreakdown}. $25 is the equivalent rate across all 18 sessions; membership is paid in full at checkout.</p>` : ''}
            <a class="btn btn-primary btn-block" href="${enrollmentOpen ? '/#sections' : '/join'}">${enrollmentOpen ? 'Choose a section' : 'Get notified'} ${I.arrow}</a>
          </article>
          <article class="card plan">
            <p class="eyebrow">Drop in</p>
            <p class="price">${money(program.dropInPrice)}<span> per session</span></p>
            <p class="price-sub">No commitment</p>
            <ul class="ticks">
              <li>${I.check}One small-group session of your choice</li>
              <li>${I.check}Whenever a section has room</li>
              <li>${I.check}Easy to switch to a membership later</li>
            </ul>
            <a class="btn btn-outline btn-block" href="${joinHref('dropin')}">Pick a session ${I.arrow}</a>
          </article>
        </div>
      </div>
    </section>

    <section class="section section-rule" id="questions" aria-labelledby="faq-title">
      <div class="wrap narrow">
        <h2 id="faq-title">Questions</h2>
        <div class="faq">${faqs.map(([q, a]) => `
          <details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}
        </div>
      </div>
    </section>

    <section class="band band-close" aria-labelledby="close-title">
      <div class="wrap close-grid">
        <div>
          <h2 id="close-title">Read the Great Books. Find people to think with. Build a philosophy of your own.</h2>
          <a class="btn btn-primary" href="${enrollmentOpen ? '/#sections' : '/join'}">${primaryCta} ${I.arrow}</a>
        </div>
        ${interestForm({ heading: 'Not this term?', sub: 'Leave your email and hear about the next reading first.', button: 'Keep me posted' })}
      </div>
    </section>`;

  return layout({ program, title: `${program.name} · ${program.org}`, body });
}

// ---------- join ----------

function planSummary({ program, plan, mode }) {
  const member = plan === 'member';
  return `
      <aside class="card summary" aria-label="Summary">
        <p class="eyebrow">${member ? 'Membership' : 'Drop in'}</p>
        <p class="price">${member ? money(weekly(program) || upfront(program) ? 25 : program.memberPrice) : money(program.dropInPrice)}<span>${member ? (upfront(program) ? ' per included session' : weekly(program) ? ' every Monday' : ` every ${program.weeks} weeks`) : ' one session'}</span></p>
        ${member && upfront(program) ? '<p class="price-sub">$450 paid once for six weeks</p>' : ''}
        <ul class="ticks">
          ${member ? `<li>${I.check}${program.hoursPerWeek} class hours a week${program.officeHours ? ', plus optional office hours' : ''}</li>
          <li>${I.check}Weekly lecture and ${meetingPhrase(program)}</li>
          <li>${I.check}Same section and people all term</li>
          <li>${I.check}${upfront(program) ? '18 included sessions. No automatic renewal' : weekly(program) ? '18 payments. $450 total. No automatic new term' : 'Cancel before your next billing date'}</li>` : `<li>${I.check}One small-group session on Zoom</li>
          <li>${I.check}Readings on your member page</li>
          <li>${I.check}Switch to membership anytime</li>`}
        </ul>
        <p class="summary-pay">${I.lock}${mode === 'stripe' ? (member && upfront(program) ? 'Secure one-time payment by Stripe.' : 'Secure checkout by Stripe. Your card is saved for next time.') : 'No payment today. We email you a secure payment link before the term begins, and your seat is held until then.'}</p>
        ${mode === 'stripe' && member ? `<p class="help">${upfront(program) ? `$450 due at checkout before any discount. ${sessionBreakdown}. The $25 rate is an equivalent, not a separate charge.` : weekly(program) ? 'No charge today. The first $25 payment is the following Monday. Payments continue after the six-week course until all 18 installments have been billed.' : `${money(program.memberPrice)} due today before any discount. Automatically renews every ${program.weeks} weeks from purchase.`}</p>` : ''}
      </aside>`;
}

function join_({ program, mode, enrollmentOpen, plan, avail, notice: n, code, preselect, slot }) {
  const member = plan === 'member';
  const tabs = `
      <nav class="tabs" aria-label="Choose a plan">
        <a href="${joinHref('member', preselect)}"${member ? ' aria-current="page"' : ''}>Membership <span>${upfront(program) ? '$25 / included session' : weekly(program) ? '$25 / week' : `${money(program.memberPrice)} / term`}</span></a>
        <a href="${joinHref('dropin', preselect)}"${member ? '' : ' aria-current="page"'}>Drop in <span>${money(program.dropInPrice)}</span></a>
      </nav>`;

  const head = `
    <section class="page-head">
      <div class="wrap">
        <p class="crumbs"><a href="/">${esc(program.shortName)}</a> <span aria-hidden="true">/</span> Join</p>
        <h1>${member ? 'Choose your section' : 'Drop in for a session'}</h1>
        <p class="lede">${member ? `Pick the section you’ll meet with ${frequency(program)}. Everyone attends the ${esc(formatDays([program.lecture.weekday]).replace(/s$/, ''))} lecture together.` : 'Pick one small-group session. Your reading and joining link will be on your member page.'}</p>
      </div>
    </section>`;

  if (!avail) {
    return layout({ program, title: `Join · ${program.name}`, noindex: true, body: `${head}
    <section class="section tight"><div class="wrap narrow">${notice(n || 'unavailable')}${interestForm({ heading: 'Get the link when it’s back', button: 'Notify me' })}</div></section>` });
  }

  let picker;
  let anyOpen;
  if (member) {
    const open = program.sections.filter((s) => avail[s.id].memberLeft > 0);
    anyOpen = open.length > 0;
    const pickId = (open.find((s) => s.id === preselect) || open[0] || {}).id;
    picker = `
          <fieldset class="step">
            <legend><span class="step-no">1</span> Section</legend>
            <div class="options">${program.sections.map((sec) => {
              const left = avail[sec.id].memberLeft;
              const full = left <= 0;
              return `
              <label class="option${full ? ' is-full' : ''}">
                <input type="radio" name="section" value="${esc(sec.id)}"${full ? ' disabled' : ''}${sec.id === pickId ? ' checked' : ''} required>
                <span class="opt-body">
                  <span class="opt-title">${esc(sec.name)}</span>
                  <span class="opt-sub">${esc(secTime(sec))} · ${esc(sec.where)}</span>
                  <span class="opt-sub">Starts ${esc(formatDate(firstDate(program, sec), { weekday: false }))}${sec.facilitator ? ` · ${esc(sec.facilitator)}` : ''}</span>
                </span>
                <span class="pill pill-${seatsClass(left)}">${seatsLabel(left)}</span>
              </label>`;
            }).join('')}
            </div>
          </fieldset>`;
  } else {
    let checked = false;
    const groups = program.sections.map((sec) => {
      const dates = avail[sec.id].dates.filter((d) => d.left > 0);
      const opts = dates.map((d) => {
        const value = `${sec.id}|${d.date}`;
        const isChecked = !checked && (slot ? value === slot : true);
        if (isChecked) checked = true;
        return `
                <label class="option option-slim">
                  <input type="radio" name="slot" value="${esc(value)}"${isChecked ? ' checked' : ''} required>
                  <span class="opt-body"><span class="opt-title">${esc(formatDate(d.date, { short: true }))}</span><span class="opt-sub">${formatTime(sec.time)} ET</span></span>
                  <span class="pill pill-${seatsClass(d.left)}">${seatsLabel(d.left)}</span>
                </label>`;
      });
      return `
              <div class="opt-group">
                <p class="opt-group-title">${esc(sec.name)} <span class="muted">· ${esc(formatDays(sec.weekdays))} · ${esc(sec.where)}</span></p>
                ${opts.length ? `${opts.slice(0, 4).join('')}${opts.length > 4 ? `<details class="later-dates"${dates.slice(4).some((d) => `${sec.id}|${d.date}` === slot) ? ' open' : ''}><summary>See ${opts.length - 4} later sessions</summary>${opts.slice(4).join('')}</details>` : ''}` : '<p class="muted small">Full for the rest of the term.</p>'}
              </div>`;
    }).join('');
    if (!checked && slot) {
      // The requested slot is gone; fall back to the first open one.
      return join_({ program, mode, enrollmentOpen, plan, avail, notice: n || 'full', code, preselect, slot: '' });
    }
    anyOpen = checked;
    picker = `
          <fieldset class="step">
            <legend><span class="step-no">1</span> Session</legend>
            <div class="options">${groups}
            </div>
          </fieldset>`;
  }

  const details = mode === 'local' || (member && weekly(program)) ? `
          <fieldset class="step">
            <legend><span class="step-no">2</span> Your details</legend>
            <div class="field-row">
              <div class="field"><label for="j-name">Full name <span class="req" aria-hidden="true">*</span></label><input id="j-name" name="name" required autocomplete="name"></div>
              <div class="field"><label for="j-email">Email <span class="req" aria-hidden="true">*</span></label><input id="j-email" name="email" type="email" required autocomplete="email" inputmode="email"><p class="help">Use the email you want associated with your membership and billing.</p></div>
            </div>
          </fieldset>` : '';

  const codeBox = `
          <details class="code"${code ? ' open' : ''}>
            <summary>Have a code?</summary>
            <div class="field code-field"><label for="j-code">Code</label><input id="j-code" name="code" value="${esc(code || '')}" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>
          </details>`;

  const fullOnes = member ? program.sections.filter((s) => avail[s.id].memberLeft <= 0) : [];
  const waitlist = fullOnes.length ? interestForm({
    id: 'waitlist',
    sections: fullOnes,
    heading: fullOnes.length === 1 ? `${esc(fullOnes[0].name)} is full` : 'Some sections are full',
    sub: 'Leave your email so the club can contact you if a seat opens.',
    button: 'Join the waitlist',
  }) : '';

  const consent = member && weekly(program) ? `<div class="commitment"><p class="eyebrow">Your payment plan</p><p><strong>$25 × 18 Mondays = $450</strong></p><label class="consent"><input type="checkbox" name="terms" value="${VERSION}" required><span>${esc(installmentTerms(nextMonday(program.timezone), program.timezone))}</span></label><p class="help">For refund or cancellation requests, <a href="${esc(program.orgUrl)}contact">contact the club</a>. Skipping a class does not pause the payment plan.</p></div>` : '';
  const submitLabel = mode === 'stripe' ? (member && upfront(program) ? 'Continue to $450 checkout' : member && weekly(program) ? 'Save my card & enroll' : 'Continue to payment') : member ? 'Reserve my seat' : 'Reserve this session';
  const form = !enrollmentOpen ? `
        <div>${interestForm({ heading: 'Signups open soon', sub: 'Leave your email and we’ll send you the link before anyone else.', button: 'Notify me' })}</div>` : `
        <form method="post" action="/checkout" class="join-form">
          <input type="hidden" name="checkoutId" value="${randomUUID()}">
          <input type="hidden" name="plan" value="${plan}">
          ${picker}
          ${anyOpen ? `${details}
          ${member && weekly(program) ? '<input type="hidden" name="code" value=""><p class="help">This fixed $450 installment plan does not apply discount codes. Contact the club before enrolling if you have a separate offer.</p>' : codeBox}
          ${consent}
          ${member && upfront(program) ? '<div class="commitment"><p class="eyebrow">Your membership</p><p><strong>$450 paid once · Six-week course</strong></p><p class="help">The $25 per-session rate is included in the full membership price. No installments. No automatic renewal. Any valid discount is shown in Stripe before you pay.</p></div>' : ''}
          <button type="submit" class="btn btn-primary btn-block btn-lg">${submitLabel} ${I.arrow}</button>
          ${mode === 'stripe' ? '<p class="help">After checkout, return to this site and save your private access link. Your schedule and joining details are kept on your member page.</p>' : ''}` : `<p class="muted">${member ? 'Every section is full this term.' : 'No drop-in sessions are left this term.'}</p>`}
        </form>`;

  const body = `${head}
    <section class="section tight">
      <div class="wrap">
        ${notice(n)}
        ${tabs}
        <div class="join-grid">
          <div>${form}${waitlist}</div>
          ${planSummary({ program, plan, mode })}
        </div>
      </div>
    </section>`;
  return layout({ program, title: `Join · ${program.name}`, noindex: true, body });
}

// ---------- after signup ----------

function scheduleList(program, events, limit = 8) {
  const items = events.slice(0, limit).map((e) => `
          <li><span class="d">${esc(formatDate(e.date))}</span><span class="t">${formatTime(e.time)} ET</span><span class="w">${esc(e.title.replace(`${program.shortName}: `, ''))}</span></li>`).join('');
  const more = events.length > limit ? `<p class="muted small">And ${events.length - limit} more. The calendar file has every date.</p>` : '';
  return `<ul class="schedule">${items}
        </ul>${more}`;
}

function welcome({ program, r, section, events, calendarHref, memberLink, accessPassHref }) {
  if (r.upfront && r.billingOnly) return layout({ program, title: `Course completed · ${program.name}`, noindex: true, body: `<section class="section"><div class="wrap narrow"><h1>Your course has ended.</h1><p>Your six-week membership was a one-time purchase. There is no automatic renewal.</p><a class="btn btn-outline" href="${esc(program.orgUrl)}contact">Contact the club</a></div></section>` });
  if (r.billingOnly) return layout({ program, title: `Your payment plan · ${program.name}`, noindex: true, body: `<section class="section"><div class="wrap narrow"><h1>Your payment plan</h1><p>Your course access is no longer active. You can still review invoices and update your card.</p>${memberLink ? `<a class="btn btn-primary" href="${esc(memberLink)}">Open member page and billing</a>` : ''}</div></section>` });
  const member = r.md.plan === 'member';
  const pending = r.pending;
  if (r.processing) return layout({ program, title: `Payment processing · ${program.name}`, noindex: true, body: `<section class="section confirm"><div class="wrap narrow"><span class="confirm-mark">${I.lock}</span><h1>Your payment is processing.</h1><p class="lede">We’ll confirm your place once payment clears.</p><p>Please check your receipt before paying again. Your schedule and member access will appear here after confirmation.</p><a class="btn btn-outline" href="${esc(calendarHref.replace('/calendar.ics', '/welcome'))}">Check payment status</a></div></section>` });
  const heading = pending ? 'Your seat is held.' : 'You’re in.';
  const first = (r.name || '').split(' ')[0];
  const next = pending ? [
    [I.mail, 'Check your email', 'We sent a confirmation with your schedule and a link back here.'],
    [I.lock, 'Pay when we send the link', `We email a secure payment link before ${formatDate(program.termStarts, { weekday: false })}. Your seat stays held until then.`],
    [I.video, 'Join your first session', 'Zoom links and the first reading appear on your member page before you start.'],
  ] : [
    [I.mail, 'Keep your confirmation', r.installments ? 'Your card is saved and your 18-payment plan is scheduled. Save your member link to return to your schedule and billing.' : 'Your payment is confirmed. Save your member link below to return to your schedule.'],
    [I.video, 'Get your links', 'Your member page has the Zoom link, lecture details and readings.'],
    [I.cal, 'Save the dates', 'Add every session to your calendar in one tap.'],
  ];
  const body = `
    <section class="section confirm">
      <div class="wrap narrow">
        <span class="confirm-mark">${I.check}</span>
        <h1>${heading}</h1>
        <p class="lede">${first ? `${esc(first)}, you` : 'You'} ${member ? `have a membership seat in <strong>${esc(section.name)}</strong>, ${esc(secTime(section))}.` : `have a drop-in seat on <strong>${esc(formatDate(r.md.date))}</strong> at ${formatTime(section.time)} ET.`}</p>
        ${r.processing ? '<p>Your bank payment is still clearing. Stripe will email you when it does.</p>' : ''}
        <div class="confirm-actions">
          <a class="btn btn-primary" href="${esc(calendarHref)}">${I.cal} Add to my calendar</a>
          ${memberLink ? `<a class="btn btn-outline" href="${esc(memberLink)}">Open my member page ${I.arrow}</a>` : ''}
        </div>
        ${accessPassHref ? `<div class="card"><h2 class="h3">Keep your access link</h2><p>This browser remembers you. Download your private link so you can return from another device or after clearing your browser.</p><a class="btn btn-outline" href="${esc(accessPassHref)}" download>Save my access link</a><p class="help">Keep it private—anyone with this link can open your member page.</p></div>` : ''}
        <h2 class="h3">What happens next</h2>
        <ol class="next">${next.map(([ic, h, p]) => `
          <li><span class="step-icon">${ic}</span><div><h3>${h}</h3><p>${esc(p)}</p></div></li>`).join('')}
        </ol>
        <h2 class="h3">Your schedule</h2>
        ${scheduleList(program, events)}
        ${!member ? `<p class="muted">Liked it? <a href="${joinHref('member', r.md.section)}">A membership</a> holds your seat for the six-week course. $450 paid once; equivalent to $25 per included session.</p>` : ''}
      </div>
    </section>`;
  return layout({ program, title: `${heading.replace('.', '')} · ${program.name}`, noindex: true, body });
}

function login({ program, sent, expired, invalid, available }) {
  const body = sent ? `
    <section class="section confirm">
      <div class="wrap narrow">
        <span class="confirm-mark">${I.mail}</span>
        <h1>Check your email.</h1>
        <p class="lede">If that email has a seat, a sign-in link is on its way. It can take a minute.</p>
        <p class="muted">Nothing arrived? Use the email you signed up with, and check your spam folder. <a href="/login">Try again</a></p>
      </div>
    </section>` : `
    <section class="section">
      <div class="wrap narrow">
        <h1>Find your section</h1>
        <p class="lede">${available ? 'Enter the email you signed up with. We’ll send you a link to your schedule, joining details and readings. No password needed.' : 'Open the private access link you saved after checkout to find your schedule, joining details and membership billing.'}</p>
        ${expired ? `<p class="notice notice-info" role="status">That sign-in link has expired. ${available ? 'Enter your email for a new one.' : 'Use your downloaded access link or the original payment confirmation page to return.'}</p>` : ''}
        ${available ? `<form method="post" action="/login" class="card form-card login-card">
          <div class="field"><label for="l-email">Email</label><input id="l-email" name="email" type="email" required autocomplete="email" inputmode="email"${invalid ? ' aria-invalid="true" aria-describedby="l-err"' : ''}>${invalid ? '<p class="field-error" id="l-err" role="alert">Please enter a valid email address.</p>' : ''}</div>
          <button type="submit" class="btn btn-primary btn-block">Email me a link ${I.arrow}</button>
        </form>` : '<div class="card"><h2 class="h3">Already joined?</h2><p>Look for <strong>reading-club-access.txt</strong> in your downloads, or use the browser where you completed payment.</p><p>If you have lost your link, <a href="https://nyphilosophy.org/contact">contact the club</a> with your payment receipt so we can help.</p></div>'}
        <p class="muted">Not signed up yet? <a href="/#sections">See the sections</a>.</p>
      </div>
    </section>`;
  return layout({ program, title: `Sign in · ${program.name}`, noindex: true, body });
}

function detailRow(icn, label, value, fallback = 'Will be posted here before your first session.') {
  const v = String(value || '').trim();
  const shown = !v ? `<span class="muted">${fallback}</span>` : /^https?:\/\//.test(v) ? `<a href="${esc(v)}" rel="noopener">${esc(v.replace(/^https?:\/\//, ''))}</a>` : esc(v);
  return `<div class="drow"><span class="drow-icon">${icn}</span><div><p class="drow-label">${label}</p><p>${shown}</p></div></div>`;
}

function member({ program, mode, email, items, privateInfo = {}, portalUrl, token, billingAvailable = false }) {
  const priv = privateInfo.sections || {};
  const lecture = privateInfo.lecture || {};
  const hasMembership = items.some((i) => i.plan === 'member');
  const blocks = items.map((it) => {
    const sec = it.sectionInfo;
    const isMember = it.plan === 'member';
    return `
        <article class="card enrolled">
          <div class="enrolled-head">
            <h2 class="h3">${isMember ? esc(sec.name) : `Drop-in · ${esc(formatDate(it.date))}`}</h2>
            <span class="pill pill-open">${isMember ? 'Member' : 'Drop in'}</span>
          </div>
          <div class="drows">
            ${detailRow(I.cal, 'When', isMember ? secTime(sec) : `${formatDate(it.date)}, ${formatTime(sec.time)} ET`)}
            ${sec.facilitator ? detailRow(I.people, 'Facilitator', sec.facilitator) : ''}
            ${detailRow(I.video, `${esc(sec.where)} link`, (priv[sec.id] || {}).zoom)}
            ${isMember ? detailRow(I.pin, 'Lecture', lecture.address, esc(program.lecture.where)) : ''}
            ${isMember && lecture.stream ? detailRow(I.video, 'Lecture stream', lecture.stream) : ''}
            ${isMember && program.officeHours ? detailRow(I.video, 'Optional office hours', privateInfo.officeHours?.zoom) : ''}
          </div>
          <p class="eyebrow">Coming up</p>
          ${scheduleList(program, it.events, 6)}
        </article>`;
  }).join('');
  const body = `
    <section class="page-head">
      <div class="wrap">
        <p class="crumbs"><a href="/">${esc(program.shortName)}</a> <span aria-hidden="true">/</span> Your page</p>
        <h1>Your Reading Club</h1>
        <p class="muted">Signed in as ${esc(email)}</p>
        <form method="post" action="/logout"><button class="btn btn-outline">Sign out</button></form>
      </div>
    </section>
    <section class="section tight">
      <div class="wrap">
        ${items.length ? `
        <div class="member-grid">
          <div class="stack">${blocks}</div>
          <aside class="stack">
            <div class="card">
              ${detailRow(I.book, 'This week’s reading', privateInfo.readings, 'Will be posted here before each session.')}
              <a class="btn btn-primary btn-block" href="/my/calendar.ics?t=${esc(token)}">${I.cal} Add to my calendar</a>
            </div>
            ${mode === 'local' ? `<div class="card"><p class="drow-label">Payment</p><p>No payment is due yet. We’ll email you a secure payment link before the term begins.</p></div>` : ''}
            ${billingAvailable ? `<div class="card"><p class="drow-label">Billing</p><p>View invoices and update your card. For questions about your commitment or a refund, contact the club.</p><form method="post" action="/billing"><input type="hidden" name="t" value="${esc(token)}"><button class="btn btn-outline btn-block">Manage membership</button></form></div>` : ''}
            ${hasMembership ? '' : `<div class="card"><p class="drow-label">Want a seat every week?</p><p>Membership holds your place all term. $450 paid once for six weeks; equivalent to $25 per included session.</p><a class="btn btn-outline btn-block" href="${joinHref('member')}">See sections</a></div>`}
          </aside>
        </div>` : `
        <div class="narrow">
          <p class="lede">We couldn’t find a current seat for this email.</p>
          <p>If you signed up with a different email, <a href="/login">sign in with that one</a>, or <a href="/#sections">join Reading Club</a>.</p>
          ${billingAvailable ? `<form method="post" action="/billing"><input type="hidden" name="t" value="${esc(token)}"><button class="btn btn-outline">Manage membership and payment method</button></form>` : ''}
        </div>`}
      </div>
    </section>`;
  return layout({ program, title: `Your Reading Club · ${program.name}`, noindex: true, body });
}

function simple({ program, title, heading, lede, extra = '', mark = '' }) {
  return layout({ program, title: `${title} · ${program.name}`, noindex: true, body: `
    <section class="section confirm">
      <div class="wrap narrow">
        ${mark ? `<span class="confirm-mark">${mark}</span>` : ''}
        <h1>${heading}</h1>
        <p class="lede">${lede}</p>
        ${extra}
        <p><a class="btn btn-outline" href="/">Back to Reading Club</a></p>
      </div>
    </section>` });
}

const notConfirmed = ({ program }) => simple({ program, title: 'Not found', heading: 'We couldn’t confirm that signup.', lede: 'Check your payment receipt before trying again. If you paid and cannot open your member page, contact the club with your receipt.', extra: '<p class="muted">Already signed up? <a href="/login">Sign in to see your section</a>.</p>' });
const interestThanks = ({ program, section }) => simple({ program, title: 'Thank you', mark: I.check, heading: section ? 'You’re on the waitlist.' : 'Thank you.', lede: section ? `We’ll email you the moment a seat opens in ${esc(section.name)}.` : 'We’ll write when the next reading opens.' });
const notFound = ({ program }) => simple({ program, title: 'Page not found', heading: 'Page not found.', lede: 'That page doesn’t exist, or the link is out of date.' });
const problem = ({ program }) => simple({ program, title: 'Something went wrong', heading: 'Something went wrong.', lede: 'Please try again in a minute.' });

module.exports = { landing, join: join_, welcome, login, member, notConfirmed, interestThanks, notFound, problem, esc };
