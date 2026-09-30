'use strict';
// The payment placeholder. Until Stripe is connected, a signup reserves a seat
// instead of charging a card. Reservations count toward section capacity, and
// the organizers send payment links later.
//
// Where reservations live:
//   - Upstash Redis (KV_REST_API_URL + KV_REST_API_TOKEN), the choice on Vercel
//   - a JSON file in DATA_DIR, the choice on a normal server with a disk

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- stores ----------

function createFileStore(dataDir) {
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
  return {
    kind: 'file',
    async load() { return db; },
    async addReservation(r) { db.reservations.push(r); await save(); },
    async addLead(l) { db.leads.push(l); await save(); },
    flush: () => queue,
  };
}

// Upstash's REST API: one POST per command, no client library needed.
function createRedisStore({ url, token, prefix = 'reading-club', fetchImpl = fetch }) {
  const base = url.replace(/\/$/, '');
  async function cmd(...args) {
    const res = await fetchImpl(base, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(`Redis: ${body.error || res.status}`);
    return body.result;
  }
  const list = async (key) => (await cmd('LRANGE', `${prefix}:${key}`, 0, -1)).map((s) => JSON.parse(s));
  return {
    kind: 'redis',
    async load() {
      const [reservations, leads] = await Promise.all([list('reservations'), list('leads')]);
      return { reservations, leads };
    },
    async addReservation(r) { await cmd('RPUSH', `${prefix}:reservations`, JSON.stringify(r)); },
    async addLead(l) { await cmd('RPUSH', `${prefix}:leads`, JSON.stringify(l)); },
    flush: async () => {},
  };
}

// ---------- ledger ----------

function createLocalLedger({ program, store, dataDir }) {
  const db = store || createFileStore(dataDir);
  const mine = (r) => r.program === program.program && r.status !== 'canceled';
  const all = async () => (await db.load()).reservations.filter(mine);

  return {
    mode: 'local',
    storage: db.kind,
    cacheMs: 0,

    async counts() {
      const members = Object.fromEntries(program.sections.map((s) => [s.id, 0]));
      const dropins = {};
      for (const r of await all()) {
        if (r.plan === 'member' && r.section in members) members[r.section]++;
        if (r.plan === 'dropin') dropins[`${r.section}|${r.date}`] = (dropins[`${r.section}|${r.date}`] || 0) + 1;
      }
      return { members, dropins };
    },

    async enrollmentsFor(email) {
      return (await all()).filter((r) => r.email === email)
        .map((r) => ({ plan: r.plan, section: r.section, date: r.date, source: r.source }));
    },

    async receipt(id) {
      const r = (await all()).find((x) => x.id === id);
      if (!r) return null;
      return { email: r.email, name: r.name, md: { plan: r.plan, section: r.section, date: r.date, source: r.source }, code: r.code, pending: true };
    },

    async saveLead(lead) {
      await db.addLead({ ...lead, program: program.program, createdAt: new Date().toISOString() });
    },

    // No payment: record the seat and send them to their confirmation page.
    async begin({ plan, section, date, source, code, name, email }) {
      if (!name || !email) return { error: 'details' };
      const dupe = (await all()).find((r) => r.email === email && r.plan === plan && r.section === section.id && (plan === 'member' || r.date === date));
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
      await db.addReservation(reservation);
      return { redirect: `/welcome?id=${reservation.id}`, reservation };
    },

    all: () => db.load(),
    flush: () => db.flush(),
  };
}

module.exports = { createLocalLedger, createFileStore, createRedisStore };
