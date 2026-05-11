function up({ db }) {
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

  tolerantExec("ALTER TABLE vault_user_stats ADD COLUMN key_balances_json TEXT DEFAULT '{}'");
  tolerantExec("ALTER TABLE vault_openings ADD COLUMN key_tier TEXT DEFAULT 'default'");
  tolerantExec('CREATE INDEX IF NOT EXISTS idx_vault_openings_key_tier ON vault_openings(guild_id, season_id, key_tier)');
}

module.exports = {
  version: 13,
  name: 'vault_key_tiers',
  up,
};
