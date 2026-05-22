module.exports = {
  version: 20,
  name: 'engagement_reward_knobs',
  up: ({ db, logger }) => {
    const tolerantExec = (sql) => {
      try {
        db.exec(sql);
      } catch (_error) {}
    };
    tolerantExec('ALTER TABLE engagement_config ADD COLUMN daily_reward_points INTEGER DEFAULT 25');
    tolerantExec('ALTER TABLE engagement_config ADD COLUMN daily_streak_bonus INTEGER DEFAULT 5');
    tolerantExec('ALTER TABLE engagement_config ADD COLUMN daily_streak_cap INTEGER DEFAULT 7');
    tolerantExec('ALTER TABLE engagement_config ADD COLUMN minigame_reward_first INTEGER DEFAULT 30');
    tolerantExec('ALTER TABLE engagement_config ADD COLUMN minigame_reward_second INTEGER DEFAULT 15');
    tolerantExec('ALTER TABLE engagement_config ADD COLUMN minigame_reward_third INTEGER DEFAULT 8');
    logger.log('[migration] 020 engagement_reward_knobs applied');
  },
};

