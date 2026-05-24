#!/usr/bin/env node

const assert = require('assert');
const { getPlanPreset } = require('../config/plans');

function run() {
  const starter = getPlanPreset('starter');
  const growth = getPlanPreset('growth');
  const pro = getPlanPreset('pro');

  // Module enablement policy
  assert.strictEqual(starter.modules.aiassistant, false, 'starter: aiassistant must be disabled');
  assert.strictEqual(growth.modules.aiassistant, false, 'growth: aiassistant must be disabled');
  assert.strictEqual(pro.modules.aiassistant, true, 'pro: aiassistant must be enabled');

  for (const [moduleKey, enabled] of Object.entries(starter.modules)) {
    if (moduleKey === 'aiassistant') continue;
    assert.strictEqual(enabled, true, `starter: module ${moduleKey} should be enabled`);
  }
  for (const [moduleKey, enabled] of Object.entries(growth.modules)) {
    if (moduleKey === 'aiassistant') continue;
    assert.strictEqual(enabled, true, `growth: module ${moduleKey} should be enabled`);
  }

  // Engagement provider policy
  assert.strictEqual(Number(starter.moduleLimits.engagement.allow_discord_provider), 1, 'starter: discord provider enabled');
  assert.strictEqual(Number(starter.moduleLimits.engagement.allow_x_provider), 0, 'starter: x provider disabled');
  assert.strictEqual(Number(growth.moduleLimits.engagement.allow_discord_provider), 1, 'growth: discord provider enabled');
  assert.strictEqual(Number(growth.moduleLimits.engagement.allow_x_provider), 1, 'growth: x provider enabled');
  assert.strictEqual(Number(pro.moduleLimits.engagement.allow_discord_provider), 1, 'pro: discord provider enabled');
  assert.strictEqual(Number(pro.moduleLimits.engagement.allow_x_provider), 1, 'pro: x provider enabled');

  // "All modules enabled" promise (no max enabled module cap)
  assert.strictEqual(starter.limits.max_enabled_modules, null, 'starter: max_enabled_modules should be null');
  assert.strictEqual(growth.limits.max_enabled_modules, null, 'growth: max_enabled_modules should be null');
  assert.strictEqual(pro.limits.max_enabled_modules, null, 'pro: max_enabled_modules should be null');

  console.log('plan preset policy assertions passed');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
