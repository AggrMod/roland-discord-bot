module.exports = {
  version: 37,
  name: 'guild_guard_threat_intelligence',
  up: ({ db, logger }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS guild_guard_threat_domains (
        domain TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        confidence INTEGER NOT NULL DEFAULT 0,
        report_count INTEGER NOT NULL DEFAULT 0,
        source_guild_count INTEGER NOT NULL DEFAULT 0,
        reviewed_by TEXT,
        reviewed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS guild_guard_threat_domain_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT NOT NULL,
        source_guild_id TEXT NOT NULL,
        source_incident_id TEXT NOT NULL,
        submitted_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(domain, source_guild_id, source_incident_id)
      );

      CREATE INDEX IF NOT EXISTS idx_guild_guard_threat_domains_status
        ON guild_guard_threat_domains(status, confidence DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_guild_guard_threat_reports_source
        ON guild_guard_threat_domain_reports(source_guild_id, created_at DESC);
    `);
    logger.log('[DB] Migration v37 added reviewed Guild Guard domain intelligence');
  },
};
