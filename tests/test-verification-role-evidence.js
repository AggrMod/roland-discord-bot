const assert = require('assert');
const roleService = require('../services/roleService');

async function main() {
  const originalGetEffectiveTiers = roleService.getEffectiveTiers.bind(roleService);
  const roleCache = new Map();
  const holderRole = {
    id: 'role-sol-holder',
    name: 'SOLROLEA',
    position: 1,
    managed: false,
    permissions: { has: () => false },
  };
  const guild = {
    id: 'guild-role-evidence',
    roles: { cache: new Map([[holderRole.id, holderRole]]) },
    members: { me: { roles: { highest: { position: 10 } } } },
  };
  const member = {
    id: 'user-role-evidence',
    user: { tag: 'holder#0001' },
    guild,
    roles: {
      cache: roleCache,
      add: async role => roleCache.set(role.id, role),
      remove: async role => roleCache.delete(role.id),
    },
  };

  try {
    roleService.getEffectiveTiers = () => [{
      name: 'Solpranos',
      chainId: 'solana:mainnet',
      collectionId: 'solpranos-collection',
      minNFTs: 1,
      maxNFTs: 999999,
      roleId: holderRole.id,
    }];

    const result = await roleService.syncTierRoles(member, [
      { collectionKey: 'solpranos-collection' },
      { collectionKey: 'solpranos-collection' },
    ], guild.id, new Set());

    assert.strictEqual(result.added.length, 1, 'matching Solana collection assigns the role');
    assert.strictEqual(result.granted.length, 1, 'matching Solana collection returns one grant explanation');
    assert.deepStrictEqual(result.granted[0], {
      kind: 'nft',
      chainName: 'Solana',
      assetName: 'Solpranos',
      balance: 2,
      min: 1,
      max: 999999,
      unit: 'NFTs',
      roleId: holderRole.id,
      roleName: holderRole.name,
    });
  } finally {
    roleService.getEffectiveTiers = originalGetEffectiveTiers;
  }

  console.log('verification role evidence assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
