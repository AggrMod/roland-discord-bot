const assert = require('assert');
const db = require('../database/db');
const vaultService = require('../services/vaultService');

async function run() {
  const suffix = String(Date.now());
  const guildId = `vault-social-${suffix}`;
  const userId = `user-${suffix}`;
  const seasonId = 'default';

  db.prepare('DELETE FROM vault_rewards WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM vault_reward_social_checks WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM engagement_social_accounts WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM vault_user_stats WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM vault_seasons WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM vault_config WHERE guild_id = ?').run(guildId);

  vaultService.getConfig(guildId);
  vaultService.upsertSeason(guildId, { seasonId, seasonName: 'Test', active: true });

  const gated = vaultService.assignManualReward(guildId, seasonId, userId, {
    code: 'x_gate_reward',
    name: 'X Gate Reward',
    tier: 'rare',
    payload: {
      social_requirements: [
        { provider: 'x', action: 'x_follow', target_account_handle: 'guildpilot' },
      ],
    },
  });
  assert.strictEqual(gated.success, true, 'gated reward assignment should succeed');

  const blocked = await vaultService.updateRewardClaimStatus(guildId, gated.rewardId, 'claimed', 'attempt without X link');
  assert.strictEqual(blocked.success, false, 'gated reward should be blocked when social requirements are not met');
  assert.strictEqual(blocked.code, 'social_requirements_pending', 'blocked reason should be social requirements');

  const free = vaultService.assignManualReward(guildId, seasonId, userId, {
    code: 'plain_reward',
    name: 'Plain Reward',
    tier: 'common',
    payload: { reward: 'plain' },
  });
  assert.strictEqual(free.success, true, 'plain reward assignment should succeed');
  const claimed = await vaultService.updateRewardClaimStatus(guildId, free.rewardId, 'claimed', 'ok');
  assert.strictEqual(claimed.success, true, 'plain reward should be claimable');
  assert.strictEqual(String(claimed.reward.claim_status), 'claimed', 'plain reward status should update');

  console.log('vault social gate assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

