#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet } = require('ethers');

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildpilot-ethereum-nft-sales-'));
process.env.DATABASE_PATH = path.join(runDir, 'ethereum-sales.db');
process.env.DB_BACKUP_ENABLED = 'false';
process.env.DB_BACKUP_ON_STARTUP = 'false';
process.env.EVM_ETHEREUM_RPC_URL = 'https://eth-mainnet.g.alchemy.com/v2/test-sales-key';

async function main() {
  const db = require('../database/db');
  const evmService = require('../services/evmService');
  const nftActivityService = require('../services/nftActivityService');
  const evmTrackerService = require('../services/evmTrackerService');

  const guildId = 'guild-ethereum-sales';
  const collection = Wallet.createRandom().address;
  const seller = Wallet.createRandom().address;
  const buyer = Wallet.createRandom().address;
  const added = nftActivityService.addTrackedCollection({
    guildId,
    chain: 'eip155:1',
    collectionAddress: collection,
    collectionName: 'Ethereum Test Collection',
    channelId: '123456789012345678',
    nftStandard: 'erc721',
    trackMint: false,
    trackTransfer: false,
    trackSale: true,
    trackBid: false,
    trackList: false,
    trackDelist: false,
  });
  assert.strictEqual(added.success, true);
  const config = db.prepare('SELECT * FROM nft_tracked_collections WHERE id = ?').get(added.id);
  db.prepare(`
    INSERT INTO evm_tracker_cursors (guild_id, chain_id, tracker_type, tracker_id, last_block)
    VALUES (?, 'eip155:1', 'nft-sale', ?, 99)
  `).run(guildId, config.id);

  const provider = {
    getBlockNumber: async () => 103,
    getBlock: async () => ({ timestamp: 1785513600 }),
  };
  const originalProvider = evmService.getProvider.bind(evmService);
  const originalFetch = global.fetch;
  const requestedUrls = [];
  evmService.getProvider = () => provider;
  global.fetch = async input => {
    requestedUrls.push(String(input));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        nftSales: [7, 8].map((tokenId, bundleIndex) => ({
          marketplace: 'seaport',
          contractAddress: collection,
          tokenId: String(tokenId),
          quantity: '1',
          buyerAddress: buyer,
          sellerAddress: seller,
          sellerFee: { amount: '1000000000000000000', symbol: 'WETH', decimals: 18 },
          protocolFee: { amount: '100000000000000000', symbol: 'WETH', decimals: 18 },
          royaltyFee: { amount: '50000000000000000', symbol: 'WETH', decimals: 18 },
          blockNumber: 100,
          logIndex: 12,
          bundleIndex,
          transactionHash: `0x${'a'.repeat(64)}`,
        })),
      }),
    };
  };

  try {
    assert.strictEqual(
      evmTrackerService.getAlchemyEthereumSalesEndpoint(),
      'https://eth-mainnet.g.alchemy.com/nft/v2/test-sales-key/getNFTSales'
    );
    const result = await evmTrackerService.pollCollectionSales(config);
    assert.strictEqual(result.processed, 2, 'each NFT in a bundled sale is recorded separately');
    assert.strictEqual(requestedUrls.length, 1);
    const requested = new URL(requestedUrls[0]);
    assert.strictEqual(requested.pathname, '/nft/v2/test-sales-key/getNFTSales');
    assert.strictEqual(requested.searchParams.get('contractAddress'), collection);
    assert.strictEqual(requested.searchParams.get('fromBlock'), '100');
    assert.strictEqual(requested.searchParams.get('toBlock'), '100');

    const rows = db.prepare(`
      SELECT event_type, token_mint, price_sol, tx_signature, source, raw_json
      FROM nft_activity_events
      ORDER BY id ASC
    `).all();
    assert.strictEqual(rows.length, 2);
    assert.ok(rows.every(row => row.event_type === 'sell'));
    assert.ok(rows.every(row => row.source === 'alchemy-nft-sales'));
    assert.ok(rows.every(row => Math.abs(Number(row.price_sol) - 1.15) < 1e-9));
    assert.notStrictEqual(rows[0].tx_signature, rows[1].tx_signature, 'bundle entries have unique dedupe keys');
    assert.match(rows[0].token_mint, /#7$/);
    assert.strictEqual(JSON.parse(rows[0].raw_json).currencySymbol, 'WETH');

    const cursor = db.prepare(`
      SELECT last_block FROM evm_tracker_cursors
      WHERE guild_id = ? AND chain_id = 'eip155:1' AND tracker_type = 'nft-sale' AND tracker_id = ?
    `).get(guildId, config.id);
    assert.strictEqual(cursor.last_block, 100);

    const unsupported = await evmTrackerService.pollCollectionSales({ ...config, chain_id: 'eip155:4663' });
    assert.strictEqual(unsupported.skipped, true, 'sales polling remains Ethereum-only');

    const portalJs = fs.readFileSync(path.join(__dirname, '../web/public/portal.js'), 'utf8');
    assert.ok(portalJs.includes("supportsEthereumSales = chainId === 'eip155:1'"));
    assert.ok(portalJs.includes('Alchemy covers completed marketplace sales'));
  } finally {
    global.fetch = originalFetch;
    evmService.getProvider = originalProvider;
    db.close();
    fs.rmSync(runDir, { recursive: true, force: true });
  }

  console.log('Ethereum NFT completed-sale tracker assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
