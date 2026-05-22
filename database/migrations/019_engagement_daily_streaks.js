module.exports = {
  version: 19,
  name: 'engagement_daily_streaks',
  up: ({ db, logger }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS engagement_daily_streaks (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        streak_count INTEGER NOT NULL DEFAULT 0,
        last_claimed_at DATETIME,
        best_streak INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_daily_streaks_guild ON engagement_daily_streaks(guild_id)');
    logger.log('[migration] 019 engagement_daily_streaks applied');
  },
};

