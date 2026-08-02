#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AbiCoder, Wallet, id } = require('ethers');

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildpilot-evm-nft-tracker-'));
process.env.DATABASE_PATH = path.join(runDir, 'tracker.db');
process.env.DB_BACKUP_ENABLED = 'false';
process.env.DB_BACKUP_ON_STARTUP = 'false';

async function main() {
  const db = require('../database/db');
  const evmService = require('../services/evmService');
  const nftActivityService = require('../services/nftActivityService');
  const evmTrackerService = require('../services/evmTrackerService');

  const guildId = 'guild-erc1155';
  const collection = Wallet.createRandom().address;
  const holder = Wallet.createRandom().address;
  const added = nftActivityService.addTrackedCollection({
    guildId,
    chain: 'eip155:1',
    collectionAddress: collection,
    collectionName: 'Edition X',
    channelId: '123456789012345678',
    nftStandard: 'erc1155',
    tokenId: '42',
    trackMint: true,
    trackTransfer: true,
  });
  assert.strictEqual(added.success, true);
  const config = db.prepare('SELECT * FROM nft_tracked_collections WHERE id = ?').get(added.id);
  assert.strictEqual(config.nft_standard, 'erc1155');
  assert.strictEqual(config.token_id, '42');
  db.prepare(`
    INSERT INTO evm_tracker_cursors (guild_id, chain_id, tracker_type, tracker_id, last_block)
    VALUES (?, 'eip155:1', 'nft', ?, 99)
  `).run(guildId, config.id);

  const addressTopic = address => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
  const zero = '0x0000000000000000000000000000000000000000';
  const log = {
    topics: [
      id('TransferSingle(address,address,address,uint256,uint256)'),
      addressTopic(holder),
      addressTopic(zero),
      addressTopic(holder),
    ],
    data: AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [42n, 3n]),
    transactionHash: `0x${'e'.repeat(64)}`,
    blockNumber: 100,
    index: 4,
  };
  const provider = {
    getBlockNumber: async () => 103,
    getBlock: async () => ({ timestamp: 1785513600 }),
    getLogs: async () => [log],
  };
  const originalProvider = evmService.getProvider.bind(evmService);
  evmService.getProvider = () => provider;
  const result = await evmTrackerService.pollCollection(config);
  evmService.getProvider = originalProvider;

  assert.strictEqual(result.processed, 1, 'matching ERC-1155 token activity is ingested');
  const event = db.prepare("SELECT token_mint, event_type, chain_id FROM nft_activity_events WHERE source = 'evm-rpc'").get();
  assert.strictEqual(event.token_mint.toLowerCase(), `${collection}#42`.toLowerCase());
  assert.strictEqual(event.event_type, 'mint');
  assert.strictEqual(event.chain_id, 'eip155:1');

  db.close();
  fs.rmSync(runDir, { recursive: true, force: true });
  console.log('EVM NFT tracker standard checks passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
