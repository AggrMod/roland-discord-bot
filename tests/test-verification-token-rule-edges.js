#!/usr/bin/env node

const assert = require('assert');
const roleService = require('../services/roleService');
const tokenService = require('../services/tokenService');

const originalGetTokenRoleRules = roleService.getTokenRoleRules.bind(roleService);
const originalIsProtectedRole = roleService.isProtectedRole.bind(roleService);
const originalCanBotManageRole = roleService.canBotManageRole.bind(roleService);
const originalGetAggregateBalancesForWallets = tokenService.getAggregateBalancesForWallets.bind(tokenService);

async function run() {
  roleService.getTokenRoleRules = () => ([
    { roleId: 'role-add', tokenMint: 'mint-add', tokenSymbol: 'ADD', minAmount: 1, maxAmount: 10, enabled: true, neverRemove: false },
    { roleId: 'role-remove', tokenMint: 'mint-remove', tokenSymbol: 'REM', minAmount: 1, maxAmount: 10, enabled: true, neverRemove: false },
    { roleId: 'role-keep', tokenMint: 'mint-keep', tokenSymbol: 'KEEP', minAmount: 1, maxAmount: 10, enabled: true, neverRemove: true },
  ]);
  roleService.isProtectedRole = () => false;
  roleService.canBotManageRole = () => true;
  tokenService.getAggregateBalancesForWallets = async () => ({
    'mint-add': 5,
    'mint-remove': 20,
    'mint-keep': 20,
  });

  const added = [];
  const removed = [];
  const guildRoles = new Map([
    ['role-add', { id: 'role-add', name: 'Role Add', position: 1, managed: false, permissions: { has: () => false } }],
    ['role-remove', { id: 'role-remove', name: 'Role Remove', position: 1, managed: false, permissions: { has: () => false } }],
    ['role-keep', { id: 'role-keep', name: 'Role Keep', position: 1, managed: false, permissions: { has: () => false } }],
  ]);
  const roleCache = new Map([
    ['role-remove', { id: 'role-remove' }],
    ['role-keep', { id: 'role-keep' }],
  ]);

  const member = {
    id: 'user-token-edges',
    user: { tag: 'tokenedges#0001' },
    guild: {
      id: 'guild-token-edges',
      roles: { cache: guildRoles },
      members: {
        me: { roles: { highest: { position: 100 } } },
      },
    },
    roles: {
      cache: roleCache,
      add: async (role) => {
        added.push(role.id);
        roleCache.set(role.id, { id: role.id });
      },
      remove: async (role) => {
        removed.push(role.id);
        roleCache.delete(role.id);
      },
    },
  };

  const changes = await roleService.syncTokenRoles(
    member,
    ['wallet-a'],
    'guild-token-edges',
    new Set(['role-remove', 'role-keep'])
  );

  assert.ok(added.includes('role-add'), 'role should be added when balance is within min/max range');
  assert.ok(removed.includes('role-remove'), 'role should be removed when balance exceeds maxAmount');
  assert.strictEqual(removed.includes('role-keep'), false, 'neverRemove role should not be removed when out of range');
  assert.strictEqual(roleCache.has('role-add'), true, 'added role should exist on member');
  assert.strictEqual(roleCache.has('role-remove'), false, 'removed role should no longer exist on member');
  assert.strictEqual(roleCache.has('role-keep'), true, 'neverRemove role should remain on member');
  assert.ok(changes.added.some((entry) => String(entry).includes('ADD')), 'change summary should include added ADD label');
  assert.ok(changes.removed.some((entry) => String(entry).includes('REM')), 'change summary should include removed REM label');
  assert.strictEqual(changes.added.length, 1, 'one token role should be added');
  assert.strictEqual(changes.removed.length, 1, 'one token role should be removed');

  console.log('verification token rule edge assertions passed');
}

run()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    roleService.getTokenRoleRules = originalGetTokenRoleRules;
    roleService.isProtectedRole = originalIsProtectedRole;
    roleService.canBotManageRole = originalCanBotManageRole;
    tokenService.getAggregateBalancesForWallets = originalGetAggregateBalancesForWallets;
  });
