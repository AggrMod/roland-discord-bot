const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-message-service-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.MULTITENANT_ENABLED = 'true';

const db = require('../database/db');
const tenantService = require('../services/tenantService');
const clientProvider = require('../utils/clientProvider');
const autoMessageService = require('../services/autoMessageService');

const guildId = '133456789012345678';
const channelA = '233456789012345678';
const channelB = '333456789012345678';

tenantService.ensureTenant(guildId, 'Auto Message Guild');
tenantService.setTenantPlan(guildId, 'pro', 'test');
tenantService.setTenantModule(guildId, 'automessages', true, 'test');

const sentByChannel = new Map();
function makeChannel(id, shouldFail = false) {
  if (!sentByChannel.has(id)) sentByChannel.set(id, []);
  return {
    id,
    isTextBased: () => true,
    send: async (payload) => {
      if (shouldFail) throw new Error('send failed');
      const arr = sentByChannel.get(id);
      const message = { id: `${id}-${arr.length + 1}`, payload };
      arr.push(message);
      return message;
    },
  };
}

clientProvider.setClient({
  channels: {
    fetch: async (id) => {
      if (id === channelA) return makeChannel(channelA);
      if (id === channelB) return makeChannel(channelB);
      if (id === '433456789012345678') return makeChannel(id, true);
      return null;
    },
  },
});

function createPayload(name, channelId, scheduleConfig = { value: 15, unit: 'minutes' }) {
  return {
    name,
    channelId,
    enabled: true,
    scheduleType: 'interval',
    scheduleConfig,
    timezone: 'Europe/Amsterdam',
    embed: {
      title: name,
      description: `Description for ${name}`,
      color: '#2AABEE',
    },
  };
}

(async () => {
  const first = autoMessageService.createMessage(guildId, createPayload('First', channelA));
  assert.strictEqual(first.success, true);
  const second = autoMessageService.createMessage(guildId, createPayload('Second', channelB));
  assert.strictEqual(second.success, true);

  db.prepare('UPDATE auto_messages SET next_run_at = ? WHERE guild_id = ?').run(new Date(Date.now() - 60 * 1000).toISOString(), guildId);
  const summary = await autoMessageService.runDueMessages(new Date());
  assert.strictEqual(summary.sent, 2);
  assert.strictEqual(sentByChannel.get(channelA).length, 1);
  assert.strictEqual(sentByChannel.get(channelB).length, 1);
  assert.ok(Array.isArray(sentByChannel.get(channelA)[0].payload.embeds), 'auto message should send embeds');

  const intervalNext = autoMessageService.computeNextRun({
    scheduleType: 'interval',
    scheduleConfig: { value: 30, unit: 'minutes' },
    timezone: 'Europe/Amsterdam',
  }, new Date('2026-06-17T10:00:00.000Z'));
  assert.strictEqual(intervalNext.toISOString(), '2026-06-17T10:30:00.000Z');

  const dailyNext = autoMessageService.computeNextRun({
    scheduleType: 'daily',
    scheduleConfig: { time: '09:00' },
    timezone: 'Europe/Amsterdam',
  }, new Date('2026-06-17T08:00:00.000Z'));
  assert.ok(dailyNext > new Date('2026-06-17T08:00:00.000Z'));

  const weeklyNext = autoMessageService.computeNextRun({
    scheduleType: 'weekly',
    scheduleConfig: { time: '09:00', weekdays: ['mon'] },
    timezone: 'Europe/Amsterdam',
  }, new Date('2026-06-17T08:00:00.000Z'));
  assert.strictEqual(weeklyNext.getUTCDay(), 1);

  const missed = autoMessageService.computeNextRun({
    scheduleType: 'daily',
    scheduleConfig: { time: '09:00' },
    timezone: 'Europe/Amsterdam',
  }, new Date('2026-06-17T12:00:00.000Z'));
  assert.ok(missed > new Date('2026-06-17T12:00:00.000Z'), 'missed daily run should move to future');

  autoMessageService.updateSettings(guildId, { enabled: false });
  db.prepare('UPDATE auto_messages SET next_run_at = ? WHERE guild_id = ?').run(new Date(Date.now() - 60 * 1000).toISOString(), guildId);
  const beforeSkip = sentByChannel.get(channelA).length + sentByChannel.get(channelB).length;
  const skipped = await autoMessageService.runDueMessages(new Date());
  assert.strictEqual(skipped.skipped, 2);
  assert.strictEqual(sentByChannel.get(channelA).length + sentByChannel.get(channelB).length, beforeSkip);
  autoMessageService.updateSettings(guildId, { enabled: true });

  const failing = autoMessageService.createMessage(guildId, createPayload('Failing', '433456789012345678'));
  assert.strictEqual(failing.success, true);
  db.prepare('UPDATE auto_messages SET next_run_at = ? WHERE id = ?').run(new Date(Date.now() - 60 * 1000).toISOString(), failing.message.id);
  const failed = await autoMessageService.runDueMessages(new Date());
  assert.strictEqual(failed.failed, 1);
  assert.ok(autoMessageService.getAudit(guildId, { status: 'failed' }).length >= 1);

  const testResult = await autoMessageService.sendTestMessage(guildId, first.message.id);
  assert.strictEqual(testResult.success, true);
  assert.ok(autoMessageService.getAudit(guildId, { status: 'test' }).length >= 1);

  const limitedGuild = '533456789012345678';
  tenantService.ensureTenant(limitedGuild, 'Limited Auto Guild');
  tenantService.setTenantPlan(limitedGuild, 'starter', 'test');
  tenantService.setTenantModule(limitedGuild, 'automessages', true, 'test');
  for (let index = 0; index < 3; index += 1) {
    assert.strictEqual(autoMessageService.createMessage(limitedGuild, createPayload(`Starter ${index}`, channelA)).success, true);
  }
  const limited = autoMessageService.createMessage(limitedGuild, createPayload('Too many', channelA));
  assert.strictEqual(limited.success, false);
  assert.strictEqual(limited.code, 'limit_exceeded');

  console.log('auto message service assertions passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
