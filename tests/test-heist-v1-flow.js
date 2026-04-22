#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDbPath = path.join(
  os.tmpdir(),
  `guildpilot-heist-v1-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
);
process.env.DATABASE_PATH = tempDbPath;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MULTITENANT_ENABLED = process.env.MULTITENANT_ENABLED || 'false';

const db = require('../database/db');
const heistService = require('../services/heistService');
const nftService = require('../services/nftService');

function ensureUserWithWallet(userId, username, wallet) {
  db.prepare('INSERT OR IGNORE INTO users (discord_id, username) VALUES (?, ?)').run(userId, username);
  db.prepare('INSERT OR REPLACE INTO wallets (discord_id, wallet_address, primary_wallet) VALUES (?, ?, ?)').run(userId, wallet, 1);
}

async function run() {
  const guildId = '1468176555091034265';
  const user1 = { id: 'heist_user_1', name: 'Heist User One', wallet: 'wallet_u1' };
  const user2 = { id: 'heist_user_2', name: 'Heist User Two', wallet: 'wallet_u2' };

  ensureUserWithWallet(user1.id, user1.name, user1.wallet);
  ensureUserWithWallet(user2.id, user2.name, user2.wallet);
  heistService.ensureGuildScaffold(guildId);

  const nftInventory = new Map();
  const originalGetNFTsForWallet = nftService.getNFTsForWallet.bind(nftService);
  nftService.getNFTsForWallet = async (walletAddress) => {
    const rows = nftInventory.get(String(walletAddress || '').trim()) || [];
    return rows.map((entry) => ({ ...entry, attributes: Array.isArray(entry.attributes) ? [...entry.attributes] : [] }));
  };

  try {
    nftInventory.set(user1.wallet, [
      { mint: 'MINT_A', name: 'The Driver', attributes: [{ trait_type: 'Role', value: 'Driver' }] },
    ]);
    nftInventory.set(user2.wallet, [
      { mint: 'MINT_C', name: 'The Enforcer', attributes: [{ trait_type: 'Role', value: 'Enforcer' }] },
    ]);

    const soloTemplate = heistService.createTemplate(guildId, {
      name: 'Solo Smoke Mission',
      description: 'Simple solo mission for smoke validation',
      mode: 'solo',
      required_slots: 1,
      total_slots: 1,
      max_nfts_per_user: 1,
      duration_minutes: 60,
      base_xp_reward: 100,
      base_streetcredit_reward: 50,
      spawn_weight: 1,
    });
    assert.strictEqual(soloTemplate.success, true, 'solo template should be created');

    const soloTemplateRow = heistService
      .listTemplates(guildId, { includeDisabled: true })
      .find((entry) => entry.name === 'Solo Smoke Mission');
    assert.ok(soloTemplateRow, 'solo template should exist');

    const soloSpawn = heistService.spawnMissionNow(guildId, Number(soloTemplateRow.id), { spawnSource: 'test' });
    assert.strictEqual(soloSpawn.success, true, 'solo mission should spawn');
    assert.ok(soloSpawn.missionId, 'solo mission id should exist');

    const soloJoin = await heistService.joinMission({
      guildId,
      missionId: soloSpawn.missionId,
      userId: user1.id,
      username: user1.name,
      selectedMints: ['MINT_A'],
    });
    assert.strictEqual(soloJoin.success, true, 'user should join solo mission');

    const duplicateSoloJoin = await heistService.joinMission({
      guildId,
      missionId: soloSpawn.missionId,
      userId: user1.id,
      username: user1.name,
      selectedMints: ['MINT_A'],
    });
    assert.strictEqual(duplicateSoloJoin.success, false, 'duplicate join with same lock should fail');

    const soloResolve = await heistService.resolveMission(guildId, soloSpawn.missionId);
    assert.strictEqual(soloResolve.success, true, 'solo mission should resolve');
    assert.strictEqual(soloResolve.status, 'completed', 'solo mission should complete');

    const profileAfterSolo = heistService.getProfile(guildId, user1.id, user1.name);
    assert.strictEqual(Number(profileAfterSolo.total_xp), 100, 'solo mission should award xp');
    assert.strictEqual(Number(profileAfterSolo.total_streetcredit), 50, 'solo mission should award streetcredit');

    const createVaultItem = heistService.createVaultItem(guildId, {
      name: 'Vault Reward Crate',
      description: 'Manual fulfillment item',
      cost_streetcredit: 30,
      required_vault_tier: 0,
      reward_type: 'manual',
      fulfillment_mode: 'manual',
      quantity_remaining: 1,
      enabled: true,
    });
    assert.strictEqual(createVaultItem.success, true, 'vault item should be created');

    const vaultItem = heistService
      .listVaultItems(guildId, { includeDisabled: true })
      .find((entry) => entry.name === 'Vault Reward Crate');
    assert.ok(vaultItem, 'vault item should exist');

    const redeemOne = await heistService.redeemVaultItem(guildId, user1.id, user1.name, vaultItem.id);
    assert.strictEqual(redeemOne.success, true, 'first redemption should succeed');
    assert.ok(redeemOne.redemption?.id, 'redemption row should be created');

    const profileAfterRedeem = heistService.getProfile(guildId, user1.id, user1.name);
    assert.strictEqual(Number(profileAfterRedeem.total_streetcredit), 20, 'redemption should deduct streetcredit once');

    const redeemTwo = await heistService.redeemVaultItem(guildId, user1.id, user1.name, vaultItem.id);
    assert.strictEqual(redeemTwo.success, false, 'second redemption should fail when item is out of stock');

    const profileAfterFailedRedeem = heistService.getProfile(guildId, user1.id, user1.name);
    assert.strictEqual(
      Number(profileAfterFailedRedeem.total_streetcredit),
      20,
      'failed redemption must not deduct streetcredit'
    );

    const updateRedemption = heistService.updateVaultRedemptionStatus(
      guildId,
      redeemOne.redemption.id,
      { fulfillment_status: 'completed', note: 'fulfilled in smoke test' },
      'heist_admin'
    );
    assert.strictEqual(updateRedemption.success, true, 'redemption status should be updateable');
    const updatedRedemption = db
      .prepare('SELECT fulfillment_status, metadata_json FROM heist_vault_redemptions WHERE id = ?')
      .get(Number(redeemOne.redemption.id));
    assert.strictEqual(updatedRedemption.fulfillment_status, 'completed', 'redemption status must be completed');
    assert.ok(
      String(updatedRedemption.metadata_json || '').includes('fulfilled in smoke test'),
      'redemption metadata should include note'
    );

    const coopTemplate = heistService.createTemplate(guildId, {
      name: 'Coop Ownership Mission',
      description: 'One slot should fail if NFT ownership changes',
      mode: 'coop',
      required_slots: 2,
      total_slots: 2,
      max_nfts_per_user: 1,
      duration_minutes: 60,
      base_xp_reward: 80,
      base_streetcredit_reward: 40,
      spawn_weight: 1,
    });
    assert.strictEqual(coopTemplate.success, true, 'coop template should be created');

    const coopTemplateRow = heistService
      .listTemplates(guildId, { includeDisabled: true })
      .find((entry) => entry.name === 'Coop Ownership Mission');
    assert.ok(coopTemplateRow, 'coop template should exist');

    nftInventory.set(user1.wallet, [
      { mint: 'MINT_B', name: 'The Accountant', attributes: [{ trait_type: 'Role', value: 'Accountant' }] },
    ]);
    nftInventory.set(user2.wallet, [
      { mint: 'MINT_C', name: 'The Enforcer', attributes: [{ trait_type: 'Role', value: 'Enforcer' }] },
    ]);

    const coopSpawn = heistService.spawnMissionNow(guildId, Number(coopTemplateRow.id), { spawnSource: 'test' });
    assert.strictEqual(coopSpawn.success, true, 'coop mission should spawn');

    const coopJoinU1 = await heistService.joinMission({
      guildId,
      missionId: coopSpawn.missionId,
      userId: user1.id,
      username: user1.name,
      selectedMints: ['MINT_B'],
    });
    assert.strictEqual(coopJoinU1.success, true, 'user1 should join coop mission');

    const coopJoinU2 = await heistService.joinMission({
      guildId,
      missionId: coopSpawn.missionId,
      userId: user2.id,
      username: user2.name,
      selectedMints: ['MINT_C'],
    });
    assert.strictEqual(coopJoinU2.success, true, 'user2 should join coop mission');

    nftInventory.set(user2.wallet, []);
    const coopResolve = await heistService.resolveMission(guildId, coopSpawn.missionId);
    assert.strictEqual(coopResolve.success, true, 'coop mission should resolve');
    assert.strictEqual(coopResolve.status, 'completed', 'coop mission should still complete with partial success');
    assert.strictEqual(
      coopResolve.outcomes.some((entry) => entry.success === false && entry.failureReason === 'nft_no_longer_owned'),
      true,
      'one slot should fail due to ownership change'
    );
    assert.strictEqual(
      coopResolve.outcomes.some((entry) => entry.success === true),
      true,
      'at least one slot should succeed'
    );

    const profileAfterCoopUser1 = heistService.getProfile(guildId, user1.id, user1.name);
    const profileAfterCoopUser2 = heistService.getProfile(guildId, user2.id, user2.name);
    assert.strictEqual(Number(profileAfterCoopUser1.total_xp), 140, 'user1 should receive coop xp split reward');
    assert.strictEqual(Number(profileAfterCoopUser1.total_streetcredit), 40, 'user1 should receive coop streetcredit split reward');
    assert.strictEqual(Number(profileAfterCoopUser2.total_xp), 0, 'user2 should not receive rewards when slot fails');
    assert.strictEqual(Number(profileAfterCoopUser2.missions_failed), 1, 'user2 failed mission count should increment');

    const remainingLocks = db
      .prepare('SELECT COUNT(*) AS count FROM heist_locked_nfts WHERE guild_id = ?')
      .get(guildId);
    assert.strictEqual(Number(remainingLocks.count || 0), 0, 'all locks should be released after resolution');

    console.log('Heist v1 flow assertions passed');
  } finally {
    nftService.getNFTsForWallet = originalGetNFTsForWallet;
    try {
      db.close();
    } catch (_error) {
      // Ignore close errors in test teardown.
    }
    try {
      fs.unlinkSync(tempDbPath);
    } catch (_error) {
      // Ignore temp cleanup errors.
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
