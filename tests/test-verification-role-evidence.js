const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildpilot-role-evidence-'));
process.env.DATABASE_PATH = path.join(runDir, 'role-evidence.db');
process.env.DB_BACKUP_ENABLED = 'false';
process.env.DB_BACKUP_ON_STARTUP = 'false';

async function main() {
  const db = require('../database/db');
  const roleService = require('../services/roleService');
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
    db.prepare(`
      INSERT INTO nft_tracked_collections (
        guild_id, chain_family, chain_id, collection_address, collection_name, channel_id
      ) VALUES (?, 'solana', 'solana:mainnet', ?, ?, ?)
    `).run(guild.id, 'solpranos-collection', 'The Solpranos', 'channel-role-evidence');

    roleService.getEffectiveTiers = () => [{
      name: 'Solana test role',
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
      assetName: 'The Solpranos',
      balance: 2,
      min: 1,
      max: 999999,
      unit: 'NFTs',
      roleId: holderRole.id,
      roleName: holderRole.name,
    });
  } finally {
    roleService.getEffectiveTiers = originalGetEffectiveTiers;
    db.close();
    fs.rmSync(runDir, { recursive: true, force: true });
  }

  console.log('verification role evidence assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
