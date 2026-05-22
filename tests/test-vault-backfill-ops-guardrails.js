#!/usr/bin/env node

const assert = require('assert');
const { parseBulkBackfillOptions } = require('../web/routes/adminVault');

function run() {
  const missingConfirm = parseBulkBackfillOptions({
    dryRun: false,
    limitPerWallet: 100,
  });
  assert.strictEqual(missingConfirm.success, false, 'non-dry-run without confirmation should fail');
  assert.match(String(missingConfirm.message || ''), /confirmation/i);

  const validLiveRun = parseBulkBackfillOptions({
    dryRun: false,
    confirmation: 'RUN_BACKFILL',
    limitPerWallet: 5000,
    delayMs: 250,
    maxRuntimeMs: 600000,
    rpcRetryMax: 2,
  });
  assert.strictEqual(validLiveRun.success, true, 'confirmed non-dry-run should pass');
  assert.strictEqual(validLiveRun.options.dryRun, false);

  const invalidLimit = parseBulkBackfillOptions({
    dryRun: true,
    limitPerWallet: 50001,
  });
  assert.strictEqual(invalidLimit.success, false, 'out-of-range limit should fail');

  const invalidRuntime = parseBulkBackfillOptions({
    dryRun: true,
    maxRuntimeMs: 5000,
  });
  assert.strictEqual(invalidRuntime.success, false, 'runtime under minimum should fail');

  const validDryRun = parseBulkBackfillOptions({
    dryRun: true,
    limitPerWallet: 1000,
    delayMs: 0,
    maxRuntimeMs: 120000,
    rpcRetryMax: 0,
  });
  assert.strictEqual(validDryRun.success, true, 'dry-run within bounds should pass');
  assert.strictEqual(validDryRun.options.dryRun, true);
}

try {
  run();
  console.log('vault bulk backfill ops guardrail assertions passed');
} catch (error) {
  console.error('vault bulk backfill ops guardrail test failed:', error);
  process.exitCode = 1;
}
