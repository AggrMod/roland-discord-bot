#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDbPath = path.join(
  os.tmpdir(),
  `guildpilot-vault-ticket-wallet-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
);
process.env.DATABASE_PATH = tempDbPath;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MULTITENANT_ENABLED = process.env.MULTITENANT_ENABLED || 'false';

const db = require('../database/db');
const vaultCommand = require('../commands/vault/vault');
const vaultService = require('../services/vaultService');
const ticketService = require('../services/ticketService');

function cleanup() {
  try { db.close(); } catch (_error) {}
  try { fs.unlinkSync(tempDbPath); } catch (_error) {}
}

async function run() {
  const guildId = 'vault_ticket_wallet_guild';
  const userId = 'vault_ticket_wallet_user';
  const wallet = '8ZXH1ieZH9zHpzSXwLEof9pwY2iZRw4WDkskqzRpKBfM';
  const originalCreate = ticketService.createSystemTicketFromCategory;

  try {
    const configResult = vaultService.saveConfig(guildId, {
      general: { enabled: true },
      ticketing: { createTicketOnWin: true, rewardTicketCategoryId: 42 },
      rewardTable: { rewards: [] },
    });
    assert.strictEqual(configResult.success, true, configResult.message || 'config should save');
    db.prepare('INSERT INTO users (discord_id, username) VALUES (?, ?)').run(userId, 'winner');
    db.prepare('INSERT INTO wallets (discord_id, wallet_address, primary_wallet, is_favorite) VALUES (?, ?, 1, 1)').run(userId, wallet);

    let captured = null;
    ticketService.createSystemTicketFromCategory = async (categoryId, options) => {
      captured = { categoryId, options };
      return { success: true, ticketNumber: 7, channelId: 'ticket-channel' };
    };

    const result = await vaultCommand.maybeCreateRewardTicket(
      guildId,
      { id: userId, username: 'winner' },
      {
        success: true,
        won: true,
        openingId: 123,
        claimId: 456,
        keyTier: 'default',
        season: { season_id: 'default', season_name: 'Default' },
        stats: { available_keys: 0, key_balances: {} },
        reward: {
          code: 'limited',
          name: 'Limited Prize',
          tier: 'rare',
          payload: { payout: 'manual' },
        },
      }
    );

    assert.strictEqual(result.created, true, 'ticket should be created');
    assert.strictEqual(captured.categoryId, 42, 'configured reward ticket category should be used');
    assert.strictEqual(captured.options.templateResponses['Vault Reward ID'], '456', 'ticket should use reward id wording');
    assert.strictEqual(captured.options.templateResponses['Payout Wallet'], wallet, 'ticket should include primary/favorite payout wallet');
    assert.ok(
      captured.options.templateResponses['Payout Wallet Link'].includes(wallet),
      'ticket should include payout wallet explorer link'
    );
    assert.ok(captured.options.intro.includes(`Primary Payout Wallet: ${wallet}`), 'intro should show payout wallet');
    assert.ok(!captured.options.intro.includes('Vault Claim ID'), 'intro should not use claim wording');
  } finally {
    ticketService.createSystemTicketFromCategory = originalCreate;
  }
}

run()
  .then(() => {
    console.log('vault ticket payout wallet assertions passed');
  })
  .catch((error) => {
    console.error('vault ticket payout wallet assertions failed:', error);
    process.exitCode = 1;
  })
  .finally(cleanup);
