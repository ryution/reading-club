'use strict';
// The payment placeholder. Until Stripe is connected, a signup reserves a seat
// here instead of charging a card. Reservations count toward section capacity,
// and the organizers send payment links later. One JSON file, one server.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createLocalLedger({ program, dataDir }) {
  const file = path.join(dataDir, 'reservations.json');
  fs.mkdirSync(dataDir, { recursive: true });
  let db = { reservations: [], leads: [] };
  if (fs.existsSync(file)) db = { reservations: [], leads: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) };

  // Writes are queued so two signups at once can't clobber each other.
  let queue = Promise.resolve();
  const save = () => {
    queue = queue.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(db, null, 2));
      await fs.promises.rename(tmp, file);
    });
    return queue;
  };

  const mine = (r) => r.program === program.program && r.status !== 'canceled';

  return {
    mode: 'local',
    cacheMs: 0,

    async counts() {
      const members = Object.fromEntries(program.sections.map((s) => [s.id, 0]));
      const dropins = {};
      for (const r of db.reservations.filter(mine)) {
        if (r.plan === 'member' && r.section in members) members[r.section]++;
        if (r.plan === 'dropin') dropins[`${r.section}|${r.date}`] = (dropins[`${r.section}|${r.date}`] || 0) + 1;
      }
      return { members, dropins };
    },

    async enrollmentsFor(email) {
      return db.reservations.filter((r) => mine(r) && r.email === email)
        .map((r) => ({ plan: r.plan, section: r.section, date: r.date, source: r.source }));
    },

    async receipt(id) {
      const r = db.reservations.find((x) => x.id === id && mine(x));
      if (!r) return null;
      return { email: r.email, name: r.name, md: { plan: r.plan, section: r.section, date: r.date, source: r.source }, code: r.code, pending: true };
    },

    async saveLead(lead) {
      db.leads.push({ ...lead, program: program.program, createdAt: new Date().toISOString() });
      await save();
    },

    // No payment: record the seat and send them to their confirmation page.
    async begin({ plan, section, date, source, code, name, email }) {
      if (!name || !email) return { error: 'details' };
      const dupe = db.reservations.find((r) => mine(r) && r.email === email && r.plan === plan && r.section === section.id && (plan === 'member' || r.date === date));
      if (dupe) return { redirect: `/welcome?id=${dupe.id}`, reservation: dupe, existing: true };
      const reservation = {
        id: `r_${crypto.randomBytes(12).toString('base64url')}`,
        program: program.program,
        status: 'reserved',
        plan, section: section.id, date: plan === 'dropin' ? date : undefined,
        name, email, source, code: code || undefined,
        amount: plan === 'member' ? program.memberPrice : program.dropInPrice,
        createdAt: new Date().toISOString(),
      };
      db.reservations.push(reservation);
      await save();
      return { redirect: `/welcome?id=${reservation.id}`, reservation };
    },

    all() { return db; },
    flush() { return queue; },
  };
}

module.exports = { createLocalLedger };
