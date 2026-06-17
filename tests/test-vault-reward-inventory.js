#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDbPath = path.join(
  os.tmpdir(),
  `guildpilot-vault-reward-inventory-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
);
process.env.DATABASE_PATH = tempDbPath;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MULTITENANT_ENABLED = process.env.MULTITENANT_ENABLED || 'false';

const db = require('../database/db');
const vaultService = require('../services/vaultService');

function cleanup() {
  try { db.close(); } catch (_error) {}
  try { fs.unlinkSync(tempDbPath); } catch (_error) {}
}

function withRandomSequence(values, fn) {
  const original = Math.random;
  let idx = 0;
  Math.random = () => values[Math.min(idx++, values.length - 1)];
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

async function run() {
  const guildId = 'vault_reward_inventory_guild';
  const userId = 'vault_reward_inventory_user';

  const result = vaultService.saveConfig(guildId, {
    general: { enabled: true },
    security: { openCooldownSeconds: 0 },
    keyTiers: [
      { id: 'default', name: 'Default', enabled: true, inheritsFrom: null },
    ],
    rewardTable: {
      winChancesByKeyTier: { default: 100 },
      rewards: [
        { code: 'limited', name: 'Limited Prize', tier: 'rare', weight: 100, enabled: true, quantity: 1, type: 'claimable_reward' },
      ],
    },
  });
  assert.strictEqual(result.success, true, result.message || 'config should save');
  vaultService.ensureDefaultSeason(guildId);
  vaultService.addKeys(guildId, 'default', userId, 1, 'test', null, 'default');

  const win = withRandomSequence([0, 0], () => vaultService.openVault(guildId, userId, { keyTier: 'default' }));
  assert.strictEqual(win.success, true, 'vault open should succeed');
  assert.strictEqual(win.won, true, '100 percent win chance should award a prize');
  assert.strictEqual(win.reward.code, 'limited', 'limited prize should be awarded');
  assert.ok(Number(win.claimId || 0) > 0, 'claim id should be created for claimable reward');
  assert.strictEqual(win.inventoryUpdate?.changed, true, 'winning should reserve/decrement inventory');
  assert.strictEqual(win.inventoryUpdate?.removed, true, 'quantity 1 reward should be removed from pool');

  const afterWinRewards = vaultService.getRewards(guildId).map(reward => reward.code);
  assert.deepStrictEqual(afterWinRewards, [], 'limited prize should no longer be available after win');

  const claimed = await vaultService.updateRewardClaimStatus(guildId, win.claimId, 'claimed', 'fulfilled');
  assert.strictEqual(claimed.success, true, 'claim finalization should still succeed');
  assert.strictEqual(claimed.inventoryUpdate, null, 'claim finalization should not decrement inventory a second time');
  assert.deepStrictEqual(vaultService.getRewards(guildId).map(reward => reward.code), [], 'claim finalization should not alter already-reserved inventory');
}

run()
  .then(() => {
    console.log('vault reward inventory assertions passed');
  })
  .catch((error) => {
    console.error('vault reward inventory assertions failed:', error);
    process.exitCode = 1;
  })
  .finally(cleanup);
