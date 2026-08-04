module.exports = {
  version: 36,
  name: 'guild_guard_member_reports',
  up: ({ db, logger }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS guild_guard_member_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id TEXT NOT NULL UNIQUE,
        guild_id TEXT NOT NULL,
        reporter_user_id TEXT NOT NULL,
        reported_user_id TEXT,
        description TEXT NOT NULL,
        evidence_reference TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        reviewed_by TEXT,
        reviewed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_guild_guard_member_reports_guild
        ON guild_guard_member_reports(guild_id, status, created_at DESC);
    `);
    logger.log('[DB] Migration v36 added Guild Guard member scam reports');
  },
};
