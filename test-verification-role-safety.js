#!/usr/bin/env node

const assert = require('assert');
const roleService = require('./services/roleService');

const originalGetEffectiveTiers = roleService.getEffectiveTiers.bind(roleService);
const originalGetEffectiveTraitRoles = roleService.getEffectiveTraitRoles.bind(roleService);
const originalGetTokenRoleRules = roleService.getTokenRoleRules.bind(roleService);
const originalIsProtectedRole = roleService.isProtectedRole.bind(roleService);
const originalCanBotManageRole = roleService.canBotManageRole.bind(roleService);

async function run() {
  roleService.getEffectiveTiers = () => ([
    { roleId: 'B', neverRemove: false },
    { roleId: 'C', neverRemove: true },
  ]);
  roleService.getEffectiveTraitRoles = () => ([
    { roleId: 'D', neverRemove: false },
    { roleId: 'C', neverRemove: false },
  ]);
  roleService.getTokenRoleRules = () => ([
    { roleId: 'E', enabled: true, neverRemove: false },
    { roleId: 'F', enabled: false, neverRemove: false },
  ]);
  roleService.isProtectedRole = () => false;
  roleService.canBotManageRole = () => true;

  const managedStates = roleService.getManagedVerificationRoleStates('guild-test');
  assert.strictEqual(managedStates.has('A'), false, 'unconfigured role A must never be managed');
  assert.strictEqual(managedStates.has('B'), true, 'configured tier role B should be managed');
  assert.strictEqual(managedStates.has('C'), true, 'configured role C should be managed');
  assert.strictEqual(managedStates.has('D'), true, 'configured trait role D should be managed');
  assert.strictEqual(managedStates.has('E'), true, 'configured token role E should be managed');
  assert.strictEqual(managedStates.has('F'), false, 'disabled token rule role F should not be managed');
  assert.strictEqual(managedStates.get('C').neverRemove, true, 'neverRemove should be preserved across rule sources');

  const guildRoles = new Map([
    ['A', { id: 'A', name: 'Role A', position: 1, managed: false, permissions: { has: () => false } }],
    ['B', { id: 'B', name: 'Role B', position: 1, managed: false, permissions: { has: () => false } }],
    ['C', { id: 'C', name: 'Role C', position: 1, managed: false, permissions: { has: () => false } }],
    ['D', { id: 'D', name: 'Role D', position: 1, managed: false, permissions: { has: () => false } }],
    ['E', { id: 'E', name: 'Role E', position: 1, managed: false, permissions: { has: () => false } }],
  ]);

  const removed = [];
  const member = {
    id: 'user-1',
    user: { tag: 'tester#0001' },
    guild: {
      id: 'guild-test',
      roles: { cache: guildRoles },
      members: {
        me: { roles: { highest: { position: 100 } } },
      },
    },
    roles: {
      cache: new Map([['A', {}], ['B', {}], ['C', {}], ['E', {}]]),
      remove: async (role) => {
        removed.push(role.id);
      },
    },
  };

  const guild = {
    id: 'guild-test',
    roles: { cache: guildRoles },
    members: {
      me: { roles: { highest: { position: 100 } } },
      fetch: async (userId) => {
        assert.strictEqual(userId, 'user-1', 'remove method should fetch requested user');
        return member;
      },
    },
  };

  const safeRemovalResult = await roleService.removeAllManagedVerificationRoles(guild, 'user-1', 'guild-test', { respectNeverRemove: true });
  assert.strictEqual(safeRemovalResult.success, true, 'safe removal should succeed');
  assert.deepStrictEqual(removed.sort(), ['B', 'E'], 'only configured removable roles should be removed');
  assert.strictEqual(removed.includes('A'), false, 'unconfigured role A must never be removed');
  assert.strictEqual(removed.includes('C'), false, 'neverRemove role C must not be removed');

  removed.length = 0;
  const forceRemovalResult = await roleService.removeAllManagedVerificationRoles(guild, 'user-1', 'guild-test', { respectNeverRemove: false });
  assert.strictEqual(forceRemovalResult.success, true, 'force removal should succeed');
  assert.strictEqual(removed.includes('C'), true, 'force mode may remove neverRemove role C');

  console.log('Verification role safety assertions passed');
}

run()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    roleService.getEffectiveTiers = originalGetEffectiveTiers;
    roleService.getEffectiveTraitRoles = originalGetEffectiveTraitRoles;
    roleService.getTokenRoleRules = originalGetTokenRoleRules;
    roleService.isProtectedRole = originalIsProtectedRole;
    roleService.canBotManageRole = originalCanBotManageRole;
  });
