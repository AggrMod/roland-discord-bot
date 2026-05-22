#!/usr/bin/env node

const assert = require('assert');

const db = require('../database/db');
const nftActivityService = require('../services/nftActivityService');
const clientProvider = require('../utils/clientProvider');
const logger = require('../utils/logger');

async function run() {
  const stamp = Date.now();
  const guildId = `nft-burst-guild-${stamp}`;
  const collection = `NFT_BURST_COLL_${stamp}`;
  const channelId = `nft-burst-channel-${stamp}`;
  const burstSize = 300;
  const sent = [];
  const originalGetClient = clientProvider.getClient;
  const originalLoggerLog = logger.log;

  try {
    logger.log = () => {};
    const add = nftActivityService.addTrackedCollection({
      guildId,
      collectionAddress: collection,
      collectionName: 'Burst Collection',
      channelId,
      trackMint: true,
      trackSale: true,
      trackList: true,
      trackDelist: true,
      trackTransfer: true,
      trackBid: true,
    });
    assert.strictEqual(add.success, true, 'tracked collection should be added');

    clientProvider.getClient = () => ({
      user: { displayAvatarURL: () => 'https://example.com/bot.png' },
      channels: {
        fetch: async (id) => {
          if (String(id) !== String(channelId)) return null;
          return {
            id: channelId,
            send: async (payload) => {
              sent.push(payload);
              return { id: `msg-${sent.length}` };
            },
          };
        },
      },
    });

    const start = Date.now();
    for (let i = 0; i < burstSize; i += 1) {
      const ingest = nftActivityService.ingestEvent({
        type: 'NFT_SALE',
        collectionKey: collection,
        tokenMint: `mint-${stamp}-${i}`,
        tokenName: `Burst #${i}`,
        fromWallet: `from-${i}`,
        toWallet: `to-${i}`,
        priceSol: 0.1 + (i / 1000),
        txSignature: `burst-${stamp}-${i}`,
        chain: 'solana',
        eventTime: new Date().toISOString(),
      }, 'webhook');
      assert.strictEqual(ingest.success, true, `event ${i} should ingest`);
    }
    const elapsedMs = Date.now() - start;

    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM nft_activity_events
      WHERE collection_key = ?
        AND tx_signature LIKE ?
    `).get(collection.toLowerCase(), `burst-${stamp}-%`);
    assert.strictEqual(Number(row?.count || 0), burstSize, 'all burst events should be persisted');

    // Allow async send queue to flush.
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.ok(sent.length > 0, 'burst should still produce alert sends');
    assert.ok(elapsedMs < 5000, `burst ingest should stay responsive (elapsed=${elapsedMs}ms)`);

    console.log('nft webhook throughput burst assertions passed');
  } finally {
    clientProvider.getClient = originalGetClient;
    logger.log = originalLoggerLog;
  }
}

run().catch((error) => {
  console.error('NFT webhook throughput burst test failed:', error.message);
  process.exit(1);
});
