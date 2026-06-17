const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-bridge-service-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.MULTITENANT_ENABLED = 'true';

require('../database/db');
const tenantService = require('../services/tenantService');
const clientProvider = require('../utils/clientProvider');
const telegramBridgeService = require('../services/telegramBridgeService');

const guildId = '123456789012345678';
const channelA = '223456789012345678';
const channelB = '323456789012345678';

tenantService.ensureTenant(guildId, 'Bridge Guild');
tenantService.setTenantPlan(guildId, 'pro', 'test');
tenantService.setTenantModule(guildId, 'telegrambridge', true, 'test');

const sentByChannel = new Map();
function makeChannel(id, shouldFail = false) {
  if (!sentByChannel.has(id)) sentByChannel.set(id, []);
  return {
    id,
    isTextBased: () => true,
    send: async (payload) => {
      if (shouldFail) throw new Error('send failed');
      const arr = sentByChannel.get(id);
      const message = {
        id: `${id}-${arr.length + 1}`,
        payload,
        edit: async (nextPayload) => {
          message.payload = nextPayload;
          return message;
        },
      };
      arr.push(message);
      return message;
    },
    messages: {
      fetch: async (messageId) => {
        for (const arr of sentByChannel.values()) {
          const found = arr.find(item => item.id === messageId);
          if (found) return found;
        }
        return null;
      },
    },
  };
}

clientProvider.setClient({
  channels: {
    fetch: async (id) => {
      if (id === channelA) return makeChannel(channelA);
      if (id === channelB) return makeChannel(channelB);
      return null;
    },
  },
});

const first = telegramBridgeService.createMapping(guildId, {
  name: 'Announcements A',
  telegramChatId: '-1001234567890',
  telegramChatTitle: 'Announcements',
  telegramChatType: 'channel',
  discordChannelId: channelA,
});
assert.strictEqual(first.success, true);

const second = telegramBridgeService.createMapping(guildId, {
  name: 'Announcements B',
  telegramChatId: '-1001234567890',
  telegramChatTitle: 'Announcements',
  telegramChatType: 'channel',
  discordChannelId: channelB,
});
assert.strictEqual(second.success, true);

const duplicate = telegramBridgeService.createMapping(guildId, {
  telegramChatId: '-1001234567890',
  discordChannelId: channelA,
});
assert.strictEqual(duplicate.success, false);
assert.strictEqual(duplicate.code, 'duplicate_mapping');

(async () => {
  const longText = 'A'.repeat(4100);
  const update = {
    update_id: 77,
    channel_post: {
      message_id: 44,
      date: 1,
      chat: { id: -1001234567890, title: 'Announcements', type: 'channel' },
      text: longText,
    },
  };
  const result = await telegramBridgeService.ingestTelegramUpdate(update);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.matchedMappings, 2);
  assert.ok(sentByChannel.get(channelA).length > 1, 'long text should split for channel A');
  assert.ok(sentByChannel.get(channelB).length > 1, 'long text should split for channel B');
  assert.ok(sentByChannel.get(channelA).every(msg => String(msg.payload.content || '').length <= 2000));
  assert.ok(sentByChannel.get(channelA).some(msg => Array.isArray(msg.payload.embeds) && msg.payload.embeds.length === 1), 'messages should use embeds');

  const bridgeId = await telegramBridgeService.ingestTelegramUpdate({
    update_id: 771,
    message: {
      message_id: 99,
      chat: { id: -1001234567890, title: 'Announcements', type: 'channel' },
      text: '/bridgeid',
    },
  });
  assert.strictEqual(bridgeId.reason, 'bridgeid_command');

  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const textUrl = String(url || '');
    if (textUrl.includes('/getFile')) {
      return {
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'photos/file_1.jpg', file_size: 11 } }),
      };
    }
    if (textUrl.includes('/file/bottest-token/photos/file_1.jpg')) {
      return {
        ok: true,
        arrayBuffer: async () => Buffer.from('hello media').buffer.slice(0, 11),
      };
    }
    throw new Error(`Unexpected fetch ${textUrl}`);
  };
  const mediaUpdate = {
    update_id: 79,
    channel_post: {
      message_id: 46,
      date: 1,
      chat: { id: -1001234567890, title: 'Announcements', type: 'channel' },
      caption: 'Photo caption',
      photo: [{ file_id: 'photo-file-id', file_size: 11, width: 100, height: 100 }],
    },
  };
  await telegramBridgeService.ingestTelegramUpdate(mediaUpdate);
  global.fetch = originalFetch;
  delete process.env.TELEGRAM_BOT_TOKEN;
  const mediaMessages = sentByChannel.get(channelA);
  assert.ok(mediaMessages.some(msg => Array.isArray(msg.payload.files) && msg.payload.files.length === 1), 'photo should be mirrored as a Discord attachment');
  assert.ok(mediaMessages.some(msg => Array.isArray(msg.payload.embeds) && JSON.stringify(msg.payload.embeds).includes('attachment://telegram-photo.jpg')), 'photo should be shown inside the Telegram embed');

  const repeat = await telegramBridgeService.ingestTelegramUpdate(update);
  assert.strictEqual(repeat.success, true);
  const duplicateAudit = telegramBridgeService.getAudit(guildId, { status: 'duplicate' });
  assert.ok(duplicateAudit.length >= 2, 'duplicate audit should be recorded per mapping');

  telegramBridgeService.updateMapping(guildId, second.mapping.id, { enabled: false });
  const disabledUpdate = {
    update_id: 78,
    channel_post: {
      message_id: 45,
      date: 1,
      chat: { id: -1001234567890, title: 'Announcements', type: 'channel' },
      text: 'Only one mapping should receive this',
    },
  };
  const beforeB = sentByChannel.get(channelB).length;
  await telegramBridgeService.ingestTelegramUpdate(disabledUpdate);
  assert.strictEqual(sentByChannel.get(channelB).length, beforeB);

  tenantService.setTenantPlan(guildId, 'starter', 'test');
  const limited = telegramBridgeService.createMapping(guildId, {
    telegramChatId: '-1009999999999',
    discordChannelId: '423456789012345678',
  });
  assert.strictEqual(limited.success, false);
  assert.strictEqual(limited.code, 'limit_exceeded');

  console.log('telegram bridge service assertions passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
