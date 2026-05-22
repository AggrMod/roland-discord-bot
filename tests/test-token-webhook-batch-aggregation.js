const assert = require('assert');

const trackedWalletsService = require('../services/trackedWalletsService');

async function run() {
  const originalIngestWebhookEvent = trackedWalletsService.ingestWebhookEvent;
  const originalExtractWebhookSignature = trackedWalletsService.extractWebhookSignature;

  try {
    trackedWalletsService.extractWebhookSignature = (event) => String(event?.signature || '').trim() || null;

    trackedWalletsService.ingestWebhookEvent = async (event) => {
      const sig = String(event?.signature || '').trim();
      if (sig === 'sig-processed') {
        return {
          success: true,
          ignored: false,
          insertedEvents: 2,
          duplicateEvents: 1,
          sentAlerts: 1,
        };
      }
      if (sig === 'sig-ignored') {
        return {
          success: true,
          ignored: true,
          reason: 'no_matching_wallets_or_tokens',
          insertedEvents: 0,
          duplicateEvents: 0,
          sentAlerts: 0,
        };
      }
      return {
        success: false,
        ignored: false,
      };
    };

    const summary = await trackedWalletsService.ingestWebhookBatch([
      { signature: 'sig-processed' },
      { signature: 'sig-processed' }, // duplicate inside same batch should be ignored before ingest call
      { signature: 'sig-ignored' },
      { signature: 'sig-failed' },
    ], { source: 'test' });

    assert.strictEqual(summary.received, 4, 'received should include full input batch');
    assert.strictEqual(summary.processed, 1, 'only processed signatures should count as processed');
    assert.strictEqual(summary.ignored, 2, 'ignored should include deduped batch signature + explicit ignored result');
    assert.strictEqual(summary.failed, 1, 'failed should include unsuccessful ingest result');
    assert.strictEqual(summary.insertedEvents, 2, 'inserted events should aggregate');
    assert.strictEqual(summary.duplicateEvents, 1, 'duplicate events should aggregate');
    assert.strictEqual(summary.sentAlerts, 1, 'sent alerts should aggregate');
    assert.strictEqual(Number(summary.ignoredReasons?.no_matching_wallets_or_tokens || 0), 1, 'ignored reason counters should aggregate');

    console.log('token webhook batch aggregation assertions passed');
  } finally {
    trackedWalletsService.ingestWebhookEvent = originalIngestWebhookEvent;
    trackedWalletsService.extractWebhookSignature = originalExtractWebhookSignature;
  }
}

run().catch((error) => {
  console.error('Token webhook batch aggregation test failed:', error.message);
  process.exit(1);
});
