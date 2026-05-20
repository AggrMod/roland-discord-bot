function up({ db }) {
  const tolerantExec = (sql) => {
    try {
      db.exec(sql);
    } catch (error) {
      const msg = String(error?.message || '');
      const ignorable = msg.includes('duplicate column name') || msg.includes('already exists') || msg.includes('no such table');
      if (!ignorable) throw error;
    }
  };

  tolerantExec(`
    CREATE TABLE IF NOT EXISTS tenant_moderation_settings (
      guild_id TEXT PRIMARY KEY,
      anti_raid_enabled INTEGER DEFAULT 0,
      anti_raid_window_seconds INTEGER DEFAULT 30,
      anti_raid_join_threshold INTEGER DEFAULT 8,
      anti_raid_action TEXT DEFAULT 'timeout',
      anti_raid_timeout_minutes INTEGER DEFAULT 10,
      keyword_filter_enabled INTEGER DEFAULT 0,
      keyword_filter_delete INTEGER DEFAULT 1,
      keyword_filter_warn INTEGER DEFAULT 1,
      log_channel_id TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  tolerantExec(`
    CREATE TABLE IF NOT EXISTS tenant_moderation_keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, keyword)
    )
  `);

  tolerantExec('CREATE INDEX IF NOT EXISTS idx_tenant_moderation_keywords_guild ON tenant_moderation_keywords(guild_id)');
}

module.exports = {
  version: 15,
  name: 'tenant_moderation_basics',
  up,
};
