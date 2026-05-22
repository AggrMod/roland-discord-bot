#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDbPath = path.join(
  os.tmpdir(),
  `guildpilot-heist-trait-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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
  const guildId = `1468${Date.now()}`.slice(0, 19);
  const user = { id: 'heist_trait_user', name: 'Trait User', wallet: 'trait_wallet_u1' };
  ensureUserWithWallet(user.id, user.name, user.wallet);
  heistService.ensureGuildScaffold(guildId);

  const nftInventory = new Map();
  const originalGetNFTsForWallet = nftService.getNFTsForWallet.bind(nftService);
  nftService.getNFTsForWallet = async (walletAddress) => {
    const rows = nftInventory.get(String(walletAddress || '').trim()) || [];
    return rows.map((entry) => ({ ...entry, attributes: Array.isArray(entry.attributes) ? [...entry.attributes] : [] }));
  };

  try {
    nftInventory.set(user.wallet, [
      {
        mint: 'MINT_TRAIT_A',
        name: 'Trait Driver',
        collection: 'REGULAR_COLL',
        attributes: [{ trait_type: 'Role', value: 'Driver' }],
      },
    ]);

    const andTemplate = heistService.createTemplate(guildId, {
      name: 'Trait AND Gate Mission',
      description: 'Requires both trait and collection',
      mode: 'solo',
      required_slots: 1,
      total_slots: 1,
      max_nfts_per_user: 1,
      duration_minutes: 30,
      base_xp_reward: 100,
      base_streetcredit_reward: 50,
      spawn_weight: 1,
      trait_requirements: {
        gateMode: 'and',
        requiredCollections: ['VIP_COLL'],
        requiredTraits: [{ traitType: 'Role', values: ['Driver'] }],
      },
    });
    assert.strictEqual(andTemplate.success, true, `AND-gated template should be created (${JSON.stringify(andTemplate)})`);

    const andTemplateRow = heistService
      .listTemplates(guildId, { includeDisabled: true })
      .find((entry) => entry.name === 'Trait AND Gate Mission');
    assert.ok(andTemplateRow, 'AND-gated template should exist');

    const andSpawn = heistService.spawnMissionNow(guildId, Number(andTemplateRow.id), { spawnSource: 'test' });
    assert.strictEqual(andSpawn.success, true, 'AND-gated mission should spawn');

    const andJoin = await heistService.joinMission({
      guildId,
      missionId: andSpawn.missionId,
      userId: user.id,
      username: user.name,
      selectedMints: ['MINT_TRAIT_A'],
    });
    assert.strictEqual(andJoin.success, false, 'AND gate should reject NFT missing required collection');

    const orTemplate = heistService.createTemplate(guildId, {
      name: 'Trait OR Gate Mission',
      description: 'Allows trait OR collection',
      mode: 'solo',
      required_slots: 1,
      total_slots: 1,
      max_nfts_per_user: 1,
      duration_minutes: 30,
      base_xp_reward: 100,
      base_streetcredit_reward: 50,
      spawn_weight: 1,
      trait_requirements: {
        gateMode: 'or',
        requiredCollections: ['VIP_COLL'],
        requiredTraits: [{ traitType: 'Role', values: ['Driver'] }],
      },
    });
    assert.strictEqual(orTemplate.success, true, 'OR-gated template should be created');

    const orTemplateRow = heistService
      .listTemplates(guildId, { includeDisabled: true })
      .find((entry) => entry.name === 'Trait OR Gate Mission');
    assert.ok(orTemplateRow, 'OR-gated template should exist');

    const bonusRule = heistService.upsertTraitBonusRule(guildId, {
      trait_type: 'Role',
      trait_value: 'Driver',
      template_id: Number(orTemplateRow.id),
      mission_type: 'nft',
      target_metric: 'xp',
      multiplier: 2,
      flat_bonus: 10,
      max_bonus: null,
      enabled: 1,
    });
    assert.strictEqual(bonusRule.success, true, 'trait bonus rule should be created');
    const scopedRules = heistService.listTraitBonusRules(guildId, { templateId: Number(orTemplateRow.id) });
    assert.ok(scopedRules.some((entry) => String(entry.target_metric) === 'xp'), 'xp trait bonus rule should be listed for template');

    const orSpawn = heistService.spawnMissionNow(guildId, Number(orTemplateRow.id), { spawnSource: 'test' });
    assert.strictEqual(orSpawn.success, true, 'OR-gated mission should spawn');

    const orJoin = await heistService.joinMission({
      guildId,
      missionId: orSpawn.missionId,
      userId: user.id,
      username: user.name,
      selectedMints: ['MINT_TRAIT_A'],
    });
    assert.strictEqual(orJoin.success, true, 'OR gate should allow trait-matching NFT');

    const resolved = await heistService.resolveMission(guildId, orSpawn.missionId);
    assert.strictEqual(resolved.success, true, 'OR mission should resolve');
    assert.strictEqual(resolved.status, 'completed', 'OR mission should complete');
    assert.ok(Array.isArray(resolved.outcomes) && resolved.outcomes.length > 0, 'resolved outcomes should exist');
    assert.ok(Array.isArray(resolved.outcomes[0].traits), 'resolved outcome should include trait snapshot');
    assert.strictEqual(Number(resolved.outcomes[0].payoutXp || 0), 210, `trait bonus rule should apply multiplier+flat bonus to XP (${JSON.stringify(resolved.outcomes[0])})`);
    assert.strictEqual(Number(resolved.outcomes[0].payoutStreetcredit || 0), 50, 'streetcredit should remain base when no street bonus rule');

    const profile = heistService.getProfile(guildId, user.id, user.name);
    assert.strictEqual(Number(profile.total_xp || 0), 210, 'profile XP should include trait bonus payout');
    assert.strictEqual(Number(profile.total_streetcredit || 0), 50, 'profile streetcredit should match base payout');

    console.log('heist trait gates + trait bonus assertions passed');
  } finally {
    nftService.getNFTsForWallet = originalGetNFTsForWallet;
    try {
      db.close();
    } catch (_error) {}
    try {
      fs.unlinkSync(tempDbPath);
    } catch (_error) {}
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
