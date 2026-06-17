const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-bridge-routes-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.MULTITENANT_ENABLED = 'true';
process.env.TELEGRAM_WEBHOOK_SECRET = 'route-secret';

require('../database/db');
const tenantService = require('../services/tenantService');
const telegramBridgeService = require('../services/telegramBridgeService');
const createRouter = require('../web/routes/adminTelegramBridge');

const guildId = '523456789012345678';
const channelId = '623456789012345678';
tenantService.ensureTenant(guildId, 'Route Guild');
tenantService.setTenantPlan(guildId, 'pro', 'test');
tenantService.setTenantModule(guildId, 'telegrambridge', true, 'test');

const app = express();
app.use(express.json());
app.use(createRouter({
  logger: { error: () => {}, warn: () => {}, log: () => {} },
  adminAuthMiddleware: (req, _res, next) => {
    req.guildId = guildId;
    req.session = { discordUser: { id: 'admin' } };
    next();
  },
  ensureTelegramBridgeModule: () => true,
  telegramBridgeService,
  timingSafeEquals: (a, b) => a === b,
  fetchGuildById: async () => ({
    channels: {
      fetch: async (id) => id === channelId ? {
        id,
        isTextBased: () => true,
        permissionsFor: () => ({ has: () => true }),
      } : null,
    },
    members: { me: { id: 'bot' } },
  }),
}));

function listen(appInstance) {
  return new Promise((resolve) => {
    const server = http.createServer(appInstance);
    server.listen(0, () => resolve(server));
  });
}

async function request(baseUrl, method, url, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  return { response, json };
}

(async () => {
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await request(baseUrl, 'POST', '/api/admin/telegram-bridge/mappings', {
      name: 'Route Sync',
      telegramChatId: '-100111222333',
      telegramChatTitle: 'Route Announcements',
      telegramChatType: 'channel',
      discordChannelId: channelId,
    });
    assert.strictEqual(created.response.status, 200);
    assert.strictEqual(created.json.success, true);
    const mappingId = created.json.data.mapping.id;

    const badChannel = await request(baseUrl, 'POST', '/api/admin/telegram-bridge/mappings', {
      telegramChatId: '-100111222334',
      discordChannelId: '723456789012345678',
    });
    assert.strictEqual(badChannel.response.status, 400);

    telegramBridgeService.recordAudit({
      guildId,
      mappingId,
      telegramChatId: '-100111222333',
      discordChannelId: channelId,
      status: 'failed',
      eventType: 'message',
      message: 'route test failure',
    });
    const audit = await request(baseUrl, 'GET', `/api/admin/telegram-bridge/audit?mappingId=${mappingId}&status=failed`);
    assert.strictEqual(audit.response.status, 200);
    assert.strictEqual(audit.json.success, true);
    assert.strictEqual(audit.json.data.audit.length, 1);

    const webhookBad = await request(baseUrl, 'POST', '/api/webhooks/telegram/wrong', { update_id: 1 });
    assert.strictEqual(webhookBad.response.status, 401);

    const webhookOk = await request(baseUrl, 'POST', '/api/webhooks/telegram/route-secret', { update_id: 1 });
    assert.strictEqual(webhookOk.response.status, 200);

    console.log('telegram bridge route assertions passed');
  } finally {
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
