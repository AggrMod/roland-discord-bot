const assert = require('assert');
const db = require('../database/db');
const walletService = require('../services/walletService');

function run() {
  const discordId = `delegation-test-${Date.now()}`;
  const suffix = String(Date.now());
  const username = 'delegation-user';
  const guildA = 'guild-delegation-a';
  const guildB = 'guild-delegation-b';
  const delegateWallet = `DelegateWallet-${suffix}`;
  const coldWallet = `ColdWallet-${suffix}`;
  const expiredColdWallet = `ColdWalletExpired-${suffix}`;

  db.prepare('DELETE FROM wallet_delegations WHERE discord_id = ?').run(discordId);
  db.prepare('DELETE FROM wallets WHERE discord_id = ?').run(discordId);
  db.prepare('DELETE FROM users WHERE discord_id = ?').run(discordId);

  const link = walletService.linkWallet(discordId, username, delegateWallet, guildA);
  assert.strictEqual(link.success, true, 'delegate wallet should link');

  const addActive = walletService.addDelegatedWallet({
    discordId,
    guildId: guildA,
    delegateWalletAddress: delegateWallet,
    coldWalletAddress: coldWallet,
  });
  assert.strictEqual(addActive.success, true, 'active delegation should be added');

  const addExpired = walletService.addDelegatedWallet({
    discordId,
    guildId: guildA,
    delegateWalletAddress: delegateWallet,
    coldWalletAddress: expiredColdWallet,
    expiresAt: '2000-01-01T00:00:00.000Z',
  });
  assert.strictEqual(addExpired.success, true, 'expired delegation row can be stored');

  const guildAWallets = walletService.getAllUserWallets(discordId, guildA);
  assert.ok(guildAWallets.includes(delegateWallet), 'direct wallet should be present');
  assert.ok(guildAWallets.includes(coldWallet.toLowerCase()), 'active delegated cold wallet should be present');
  assert.ok(!guildAWallets.includes(expiredColdWallet.toLowerCase()), 'expired delegated wallet should not be present');

  const guildBWallets = walletService.getAllUserWallets(discordId, guildB);
  assert.ok(!guildBWallets.includes(coldWallet.toLowerCase()), 'guild-scoped delegation should not resolve outside its guild');

  const revoke = walletService.revokeDelegatedWallet(discordId, coldWallet, guildA);
  assert.strictEqual(revoke.success, true, 'delegation revoke should succeed');

  const afterRevokeWallets = walletService.getAllUserWallets(discordId, guildA);
  assert.ok(!afterRevokeWallets.includes(coldWallet.toLowerCase()), 'revoked delegated wallet should be removed from effective wallet list');

  db.prepare('DELETE FROM wallet_delegations WHERE discord_id = ?').run(discordId);
  db.prepare('DELETE FROM wallets WHERE discord_id = ?').run(discordId);
  db.prepare('DELETE FROM users WHERE discord_id = ?').run(discordId);

  console.log('wallet delegation assertions passed');
}

run();
