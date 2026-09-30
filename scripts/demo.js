'use strict';
// Click through the whole site with made-up signups, no keys needed.
// Usage: npm run demo, then open http://localhost:3000
// Try a code link too: http://localhost:3000/?code=JOURNAL
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createApp, loadProgram } = require('../server');
const { createLocalLedger } = require('../lib/ledger-local');

const program = loadProgram();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-club-demo-'));
const seed = [];
const add = (n, plan, section, date) => { for (let i = 0; i < n; i++) seed.push({ id: `r_seed_${seed.length}`, program: program.program, status: 'reserved', plan, section, date, name: 'Sample', email: `sample${seed.length}@example.com`, source: 'demo' }); };
add(17, 'member', 'a'); add(20, 'member', 'b'); add(6, 'member', 'c'); add(3, 'dropin', 'a', '2026-10-19');
fs.writeFileSync(path.join(dataDir, 'reservations.json'), JSON.stringify({ reservations: seed, leads: [] }));

const PORT = process.env.PORT || 3000;
createApp({
  ledger: createLocalLedger({ program, dataDir }),
  program,
  loginSecret: 'demo-only-secret',
  privateInfo: { sections: { a: { zoom: 'https://zoom.us/j/0000000000' } }, lecture: { address: 'Venue to be announced' } },
  mailer: async ({ to, subject, text }) => console.log(`\n[demo mail to ${to}] ${subject}\n${text}\n`),
}).listen(PORT, () => console.log(`Demo on http://localhost:${PORT} (sample data, nothing is saved)`));
