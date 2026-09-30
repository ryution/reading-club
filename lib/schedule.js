'use strict';
// Pure date helpers. Dates are plain 'YYYY-MM-DD' strings in the program's
// time zone, so nothing here depends on the server clock's zone.

const DAY = 86400000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const toUTC = (d) => new Date(`${d}T00:00:00Z`);
const toStr = (t) => new Date(t).toISOString().slice(0, 10);

// Every date from termStarts for `weeks` weeks that falls on one of `weekdays`.
function termDates(termStarts, weeks, weekdays) {
  const start = toUTC(termStarts).getTime();
  const out = [];
  for (let i = 0; i < weeks * 7; i++) {
    const t = start + i * DAY;
    if (weekdays.includes(new Date(t).getUTCDay())) out.push(toStr(t));
  }
  return out;
}

// Today's date in the program's time zone.
function todayIn(timeZone, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}\u00a0${suffix}` : `${h12}\u00a0${suffix}`;
}

function formatDate(d, { weekday = true, short = false } = {}) {
  const t = toUTC(d);
  if (short) return `${WEEKDAYS[t.getUTCDay()].slice(0, 3)}, ${MONTHS[t.getUTCMonth()].slice(0, 3)} ${t.getUTCDate()}`;
  const s = `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}`;
  return weekday ? `${WEEKDAYS[t.getUTCDay()]}, ${s}` : s;
}

function plural(day) { return `${WEEKDAYS[day]}s`; }

function formatDays(weekdays) {
  const names = weekdays.map(plural);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function addDays(d, n) { return toStr(toUTC(d).getTime() + n * DAY); }

module.exports = { termDates, todayIn, formatTime, formatDate, formatDays, addDays, WEEKDAYS };
