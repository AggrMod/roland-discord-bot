const Database = require('better-sqlite3');
const path = require('path');

function debug() {
  const db = new Database(path.join(__dirname, 'database', 'guildpilot.db'));
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM micro_verify_requests GROUP BY status').all();
  console.log('--- micro_verify_requests ---');
  console.log(JSON.stringify(rows, null, 2));

  const wallets = db.prepare('SELECT * FROM wallets LIMIT 10').all();
  console.log('--- wallets (top 10) ---');
  console.log(JSON.stringify(wallets, null, 2));
}

debug();
