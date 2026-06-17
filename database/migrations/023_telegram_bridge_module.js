module.exports = {
  version: 23,
  name: 'telegram_bridge_module',
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
      CREATE TABLE IF NOT EXISTS telegram_bridge_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        webhook_status TEXT NOT NULL DEFAULT 'unknown',
        webhook_last_update_at DATETIME,
        webhook_last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS telegram_bridge_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        name TEXT,
        telegram_chat_id TEXT NOT NULL,
        telegram_chat_title TEXT,
        telegram_chat_type TEXT NOT NULL DEFAULT 'group',
        discord_channel_id TEXT NOT NULL,
        direction_mode TEXT NOT NULL DEFAULT 'telegram_to_discord',
        enabled INTEGER NOT NULL DEFAULT 1,
        include_source_header INTEGER NOT NULL DEFAULT 1,
        include_author INTEGER NOT NULL DEFAULT 1,
        mirror_media INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tolerantExec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_bridge_mapping_pair
      ON telegram_bridge_mappings(guild_id, telegram_chat_id, discord_channel_id)
      WHERE enabled = 1
    `);

    tolerantExec(`
      CREATE INDEX IF NOT EXISTS idx_telegram_bridge_mappings_chat
      ON telegram_bridge_mappings(telegram_chat_id, enabled)
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS telegram_bridge_message_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mapping_id INTEGER NOT NULL,
        guild_id TEXT NOT NULL,
        source_platform TEXT NOT NULL,
        target_platform TEXT NOT NULL,
        telegram_chat_id TEXT,
        telegram_message_id TEXT,
        telegram_update_id TEXT,
        discord_channel_id TEXT,
        discord_message_id TEXT,
        dedupe_key TEXT NOT NULL,
        origin_platform TEXT,
        origin_message_key TEXT,
        created_by_bridge INTEGER NOT NULL DEFAULT 1,
        media_group_id TEXT,
        edit_state TEXT NOT NULL DEFAULT 'original',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tolerantExec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_bridge_message_dedupe
      ON telegram_bridge_message_log(mapping_id, dedupe_key)
    `);

    tolerantExec(`
      CREATE INDEX IF NOT EXISTS idx_telegram_bridge_message_lookup
      ON telegram_bridge_message_log(mapping_id, telegram_chat_id, telegram_message_id)
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS telegram_bridge_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT,
        mapping_id INTEGER,
        telegram_chat_id TEXT,
        discord_channel_id TEXT,
        status TEXT NOT NULL,
        event_type TEXT,
        message TEXT,
        details_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tolerantExec(`
      CREATE INDEX IF NOT EXISTS idx_telegram_bridge_audit_guild
      ON telegram_bridge_audit(guild_id, created_at DESC)
    `);

    tolerantExec(`
      CREATE INDEX IF NOT EXISTS idx_telegram_bridge_audit_mapping
      ON telegram_bridge_audit(mapping_id, created_at DESC)
    `);

    logger.log('[DB] Migration v23 ensured Telegram Bridge module tables');
  }
};
