module.exports = {
  version: 29,
  name: 'guild_guard_global_reputation',
  up: ({ db, logger }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS guild_guard_global_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        category TEXT NOT NULL,
        base_score INTEGER NOT NULL DEFAULT 0,
        source_guild_id TEXT NOT NULL,
        source_incident_id TEXT NOT NULL,
        reported_by TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        revoke_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        revoked_at DATETIME,
        UNIQUE(source_guild_id, source_incident_id)
      );
      CREATE TABLE IF NOT EXISTS guild_guard_global_matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        report_id TEXT NOT NULL,
        active_score INTEGER NOT NULL DEFAULT 0,
        notified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guild_id, event_id, report_id)
      );
      CREATE INDEX IF NOT EXISTS idx_guild_guard_global_reports_user ON guild_guard_global_reports(user_id, status, category);
      CREATE INDEX IF NOT EXISTS idx_guild_guard_global_reports_source ON guild_guard_global_reports(source_guild_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_guild_guard_global_matches_guild ON guild_guard_global_matches(guild_id, notified_at DESC);
    `);
    logger.log('[DB] Migration v29 ensured Guild Guard global reputation tables');
  }
};
