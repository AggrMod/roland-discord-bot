#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDbPath = path.join(
  os.tmpdir(),
  `guildpilot-token-limits-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
);
process.env.DATABASE_PATH = tempDbPath;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MULTITENANT_ENABLED = process.env.MULTITENANT_ENABLED || 'true';

const db = require('../database/db');
const tenantService = require('../services/tenantService');
const entitlementService = require('../services/entitlementService');
const trackedWalletsService = require('../services/trackedWalletsService');

function cleanup() {
  try { db.close(); } catch (_error) {}
  try { fs.unlinkSync(tempDbPath); } catch (_error) {}
}

function run() {
  const guildId = `14681${String(Date.now()).slice(-13)}`;
  tenantService.ensureTenant(guildId, 'Token Limits Guild');

  const lockLimit = entitlementService.setTenantModuleOverride(guildId, 'tokentracker', 'max_tokens', 0);
  assert.strictEqual(lockLimit.success, true, 'should set token tracker limit override');

  const blocked = trackedWalletsService.addTrackedToken({
    guildId,
    tokenMint: `mint-blocked-${Date.now()}`,
    tokenSymbol: 'BLK',
    enabled: true,
  });
  assert.strictEqual(blocked.success, false, 'token add should be blocked when max_tokens=0');
  assert.strictEqual(String(blocked.code || ''), 'limit_exceeded', 'blocked token add should return limit_exceeded code');

  const unlockLimit = entitlementService.setTenantModuleOverride(guildId, 'tokentracker', 'max_tokens', 2);
  assert.strictEqual(unlockLimit.success, true, 'should raise token tracker limit override');

  const allowed = trackedWalletsService.addTrackedToken({
    guildId,
    tokenMint: `mint-allowed-${Date.now()}`,
    tokenSymbol: 'OK',
    enabled: true,
  });
  assert.strictEqual(allowed.success, true, 'token add should succeed once limit is raised');
}

try {
  run();
  console.log('token tracker plan limit assertions passed');
} catch (error) {
  console.error('token tracker plan limit test failed:', error);
  process.exitCode = 1;
} finally {
  cleanup();
}
