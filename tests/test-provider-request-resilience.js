const assert = require('assert');

process.env.HELIUS_API_KEY = 'test-helius-key';
process.env.HELIUS_FETCH_MAX_RETRIES = '0';
process.env.HELIUS_RPS = '1000';
process.env.HELIUS_ERROR_LOG_COOLDOWN_MS = '300000';

const nftService = require('../services/nftService');
const xProviderService = require('../services/xProviderService');

function jsonResponse(data, status = 200, statusText = 'OK') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => data,
  };
}

async function run() {
  const originalFetch = global.fetch;

  try {
    let heliusCalls = 0;
    global.fetch = async () => {
      heliusCalls += 1;
      if (heliusCalls === 1) {
        const error = new Error('This operation was aborted');
        error.name = 'AbortError';
        throw error;
      }
      return jsonResponse({ result: { items: [] } });
    };

    const failedWallet = '11111111111111111111111111111111';
    const failed = await nftService.getNFTsForWalletWithMeta(failedWallet, { guildId: 'provider-resilience' });
    assert.strictEqual(failed.degraded, true, 'an aborted Helius request must mark the wallet check degraded');
    assert.strictEqual(failed.source, 'empty-on-error', 'an aborted request must use the provider-error path');
    assert.strictEqual(
      nftService.getCachedWalletNfts(nftService.getCacheKey(failedWallet, 'provider-resilience'), { allowStale: true }),
      null,
      'a provider failure must never cache an empty NFT set'
    );

    nftService.heliusBackoffUntil = 0;
    const recovered = await nftService.getNFTsForWalletWithMeta(
      'So11111111111111111111111111111111111111112',
      { guildId: 'provider-resilience' }
    );
    assert.strictEqual(recovered.degraded, false, 'the next Helius request must run after a rejected queued request');
    assert.strictEqual(recovered.source, 'fresh-network', 'the recovered request should reach Helius');
    assert.strictEqual(heliusCalls, 2, 'a rejected request must not poison the Helius rate-limit queue');

    const requestedUrls = [];
    global.fetch = async url => {
      requestedUrls.push(new URL(String(url)));
      return jsonResponse({ data: [], meta: {} });
    };

    await xProviderService.searchRecentPosts('#solpranos -is:retweet', {
      bearerToken: 'test-x-token',
      sinceId: 'invalid-cursor',
      maxResults: 10,
    });
    assert.strictEqual(
      requestedUrls[0].searchParams.has('since_id'),
      false,
      'malformed stored X cursors must be omitted from recent-search requests'
    );
    assert.strictEqual(
      requestedUrls[0].searchParams.get('query'),
      '#solpranos -is:retweet',
      'the hashtag query should remain unchanged'
    );

    await xProviderService.searchRecentPosts('#solpranos -is:retweet', {
      bearerToken: 'test-x-token',
      sinceId: '1785745049612',
      maxResults: 10,
    });
    assert.strictEqual(
      requestedUrls[1].searchParams.get('since_id'),
      '1785745049612',
      'valid numeric X cursors should be sent'
    );

    assert.strictEqual(xProviderService.normalizePostId('12345678901234567890'), '', 'X post IDs over 19 digits are invalid');
    console.log('provider request resilience assertions passed');
  } finally {
    global.fetch = originalFetch;
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
