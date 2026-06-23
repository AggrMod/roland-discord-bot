#!/usr/bin/env node

// Fix B (audit M-2/M-4): unit coverage for the webhook abuse guards.

const assert = require('assert');

function run() {
  // Reload the module under specific env each time.
  function freshGuards(env = {}) {
    for (const [k, v] of Object.entries(env)) {
      if (v === null) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[require.resolve('../web/routes/webhookGuards')];
    return require('../web/routes/webhookGuards');
  }

  // --- Batch limit ---
  let g = freshGuards({ WEBHOOK_MAX_BATCH: '500' });
  assert.strictEqual(g.getMaxBatchSize(), 500, 'default-ish max should read from env');
  assert.strictEqual(g.withinBatchLimit(500), true, 'exactly at limit is allowed');
  assert.strictEqual(g.withinBatchLimit(501), false, 'over limit is rejected');
  assert.strictEqual(g.withinBatchLimit(0), true, 'zero events allowed');

  g = freshGuards({ WEBHOOK_MAX_BATCH: '0' });
  assert.strictEqual(g.withinBatchLimit(1_000_000), true, 'zero/unset disables the cap (unlimited)');

  g = freshGuards({ WEBHOOK_MAX_BATCH: '3' });
  assert.strictEqual(g.withinBatchLimit(4), false, 'custom cap honored');
  assert.strictEqual(g.withinBatchLimit(3), true, 'custom cap boundary honored');

  // --- Replay key stability ---
  g = freshGuards({ WEBHOOK_MAX_BATCH: '500' });
  const reqA = { method: 'POST', baseUrl: '', path: '/api/webhooks/vault-mints', headers: { authorization: 'secret' }, body: { a: 1, b: [2, 3] } };
  const reqAReordered = { method: 'POST', baseUrl: '', path: '/api/webhooks/vault-mints', headers: { authorization: 'secret' }, body: { b: [2, 3], a: 1 } };
  const reqDifferentBody = { method: 'POST', baseUrl: '', path: '/api/webhooks/vault-mints', headers: { authorization: 'secret' }, body: { a: 2 } };
  const reqDifferentSecret = { method: 'POST', baseUrl: '', path: '/api/webhooks/vault-mints', headers: { authorization: 'other' }, body: { a: 1, b: [2, 3] } };

  assert.strictEqual(g.replayKeyFor(reqA), g.replayKeyFor(reqAReordered), 'key is stable across key ordering');
  assert.notStrictEqual(g.replayKeyFor(reqA), g.replayKeyFor(reqDifferentBody), 'different body => different key');
  assert.notStrictEqual(g.replayKeyFor(reqA), g.replayKeyFor(reqDifferentSecret), 'different auth scope => different key');

  // --- Replay cache window ---
  const cache = g.createReplayCache({ windowMs: 50, maxEntries: 1000 });
  const key = g.replayKeyFor(reqA);
  assert.strictEqual(cache.isReplay(key), false, 'first sighting is not a replay');
  assert.strictEqual(cache.isReplay(key), true, 'immediate repeat is a replay');
  assert.strictEqual(cache.isReplay(g.replayKeyFor(reqDifferentBody)), false, 'unrelated key is not a replay');

  // --- Replay cache bounded ---
  const bounded = g.createReplayCache({ windowMs: 60_000, maxEntries: 10 });
  for (let i = 0; i < 100; i += 1) {
    bounded.isReplay(`k-${i}`);
  }
  assert.ok(bounded.size <= 10, `cache should stay bounded (size=${bounded.size})`);

  console.log('webhook guard assertions passed');
}

run();
