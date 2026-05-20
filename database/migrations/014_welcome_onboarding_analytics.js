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

  tolerantExec(`
    CREATE TABLE IF NOT EXISTS tenant_welcome_analytics_daily (
      guild_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      joins_total INTEGER DEFAULT 0,
      welcome_sent INTEGER DEFAULT 0,
      welcome_failed INTEGER DEFAULT 0,
      dm_sent INTEGER DEFAULT 0,
      captcha_passed INTEGER DEFAULT 0,
      captcha_failed INTEGER DEFAULT 0,
      test_sent INTEGER DEFAULT 0,
      panel_posted INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, day_key)
    )
  `);
  tolerantExec('CREATE INDEX IF NOT EXISTS idx_welcome_analytics_day ON tenant_welcome_analytics_daily(day_key)');
}

module.exports = {
  version: 14,
  name: 'welcome_onboarding_analytics',
  up,
};

