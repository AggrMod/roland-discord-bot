#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDbPath = path.join(
  os.tmpdir(),
  `guildpilot-vault-onchain-payment-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

async function run() {
  const guildId = 'vault_onchain_payment_guild';
  const seasonId = 'default';
  const discordUserId = 'vault_onchain_payment_user';
  const payerWallet = 'So11111111111111111111111111111111111111112';
  const paymentWallet = '11111111111111111111111111111111';
  const txSignature = `vault-onchain-payment-${Date.now()}`;
  const rejectedTxSignature = `vault-onchain-payment-rejected-${Date.now()}`;

  db.prepare(`
    INSERT OR REPLACE INTO users (discord_id, username, total_nfts, total_tokens, tier, voting_power, created_at, updated_at)
    VALUES (?, ?, 0, 0, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(discordUserId, 'vault-onchain-payment-user', 'None');
  db.prepare('INSERT OR REPLACE INTO wallets (discord_id, wallet_address, primary_wallet) VALUES (?, ?, 1)')
    .run(discordUserId, payerWallet);

  const configResult = vaultService.saveConfig(guildId, {
    general: { enabled: true },
    mintRules: {
      keysPerPaidMint: 2,
      keysPerFreeMint: 0,
      pressurePerPaidMint: 1,
      pressurePerFreeMint: 0,
      keyTierGrants: { default: { paid: 2, free: 0 } },
    },
    mintSource: {
      mode: 'custom_webhook',
      countTransfersToPaymentWallet: true,
      paymentWalletAddress: paymentWallet,
      paymentWalletAddresses: [paymentWallet],
      paymentMinLamports: 1000,
    },
  });
  assert.strictEqual(configResult.success, true, 'vault config should save');
  vaultService.ensureDefaultSeason(guildId);

  vaultService.getRpcConnection = () => ({
    getParsedTransaction: async (signature) => {
      assert(
        signature === txSignature || signature === rejectedTxSignature,
        'should request the supplied tx signature'
      );
      return {
        meta: { err: null, innerInstructions: [] },
        transaction: {
          message: {
            instructions: [
              {
                program: 'system',
                parsed: {
                  type: 'transfer',
                  info: {
                    source: payerWallet,
                    destination: paymentWallet,
                    lamports: 5000,
                  },
                },
              },
            ],
          },
        },
      };
    },
  });

  const rejected = await vaultService.verifyPaymentTransaction(guildId, rejectedTxSignature, {
    seasonId,
    expectedDiscordUserId: 'different_discord_user',
  });
  assert.strictEqual(rejected.success, false, 'wrong Discord user should not be able to claim a payment');
  assert.strictEqual(
    rejected.message,
    'Payment sender wallet is not linked to your Discord account',
    'rejection should explain ownership mismatch'
  );
  const afterRejected = vaultService.getBalance(guildId, discordUserId, seasonId);
  assert.strictEqual(Number(afterRejected.stats.keys_earned || 0), 0, 'rejected claim must not grant keys');

  const first = await vaultService.verifyPaymentTransaction(guildId, txSignature, { seasonId });
  assert.strictEqual(first.success, true, 'verified payment should succeed');
  assert.strictEqual(first.verifiedOnChain, true, 'result should mark on-chain verification');
  assert.strictEqual(first.duplicate, false, 'first payment should not be duplicate');
  assert.strictEqual(first.linkedUserId, discordUserId, 'payer wallet should map to linked Discord user');
  assert.strictEqual(Number(first.grants.keys_granted || 0), 2, 'paid payment should grant configured keys');

  const afterFirst = vaultService.getBalance(guildId, discordUserId, seasonId);
  assert.strictEqual(Number(afterFirst.stats.keys_earned || 0), 2, 'keys should be added once');

  const replay = await vaultService.verifyPaymentTransaction(guildId, txSignature, { seasonId });
  assert.strictEqual(replay.success, true, 'replay should still return success');
  assert.strictEqual(replay.duplicate, true, 'replay should be detected as duplicate');

  const afterReplay = vaultService.getBalance(guildId, discordUserId, seasonId);
  assert.strictEqual(Number(afterReplay.stats.keys_earned || 0), 2, 'duplicate replay must not double-grant keys');

  const otherGuildId = 'vault_onchain_payment_other_guild';
  const otherConfig = vaultService.saveConfig(otherGuildId, {
    general: { enabled: true },
    mintRules: {
      keysPerPaidMint: 2,
      keysPerFreeMint: 0,
      keyTierGrants: { default: { paid: 2, free: 0 } },
    },
    mintSource: {
      mode: 'custom_webhook',
      countTransfersToPaymentWallet: true,
      paymentWalletAddress: paymentWallet,
      paymentWalletAddresses: [paymentWallet],
      paymentMinLamports: 1000,
    },
  });
  assert.strictEqual(otherConfig.success, true, 'second guild config should save');
  vaultService.ensureDefaultSeason(otherGuildId);
  const crossGuildReplay = await vaultService.verifyPaymentTransaction(otherGuildId, txSignature, { seasonId });
  assert.strictEqual(crossGuildReplay.success, true, 'cross-guild replay should be safely ignored');
  assert.strictEqual(crossGuildReplay.duplicate, true, 'cross-guild replay should be treated as duplicate');
  const crossRows = db.prepare('SELECT COUNT(*) AS cnt FROM vault_mint_events WHERE tx_signature = ?').get(txSignature);
  assert.strictEqual(Number(crossRows?.cnt || 0), 1, 'transaction signature should only exist once globally');
  const rejectedRows = db.prepare('SELECT COUNT(*) AS cnt FROM vault_mint_events WHERE tx_signature = ?').get(rejectedTxSignature);
  assert.strictEqual(Number(rejectedRows?.cnt || 0), 0, 'rejected transaction should not be stored');

  console.log('vault on-chain payment verification assertions passed');
}

run().catch((error) => {
  console.error('vault on-chain payment verification test failed:', error);
  process.exitCode = 1;
}).finally(cleanup);
