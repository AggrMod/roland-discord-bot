#!/usr/bin/env node

// Fix D (audit M-1): plan-identity gate in setTenantModule.
// Plan entitlement enforcement is on by default. Monitor/off remain explicit
// operational escape hatches.

process.env.MULTITENANT_ENABLED = 'true';

const assert = require('assert');
const tenantService = require('../services/tenantService');

// Guild IDs must be Discord snowflakes (17-20 digit numeric strings).
function freshGuild() {
  const guildId = `${Date.now()}${Math.floor(Math.random() * 90000 + 10000)}`; // 18 digits
  tenantService.ensureTenant(guildId); // default plan = starter (aiassistant: false)
  return guildId;
}

function run() {
  // --- Default (flag unset): secure-by-default gating ---
  delete process.env.MODULE_IDENTITY_ENFORCE;
  let g = freshGuild();
  let r = tenantService.setTenantModule(g, 'aiassistant', true, 'tester');
  assert.strictEqual(r.success, false, 'default mode must block out-of-plan modules');
  assert.strictEqual(r.code, 'module_not_in_plan');

  // --- Explicit off: emergency/migration escape hatch ---
  process.env.MODULE_IDENTITY_ENFORCE = 'off';
  g = freshGuild();
  r = tenantService.setTenantModule(g, 'aiassistant', true, 'tester');
  assert.strictEqual(r.success, true, 'explicit off mode must not block');

  // --- Monitor: logs but does not block ---
  process.env.MODULE_IDENTITY_ENFORCE = 'monitor';
  g = freshGuild();
  r = tenantService.setTenantModule(g, 'aiassistant', true, 'tester');
  assert.strictEqual(r.success, true, 'monitor mode must not block');

  // --- Enforce: blocks a module not in the plan ---
  process.env.MODULE_IDENTITY_ENFORCE = 'enforce';
  g = freshGuild();
  r = tenantService.setTenantModule(g, 'aiassistant', true, 'tester');
  assert.strictEqual(r.success, false, 'enforce must block aiassistant on starter');
  assert.strictEqual(r.code, 'module_not_in_plan', 'block reason is module_not_in_plan');

  // --- Enforce: a plan-included module still enables ---
  r = tenantService.setTenantModule(g, 'governance', true, 'tester');
  assert.strictEqual(r.success, true, 'enforce must allow a plan-included module');

  // --- Enforce + bypass (operator/superadmin): allowed ---
  r = tenantService.setTenantModule(g, 'aiassistant', true, 'tester', { bypassPlanGate: true });
  assert.strictEqual(r.success, true, 'bypassPlanGate must allow operator/superadmin grants');

  // --- Grandfathered: already-enabled module is not disturbed in enforce ---
  r = tenantService.setTenantModule(g, 'aiassistant', true, 'tester');
  assert.strictEqual(r.success, true, 'already-enabled module must not be blocked in enforce');

  // --- Enforce on a Pro tenant: aiassistant is in-plan, so allowed ---
  const proGuild = freshGuild();
  tenantService.setTenantPlan(proGuild, 'pro', 'tester');
  r = tenantService.setTenantModule(proGuild, 'aiassistant', true, 'tester');
  assert.strictEqual(r.success, true, 'aiassistant is included in pro plan, must be allowed under enforce');

  delete process.env.MODULE_IDENTITY_ENFORCE;
  console.log('module-identity gate assertions passed');
}

run();
