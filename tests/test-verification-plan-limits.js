#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDbPath = path.join(
  os.tmpdir(),
  `guildpilot-verification-limits-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
);
process.env.DATABASE_PATH = tempDbPath;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MULTITENANT_ENABLED = process.env.MULTITENANT_ENABLED || 'true';

const db = require('../database/db');
const tenantService = require('../services/tenantService');
const entitlementService = require('../services/entitlementService');
const roleService = require('../services/roleService');

function cleanup() {
  try { db.close(); } catch (_error) {}
  try { fs.unlinkSync(tempDbPath); } catch (_error) {}
}

function run() {
  const guildId = `14681${String(Date.now()).slice(-13)}`;
  tenantService.ensureTenant(guildId, 'Verification Limits Guild');

  const setLimit = entitlementService.setTenantModuleOverride(guildId, 'verification', 'max_token_rules', 1);
  assert.strictEqual(setLimit.success, true, 'should set verification token rule limit override');

  const first = roleService.addTokenRoleRule({
    guildId,
    tokenMint: `mint-a-${Date.now()}`,
    roleId: '123456789012345678',
    minAmount: 1,
    enabled: true,
  });
  assert.strictEqual(first.success, true, 'first token rule should succeed within limit');

  const second = roleService.addTokenRoleRule({
    guildId,
    tokenMint: `mint-b-${Date.now()}`,
    roleId: '223456789012345678',
    minAmount: 1,
    enabled: true,
  });
  assert.strictEqual(second.success, false, 'second token rule should be blocked at limit');
  assert.strictEqual(String(second.code || ''), 'limit_exceeded', 'blocked rule should return limit_exceeded');
  assert.match(String(second.message || ''), /limit reached/i, 'blocked rule should include clear limit message');
}

try {
  run();
  console.log('verification plan limit assertions passed');
} catch (error) {
  console.error('verification plan limit test failed:', error);
  process.exitCode = 1;
} finally {
  cleanup();
}
