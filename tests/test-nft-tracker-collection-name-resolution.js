#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { resolveTrackedCollectionMetadata } = require('../web/routes/adminTrackers');
const evmService = require('../services/evmService');

async function main() {
  const originalEvmResolver = evmService.getNftCollectionMetadata.bind(evmService);
  const robinhoodCollection = '0x4b712c60e11938b1026b8f5158e7e7f5b467302b';

  try {
    let resolvedChain = null;
    evmService.getNftCollectionMetadata = async (_address, chainId) => {
      resolvedChain = chainId;
      return { name: 'Chibi Hood', symbol: 'CHIBI' };
    };
    const evmResult = await resolveTrackedCollectionMetadata({
      nftActivityService: { resolveTokenAssetMeta: async () => ({ name: null }) },
      chainValue: 'eip155:4663',
      collectionAddress: robinhoodCollection,
    });
    assert.strictEqual(evmResult.success, true);
    assert.strictEqual(evmResult.name, 'Chibi Hood');
    assert.strictEqual(evmResult.symbol, 'CHIBI');
    assert.strictEqual(evmResult.chainId, 'eip155:4663');
    assert.strictEqual(resolvedChain, 'eip155:4663', 'metadata lookup uses the selected EVM network');

    const solanaResult = await resolveTrackedCollectionMetadata({
      nftActivityService: { resolveTokenAssetMeta: async () => ({ name: 'Solpranos' }) },
      chainValue: 'solana:mainnet',
      collectionAddress: '11111111111111111111111111111111',
    });
    assert.strictEqual(solanaResult.success, true);
    assert.strictEqual(solanaResult.name, 'Solpranos');

    const invalidResult = await resolveTrackedCollectionMetadata({
      nftActivityService: { resolveTokenAssetMeta: async () => ({ name: 'Should not resolve' }) },
      chainValue: 'eip155:4663',
      collectionAddress: 'not-an-address',
    });
    assert.strictEqual(invalidResult.success, false);
    assert.match(invalidResult.message, /valid collection address/i);

    evmService.getNftCollectionMetadata = async () => ({ name: null });
    const missingResult = await resolveTrackedCollectionMetadata({
      nftActivityService: { resolveTokenAssetMeta: async () => ({ name: null }) },
      chainValue: 'eip155:4663',
      collectionAddress: robinhoodCollection,
    });
    assert.strictEqual(missingResult.success, false);
    assert.match(missingResult.message, /enter it manually/i);

    const repoRoot = path.resolve(__dirname, '..');
    const portalHtml = fs.readFileSync(path.join(repoRoot, 'web/public/portal.html'), 'utf8');
    const portalJs = fs.readFileSync(path.join(repoRoot, 'web/public/portal.js'), 'utf8');
    const routeSource = fs.readFileSync(path.join(repoRoot, 'web/routes/adminTrackers.js'), 'utf8');
    assert.ok(portalHtml.includes('colNameResolutionStatus'), 'main tracker form shows metadata resolution state');
    assert.ok(portalJs.includes("/api/admin/nft-tracker/collections/resolve-metadata"), 'portal resolves names from the server');
    assert.ok(portalJs.includes('caNameStatus'), 'NFT Activity modal shows metadata resolution state');
    assert.ok(routeSource.includes('effectiveCollectionName = resolvedCollectionName || explicitCollectionName'), 'save repeats resolution and retains manual fallback');
  } finally {
    evmService.getNftCollectionMetadata = originalEvmResolver;
  }

  console.log('NFT tracker collection name resolution assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
