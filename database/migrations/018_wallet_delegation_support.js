module.exports = {
  version: 18,
  name: 'wallet_delegation_support',
  up: ({ db, logger }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS wallet_delegations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_id TEXT NOT NULL,
        guild_id TEXT NOT NULL DEFAULT '',
        delegate_wallet_address TEXT NOT NULL,
        cold_wallet_address TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        expires_at DATETIME DEFAULT NULL,
        metadata_json TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(discord_id, guild_id, cold_wallet_address)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_wallet_delegations_user_guild_status ON wallet_delegations(discord_id, guild_id, status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_wallet_delegations_delegate_wallet ON wallet_delegations(delegate_wallet_address)');
    logger.log('[DB] Migration v18 ensured wallet delegation support');
  }
};

