#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDbPath = path.join(
  os.tmpdir(),
  `guildpilot-vault-tiers-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function run() {
  const guildId = 'vault_tier_test_guild';
  const seasonId = 'default';
  const userId = 'vault_tier_test_user';

  const invalidParent = vaultService.saveConfig(guildId, {
    keyTiers: [
      { id: 'default', name: 'Default', enabled: true, inheritsFrom: null },
      { id: 'silver', name: 'Silver', enabled: true, inheritsFrom: 'ghost' },
    ],
  });
  assert.strictEqual(invalidParent.success, false, 'unknown inheritance parent should fail');

  const invalidCycle = vaultService.saveConfig(guildId, {
    keyTiers: [
      { id: 'default', name: 'Default', enabled: true, inheritsFrom: null },
      { id: 'bronze', name: 'Bronze', enabled: true, inheritsFrom: 'gold' },
      { id: 'silver', name: 'Silver', enabled: true, inheritsFrom: 'bronze' },
      { id: 'gold', name: 'Gold', enabled: true, inheritsFrom: 'silver' },
    ],
  });
  assert.strictEqual(invalidCycle.success, false, 'inheritance cycle should fail');

  const validConfig = vaultService.saveConfig(guildId, {
    general: { enabled: true },
    security: { openCooldownSeconds: 60, upgradeCooldownSeconds: 0, upgradeDailyCapPerUser: 0 },
    keyTiers: [
      { id: 'default', name: 'Default', enabled: true, inheritsFrom: null },
      { id: 'bronze', name: 'Bronze', enabled: true, inheritsFrom: null },
      { id: 'silver', name: 'Silver', enabled: true, inheritsFrom: 'bronze' },
      { id: 'gold', name: 'Gold', enabled: true, inheritsFrom: 'silver' },
    ],
    minting: {
      mode: 'custom_webhook',
      countTransfersToPaymentWallet: true,
      paymentWallets: ['11111111111111111111111111111111'],
      minLamports: 1,
      grantsPerMint: {
        bronze: { paid: 1, free: 0, pressure: 0 },
        silver: { paid: 1, free: 0, pressure: 0 },
        gold: { paid: 1, free: 0, pressure: 0 },
      },
      paymentBands: [
        { keyTier: 'bronze', minLamports: 1, maxLamports: 499999999, paid: 1, free: 0 },
        { keyTier: 'gold', minLamports: 500000000, maxLamports: null, paid: 1, free: 0 },
      ],
    },
    rewardTable: {
      version: 'default',
      rewards: [
        { code: 'nothing', name: 'Nothing', tier: 'common', weight: 0, enabled: true, type: 'no_reward' },
        { code: 'bronze_reward', name: 'Bronze Reward', tier: 'common', weight: 1, keyTier: 'bronze', enabled: true, quantity: null, type: 'none' },
        { code: 'silver_reward', name: 'Silver Reward', tier: 'rare', weight: 1, keyTier: 'silver', enabled: true, quantity: null, type: 'none' },
        { code: 'gold_reward', name: 'Gold Reward', tier: 'epic', weight: 1, keyTier: 'gold', enabled: true, quantity: null, type: 'none' },
      ],
    },
  });
  assert.strictEqual(validConfig.success, true, 'valid tier config should save');
  vaultService.ensureDefaultSeason(guildId);

  const grants = vaultService.computeMintGrants(vaultService.getConfig(guildId), 'paid');
  assert.strictEqual(grants.keys_granted, 4, 'total keys granted should aggregate tier grants');
  assert.strictEqual(grants.key_tier_grants.default, 1, 'default grant should remain available');
  assert.strictEqual(grants.key_tier_grants.bronze, 1, 'bronze grant should be present');
  assert.strictEqual(grants.key_tier_grants.gold, 1, 'gold grant should be present');

  vaultService.applyMintGrantsToUser(guildId, seasonId, userId, 'wallet_1', grants);

  const balance = vaultService.getBalance(guildId, userId, seasonId);
  assert.strictEqual(balance.success, true, 'balance should load');
  assert.strictEqual(balance.stats.key_balances.bronze, 1, 'bronze balance should increment');
  assert.strictEqual(balance.stats.key_balances.silver, 1, 'silver balance should increment');
  assert.strictEqual(balance.stats.key_balances.gold, 1, 'gold balance should increment');

  const keyOverview = vaultService.listUserKeyOverview(guildId, seasonId, 20);
  assert.ok(Array.isArray(keyOverview) && keyOverview.length >= 1, 'overview should include user rows');
  const me = keyOverview.find(row => String(row.discord_user_id) === userId);
  assert.ok(me, 'overview should include the test user');
  assert.strictEqual(Number(me.available_keys_total), 4, 'overview total should match tier balances');

  const openWithGold = vaultService.openVault(guildId, userId, { keyTier: 'gold' });
  assert.strictEqual(openWithGold.success, true, 'gold key should open');
  assert.ok(['gold_reward', 'silver_reward', 'bronze_reward'].includes(String(openWithGold.reward?.code || '')), 'gold tier should inherit silver/bronze rewards');
  const cooldownHit = vaultService.openVault(guildId, userId, { keyTier: 'bronze' });
  assert.strictEqual(cooldownHit.success, false, 'second open should respect cooldown');
  assert.strictEqual(cooldownHit.code, 'cooldown_active', 'cooldown error code should be set');

  const afterOpen = vaultService.getBalance(guildId, userId, seasonId);
  assert.strictEqual(afterOpen.stats.key_balances.gold, 0, 'gold key should be consumed');

  const grantsFromBands = vaultService.computeMintGrants(vaultService.getConfig(guildId), 'paid', { transferLamports: 700000000 });
  assert.strictEqual(Number(grantsFromBands.key_tier_grants.gold || 0), 1, 'high lamports should map to gold band');
}

try {
  run();
  console.log('vault key tiers test passed');
} catch (error) {
  console.error('vault key tiers test failed:', error);
  process.exitCode = 1;
} finally {
  cleanup();
}
