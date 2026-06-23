#!/usr/bin/env node

// Fix F (audit H-2): vault webhook per-guild secret + guild-match binding.
// Default (VAULT_WEBHOOK_ENFORCE_GUILD_MATCH unset) = legacy global-secret auth,
// unchanged. Enforce mode requires the target guild's own secret and rejects
// events for other guilds.

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');

const createVaultWebhooksRouter = require('../web/routes/vaultWebhooks');

// Mirror server.js helpers exactly.
function timingSafeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0 || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function normalizeWebhookSecretHeader(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/^Bearer\s+/i, '').trim();
}

const G1 = '111111111111111111';
const G2 = '222222222222222222';
const GLOBAL_SECRET = 'global-secret-value';
const G1_SECRET = 'guild1-secret-value';

const ingested = [];

function buildServer() {
  const app = express();
  app.use(express.json());
  app.use('/', createVaultWebhooksRouter({
    logger: { warn() {}, error() {}, log() {} },
    vaultService: {
      ingestMintEvent: (normalized) => {
        ingested.push(normalized.guildId);
        return { success: true, duplicate: false, linkedUserId: null, grants: null };
      },
    },
    timingSafeEquals,
    normalizeWebhookSecretHeader,
  }));
  return app;
}

function post({ port, guildQuery, secret, body }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const path = guildQuery ? `/api/webhooks/vault-mints?guildId=${guildQuery}` : '/api/webhooks/vault-mints';
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(secret ? { authorization: secret } : {}) } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function run() {
  process.env.VAULT_MINT_WEBHOOK_SECRET = GLOBAL_SECRET;
  process.env[`VAULT_WEBHOOK_SECRET_${G1}`] = G1_SECRET;

  const server = buildServer().listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;

  try {
    // ---- Default (off): legacy global secret, event guild trusted ----
    delete process.env.VAULT_WEBHOOK_ENFORCE_GUILD_MATCH;
    ingested.length = 0;
    let r = await post({ port, guildQuery: G1, secret: GLOBAL_SECRET, body: [{ guildId: G2, txSignature: 'sigA' }] });
    assert.strictEqual(r.status, 200, 'off mode: global secret authorizes');
    assert.deepStrictEqual(ingested, [G2], 'off mode: event guild is trusted (legacy behavior)');

    // ---- Enforce: per-guild secret required ----
    process.env.VAULT_WEBHOOK_ENFORCE_GUILD_MATCH = 'enforce';

    // Wrong secret (global) is rejected in enforce.
    r = await post({ port, guildQuery: G1, secret: GLOBAL_SECRET, body: [{ guildId: G1, txSignature: 'sigB' }] });
    assert.strictEqual(r.status, 401, 'enforce: global secret is not accepted');

    // No request-level guildId => 400.
    r = await post({ port, guildQuery: '', secret: G1_SECRET, body: [{ guildId: G1, txSignature: 'sigC' }] });
    assert.strictEqual(r.status, 400, 'enforce: request-level guildId required');

    // Guild with no per-guild secret => 503.
    r = await post({ port, guildQuery: G2, secret: 'whatever', body: [{ guildId: G2, txSignature: 'sigD' }] });
    assert.strictEqual(r.status, 503, 'enforce: guild without a per-guild secret is unauthorized');

    // Correct per-guild secret + matching event => processed.
    ingested.length = 0;
    r = await post({ port, guildQuery: G1, secret: G1_SECRET, body: [{ guildId: G1, txSignature: 'sigE' }] });
    assert.strictEqual(r.status, 200, 'enforce: correct per-guild secret authorizes');
    assert.strictEqual(r.body.data.processed, 1, 'enforce: matching event is processed');
    assert.deepStrictEqual(ingested, [G1], 'enforce: event pinned to authenticated guild');

    // Correct secret for G1 but event targets G2 => rejected (cross-tenant blocked).
    ingested.length = 0;
    r = await post({ port, guildQuery: G1, secret: G1_SECRET, body: [{ guildId: G2, txSignature: 'sigF' }] });
    assert.strictEqual(r.status, 200, 'enforce: request authorized for G1');
    assert.strictEqual(r.body.data.rejected, 1, 'enforce: cross-guild event is rejected');
    assert.strictEqual(r.body.data.processed, 0, 'enforce: cross-guild event is not processed');
    assert.deepStrictEqual(ingested, [], 'enforce: nothing ingested for the foreign guild');

    console.log('vault webhook guild-binding assertions passed');
  } finally {
    server.close();
    delete process.env.VAULT_WEBHOOK_ENFORCE_GUILD_MATCH;
    delete process.env.VAULT_MINT_WEBHOOK_SECRET;
    delete process.env[`VAULT_WEBHOOK_SECRET_${G1}`];
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
