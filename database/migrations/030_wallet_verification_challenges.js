module.exports = {
  version: 30,
  name: 'wallet_verification_challenges',
  up: ({ db, logger }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS wallet_verification_challenges (
        challenge_id TEXT PRIMARY KEY,
        session_hash TEXT NOT NULL,
        discord_id TEXT NOT NULL,
        guild_id TEXT NOT NULL DEFAULT '',
        chain_family TEXT NOT NULL DEFAULT 'solana',
        chain_id TEXT NOT NULL DEFAULT 'solana:mainnet',
        wallet_address TEXT NOT NULL,
        message TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        consumed_at DATETIME,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_wallet_verify_challenge_owner
        ON wallet_verification_challenges(discord_id, session_hash, consumed_at, expires_at);
      CREATE INDEX IF NOT EXISTS idx_wallet_verify_challenge_expiry
        ON wallet_verification_challenges(expires_at);
    `);
    logger.log('[DB] Migration v30 added one-time wallet verification challenges');
  }
};
