module.exports = {
  version: 12,
  name: 'vault_module_foundation',
  up: ({ db, logger }) => {
    const tolerantExec = (sql) => {
      try {
        db.exec(sql);
      } catch (error) {
        const msg = String(error?.message || '');
        const ignorable = msg.includes('duplicate column name')
          || msg.includes('already exists')
          || msg.includes('no such table');
        if (!ignorable) throw error;
      }
    };

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS vault_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guild_id)
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS vault_seasons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        season_id TEXT NOT NULL DEFAULT 'default',
        season_name TEXT NOT NULL DEFAULT 'Default Season',
        active INTEGER DEFAULT 0,
        starts_at DATETIME,
        ends_at DATETIME,
        metadata_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guild_id, season_id)
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS vault_user_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        season_id TEXT NOT NULL DEFAULT 'default',
        discord_user_id TEXT NOT NULL,
        wallet_address TEXT,
        paid_mints INTEGER NOT NULL DEFAULT 0,
        free_mints INTEGER NOT NULL DEFAULT 0,
        keys_earned INTEGER NOT NULL DEFAULT 0,
        keys_used INTEGER NOT NULL DEFAULT 0,
        bonus_entries INTEGER NOT NULL DEFAULT 0,
        pressure INTEGER NOT NULL DEFAULT 0,
        points INTEGER NOT NULL DEFAULT 0,
        rewards_won INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guild_id, season_id, discord_user_id)
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS vault_openings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        season_id TEXT NOT NULL DEFAULT 'default',
        discord_user_id TEXT NOT NULL,
        reward_tier TEXT NOT NULL,
        reward_code TEXT NOT NULL,
        reward_name TEXT NOT NULL,
        reward_payload TEXT,
        key_number INTEGER,
        status TEXT NOT NULL DEFAULT 'completed',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS vault_rewards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        season_id TEXT NOT NULL DEFAULT 'default',
        discord_user_id TEXT NOT NULL,
        reward_code TEXT NOT NULL,
        reward_name TEXT NOT NULL,
        reward_tier TEXT NOT NULL,
        reward_payload TEXT,
        claim_status TEXT NOT NULL DEFAULT 'pending',
        source TEXT NOT NULL DEFAULT 'vault_open',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS vault_mint_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        season_id TEXT NOT NULL DEFAULT 'default',
        tx_signature TEXT NOT NULL,
        mint_address TEXT,
        wallet_address TEXT,
        discord_user_id TEXT,
        mint_type TEXT NOT NULL DEFAULT 'unknown',
        keys_granted INTEGER NOT NULL DEFAULT 0,
        bonus_entries_granted INTEGER NOT NULL DEFAULT 0,
        pressure_granted INTEGER NOT NULL DEFAULT 0,
        points_granted INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guild_id, tx_signature)
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS vault_admin_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        season_id TEXT,
        admin_discord_user_id TEXT,
        action TEXT NOT NULL,
        target_discord_user_id TEXT,
        details_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS vault_milestone_unlocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        season_id TEXT NOT NULL DEFAULT 'default',
        milestone_id TEXT NOT NULL,
        total_pressure INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        unlock_payload TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guild_id, season_id, milestone_id)
      )
    `);

    tolerantExec('CREATE INDEX IF NOT EXISTS idx_vault_seasons_active ON vault_seasons(guild_id, active)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_vault_user_stats_user ON vault_user_stats(guild_id, season_id, discord_user_id)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_vault_user_stats_wallet ON vault_user_stats(guild_id, wallet_address)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_vault_openings_user ON vault_openings(guild_id, season_id, discord_user_id, created_at DESC)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_vault_rewards_user ON vault_rewards(guild_id, season_id, discord_user_id, created_at DESC)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_vault_rewards_status ON vault_rewards(guild_id, season_id, claim_status)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_vault_mint_events_wallet ON vault_mint_events(guild_id, season_id, wallet_address)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_vault_mint_events_user ON vault_mint_events(guild_id, season_id, discord_user_id)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_vault_admin_logs_guild ON vault_admin_logs(guild_id, created_at DESC)');

    logger.log('[DB] Migration v12 ensured Vault module foundation tables');
  }
};
