#!/usr/bin/env node

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');
const migration = require('../database/migrations/031_webhook_event_inbox');
const createActivityWebhooksRouter = require('../web/routes/activityWebhooks');

function post({ port, body, secret }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/webhooks/token-activity', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: secret },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function run() {
  const db = new Database(':memory:');
  migration.up({ db, logger: { log() {} } });
  let resolveIngestion;
  let ingestionCalls = 0;
  const ingestionPromise = new Promise((resolve) => { resolveIngestion = resolve; });
  const secret = 'durable-inbox-secret';
  const app = express();
  app.use(express.json());
  app.use(createActivityWebhooksRouter({
    logger: { log() {}, error() {} },
    db,
    nftActivityService: { ingestEvent: () => ({ success: true }) },
    trackedWalletsService: {
      ingestWebhookBatch: async () => {
        ingestionCalls += 1;
        return ingestionPromise;
      },
    },
    getActivityWebhookSecret: () => secret,
    normalizeWebhookSecretHeader: (value) => String(value || '').replace(/^Bearer\s+/i, '').trim(),
    timingSafeEquals: (left, right) => {
      const a = Buffer.from(String(left || ''));
      const b = Buffer.from(String(right || ''));
      return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
    },
  }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const events = [{ signature: 'durable-signature', type: 'TRANSFER' }];

  try {
    const result = await post({ port, body: events, secret });
    assert.strictEqual(result.status, 200, 'durable insert is acknowledged');
    const inboxId = result.body.inboxId;
    assert(inboxId, 'response should expose an inbox correlation ID');
    const stored = db.prepare('SELECT * FROM webhook_event_inbox WHERE inbox_id = ?').get(inboxId);
    assert(stored, 'payload must exist in SQLite before HTTP 200');
    assert.strictEqual(JSON.parse(stored.payload_json)[0].signature, 'durable-signature');
    assert(['pending', 'processing'].includes(stored.status));

    resolveIngestion({ received: 1, processed: 1, ignored: 0, failed: 0, insertedEvents: 1, duplicateEvents: 0, sentAlerts: 1 });
    assert(await waitFor(() => db.prepare('SELECT status FROM webhook_event_inbox WHERE inbox_id = ?').get(inboxId)?.status === 'completed'));

    const duplicate = await post({ port, body: events, secret });
    assert.strictEqual(duplicate.body.inboxId, inboxId, 'identical retries deduplicate at the durable inbox');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(ingestionCalls, 1, 'completed duplicate is not processed again');

    console.log('webhook durable inbox assertions passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
