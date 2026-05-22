#!/usr/bin/env node

const assert = require('assert');
const db = require('../database/db');
const createAdminRolePanelsRouter = require('../web/routes/adminRolePanels');

function makeMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function runRouteHandlers(handlers, req, res) {
  let idx = 0;
  const next = async () => {
    const handler = handlers[idx++];
    if (!handler) return;
    await handler(req, res, next);
  };
  await next();
}

async function run() {
  const guildId = `guild-role-panel-limit-${Date.now()}`;
  const panelInfo = db.prepare(`
    INSERT INTO role_panels (guild_id, title, description, channel_id, single_select)
    VALUES (?, ?, ?, ?, 0)
  `).run(guildId, 'Limit Panel', 'Panel for limit test', 'channel-test');
  const panelId = Number(panelInfo.lastInsertRowid);

  for (let i = 0; i < 26; i += 1) {
    db.prepare(`
      INSERT INTO role_panel_roles (panel_id, role_id, label, enabled, sort_order)
      VALUES (?, ?, ?, 1, ?)
    `).run(panelId, `role-${i}`, `Role ${i}`, i);
  }

  const router = createAdminRolePanelsRouter({
    logger: { error: () => {} },
    adminAuthMiddleware: (req, _res, next) => next(),
    ensureSelfServeRolesModule: () => true,
    fetchGuildById: async () => null,
    getClient: () => null,
  });

  const layer = router.stack.find(entry => entry.route && entry.route.path === '/api/admin/role-panels/:id/post');
  assert.ok(layer, 'post route should exist');

  const handlers = layer.route.stack.map(entry => entry.handle);
  const req = {
    params: { id: String(panelId) },
    body: { channelId: 'channel-any' },
    guildId,
  };
  const res = makeMockRes();
  await runRouteHandlers(handlers, req, res);

  assert.strictEqual(res.statusCode, 400, 'posting panel with more than 25 enabled roles should fail');
  assert.ok(
    String(res.body?.error?.message || '').includes('max 25 role buttons'),
    'error message should clearly explain Discord 25-button limit'
  );

  db.prepare('DELETE FROM role_panel_roles WHERE panel_id = ?').run(panelId);
  db.prepare('DELETE FROM role_panels WHERE id = ?').run(panelId);

  console.log('role panel max-size posting guard assertions passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});

