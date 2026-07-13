module.exports = {
  version: 26,
  name: 'guild_guard_foundation',
  up: ({ db, logger }) => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS guild_guard_configs (
        guild_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL DEFAULT 'monitor',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS staff_identities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT,
        display_name TEXT,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guild_id, user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS domain_allowlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guild_id, domain)
      )`,
      `CREATE TABLE IF NOT EXISTS domain_blocklist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        reason TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guild_id, domain)
      )`,
      `CREATE TABLE IF NOT EXISTS risk_profiles (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        risk_score INTEGER NOT NULL DEFAULT 0,
        signal_count INTEGER NOT NULL DEFAULT 0,
        last_signal_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(guild_id, user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS risk_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        user_id TEXT,
        detector TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        score INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guild_id, event_id, detector)
      )`,
      `CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id TEXT NOT NULL UNIQUE,
        guild_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        user_id TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        risk_score INTEGER NOT NULL DEFAULT 0,
        signals_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guild_id, event_id)
      )`,
      `CREATE TABLE IF NOT EXISTS actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        incident_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS raid_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        join_count INTEGER NOT NULL DEFAULT 0,
        window_seconds INTEGER NOT NULL DEFAULT 60,
        action TEXT,
        status TEXT NOT NULL DEFAULT 'observed',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guild_id, event_id)
      )`,
      `CREATE TABLE IF NOT EXISTS false_positives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        incident_id TEXT NOT NULL,
        reported_by TEXT NOT NULL,
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      'CREATE INDEX IF NOT EXISTS idx_guild_guard_incidents_guild_created ON incidents(guild_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_guild_guard_incidents_user ON incidents(guild_id, user_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_guild_guard_signals_user ON risk_signals(guild_id, user_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_guild_guard_actions_incident ON actions(guild_id, incident_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_guild_guard_raid_events_guild ON raid_events(guild_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_guild_guard_staff_guild ON staff_identities(guild_id, enabled)',
    ];

    for (const sql of statements) db.exec(sql);
    logger.log('[DB] Migration v26 ensured Guild Guard foundation tables');
  }
};
