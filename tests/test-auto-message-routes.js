const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-message-routes-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.MULTITENANT_ENABLED = 'true';

require('../database/db');
const tenantService = require('../services/tenantService');
const clientProvider = require('../utils/clientProvider');
const autoMessageService = require('../services/autoMessageService');
const createRouter = require('../web/routes/adminAutoMessages');

const guildId = '633456789012345678';
const channelId = '733456789012345678';
tenantService.ensureTenant(guildId, 'Auto Route Guild');
tenantService.setTenantPlan(guildId, 'pro', 'test');
tenantService.setTenantModule(guildId, 'automessages', true, 'test');

const sentMessages = [];
clientProvider.setClient({
  channels: {
    fetch: async (id) => id === channelId ? {
      id,
      isTextBased: () => true,
      send: async (payload) => {
        const sent = { id: `route-${sentMessages.length + 1}`, payload };
        sentMessages.push(sent);
        return sent;
      },
    } : null,
  },
});

const app = express();
app.use(express.json());
app.use(createRouter({
  logger: { error: () => {}, warn: () => {}, log: () => {} },
  adminAuthMiddleware: (req, _res, next) => {
    req.guildId = guildId;
    req.session = { discordUser: { id: 'admin' } };
    next();
  },
  ensureAutoMessagesModule: () => true,
  autoMessageService,
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
    const created = await request(baseUrl, 'POST', '/api/admin/auto-messages/messages', {
      name: 'Route Auto',
      channelId,
      scheduleType: 'daily',
      scheduleConfig: { time: '09:00' },
      timezone: 'Europe/Amsterdam',
      embed: { title: 'Route Auto', description: 'Route description', color: '#2AABEE' },
    });
    assert.strictEqual(created.response.status, 200);
    assert.strictEqual(created.json.success, true);
    const messageId = created.json.data.message.id;

    const badChannel = await request(baseUrl, 'POST', '/api/admin/auto-messages/messages', {
      name: 'Bad Auto',
      channelId: '833456789012345678',
      embed: { title: 'Bad', description: 'Bad' },
    });
    assert.strictEqual(badChannel.response.status, 400);

    const list = await request(baseUrl, 'GET', '/api/admin/auto-messages/messages');
    assert.strictEqual(list.response.status, 200);
    assert.strictEqual(list.json.data.messages.length, 1);

    const test = await request(baseUrl, 'POST', `/api/admin/auto-messages/messages/${messageId}/test`);
    assert.strictEqual(test.response.status, 200);
    assert.strictEqual(sentMessages.length, 1);

    const audit = await request(baseUrl, 'GET', `/api/admin/auto-messages/audit?messageId=${messageId}&status=test`);
    assert.strictEqual(audit.response.status, 200);
    assert.strictEqual(audit.json.data.audit.length, 1);

    const updated = await request(baseUrl, 'PUT', `/api/admin/auto-messages/messages/${messageId}`, {
      name: 'Route Auto Updated',
      channelId,
      scheduleType: 'weekly',
      scheduleConfig: { time: '10:00', weekdays: ['fri'] },
      timezone: 'Europe/Amsterdam',
      embed: { title: 'Updated', description: 'Updated description', color: '#2AABEE' },
    });
    assert.strictEqual(updated.response.status, 200);
    assert.strictEqual(updated.json.data.message.scheduleType, 'weekly');

    const deleted = await request(baseUrl, 'DELETE', `/api/admin/auto-messages/messages/${messageId}`);
    assert.strictEqual(deleted.response.status, 200);

    console.log('auto message route assertions passed');
  } finally {
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
