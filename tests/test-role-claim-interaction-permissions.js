#!/usr/bin/env node

const assert = require('assert');
const roleClaimService = require('../services/roleClaimService');
const db = require('../database/db');

function makeGuild({
  guildId,
  roleId = 'role-1',
  rolePosition = 5,
  botHighestPosition = 10,
  botCanManageRoles = true,
  managed = false,
} = {}) {
  const role = {
    id: roleId,
    name: 'Claimable Role',
    position: rolePosition,
    managed,
  };

  return {
    id: guildId,
    roles: {
      cache: new Map([[roleId, role]]),
    },
    members: {
      me: {
        roles: {
          highest: { position: botHighestPosition },
        },
        permissions: {
          has: () => botCanManageRoles,
        },
      },
    },
  };
}

function makeMember({ roleId = 'role-1', hasRole = false } = {}) {
  const roleCache = new Set(hasRole ? [roleId] : []);
  return {
    user: { tag: 'tester#0001' },
    roles: {
      cache: {
        has: (id) => roleCache.has(id),
      },
      add: async () => { roleCache.add(roleId); },
      remove: async () => { roleCache.delete(roleId); },
    },
  };
}

async function run() {
  const stamp = Date.now();
  const guildId = `role-claim-guild-${stamp}`;
  const roleId = `role-${stamp}`;

  // Non-claimable role should be rejected.
  {
    const guild = makeGuild({ guildId, roleId });
    const member = makeMember({ roleId, hasRole: false });
    const res = await roleClaimService.toggleRole(guild, member, roleId);
    assert.strictEqual(res.success, false, 'non-panel role must be rejected');
    assert.match(String(res.message || ''), /not available/i, 'error should mention claimability');
  }

  // Add role to active role panel so toggle checks continue.
  const panel = db.prepare(`
    INSERT INTO role_panels (guild_id, title, description, channel_id, single_select)
    VALUES (?, ?, ?, ?, 0)
  `).run(guildId, 'Claims', 'Claims panel', `chan-${stamp}`);
  const panelId = Number(panel.lastInsertRowid);
  db.prepare(`
    INSERT INTO role_panel_roles (panel_id, role_id, label, enabled, sort_order)
    VALUES (?, ?, ?, 1, 1)
  `).run(panelId, roleId, 'Claimable Role');

  // Bot missing ManageRoles should be rejected.
  {
    const guild = makeGuild({ guildId, roleId, botCanManageRoles: false });
    const member = makeMember({ roleId, hasRole: false });
    const res = await roleClaimService.toggleRole(guild, member, roleId);
    assert.strictEqual(res.success, false, 'toggle must fail when bot lacks ManageRoles');
    assert.match(String(res.message || ''), /ManageRoles/i, 'error should mention ManageRoles');
  }

  // Role hierarchy violation should be rejected.
  {
    const guild = makeGuild({ guildId, roleId, rolePosition: 50, botHighestPosition: 10 });
    const member = makeMember({ roleId, hasRole: false });
    const res = await roleClaimService.toggleRole(guild, member, roleId);
    assert.strictEqual(res.success, false, 'toggle must fail when role above bot');
    assert.match(String(res.message || ''), /hierarchy/i, 'error should mention hierarchy');
  }

  // Happy path: add + remove should both work.
  {
    const guild = makeGuild({ guildId, roleId, rolePosition: 5, botHighestPosition: 10, botCanManageRoles: true });
    const member = makeMember({ roleId, hasRole: false });
    const added = await roleClaimService.toggleRole(guild, member, roleId);
    assert.strictEqual(added.success, true, 'role add should succeed');
    assert.strictEqual(added.action, 'added', 'first toggle should add role');

    const removed = await roleClaimService.toggleRole(guild, member, roleId);
    assert.strictEqual(removed.success, true, 'role remove should succeed');
    assert.strictEqual(removed.action, 'removed', 'second toggle should remove role');
  }

  db.prepare('DELETE FROM role_panel_roles WHERE panel_id = ?').run(panelId);
  db.prepare('DELETE FROM role_panels WHERE id = ?').run(panelId);

  console.log('role claim interaction permission assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

