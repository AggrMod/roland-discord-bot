const db = require('../db');
const logger = require('../../utils/logger');

module.exports = function applyEngagementRewardKnobsMigration() {
  try {
    db.exec('ALTER TABLE engagement_config ADD COLUMN daily_reward_points INTEGER DEFAULT 25');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE engagement_config ADD COLUMN daily_streak_bonus INTEGER DEFAULT 5');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE engagement_config ADD COLUMN daily_streak_cap INTEGER DEFAULT 7');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE engagement_config ADD COLUMN minigame_reward_first INTEGER DEFAULT 30');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE engagement_config ADD COLUMN minigame_reward_second INTEGER DEFAULT 15');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE engagement_config ADD COLUMN minigame_reward_third INTEGER DEFAULT 8');
  } catch (_) {}
  logger.log('[migration] 020_engagement_reward_knobs applied');
};

