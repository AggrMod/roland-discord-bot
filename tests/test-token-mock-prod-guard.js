#!/usr/bin/env node

// Fix A (audit H-3): tokenService must never let fabricated (mock) balances
// decide token-gated roles in production. Mirrors nftService's guard.
//
// Constructor behavior depends on env at module-load time, so the load-time
// cases run in child processes; the runtime suppression case runs in-process
// (this process is started in production mode with MOCK_MODE off).

process.env.NODE_ENV = 'production';
process.env.MOCK_MODE = 'false';
delete process.env.ALLOW_MOCK_IN_PROD;

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');

function loadTokenServiceInChild(extraEnv) {
  return spawnSync(
    process.execPath,
    ['-e', "require('./services/tokenService'); console.log('LOADED_OK');"],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DB_BACKUP_ENABLED: 'false',
        DB_BACKUP_ON_STARTUP: 'false',
        ...extraEnv,
      },
    }
  );
}

async function run() {
  const tokenService = require('../services/tokenService');
  const tenantService = require('../services/tenantService');

  const originals = {
    isMultitenantEnabled: tenantService.isMultitenantEnabled.bind(tenantService),
    getTenantContext: tenantService.getTenantContext.bind(tenantService),
  };

  try {
    // --- Runtime suppression: prod + tenant mock enabled => empty, never mock ---
    tenantService.isMultitenantEnabled = () => true;
    tenantService.getTenantContext = (guildId) => ({
      guildId,
      limits: { mockDataEnabled: true },
    });

    const wallet = 'So11111111111111111111111111111111111111112';
    const balances = await tokenService.getWalletTokenBalances(wallet, { guildId: 'guild-mock' });
    assert.deepStrictEqual(
      balances,
      [],
      'production must return empty balances (not fabricated mock) even when tenant mock is enabled'
    );

    // Sanity: the mock generator itself still produces balances (proves the
    // empty result above is the guard, not a broken mock path).
    const rawMock = tokenService.getMockTokenBalances(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']);
    assert.ok(Array.isArray(rawMock) && rawMock.length > 0, 'mock generator should still produce balances when called directly');
  } finally {
    tenantService.isMultitenantEnabled = originals.isMultitenantEnabled;
    tenantService.getTenantContext = originals.getTenantContext;
  }

  // --- Load-time guard: prod + MOCK_MODE + no opt-in => refuse to load ---
  const refused = loadTokenServiceInChild({ NODE_ENV: 'production', MOCK_MODE: 'true', ALLOW_MOCK_IN_PROD: '' });
  assert.notStrictEqual(refused.status, 0, 'tokenService must refuse to load in production with MOCK_MODE enabled');
  assert.ok(
    /MOCK_MODE is not allowed in production/.test(`${refused.stderr || ''}${refused.stdout || ''}`),
    'refusal should explain the MOCK_MODE-in-production reason'
  );

  // --- Explicit opt-in: prod + MOCK_MODE + ALLOW_MOCK_IN_PROD => loads ---
  const optIn = loadTokenServiceInChild({ NODE_ENV: 'production', MOCK_MODE: 'true', ALLOW_MOCK_IN_PROD: 'true' });
  assert.strictEqual(optIn.status, 0, 'explicit ALLOW_MOCK_IN_PROD must permit load in production');
  assert.ok(/LOADED_OK/.test(optIn.stdout || ''), 'opt-in load should complete');

  // --- Non-production: mock is allowed normally ---
  const dev = loadTokenServiceInChild({ NODE_ENV: 'development', MOCK_MODE: 'true', ALLOW_MOCK_IN_PROD: '' });
  assert.strictEqual(dev.status, 0, 'non-production should permit MOCK_MODE');
  assert.ok(/LOADED_OK/.test(dev.stdout || ''), 'non-production load should complete');

  console.log('token mock prod-guard assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
