module.exports = {
  version: 10,
  name: 'heist_v1_foundation',
  up: ({ db, logger }) => {
    const tolerantExec = (sql) => {
      try {
        db.exec(sql);
      } catch (error) {
        const message = String(error?.message || '').toLowerCase();
        const ignorable = message.includes('duplicate column name')
          || message.includes('already exists')
          || message.includes('no such table')
          || message.includes('no such column');
        if (!ignorable) throw error;
      }
    };

    tolerantExec("ALTER TABLE tenant_branding ADD COLUMN missions_label TEXT");

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS heist_config (
        guild_id TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 1,
        module_display_name TEXT DEFAULT 'Missions',
        xp_label TEXT DEFAULT 'XP',
        streetcredit_label TEXT DEFAULT 'Streetcredit',
        task_label TEXT DEFAULT 'Jobs',
        mission_feed_channel_id TEXT,
        mission_log_channel_id TEXT,
        vault_log_channel_id TEXT,
        panel_channel_id TEXT,
        panel_message_id TEXT,
        mission_spawn_enabled INTEGER DEFAULT 1,
        spawn_interval_minutes INTEGER DEFAULT 180,
        max_active_missions INTEGER DEFAULT 5,
        default_duration_minutes INTEGER DEFAULT 1440,
        default_max_nfts_per_user INTEGER DEFAULT 2,
        random_seed TEXT,
        metadata_json TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS heist_ladder (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        rank_key TEXT NOT NULL,
        rank_name TEXT NOT NULL,
        min_xp INTEGER NOT NULL DEFAULT 0,
        vault_tier INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guild_id, rank_key)
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS heist_profiles (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT,
        total_xp INTEGER DEFAULT 0,
        total_streetcredit INTEGER DEFAULT 0,
        rank_key TEXT,
        rank_name TEXT,
        vault_tier INTEGER DEFAULT 0,
        missions_completed INTEGER DEFAULT 0,
        missions_failed INTEGER DEFAULT 0,
        last_mission_at DATETIME,
        metadata_json TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id)
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS heist_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        template_key TEXT,
        name TEXT NOT NULL,
        description TEXT,
        mission_type TEXT DEFAULT 'standard',
        mode TEXT DEFAULT 'solo',
        required_slots INTEGER DEFAULT 1,
        total_slots INTEGER DEFAULT 1,
        max_nfts_per_user INTEGER DEFAULT 2,
        duration_minutes INTEGER DEFAULT 1440,
        base_xp_reward INTEGER DEFAULT 25,
        base_streetcredit_reward INTEGER DEFAULT 25,
        trait_requirements_json TEXT DEFAULT '{}',
        objective_json TEXT DEFAULT '[]',
        reward_rules_json TEXT DEFAULT '{}',
        active_window_json TEXT DEFAULT '{}',
        spawn_weight INTEGER DEFAULT 1,
        cooldown_minutes INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        metadata_json TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS heist_missions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mission_id TEXT NOT NULL UNIQUE,
        guild_id TEXT NOT NULL,
        template_id INTEGER,
        title TEXT NOT NULL,
        description TEXT,
        mission_type TEXT DEFAULT 'standard',
        mode TEXT DEFAULT 'solo',
        status TEXT DEFAULT 'recruiting',
        required_slots INTEGER DEFAULT 1,
        total_slots INTEGER DEFAULT 1,
        filled_slots INTEGER DEFAULT 0,
        max_nfts_per_user INTEGER DEFAULT 2,
        base_xp_reward INTEGER DEFAULT 25,
        base_streetcredit_reward INTEGER DEFAULT 25,
        objective_json TEXT DEFAULT '[]',
        trait_requirements_json TEXT DEFAULT '{}',
        reward_rules_json TEXT DEFAULT '{}',
        spawn_source TEXT DEFAULT 'random',
        started_at DATETIME,
        ends_at DATETIME,
        resolved_at DATETIME,
        metadata_json TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS heist_mission_slots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        slot_index INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT,
        wallet_address TEXT NOT NULL,
        nft_mint TEXT NOT NULL,
        nft_name TEXT,
        trait_snapshot_json TEXT DEFAULT '[]',
        status TEXT DEFAULT 'joined',
        payout_xp INTEGER DEFAULT 0,
        payout_streetcredit INTEGER DEFAULT 0,
        failure_reason TEXT,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME,
        UNIQUE(mission_id, slot_index),
        UNIQUE(mission_id, nft_mint)
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS heist_locked_nfts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        nft_mint TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        mission_slot_id INTEGER,
        locked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        metadata_json TEXT DEFAULT '{}',
        UNIQUE(guild_id, nft_mint)
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS heist_trait_bonus_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        trait_type TEXT NOT NULL,
        trait_value TEXT NOT NULL,
        mission_type TEXT,
        target_metric TEXT NOT NULL,
        multiplier REAL DEFAULT 1,
        flat_bonus INTEGER DEFAULT 0,
        max_bonus INTEGER,
        enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS heist_vault_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        cost_streetcredit INTEGER NOT NULL DEFAULT 0,
        required_vault_tier INTEGER DEFAULT 0,
        reward_type TEXT DEFAULT 'manual',
        fulfillment_mode TEXT DEFAULT 'manual',
        role_id TEXT,
        code_pool_json TEXT DEFAULT '[]',
        quantity_remaining INTEGER DEFAULT -1,
        enabled INTEGER DEFAULT 1,
        metadata_json TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS heist_vault_redemptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT,
        item_id INTEGER NOT NULL,
        cost_streetcredit INTEGER NOT NULL DEFAULT 0,
        fulfillment_status TEXT DEFAULT 'pending',
        ticket_channel_id TEXT,
        log_message_id TEXT,
        metadata_json TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        fulfilled_at DATETIME
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS heist_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        mission_id TEXT,
        user_id TEXT,
        payload_json TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tolerantExec('CREATE INDEX IF NOT EXISTS idx_heist_templates_guild_enabled ON heist_templates(guild_id, enabled)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_heist_missions_guild_status_end ON heist_missions(guild_id, status, ends_at)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_heist_missions_created ON heist_missions(created_at DESC)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_heist_slots_mission_user ON heist_mission_slots(mission_id, user_id)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_heist_slots_user_status ON heist_mission_slots(guild_id, user_id, status)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_heist_locks_user ON heist_locked_nfts(guild_id, user_id)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_heist_profiles_rank ON heist_profiles(guild_id, total_xp DESC)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_heist_vault_items_guild_enabled ON heist_vault_items(guild_id, enabled)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_heist_vault_redemptions_user ON heist_vault_redemptions(guild_id, user_id, created_at DESC)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_heist_events_guild_created ON heist_events(guild_id, created_at DESC)');

    logger.log('[DB] Migration v10 ensured heist v1 schema + missions_label branding support');
  },
};

