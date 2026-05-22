const assert = require('assert');
const db = require('../database/db');
const engagementService = require('../services/engagementService');

function run() {
  const suffix = String(Date.now());
  const guildId = `guild-eng-${suffix}`;
  const userId = `user-eng-${suffix}`;
  const userA = `user-a-${suffix}`;
  const userB = `user-b-${suffix}`;
  const userC = `user-c-${suffix}`;

  db.prepare('DELETE FROM engagement_daily_streaks WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM points_ledger WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM points_totals WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM engagement_config WHERE guild_id = ?').run(guildId);

  engagementService.setConfig(guildId, {
    daily_reward_points: 20,
    daily_streak_bonus: 10,
    daily_streak_cap: 5,
    minigame_reward_first: 50,
    minigame_reward_second: 25,
    minigame_reward_third: 10,
  });

  const first = engagementService.claimDailyReward(guildId, userId, 'tester');
  assert.strictEqual(first.success, true, 'first daily claim should succeed');
  assert.strictEqual(first.streak, 1, 'first streak should be 1');
  assert.strictEqual(first.points, 20, 'first claim should use base reward');

  const duplicate = engagementService.claimDailyReward(guildId, userId, 'tester');
  assert.strictEqual(duplicate.success, false, 'duplicate claim should fail');
  assert.strictEqual(duplicate.reason, 'cooldown', 'duplicate claim should be cooldown gated');

  db.prepare("UPDATE engagement_daily_streaks SET last_claimed_at = datetime('now','-25 hours'), streak_count = 1 WHERE guild_id = ? AND user_id = ?")
    .run(guildId, userId);
  db.prepare("DELETE FROM points_ledger WHERE guild_id = ? AND user_id = ? AND action_type = 'daily_streak'")
    .run(guildId, userId);
  const second = engagementService.claimDailyReward(guildId, userId, 'tester');
  assert.strictEqual(second.success, true, 'second daily claim should succeed after cooldown');
  assert.strictEqual(second.streak, 2, 'streak should increment');
  assert.strictEqual(second.points, 30, 'second claim should include streak bonus');

  db.prepare("UPDATE engagement_daily_streaks SET last_claimed_at = datetime('now','-49 hours'), streak_count = 4 WHERE guild_id = ? AND user_id = ?")
    .run(guildId, userId);
  db.prepare("DELETE FROM points_ledger WHERE guild_id = ? AND user_id = ? AND action_type = 'daily_streak'")
    .run(guildId, userId);
  const reset = engagementService.claimDailyReward(guildId, userId, 'tester');
  assert.strictEqual(reset.success, true, 'claim after broken streak should still succeed');
  assert.strictEqual(reset.streak, 1, 'streak should reset after >48h gap');
  assert.strictEqual(reset.points, 20, 'reset streak should return to base reward');

  const rewarded = engagementService.awardMinigamePlacements(
    guildId,
    [{ userId: userA, username: 'alpha' }, { userId: userB, username: 'beta' }, { userId: userC, username: 'gamma' }],
    'trivia'
  );
  assert.strictEqual(rewarded.length, 3, 'minigame payouts should include top three users');

  const a = engagementService.getUserPoints(guildId, userA);
  const b = engagementService.getUserPoints(guildId, userB);
  const c = engagementService.getUserPoints(guildId, userC);
  assert.strictEqual(a.total_points, 50, 'first place reward should match config');
  assert.strictEqual(b.total_points, 25, 'second place reward should match config');
  assert.strictEqual(c.total_points, 10, 'third place reward should match config');

  const actionRows = db.prepare(`
    SELECT action_type, points
    FROM points_ledger
    WHERE guild_id = ? AND user_id IN (?, ?, ?)
    ORDER BY id ASC
  `).all(guildId, userA, userB, userC);
  assert.ok(actionRows.some(row => row.action_type === 'game_win' && Number(row.points) === 50), 'first place should log game_win');
  assert.ok(actionRows.some(row => row.action_type === 'game_place' && Number(row.points) === 25), 'second place should log game_place');
  assert.ok(actionRows.some(row => row.action_type === 'game_place' && Number(row.points) === 10), 'third place should log game_place');

  console.log('engagement streak + minigame reward assertions passed');
}

run();
