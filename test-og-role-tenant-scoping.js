const assert = require('assert');

process.env.MULTITENANT_ENABLED = 'true';

const tenantService = require('./services/tenantService');
const ogRoleService = require('./services/ogRoleService');

function makeGuildId(prefix) {
  const seed = Date.now().toString().slice(-12);
  const raw = `${prefix}${seed}`;
  return raw.slice(0, 20).padEnd(18, '0');
}

function run() {
  const guildA = makeGuildId('333');
  const guildB = makeGuildId('444');

  tenantService.ensureTenant(guildA);
  tenantService.ensureTenant(guildB);

  let result = ogRoleService.setRole('123456789012345678', guildA);
  assert.strictEqual(result.success, true, 'Guild A role set should succeed');
  result = ogRoleService.setLimit(12, guildA);
  assert.strictEqual(result.success, true, 'Guild A limit set should succeed');
  result = ogRoleService.setEnabled(true, guildA);
  assert.strictEqual(result.success, true, 'Guild A enable should succeed');

  result = ogRoleService.setRole('223456789012345678', guildB);
  assert.strictEqual(result.success, true, 'Guild B role set should succeed');
  result = ogRoleService.setLimit(5, guildB);
  assert.strictEqual(result.success, true, 'Guild B limit set should succeed');
  result = ogRoleService.setEnabled(true, guildB);
  assert.strictEqual(result.success, true, 'Guild B enable should succeed');

  const cfgA = ogRoleService.getConfig(guildA);
  const cfgB = ogRoleService.getConfig(guildB);

  assert.strictEqual(cfgA.roleId, '123456789012345678', 'Guild A role should remain isolated');
  assert.strictEqual(cfgB.roleId, '223456789012345678', 'Guild B role should remain isolated');
  assert.strictEqual(Number(cfgA.limit), 12, 'Guild A limit should remain isolated');
  assert.strictEqual(Number(cfgB.limit), 5, 'Guild B limit should remain isolated');
  assert.strictEqual(Boolean(cfgA.enabled), true, 'Guild A should be enabled');
  assert.strictEqual(Boolean(cfgB.enabled), true, 'Guild B should be enabled');

  result = ogRoleService.setEnabled(false, guildA);
  assert.strictEqual(result.success, true, 'Guild A disable should succeed');

  const afterDisableA = ogRoleService.getConfig(guildA);
  const afterDisableB = ogRoleService.getConfig(guildB);

  assert.strictEqual(afterDisableA.roleId, null, 'Guild A disable should clear only guild A role');
  assert.strictEqual(afterDisableB.roleId, '223456789012345678', 'Guild B role must remain unchanged');

  console.log('OG role tenant scoping assertions passed');
}

try {
  run();
  process.exit(0);
} catch (error) {
  console.error('OG role tenant scoping test failed:', error.message);
  process.exit(1);
}
