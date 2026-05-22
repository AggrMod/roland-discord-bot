const assert = require('assert');

const db = require('../database/db');
const nftActivityService = require('../services/nftActivityService');
const clientProvider = require('../utils/clientProvider');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const stamp = Date.now();
  const guildA = `nft-a-${stamp}`;
  const guildB = `nft-b-${stamp}`;
  const collectionA = `COLLA_${stamp}`;
  const collectionB = `COLLB_${stamp}`;
  const channelA = `nft-channel-a-${stamp}`;
  const channelB = `nft-channel-b-${stamp}`;

  const sentA = [];
  const sentB = [];
  const originalGetClient = clientProvider.getClient;

  try {
    const addA = nftActivityService.addTrackedCollection({
      guildId: guildA,
      collectionAddress: collectionA,
      collectionName: 'Collection Alpha',
      channelId: channelA,
      trackMint: true,
      trackSale: true,
      trackList: true,
      trackDelist: true,
      trackTransfer: false,
      trackBid: false,
    });
    assert.strictEqual(addA.success, true, 'collection A should be added');

    const addB = nftActivityService.addTrackedCollection({
      guildId: guildB,
      collectionAddress: collectionB,
      collectionName: 'Collection Beta',
      channelId: channelB,
      trackMint: true,
      trackSale: true,
      trackList: true,
      trackDelist: true,
      trackTransfer: false,
      trackBid: false,
    });
    assert.strictEqual(addB.success, true, 'collection B should be added');

    clientProvider.getClient = () => ({
      user: { displayAvatarURL: () => 'https://example.com/bot.png' },
      channels: {
        fetch: async (id) => {
          if (String(id) === String(channelA)) {
            return {
              id: channelA,
              send: async (payload) => {
                sentA.push(payload);
                return { id: `msg-a-${sentA.length}` };
              },
            };
          }
          if (String(id) === String(channelB)) {
            return {
              id: channelB,
              send: async (payload) => {
                sentB.push(payload);
                return { id: `msg-b-${sentB.length}` };
              },
            };
          }
          return null;
        },
      },
    });

    const duplicateSig = `dup-sig-${stamp}`;
    const firstIngest = nftActivityService.ingestEvent({
      type: 'NFT_SALE',
      collectionKey: collectionA,
      tokenMint: `mint-a-${stamp}`,
      tokenName: 'Alpha #1',
      fromWallet: 'from-wallet-a',
      toWallet: 'to-wallet-a',
      priceSol: 1.25,
      txSignature: duplicateSig,
      chain: 'solana',
      eventTime: new Date().toISOString(),
    }, 'webhook');
    assert.strictEqual(firstIngest.success, true, 'first event should ingest');

    const secondIngest = nftActivityService.ingestEvent({
      type: 'NFT_SALE',
      collectionKey: collectionA,
      tokenMint: `mint-a-${stamp}`,
      tokenName: 'Alpha #1',
      fromWallet: 'from-wallet-a',
      toWallet: 'to-wallet-a',
      priceSol: 1.25,
      txSignature: duplicateSig,
      chain: 'solana',
      eventTime: new Date().toISOString(),
    }, 'webhook');

    assert.strictEqual(secondIngest.success, false, 'duplicate event should be ignored');
    assert.strictEqual(secondIngest.ignored, true, 'duplicate event should be marked ignored');

    await wait(120);

    const dupCount = db.prepare('SELECT COUNT(*) AS count FROM nft_activity_events WHERE tx_signature = ?').get(duplicateSig);
    assert.strictEqual(Number(dupCount?.count || 0), 1, 'duplicate tx should only be stored once');
    assert.strictEqual(sentA.length, 1, 'duplicate tx should emit one alert for collection A');
    assert.strictEqual(sentB.length, 0, 'collection B should not receive collection A alerts');

    const edgeSig = `edge-sig-${stamp}`;
    const edgeIngest = nftActivityService.ingestEvent({
      type: 'NFT_SALE',
      accountData: [{ account: collectionB.toLowerCase() }, { account: 'other-account' }],
      events: {
        nft: {
          amount: 2500000000,
          seller: 'from-wallet-b',
          buyer: 'to-wallet-b',
          nfts: [{ mint: `mint-b-${stamp}` }],
        },
      },
      txSignature: edgeSig,
      chain: 'solana',
      eventTime: new Date().toISOString(),
    }, 'webhook');

    assert.strictEqual(edgeIngest.success, true, 'edge metadata event should ingest through accountData matching');

    await wait(120);

    const edgeRow = db.prepare('SELECT collection_key, token_mint, tx_signature FROM nft_activity_events WHERE tx_signature = ?').get(edgeSig);
    assert.strictEqual(String(edgeRow?.collection_key || ''), collectionB.toLowerCase(), 'edge event should map to tracked collection key');
    assert.strictEqual(String(edgeRow?.token_mint || ''), `mint-b-${stamp}`, 'edge event should extract nft mint');

    assert.strictEqual(sentB.length, 1, 'collection B should receive its edge metadata alert');
    const edgeEmbed = sentB[0]?.embeds?.[0];
    assert.ok(edgeEmbed, 'edge alert should include embed payload');
    const edgeTitle = typeof edgeEmbed?.data?.title === 'string' ? edgeEmbed.data.title : '';
    assert.ok(edgeTitle.includes('Collection Beta'), 'embed title should include tracked collection name');

    console.log('nft webhook dedup + multi-collection edge alert assertions passed');
  } finally {
    clientProvider.getClient = originalGetClient;
  }
}

run().catch((error) => {
  console.error('NFT webhook dedup + edge alert test failed:', error.message);
  process.exit(1);
});
