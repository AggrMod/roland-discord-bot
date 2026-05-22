#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDbPath = path.join(
  os.tmpdir(),
  `guildpilot-verify-soak-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
);
process.env.DATABASE_PATH = tempDbPath;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MULTITENANT_ENABLED = process.env.MULTITENANT_ENABLED || 'true';

const db = require('../database/db');
const roleService = require('../services/roleService');
const nftService = require('../services/nftService');
const tokenService = require('../services/tokenService');

function cleanup() {
  try { db.close(); } catch (_error) {}
  try { fs.unlinkSync(tempDbPath); } catch (_error) {}
}

async function run() {
  const guildId = `14681${String(Date.now()).slice(-13)}`;
  const discordId = `710${String(Date.now()).slice(-15)}`;

  db.prepare(`
    INSERT OR REPLACE INTO users (
      discord_id, username, total_nfts, total_tokens, tier, voting_power, created_at, updated_at
    ) VALUES (?, ?, 0, 0, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(discordId, 'soak-user');

  const walletCount = 250;
  const wallets = Array.from({ length: walletCount }, (_, idx) => `SoWallet${idx.toString().padStart(4, '0')}`);

  const originalGetVerificationWallets = roleService.getVerificationWallets.bind(roleService);
  const originalNftFetch = nftService.getAllNFTsForWalletsWithHealth.bind(nftService);
  const originalTokenBalances = tokenService.getAggregateBalancesForWallets.bind(tokenService);
  const originalSyncTierRoles = roleService.syncTierRoles.bind(roleService);
  const originalSyncTraitRoles = roleService.syncTraitRoles.bind(roleService);
  const originalSyncTokenRoles = roleService.syncTokenRoles.bind(roleService);

  roleService.getVerificationWallets = () => wallets;
  nftService.getAllNFTsForWalletsWithHealth = async (inputWallets) => {
    assert.strictEqual(inputWallets.length, walletCount, 'role sync should receive full high-volume wallet set');
    return { nfts: [], health: { hadFailureWithoutCache: false } };
  };
  tokenService.getAggregateBalancesForWallets = async () => ({});
  roleService.syncTierRoles = async () => ({ added: [], removed: [] });
  roleService.syncTraitRoles = async () => ({ added: [], removed: [] });
  roleService.syncTokenRoles = async () => ({ added: [], removed: [] });

  const member = {
    user: { tag: 'soak-user#0001' },
    guild: {
      roles: { cache: new Map() },
    },
    roles: {
      cache: new Map(),
      add: async () => {},
      remove: async () => {},
    },
  };

  const guild = {
    id: guildId,
    name: 'Soak Guild',
    members: {
      fetch: async (id) => (String(id) === String(discordId) ? member : null),
    },
    roles: { cache: new Map() },
  };

  const start = Date.now();
  const result = await roleService.syncUserDiscordRoles(guild, discordId, guildId);
  const durationMs = Date.now() - start;

  roleService.getVerificationWallets = originalGetVerificationWallets;
  nftService.getAllNFTsForWalletsWithHealth = originalNftFetch;
  tokenService.getAggregateBalancesForWallets = originalTokenBalances;
  roleService.syncTierRoles = originalSyncTierRoles;
  roleService.syncTraitRoles = originalSyncTraitRoles;
  roleService.syncTokenRoles = originalSyncTokenRoles;

  assert.strictEqual(result.success, true, 'high-volume role sync should succeed');
  assert.ok(durationMs < 5000, `high-volume role sync should complete quickly (actual ${durationMs}ms)`);
}

run()
  .then(() => {
    console.log('verification high-volume sync assertions passed');
  })
  .catch((error) => {
    console.error('verification high-volume sync test failed:', error);
    process.exitCode = 1;
  })
  .finally(cleanup);
