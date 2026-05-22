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
  const guildId = `guild-role-panel-stale-${Date.now()}`;
  const staleChannelId = 'channel-stale';
  const staleMessageId = 'message-stale';
  const newMessageId = `msg-new-${Date.now()}`;

  const panelInfo = db.prepare(`
    INSERT INTO role_panels (guild_id, title, description, channel_id, message_id, single_select)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(guildId, 'Stale Panel', 'Panel stale reconcile test', staleChannelId, staleMessageId);
  const panelId = Number(panelInfo.lastInsertRowid);

  db.prepare(`
    INSERT INTO role_panel_roles (panel_id, role_id, label, enabled, sort_order)
    VALUES (?, ?, ?, 1, 1)
  `).run(panelId, 'role-1', 'Role 1');

  let sendCalls = 0;
  const mockChannel = {
    messages: {
      fetch: async () => {
        throw new Error('Unknown Message');
      },
    },
    send: async () => {
      sendCalls += 1;
      return { id: newMessageId };
    },
  };

  const router = createAdminRolePanelsRouter({
    logger: { error: () => {} },
    adminAuthMiddleware: (req, _res, next) => next(),
    ensureSelfServeRolesModule: () => true,
    fetchGuildById: async () => null,
    getClient: () => ({
      channels: {
        cache: {
          get: (id) => (id === staleChannelId ? mockChannel : null),
        },
        fetch: async (id) => (id === staleChannelId ? mockChannel : null),
      },
      user: {
        displayAvatarURL: () => null,
      },
    }),
  });

  const layer = router.stack.find(entry => entry.route && entry.route.path === '/api/admin/role-panels/:id/post');
  assert.ok(layer, 'post route should exist');
  const handlers = layer.route.stack.map(entry => entry.handle);

  const req = {
    params: { id: String(panelId) },
    body: { channelId: staleChannelId },
    guildId,
  };
  const res = makeMockRes();
  await runRouteHandlers(handlers, req, res);

  assert.strictEqual(res.statusCode, 200, 'stale panel repost should succeed');
  assert.strictEqual(sendCalls, 1, 'stale message should trigger a fresh panel send');
  assert.strictEqual(res.body?.success, true, 'success payload expected');

  const row = db.prepare('SELECT channel_id, message_id FROM role_panels WHERE id = ? LIMIT 1').get(panelId);
  assert.strictEqual(String(row?.channel_id || ''), staleChannelId, 'panel channel should remain target channel');
  assert.strictEqual(String(row?.message_id || ''), newMessageId, 'panel should persist new message id after stale recovery');

  db.prepare('DELETE FROM role_panel_roles WHERE panel_id = ?').run(panelId);
  db.prepare('DELETE FROM role_panels WHERE id = ?').run(panelId);

  console.log('role panel stale reconcile assertions passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});

