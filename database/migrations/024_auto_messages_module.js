module.exports = {
  version: 24,
  name: 'auto_messages_module',
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
      CREATE TABLE IF NOT EXISTS auto_message_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS auto_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        schedule_type TEXT NOT NULL DEFAULT 'interval',
        schedule_config_json TEXT NOT NULL DEFAULT '{}',
        timezone TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
        embed_json TEXT NOT NULL DEFAULT '{}',
        content_text TEXT,
        allow_everyone INTEGER NOT NULL DEFAULT 0,
        last_sent_at DATETIME,
        next_run_at DATETIME,
        last_error TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        send_count INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tolerantExec(`
      CREATE INDEX IF NOT EXISTS idx_auto_messages_guild_enabled
      ON auto_messages(guild_id, enabled)
    `);

    tolerantExec(`
      CREATE INDEX IF NOT EXISTS idx_auto_messages_due
      ON auto_messages(enabled, next_run_at)
    `);

    tolerantExec(`
      CREATE TABLE IF NOT EXISTS auto_message_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        auto_message_id INTEGER,
        channel_id TEXT,
        status TEXT NOT NULL,
        event_type TEXT NOT NULL DEFAULT 'send',
        discord_message_id TEXT,
        message TEXT,
        details_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tolerantExec(`
      CREATE INDEX IF NOT EXISTS idx_auto_message_audit_guild
      ON auto_message_audit(guild_id, created_at DESC)
    `);

    tolerantExec(`
      CREATE INDEX IF NOT EXISTS idx_auto_message_audit_message
      ON auto_message_audit(auto_message_id, created_at DESC)
    `);

    logger.log('[DB] Migration v24 ensured Auto Messages module tables');
  }
};
