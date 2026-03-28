const assert = require('assert');

process.env.MOCK_MODE = 'false';

const db = require('./database/db');
const nftService = require('./services/nftService');
const roleService = require('./services/roleService');
const walletService = require('./services/walletService');
const tenantService = require('./services/tenantService');

async function run() {
  const originals = {
    isMultitenantEnabled: tenantService.isMultitenantEnabled.bind(tenantService),
    getTenantContext: tenantService.getTenantContext.bind(tenantService),
    fetchNFTsFromHelius: nftService.fetchNFTsFromHelius.bind(nftService),
    countNFTsForWallets: nftService.countNFTsForWallets.bind(nftService),
    getAllNFTsForWallets: nftService.getAllNFTsForWallets.bind(nftService),
    getAllUserWallets: walletService.getAllUserWallets.bind(walletService),
    tiersConfig: roleService.tiersConfig,
    traitRolesConfig: roleService.traitRolesConfig
  };

  try {
    tenantService.isMultitenantEnabled = () => true;
    tenantService.getTenantContext = (guildId) => ({
      guildId,
      limits: { mockDataEnabled: guildId === 'guild-mock' }
    });

    nftService.fetchNFTsFromHelius = async () => ([
      { mint: 'live-mint', attributes: [{ trait_type: 'Role', value: 'The Don' }], assignedToMission: null }
    ]);

    const mockNFTs = await nftService.getNFTsForWallet('wallet-1', { guildId: 'guild-mock' });
    assert.ok(mockNFTs.length > 0, 'tenant mock guild should return mock NFTs');
    assert.ok(mockNFTs.every(nft => nft.mint.startsWith('MOCK_')), 'tenant mock guild should only receive mock mints');

    const liveNFTs = await nftService.getNFTsForWallet('wallet-1', { guildId: 'guild-live' });
    assert.strictEqual(liveNFTs[0].mint, 'live-mint', 'non-mock guild should use live fetch path');

    let forwardedGuildId = null;
    nftService.countNFTsForWallets = async (_wallets, options = {}) => {
      forwardedGuildId = options.guildId || null;
      return 1;
    };
    walletService.getAllUserWallets = () => ['wallet-1'];

    const userId = `tenant-scope-${Date.now()}`;
    db.prepare(`
      INSERT OR REPLACE INTO users (discord_id, username, total_nfts, tier, voting_power)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, 'Tenant Tester', 0, null, 0);

    const updateResult = await roleService.updateUserRoles(userId, 'Tenant Tester', 'guild-forward');
    assert.strictEqual(updateResult.success, true, 'updateUserRoles should succeed with tenant guildId');
    assert.strictEqual(forwardedGuildId, 'guild-forward', 'updateUserRoles should forward guildId to nftService');

    let syncForwardedGuildId = null;
    nftService.getAllNFTsForWallets = async (_wallets, options = {}) => {
      syncForwardedGuildId = options.guildId || null;
      return [];
    };
    roleService.tiersConfig = { tiers: [] };
    roleService.traitRolesConfig = { traitRoles: [] };

    const fakeMember = {
      user: { tag: 'Tenant Tester#0001' },
      guild: { roles: { cache: new Map() } },
      roles: { cache: new Map(), add: async () => {}, remove: async () => {} }
    };
    const fakeGuild = {
      id: 'guild-sync',
      members: { fetch: async () => fakeMember },
      roles: { cache: new Map() }
    };

    const syncResult = await roleService.syncUserDiscordRoles(fakeGuild, userId, 'guild-sync');
    assert.strictEqual(syncResult.success, true, 'syncUserDiscordRoles should succeed with tenant guildId');
    assert.strictEqual(syncForwardedGuildId, 'guild-sync', 'syncUserDiscordRoles should forward guildId to nftService');

    console.log('Tenant scoping assertions passed');
  } finally {
    tenantService.isMultitenantEnabled = originals.isMultitenantEnabled;
    tenantService.getTenantContext = originals.getTenantContext;
    nftService.fetchNFTsFromHelius = originals.fetchNFTsFromHelius;
    nftService.countNFTsForWallets = originals.countNFTsForWallets;
    nftService.getAllNFTsForWallets = originals.getAllNFTsForWallets;
    walletService.getAllUserWallets = originals.getAllUserWallets;
    roleService.tiersConfig = originals.tiersConfig;
    roleService.traitRolesConfig = originals.traitRolesConfig;
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
