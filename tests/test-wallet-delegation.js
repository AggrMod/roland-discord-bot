const assert = require('assert');
const db = require('../database/db');
const walletService = require('../services/walletService');

function run() {
  const discordId = `delegation-disabled-test-${Date.now()}`;
  const suffix = String(Date.now());
  const username = 'delegation-disabled-user';
  const guildId = 'guild-delegation-disabled';
  const delegateWallet = `DelegateWallet-${suffix}`;
  const coldWallet = `ColdWallet-${suffix}`;

  db.prepare('DELETE FROM wallet_delegations WHERE discord_id = ?').run(discordId);
  db.prepare('DELETE FROM wallets WHERE discord_id = ?').run(discordId);
  db.prepare('DELETE FROM users WHERE discord_id = ?').run(discordId);

  const link = walletService.linkWallet(discordId, username, delegateWallet, guildId);
  assert.strictEqual(link.success, true, 'direct wallet should link');

  const addAttempt = walletService.addDelegatedWallet({
    discordId,
    guildId,
    delegateWalletAddress: delegateWallet,
    coldWalletAddress: coldWallet,
  });
  assert.strictEqual(addAttempt.success, false, 'delegation creation must be disabled');
  assert.strictEqual(addAttempt.code, 'DELEGATION_DISABLED', 'disabled response should be explicit');

  // Simulate legacy/previously inserted rows and verify they are ignored.
  db.prepare(`
    INSERT INTO wallet_delegations (
      discord_id, guild_id, delegate_wallet_address, cold_wallet_address, status, updated_at
    ) VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
    ON CONFLICT(discord_id, guild_id, cold_wallet_address)
    DO UPDATE SET status = 'active', updated_at = CURRENT_TIMESTAMP
  `).run(discordId, guildId, delegateWallet, coldWallet);

  const delegations = walletService.getDelegatedWallets(discordId, guildId);
  assert.deepStrictEqual(delegations, [], 'delegation reads must be hidden while disabled');

  const effectiveWallets = walletService.getAllUserWallets(discordId, guildId);
  assert.ok(effectiveWallets.includes(delegateWallet), 'direct wallet should remain effective');
  assert.ok(!effectiveWallets.includes(coldWallet), 'legacy delegated cold wallet must not be effective');

  db.prepare('DELETE FROM wallet_delegations WHERE discord_id = ?').run(discordId);
  db.prepare('DELETE FROM wallets WHERE discord_id = ?').run(discordId);
  db.prepare('DELETE FROM users WHERE discord_id = ?').run(discordId);

  console.log('wallet delegation disabled assertions passed');
}

run();
