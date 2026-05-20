const assert = require('assert');

process.env.TURNSTILE_SECRET_KEY = '';

const welcomeService = require('../services/welcomeService');
const tenantService = require('../services/tenantService');
const clientProvider = require('../utils/clientProvider');

async function run() {
  const guildId = `welcome-smoke-${Date.now()}`;
  const userId = `user-${Date.now()}`;
  const welcomeChannelId = 'welcome-channel';
  const verificationChannelId = 'verify-channel';
  const captchaRoleId = '123456789012345671';
  const newcomerRoleId = '123456789012345672';

  const sentMessages = [];
  const welcomeChannel = {
    id: welcomeChannelId,
    name: 'welcome',
    send: async (payload) => {
      sentMessages.push(payload);
      return { id: `msg-${sentMessages.length}` };
    },
  };
  const verificationChannel = {
    id: verificationChannelId,
    name: 'verify',
    send: async (payload) => {
      sentMessages.push(payload);
      return { id: `verify-msg-${sentMessages.length}` };
    },
  };

  const channelsMap = new Map([
    [welcomeChannelId, welcomeChannel],
    [verificationChannelId, verificationChannel],
  ]);

  const memberState = {
    added: [],
    removed: [],
    dmSent: 0,
  };
  const member = {
    id: userId,
    displayName: 'Smoke Tester',
    user: {
      id: userId,
      username: 'SmokeTester',
      displayAvatarURL: () => 'https://example.com/avatar.png',
    },
    roles: {
      add: async (roleId) => { memberState.added.push(String(roleId)); },
      remove: async (roleId) => { memberState.removed.push(String(roleId)); },
    },
    send: async () => { memberState.dmSent += 1; },
    guild: {
      id: guildId,
      name: 'Welcome Smoke Guild',
      memberCount: 42,
      channels: {
        cache: channelsMap,
        fetch: async () => channelsMap,
      },
      members: {
        fetch: async (id) => (String(id) === String(userId) ? member : null),
      },
    },
  };

  const guild = member.guild;
  const originalIsModuleEnabled = tenantService.isModuleEnabled;
  const originalGetClient = clientProvider.getClient;

  try {
    tenantService.isModuleEnabled = () => true;
    clientProvider.getClient = () => ({
      guilds: {
        fetch: async (id) => (String(id) === String(guildId) ? guild : null),
      },
    });

    const settingsResult = welcomeService.updateSettings(guildId, {
      enabled: true,
      welcomeChannelId,
      verificationChannelId,
      welcomeMessageTemplate: 'Welcome {user_mention} to {server_name}',
      welcomeEmbed: {
        title: 'Welcome, {username}',
        description: 'You are member #{member_count}.',
        fields: [],
      },
      dmEnabled: true,
      dmMessageTemplate: 'DM hello {username}',
      autoRoleIds: [newcomerRoleId],
      captchaEnabled: true,
      captchaRoleId,
      captchaRemoveRoleId: newcomerRoleId,
      captchaPromptMode: 'channel_button',
    });
    assert.strictEqual(settingsResult.success, true, 'settings update should succeed');

    const joinResult = await welcomeService.handleMemberJoin(member);
    assert.strictEqual(joinResult.success, true, 'join flow should succeed');
    assert.strictEqual(memberState.added.includes(newcomerRoleId), true, 'newcomer role should be added on join');
    assert.strictEqual(memberState.dmSent, 1, 'onboarding DM should be sent');

    const challengeToken = welcomeService.createChallenge(guildId, userId);
    const verifyResult = await welcomeService.verifyCaptcha({
      challengeToken,
      captchaToken: 'smoke-token',
    });
    assert.strictEqual(verifyResult.success, true, 'captcha verify should succeed');
    assert.strictEqual(memberState.added.includes(captchaRoleId), true, 'captcha success role should be added');
    assert.strictEqual(memberState.removed.includes(newcomerRoleId), true, 'newcomer role should be removed after captcha');
    assert.ok(sentMessages.length >= 1, 'welcome message should be posted after captcha success');

    const analyticsResult = welcomeService.getAnalyticsSummary(guildId, 30);
    assert.strictEqual(analyticsResult.success, true, 'analytics summary should load');
    assert.ok(Number(analyticsResult.totals.joinsTotal || 0) >= 1, 'analytics should count joins');
    assert.ok(Number(analyticsResult.totals.captchaPassed || 0) >= 1, 'analytics should count captcha pass');
    assert.ok(Number(analyticsResult.totals.welcomeSent || 0) >= 1, 'analytics should count welcome sent');

    console.log('welcome onboarding smoke assertions passed');
  } finally {
    tenantService.isModuleEnabled = originalIsModuleEnabled;
    clientProvider.getClient = originalGetClient;
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
