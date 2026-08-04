module.exports = {
  version: 35,
  name: 'guild_guard_lockdown_recovery',
  up: ({ db, logger }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS guild_guard_lockdowns (
        guild_id TEXT PRIMARY KEY,
        previous_verification_level TEXT,
        applied_verification_level TEXT NOT NULL,
        restore_at DATETIME NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_guild_guard_lockdowns_restore
        ON guild_guard_lockdowns(status, restore_at);
    `);
    logger.log('[DB] Migration v35 added recoverable Guild Guard raid lockdowns');
  },
};
