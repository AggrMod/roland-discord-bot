module.exports = {
  version: 28,
  name: 'guild_guard_risk_profiles',
  up: ({ db, logger }) => {
    const columns = [
      ['risk_level', "TEXT NOT NULL DEFAULT 'low'"],
      ['first_signal_at', 'DATETIME'],
      ['violation_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['last_violation_at', 'DATETIME']
    ];
    for (const [name, definition] of columns) {
      try {
        db.exec(`ALTER TABLE risk_profiles ADD COLUMN ${name} ${definition}`);
      } catch (error) {
        if (!String(error?.message || '').includes('duplicate column name')) throw error;
      }
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_guild_guard_risk_profiles_score ON risk_profiles(guild_id, risk_score DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_guild_guard_risk_profiles_level ON risk_profiles(guild_id, risk_level)');
    logger.log('[DB] Migration v28 ensured Guild Guard risk profile fields');
  }
};
