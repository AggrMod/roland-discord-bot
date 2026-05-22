#!/usr/bin/env node

const assert = require('assert');

const nftActivityService = require('../services/nftActivityService');
const clientProvider = require('../utils/clientProvider');
const db = require('../database/db');

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  const stamp = Date.now();
  const collection = `COLL_PERMISSION_${stamp}`;
  const blockedChannel = `nft-blocked-${stamp}`;
  const goodChannel = `nft-good-${stamp}`;
  const blockedGuild = `nft-guild-blocked-${stamp}`;
  const goodGuild = `nft-guild-good-${stamp}`;
  const sentGood = [];
  const originalGetClient = clientProvider.getClient;

  try {
    const addBlocked = nftActivityService.addTrackedCollection({
      guildId: blockedGuild,
      collectionAddress: collection,
      collectionName: 'Permission Collection',
      channelId: blockedChannel,
      trackMint: true,
      trackSale: true,
      trackList: true,
      trackDelist: true,
      trackTransfer: true,
      trackBid: true,
    });
    assert.strictEqual(addBlocked.success, true, 'blocked channel collection should be added');

    const addGood = nftActivityService.addTrackedCollection({
      guildId: goodGuild,
      collectionAddress: collection,
      collectionName: 'Permission Collection',
      channelId: goodChannel,
      trackMint: true,
      trackSale: true,
      trackList: true,
      trackDelist: true,
      trackTransfer: true,
      trackBid: true,
    });
    assert.strictEqual(addGood.success, true, 'good channel collection should be added');

    clientProvider.getClient = () => ({
      user: { displayAvatarURL: () => 'https://example.com/bot.png' },
      channels: {
        fetch: async (id) => {
          if (String(id) === blockedChannel) {
            return {
              id: blockedChannel,
              send: async () => {
                const error = new Error('Missing Permissions');
                error.status = 403;
                error.code = 50013;
                throw error;
              },
            };
          }
          if (String(id) === goodChannel) {
            return {
              id: goodChannel,
              send: async (payload) => {
                sentGood.push(payload);
                return { id: `msg-good-${sentGood.length}` };
              },
            };
          }
          return null;
        },
      },
    });

    const txSig = `perm-fallback-${stamp}`;
    const ingest = nftActivityService.ingestEvent({
      type: 'NFT_SALE',
      collectionKey: collection,
      tokenMint: `mint-${stamp}`,
      tokenName: 'Permission #1',
      fromWallet: 'from-wallet',
      toWallet: 'to-wallet',
      priceSol: 1.5,
      txSignature: txSig,
      chain: 'solana',
      eventTime: new Date().toISOString(),
    }, 'webhook');
    assert.strictEqual(ingest.success, true, 'event should ingest even with one blocked channel');

    await wait(180);

    const row = db.prepare('SELECT tx_signature FROM nft_activity_events WHERE tx_signature = ?').get(txSig);
    assert.strictEqual(String(row?.tx_signature || ''), txSig, 'event should be persisted');
    assert.strictEqual(sentGood.length, 1, 'eligible secondary channel should still receive alert');
    assert.ok(sentGood[0]?.embeds?.[0], 'sent alert should include embed');

    console.log('nft alert permission fallback assertions passed');
  } finally {
    clientProvider.getClient = originalGetClient;
  }
}

run().catch((error) => {
  console.error('NFT alert permission fallback test failed:', error.message);
  process.exit(1);
});

