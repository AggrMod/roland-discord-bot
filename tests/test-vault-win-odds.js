#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDbPath = path.join(
  os.tmpdir(),
  `guildpilot-vault-win-odds-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function withRandom(value, fn) {
  const original = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

function seedConfig(guildId, winChancesByKeyTier) {
  const result = vaultService.saveConfig(guildId, {
    general: { enabled: true },
    security: { openCooldownSeconds: 0 },
    keyTiers: [
      { id: 'default', name: 'Default', enabled: true, inheritsFrom: null },
      { id: 'gold', name: 'Gold', enabled: true, inheritsFrom: 'default' },
    ],
    rewardTable: {
      winChancesByKeyTier,
      rewards: [
        { code: 'nothing', name: 'Nothing', tier: 'common', weight: 999, enabled: true, quantity: null, type: 'no_reward' },
        { code: 'cheap', name: 'Cheap Prize', tier: 'common', weight: 100, enabled: true, quantity: null, type: 'claimable_reward' },
        { code: 'jackpot', name: 'Jackpot', tier: 'legendary', weight: 1, keyTier: 'gold', enabled: true, quantity: null, type: 'claimable_reward' },
      ],
    },
  });
  assert.strictEqual(result.success, true, result.message || 'config should save');
  vaultService.ensureDefaultSeason(guildId);
}

function run() {
  const guildId = 'vault_win_odds_guild';
  const userId = 'vault_win_odds_user';

  seedConfig(guildId, { default: 0, gold: 100 });
  vaultService.addKeys(guildId, 'default', userId, 1, 'test', null, 'default');
  const loss = withRandom(0, () => vaultService.openVault(guildId, userId, { keyTier: 'default' }));
  assert.strictEqual(loss.success, true, '0 percent open should still consume a key successfully');
  assert.strictEqual(loss.won, false, '0 percent win chance should not win');
  assert.strictEqual(loss.reward.code, 'no_reward', 'loss should return synthetic no_reward');

  vaultService.addKeys(guildId, 'default', userId, 1, 'test', null, 'default');
  const win = withRandom(0, () => vaultService.openVault(guildId, userId, { keyTier: 'default' }));
  assert.strictEqual(win.success, true, 'default open should succeed');
  assert.strictEqual(win.won, false, 'default tier remains 0 percent after reseedless add');

  vaultService.addKeys(guildId, 'default', userId, 1, 'test', null, 'gold');
  const goldWin = withRandom(0.999, () => vaultService.openVault(guildId, userId, { keyTier: 'gold' }));
  assert.strictEqual(goldWin.success, true, 'gold open should succeed');
  assert.strictEqual(goldWin.won, true, '100 percent gold chance should win');
  assert.ok(Number(goldWin.claimId || 0) > 0, 'claimable win should expose a vault claim id');
  assert.notStrictEqual(goldWin.reward.code, 'nothing', 'legacy no_reward row should not be selected as a prize');
  assert.ok(['cheap', 'jackpot'].includes(goldWin.reward.code), 'gold can access inherited/default and gold prizes');

  const defaultEligible = vaultService.getEligiblePrizeRewards(guildId, 'default').map(r => r.code);
  assert.deepStrictEqual(defaultEligible, ['cheap'], 'default tier should not access gold jackpot');
  const goldEligible = vaultService.getEligiblePrizeRewards(guildId, 'gold').map(r => r.code).sort();
  assert.deepStrictEqual(goldEligible, ['cheap', 'jackpot'], 'gold tier should access jackpot and inherited prizes');
}

try {
  run();
  console.log('vault win odds test passed');
} catch (error) {
  console.error('vault win odds test failed:', error);
  process.exitCode = 1;
} finally {
  cleanup();
}
