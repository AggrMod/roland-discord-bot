#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDbPath = path.join(
  os.tmpdir(),
  `guildpilot-vault-reconcile-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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
  const guildId = '1468176555091034265';
  const seasonId = 'default';
  const discordUserId = 'vault_reconcile_user_1';
  const walletAddress = 'So11111111111111111111111111111111111111112';
  const txSig = `tx-reconcile-${Date.now()}`;

  db.prepare('INSERT OR REPLACE INTO users (discord_id, username, total_nfts, total_tokens, tier, voting_power, created_at, updated_at) VALUES (?, ?, 0, 0, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)')
    .run(discordUserId, 'reconcile-user', 'None');
  db.prepare('INSERT OR REPLACE INTO wallets (discord_id, wallet_address, primary_wallet) VALUES (?, ?, 1)')
    .run(discordUserId, walletAddress);

  const configResult = vaultService.saveConfig(guildId, {
    general: { enabled: true },
    mintRules: {
      keysPerPaidMint: 2,
      keysPerFreeMint: 0,
      pressurePerPaidMint: 0,
      pressurePerFreeMint: 0,
      keyTierGrants: { default: { paid: 2, free: 0 } },
    },
    mintSource: {
      mode: 'custom_webhook',
      countTransfersToPaymentWallet: true,
      paymentWalletAddress: '11111111111111111111111111111111',
      paymentWalletAddresses: ['11111111111111111111111111111111'],
      paymentMinLamports: 1,
    },
  });
  assert.strictEqual(configResult.success, true, 'vault config should save');
  vaultService.ensureDefaultSeason(guildId);
  vaultService.upsertSeason(guildId, { seasonId, seasonName: 'Default', active: true });

  const firstIngest = vaultService.ingestMintEvent({
    guildId,
    seasonId,
    txSignature: txSig,
    walletAddress,
    mintAddress: 'mint_reconcile_1',
    mintType: 'unknown',
    source: 'test',
  });
  assert.strictEqual(firstIngest.success, true, 'first unknown ingest should succeed');
  assert.strictEqual(firstIngest.duplicate, false, 'first ingest should not be duplicate');

  const afterUnknown = vaultService.getBalance(guildId, discordUserId, seasonId);
  assert.strictEqual(Number(afterUnknown.stats.keys_earned || 0), 0, 'unknown mint should not grant keys');

  const upgradedIngest = vaultService.ingestMintEvent({
    guildId,
    seasonId,
    txSignature: txSig,
    walletAddress,
    mintAddress: 'mint_reconcile_1',
    mintType: 'paid',
    source: 'test',
  });
  assert.strictEqual(upgradedIngest.success, true, 'paid upgrade ingest should succeed');
  assert.strictEqual(upgradedIngest.duplicate, false, 'upgrade path should be processed as an update action');
  assert.strictEqual(upgradedIngest.upgraded, true, 'upgrade path should mark upgraded=true');

  const afterUpgrade = vaultService.getBalance(guildId, discordUserId, seasonId);
  assert.strictEqual(Number(afterUpgrade.stats.keys_earned || 0), 2, 'upgrade from unknown->paid should grant keys once');
  assert.strictEqual(Number(afterUpgrade.stats.available_keys || 0), 2, 'available keys should reflect one paid mint grant');

  const replayPaid = vaultService.ingestMintEvent({
    guildId,
    seasonId,
    txSignature: txSig,
    walletAddress,
    mintAddress: 'mint_reconcile_1',
    mintType: 'paid',
    source: 'test',
  });
  assert.strictEqual(replayPaid.success, true, 'paid replay should succeed');
  assert.strictEqual(replayPaid.duplicate, true, 'paid replay should stay duplicate');

  const afterReplay = vaultService.getBalance(guildId, discordUserId, seasonId);
  assert.strictEqual(Number(afterReplay.stats.keys_earned || 0), 2, 'paid replay must not double-grant keys');

  const row = db.prepare('SELECT mint_type, keys_granted FROM vault_mint_events WHERE guild_id = ? AND tx_signature = ? LIMIT 1')
    .get(guildId, txSig);
  assert.strictEqual(String(row?.mint_type || ''), 'paid', 'mint event should be upgraded to paid');
  assert.strictEqual(Number(row?.keys_granted || 0), 2, 'mint event should store paid grant amount');

  console.log('vault mint reconciliation assertions passed');
}

try {
  run();
} catch (error) {
  console.error('vault mint reconciliation test failed:', error);
  process.exitCode = 1;
} finally {
  cleanup();
}
