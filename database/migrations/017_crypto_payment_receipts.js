function up({ db }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crypto_payment_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      tx_signature TEXT NOT NULL UNIQUE,
      amount REAL NOT NULL,
      token_symbol TEXT NOT NULL,
      sender_wallet TEXT NOT NULL,
      plan_key TEXT NOT NULL,
      billing_interval TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      verification_error TEXT DEFAULT NULL,
      verified_at DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_crypto_payment_receipts_guild ON crypto_payment_receipts(guild_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_crypto_payment_receipts_status ON crypto_payment_receipts(status)');
}

module.exports = {
  version: 17,
  name: 'crypto_payment_receipts',
  up,
};

