const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildpilot-collection-name-'));
process.env.DATABASE_PATH = path.join(runDir, 'collection-name.db');
process.env.DB_BACKUP_ENABLED = 'false';
process.env.DB_BACKUP_ON_STARTUP = 'false';

const { resolveCollectionRuleName } = require('../web/routes/verificationRoleAdmin');
const nftActivityService = require('../services/nftActivityService');
const evmService = require('../services/evmService');

async function main() {
  const originalSolanaResolver = nftActivityService.resolveTokenAssetMeta.bind(nftActivityService);
  const originalEvmResolver = evmService.getNftCollectionMetadata.bind(evmService);
  const logger = { warn: () => {} };
  const noTrackedNameDb = { prepare: () => ({ get: () => null }) };

  try {
    let providerCalls = 0;
    evmService.getNftCollectionMetadata = async () => {
      providerCalls += 1;
      return { name: 'Provider should not win' };
    };
    const trackedName = await resolveCollectionRuleName({
      db: { prepare: () => ({ get: () => ({ collection_name: 'Saved Tracker Name' }) }) },
      logger,
      guildId: 'guild-name-test',
      normalizedRule: { chainFamily: 'evm', chainId: 'eip155:1', collectionId: '0xcollection' },
    });
    assert.strictEqual(trackedName, 'Saved Tracker Name');
    assert.strictEqual(providerCalls, 0, 'tenant tracker name is reused without an external lookup');

    let solanaLookupSql = '';
    await resolveCollectionRuleName({
      db: { prepare: sql => ({ get: () => { solanaLookupSql = sql; return { collection_name: 'Solpranos' }; } }) },
      logger,
      guildId: 'guild-name-test',
      normalizedRule: { chainFamily: 'solana', chainId: 'solana:mainnet', collectionId: 'CaseSensitiveMint' },
    });
    assert.match(solanaLookupSql, /TRIM\(collection_address\) = TRIM\(\?\)/, 'Solana address lookup remains case-sensitive');
    assert.doesNotMatch(solanaLookupSql, /LOWER\(TRIM\(collection_address\)\)/, 'Solana addresses are never lowercased');

    evmService.getNftCollectionMetadata = async () => ({ name: 'The Deck by Gamblor' });
    const evmName = await resolveCollectionRuleName({
      db: noTrackedNameDb,
      logger,
      guildId: 'guild-name-test',
      normalizedRule: { chainFamily: 'evm', chainId: 'eip155:1', collectionId: '0xcollection' },
    });
    assert.strictEqual(evmName, 'The Deck by Gamblor');

    nftActivityService.resolveTokenAssetMeta = async () => ({ name: 'Solpranos' });
    const solanaName = await resolveCollectionRuleName({
      db: noTrackedNameDb,
      logger,
      guildId: 'guild-name-test',
      normalizedRule: { chainFamily: 'solana', chainId: 'solana:mainnet', collectionId: 'SolanaCollectionMint' },
    });
    assert.strictEqual(solanaName, 'Solpranos');
  } finally {
    nftActivityService.resolveTokenAssetMeta = originalSolanaResolver;
    evmService.getNftCollectionMetadata = originalEvmResolver;
    require('../database/db').close();
    fs.rmSync(runDir, { recursive: true, force: true });
  }

  console.log('verification collection name resolution assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
