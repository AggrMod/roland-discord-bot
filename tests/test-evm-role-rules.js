#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet } = require('ethers');

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildpilot-evm-roles-'));
process.env.DATABASE_PATH = path.join(runDir, 'roles.db');
process.env.DB_BACKUP_ENABLED = 'false';
process.env.DB_BACKUP_ON_STARTUP = 'false';

async function main() {
  const db = require('../database/db');
  const roleService = require('../services/roleService');
  const evmService = require('../services/evmService');

  const guildId = 'guild-evm-roles';
  const discordId = 'user-evm-roles';
  const wallet = Wallet.createRandom().address;
  const collection = Wallet.createRandom().address;
  const erc1155Collection = Wallet.createRandom().address;
  const token = Wallet.createRandom().address;

  db.prepare('INSERT INTO users (discord_id, username) VALUES (?, ?)').run(discordId, 'evm-user');
  db.prepare(`
    INSERT INTO wallets (discord_id, chain_family, chain_id, wallet_address, verified, primary_wallet)
    VALUES (?, 'evm', 'eip155:1', ?, 1, 1)
  `).run(discordId, wallet);

  const tokenRule = roleService.addTokenRoleRule({
    guildId,
    chain: 'eip155:4663',
    tokenMint: token,
    tokenSymbol: 'COINY',
    minAmount: 100,
    roleId: 'role-token',
  });
  assert.strictEqual(tokenRule.success, true);
  const storedRule = roleService.getTokenRoleRules(guildId)[0];
  assert.strictEqual(storedRule.chainFamily, 'evm');
  assert.strictEqual(storedRule.chainId, 'eip155:4663');

  db.prepare(`
    INSERT INTO tenant_role_configs (guild_id, tiers_json, traits_json)
    VALUES (?, ?, '[]')
  `).run(guildId, JSON.stringify([
    {
      name: 'Robinhood NFT Holder', chainFamily: 'evm', chainId: 'eip155:4663', collectionId: collection,
      nftStandard: 'erc721', tokenId: null, minNFTs: 1, maxNFTs: 999999, votingPower: 1,
      roleId: 'role-nft', neverRemove: false,
    },
    {
      name: 'ERC1155 Holder', chainFamily: 'evm', chainId: 'eip155:4663', collectionId: erc1155Collection,
      nftStandard: 'erc1155', tokenId: '42', minNFTs: 1, maxNFTs: 999999, votingPower: 1,
      roleId: 'role-1155', neverRemove: false,
    },
  ]));
  db.prepare(`
    INSERT INTO nft_tracked_collections (
      guild_id, chain_family, chain_id, collection_address, collection_name, channel_id, nft_standard
    ) VALUES (?, 'evm', 'eip155:4663', ?, ?, ?, 'erc721')
  `).run(guildId, collection, 'Robinhood Test Collection', 'channel-evm-721');
  db.prepare(`
    INSERT INTO nft_tracked_collections (
      guild_id, chain_family, chain_id, collection_address, collection_name, channel_id, nft_standard, token_id
    ) VALUES (?, 'evm', 'eip155:4663', ?, ?, ?, 'erc1155', '42')
  `).run(guildId, erc1155Collection, 'Robinhood Items', 'channel-evm-1155');

  const roleCache = new Map();
  const guildRoles = new Map([
    ['role-token', makeRole('role-token', 'ETHROLEB')],
    ['role-nft', makeRole('role-nft', 'SOLROLEA')],
    ['role-1155', makeRole('role-1155', 'ERC1155ROLE')],
  ]);
  const added = [];
  const removed = [];
  const member = {
    id: discordId,
    user: { tag: 'evm-user#0001' },
    guild: {
      id: guildId,
      roles: { cache: guildRoles },
      members: { me: { roles: { highest: { position: 100 } } } },
    },
    roles: {
      cache: roleCache,
      add: async role => { added.push(role.id); roleCache.set(role.id, role); },
      remove: async role => { removed.push(role.id); roleCache.delete(role.id); },
    },
  };

  const originalTokenBalance = evmService.getTokenBalance.bind(evmService);
  const originalNftBalance = evmService.getNftBalance.bind(evmService);
  let observed1155 = null;
  evmService.getTokenBalance = async () => ({ formatted: '250' });
  evmService.getNftBalance = async (_address, contract, chainId, options) => {
    if (contract.toLowerCase() === erc1155Collection.toLowerCase()) observed1155 = { chainId, ...options };
    return { balance: '1' };
  };

  const records = roleService.getVerificationWalletRecords(discordId, guildId);
  assert.deepStrictEqual(records.map(record => record.chainId), ['eip155:1']);
  const nftChanges = await roleService.syncEvmCollectionRoles(member, records, guildId, new Set(roleCache.keys()));
  const tokenChanges = await roleService.syncTokenRoles(member, records, guildId, new Set(roleCache.keys()));
  assert(added.includes('role-nft'), 'ERC-721 collection ownership assigns its Discord role');
  assert(added.includes('role-1155'), 'ERC-1155 token ownership assigns its Discord role');
  assert(added.includes('role-token'), 'ERC-20 balance assigns its Discord role');
  assert.ok(added.includes('role-nft') && added.includes('role-token'), 'an EVM wallet linked through Ethereum is evaluated on Robinhood Chain');
  assert.deepStrictEqual(observed1155, { chainId: 'eip155:4663', standard: 'erc1155', tokenId: '42' });
  assert.ok(nftChanges.granted.some(grant => grant.roleName === 'SOLROLEA' && grant.chainName === 'Robinhood Chain' && grant.balance === 1 && grant.assetName === 'Robinhood Test Collection'), 'Robinhood ERC-721 ownership assigns named role evidence');
  assert.ok(nftChanges.granted.some(grant => grant.roleName === 'ERC1155ROLE' && grant.chainName === 'Robinhood Chain' && grant.unit === 'ERC-1155 #42' && grant.assetName === 'Robinhood Items'), 'Robinhood ERC-1155 ownership assigns named token evidence');
  assert.ok(tokenChanges.granted.some(grant => grant.roleName === 'ETHROLEB' && grant.balance === 250), 'ERC-20 role includes balance evidence');

  evmService.getTokenBalance = async () => ({ formatted: '5' });
  await roleService.syncTokenRoles(member, records, guildId, new Set(roleCache.keys()));
  assert(removed.includes('role-token'), 'falling below the ERC-20 threshold removes the role');

  roleCache.set('role-token', guildRoles.get('role-token'));
  const removalsBeforeFailure = removed.length;
  evmService.getTokenBalance = async () => { throw new Error('RPC unavailable'); };
  const failedSync = await roleService.syncTokenRoles(member, records, guildId, new Set(roleCache.keys()));
  assert.strictEqual(removed.length, removalsBeforeFailure, 'RPC failure never removes a role');
  assert.strictEqual(roleCache.has('role-token'), true, 'existing role is preserved during RPC failure');
  assert.strictEqual(failedSync.incomplete, true, 'RPC failure is surfaced as an incomplete verification result');

  evmService.getTokenBalance = originalTokenBalance;
  evmService.getNftBalance = originalNftBalance;
  db.close();
  fs.rmSync(runDir, { recursive: true, force: true });
  console.log('EVM role rule checks passed.');
}

function makeRole(id, name) {
  return { id, name, position: 1, managed: false, permissions: { has: () => false } };
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
