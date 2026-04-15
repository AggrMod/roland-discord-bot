const db = require('./database/db');

async function debugOG() {
  const users = db.prepare('SELECT * FROM users').all();
  console.log('--- Users ---');
  users.forEach(u => console.log(`ID: ${u.discord_id}, Name: ${u.username}`));
  
  const wallets = db.prepare('SELECT * FROM wallets').all();
  console.log('--- Wallets ---');
  wallets.forEach(w => console.log(`Address: ${w.wallet_address}, UserID: ${w.discord_id}`));
}

debugOG().catch(console.error);
