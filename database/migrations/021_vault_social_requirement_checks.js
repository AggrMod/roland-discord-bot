module.exports = {
  version: 21,
  name: 'vault_social_requirement_checks',
  up: ({ db, logger }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vault_reward_social_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        reward_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        action_type TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        verified_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(reward_id, action_type, target_ref)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_vault_social_checks_guild ON vault_reward_social_checks(guild_id, user_id)');
    logger.log('[migration] 021 vault_social_requirement_checks applied');
  },
};

