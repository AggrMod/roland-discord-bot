#!/usr/bin/env node

const assert = require('assert');
const { Keypair } = require('@solana/web3.js');
const db = require('../database/db');
const trackedWalletsService = require('../services/trackedWalletsService');

async function run() {
  const suffix = String(Date.now());
  const guildId = `guild-wallet-race-${suffix}`;
  const walletCount = 60;

  db.prepare('DELETE FROM tracked_tokens WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM tracked_wallets WHERE guild_id = ?').run(guildId);

  const originalSyncWalletAddressToHeliusWebhook = trackedWalletsService.syncWalletAddressToHeliusWebhook.bind(trackedWalletsService);
  const originalIsTokenTrackerEnabled = trackedWalletsService.isTokenTrackerEnabled.bind(trackedWalletsService);
  const originalProcessTrackedWalletTokenActivity = trackedWalletsService.processTrackedWalletTokenActivity.bind(trackedWalletsService);

  trackedWalletsService.syncWalletAddressToHeliusWebhook = async () => ({ success: true, skipped: true });
  trackedWalletsService.isTokenTrackerEnabled = () => true;

  const tokenAdded = trackedWalletsService.addTrackedToken({
    guildId,
    tokenMint: Keypair.generate().publicKey.toBase58(),
    tokenSymbol: 'RACE',
    enabled: true,
  });
  assert.strictEqual(tokenAdded.success, true, 'tracked token should be added for polling context');

  const walletAddresses = [];
  for (let i = 0; i < walletCount; i += 1) {
    walletAddresses.push(Keypair.generate().publicKey.toBase58());
  }

  for (const walletAddress of walletAddresses) {
    const added = trackedWalletsService.addTrackedWallet({
      guildId,
      walletAddress,
      label: `wallet-${walletAddress.slice(0, 6)}`,
    });
    assert.strictEqual(added.success, true, `wallet ${walletAddress} should be added`);
  }

  const duplicate = trackedWalletsService.addTrackedWallet({
    guildId,
    walletAddress: walletAddresses[0],
    label: 'duplicate',
  });
  assert.strictEqual(duplicate.success, false, 'duplicate tracked wallet add should be rejected');

  const list = trackedWalletsService.getTrackedWallets(guildId);
  assert.strictEqual(list.length, walletCount, 'all wallets should be retrievable for large set rendering');

  let removedDuringPoll = 0;
  trackedWalletsService.processTrackedWalletTokenActivity = async (walletRow) => {
    if (!walletRow?.id) return;
    if (removedDuringPoll === 0) {
      const removed = trackedWalletsService.removeTrackedWallet(walletRow.id, guildId);
      assert.strictEqual(removed.success, true, 'wallet removal during polling should succeed');
      removedDuringPoll += 1;
      return;
    }
  };

  await trackedWalletsService.pollTrackedTokenActivity(guildId);
  assert.strictEqual(removedDuringPoll, 1, 'poll should process and tolerate wallet removal race');

  const after = trackedWalletsService.getTrackedWallets(guildId);
  assert.strictEqual(after.length, walletCount - 1, 'one wallet should be removed after race scenario');

  console.log('wallet tracker race + scale assertions passed');

  trackedWalletsService.syncWalletAddressToHeliusWebhook = originalSyncWalletAddressToHeliusWebhook;
  trackedWalletsService.isTokenTrackerEnabled = originalIsTokenTrackerEnabled;
  trackedWalletsService.processTrackedWalletTokenActivity = originalProcessTrackedWalletTokenActivity;
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

