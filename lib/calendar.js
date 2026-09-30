'use strict';
// Builds an .ics file so a new student's sessions land in their calendar.

const NEW_YORK = [
  'BEGIN:VTIMEZONE', 'TZID:America/New_York',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

function local(date, hhmm, plusMinutes = 0) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + plusMinutes;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${date.replace(/-/g, '')}T${hh}${mm}00`;
}

// Long lines must be folded at 75 octets.
function fold(line) {
  const out = [];
  let rest = line;
  while (rest.length > 74) { out.push(rest.slice(0, 74)); rest = ` ${rest.slice(74)}`; }
  out.push(rest);
  return out.join('\r\n');
}

/** events: [{ uid, date, time, minutes, title, where }] */
function buildIcs({ timeZone, calendarName, events, now = new Date() }) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//New York Philosophy Club//Reading Club//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(calendarName)}`];
  if (timeZone === 'America/New_York') lines.push(...NEW_YORK);
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=${timeZone}:${local(e.date, e.time)}`,
      `DTEND;TZID=${timeZone}:${local(e.date, e.time, e.minutes)}`,
      `SUMMARY:${esc(e.title)}`,
      `LOCATION:${esc(e.where)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

module.exports = { buildIcs };
