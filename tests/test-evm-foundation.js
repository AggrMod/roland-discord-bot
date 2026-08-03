#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet } = require('ethers');

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildpilot-evm-foundation-'));
const databasePath = path.join(runDir, 'evm.db');
process.env.DATABASE_PATH = databasePath;
process.env.DB_BACKUP_ENABLED = 'false';
process.env.DB_BACKUP_ON_STARTUP = 'false';
process.env.EVM_ROBINHOOD_RPC_URL = 'https://robinhood.example.invalid/rpc';

async function main() {
  const db = require('../database/db');
  const evmService = require('../services/evmService');
  const trackedWalletsService = require('../services/trackedWalletsService');
  const {
    getChain,
    getEvmRpcUrl,
    getExplorerUrl,
    normalizeAddress,
    normalizeChainId,
  } = require('../utils/chainIdentity');

  assert.strictEqual(normalizeChainId('base'), 'eip155:8453');
  assert.strictEqual(normalizeChainId('0x89'), 'eip155:137');
  assert.strictEqual(getChain('eip155:42161').name, 'Arbitrum One');
  assert.strictEqual(normalizeChainId('robinhood'), 'eip155:4663');
  assert.deepStrictEqual(
    { name: getChain('eip155:4663').name, numericChainId: getChain('eip155:4663').numericChainId, hexChainId: getChain('eip155:4663').hexChainId },
    { name: 'Robinhood Chain', numericChainId: 4663, hexChainId: '0x1237' }
  );
  assert.strictEqual(getEvmRpcUrl('eip155:4663'), process.env.EVM_ROBINHOOD_RPC_URL);

  const signer = Wallet.createRandom();
  const checksumAddress = normalizeAddress(signer.address.toLowerCase(), 'eip155:1');
  assert.strictEqual(checksumAddress, signer.address);
  assert.strictEqual(normalizeAddress('not-an-address', 'eip155:1'), '');

  const message = [
    'guildpilot.example wants you to sign in with your Ethereum account:',
    signer.address,
    '',
    'Link this Ethereum wallet to your Discord account on GuildPilot.',
    '',
    'URI: https://guildpilot.example/app?section=wallets',
    'Version: 1',
    'Chain ID: 1',
    'Nonce: 8b4f2ed906e54d3facce',
    'Issued At: 2026-07-31T12:00:00.000Z',
  ].join('\n');
  const signature = await signer.signMessage(message);
  assert.strictEqual(evmService.verifyWalletSignature({ address: signer.address, message, signature }), true);
  assert.strictEqual(evmService.verifyWalletSignature({ address: Wallet.createRandom().address, message, signature }), false);

  const columns = table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  for (const column of ['chain_family', 'chain_id']) assert(columns('wallets').has(column));
  for (const column of ['chain_family', 'chain_id', 'amount_raw']) assert(columns('tracked_token_events').has(column));
  assert(columns('evm_tracker_cursors').has('last_block'));

  const saved = trackedWalletsService.saveTrackedTokenEvent({
    guildId: 'guild-evm',
    chainId: 'eip155:1',
    walletId: 42,
    walletAddress: signer.address,
    tokenMint: Wallet.createRandom().address,
    tokenSymbol: 'TEST',
    tokenName: 'Test Token',
    eventType: 'transfer_in',
    amountDelta: 1.5,
    amountRaw: '1500000000000000000',
    txSignature: `0x${'a'.repeat(64)}`,
    source: 'test',
  });
  assert.strictEqual(saved.success, true);
  assert.strictEqual(saved.inserted, true);
  const event = db.prepare('SELECT chain_family, chain_id, amount_raw FROM tracked_token_events WHERE id = ?').get(saved.id);
  assert.deepStrictEqual(event, { chain_family: 'evm', chain_id: 'eip155:1', amount_raw: '1500000000000000000' });

  const txUrl = getExplorerUrl('eip155:8453', 'tx', `0x${'b'.repeat(64)}:7`);
  assert.strictEqual(txUrl, `https://basescan.org/tx/0x${'b'.repeat(64)}`);
  const robinhoodTxUrl = getExplorerUrl('robinhood', 'tx', `0x${'e'.repeat(64)}`);
  assert.strictEqual(robinhoodTxUrl, `https://robinhoodchain.blockscout.com/tx/0x${'e'.repeat(64)}`);

  const trackedToken = Wallet.createRandom().address;
  const trackedCollection = Wallet.createRandom().address;
  db.prepare(`INSERT INTO tracked_wallets (id, guild_id, chain_family, chain_id, wallet_address, label, enabled) VALUES (7, 'guild-live', 'evm', 'eip155:1', ?, 'EVM whale', 1)`).run(signer.address);
  db.prepare(`INSERT INTO tracked_tokens (id, guild_id, chain_family, chain_id, token_mint, token_symbol, token_name, decimals, enabled, alert_transfers) VALUES (8, 'guild-live', 'evm', 'eip155:1', ?, 'LIVE', 'Live Token', 18, 1, 0)`).run(trackedToken);
  db.prepare(`INSERT INTO nft_tracked_collections (id, guild_id, chain_family, chain_id, collection_address, collection_name, channel_id, track_mint, track_transfer, enabled) VALUES (9, 'guild-live', 'evm', 'eip155:1', ?, 'Live NFT', '123456789012345678', 1, 1, 1)`).run(trackedCollection);
  db.prepare(`INSERT INTO evm_tracker_cursors (guild_id, chain_id, tracker_type, tracker_id, last_block) VALUES ('guild-live', 'eip155:1', 'token', 8, 99)`).run();
  db.prepare(`INSERT INTO evm_tracker_cursors (guild_id, chain_id, tracker_type, tracker_id, last_block) VALUES ('guild-live', 'eip155:1', 'nft', 9, 99)`).run();

  const addressTopic = address => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
  const uint256 = value => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
  const transferTopic = require('ethers').id('Transfer(address,address,uint256)');
  const tokenLog = {
    topics: [transferTopic, addressTopic(ZeroAddressForTest()), addressTopic(signer.address)],
    data: uint256(1_500_000_000_000_000_000n),
    transactionHash: `0x${'c'.repeat(64)}`,
    blockNumber: 100,
    index: 1,
  };
  const nftLog = {
    topics: [transferTopic, addressTopic(ZeroAddressForTest()), addressTopic(signer.address), uint256(77)],
    data: '0x',
    transactionHash: `0x${'d'.repeat(64)}`,
    blockNumber: 100,
    index: 2,
  };
  const fakeProvider = {
    getBlockNumber: async () => 103,
    getBlock: async () => ({ timestamp: 1785513600 }),
    getLogs: async filter => String(filter.address).toLowerCase() === trackedToken.toLowerCase() ? [tokenLog] : [nftLog],
  };
  const originalGetProvider = evmService.getProvider.bind(evmService);
  evmService.getProvider = () => fakeProvider;
  const evmTrackerService = require('../services/evmTrackerService');
  const tokenResult = await evmTrackerService.pollToken(db.prepare('SELECT * FROM tracked_tokens WHERE id = 8').get());
  const nftResult = await evmTrackerService.pollCollection(db.prepare('SELECT * FROM nft_tracked_collections WHERE id = 9').get());
  evmService.getProvider = originalGetProvider;
  assert.strictEqual(tokenResult.processed, 1, 'ERC-20 Transfer log is persisted for a tracked wallet');
  assert.strictEqual(nftResult.processed, 1, 'ERC-721 mint log is ingested');
  assert.strictEqual(db.prepare("SELECT chain_id FROM tracked_token_events WHERE tx_signature = ?").get(tokenLog.transactionHash).chain_id, 'eip155:1');
  assert.strictEqual(db.prepare("SELECT chain_id FROM nft_activity_events WHERE source = 'evm-rpc'").get().chain_id, 'eip155:1');

  db.close();
  fs.rmSync(runDir, { recursive: true, force: true });
  console.log('EVM foundation checks passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

function ZeroAddressForTest() {
  return '0x0000000000000000000000000000000000000000';
}
