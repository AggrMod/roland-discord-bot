#!/usr/bin/env node
/* eslint-disable no-console */

const db = require('../database/db');
const aiAssistantService = require('../services/aiAssistantService');
const tenantService = require('../services/tenantService');
const entitlementService = require('../services/entitlementService');

const TEST_GUILD_ID = '999999999999999999';
const TEST_USER_ID = '888888888888888888';
const TEST_CHANNEL_ID = '777777777777777777';
const TEST_ROLE_ID = '666666666666666666';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function cleanupGuildState() {
  const tables = [
    'ai_assistant_usage_events',
    'ai_assistant_knowledge_docs',
    'ai_assistant_channel_policies',
    'ai_assistant_personas',
    'ai_assistant_memory_entries',
    'ai_assistant_memory_state',
    'ai_assistant_ingestion_jobs',
    'ai_assistant_action_suggestions',
    'ai_assistant_role_limits',
    'ai_assistant_tenant_settings',
  ];

  const tx = db.transaction(() => {
    for (const table of tables) {
      db.prepare(`DELETE FROM ${table} WHERE guild_id = ?`).run(TEST_GUILD_ID);
    }
  });
  tx();
}

async function run() {
  console.log('[ai-smoke] Starting AI assistant smoke checks...');

  cleanupGuildState();

  const originalGetGlobalProviderSettings = aiAssistantService.getGlobalProviderSettings.bind(aiAssistantService);
  const originalCallOpenAi = aiAssistantService.callOpenAi.bind(aiAssistantService);
  const originalCallGemini = aiAssistantService.callGemini.bind(aiAssistantService);
  const originalIsMultitenantEnabled = tenantService.isMultitenantEnabled.bind(tenantService);
  const originalGetEffectiveLimit = entitlementService.getEffectiveLimit.bind(entitlementService);

  aiAssistantService.getGlobalProviderSettings = () => ({
    openaiApiKey: 'smoke-openai-key',
    geminiApiKey: 'smoke-gemini-key',
    defaultProvider: 'openai',
    fallbackProvider: '',
    defaultModelOpenai: 'gpt-5.4',
    defaultModelGemini: 'gemini-2.0-flash',
  });
  aiAssistantService.callOpenAi = async () => 'Smoke reply @everyone @here <@888888888888888888> <@&666666666666666666> <#777777777777777777>';
  aiAssistantService.callGemini = async () => 'Smoke Gemini reply';
  tenantService.isMultitenantEnabled = () => false;
  entitlementService.getEffectiveLimit = () => null;

  try {
    const saveSettings = aiAssistantService.saveTenantSettings(TEST_GUILD_ID, {
      enabled: true,
      provider: 'openai',
      mentionEnabled: true,
      responseVisibility: 'public',
      cooldownSeconds: 3,
      perUserDailyLimit: 20,
      memoryEnabled: true,
      memoryWindowMessages: 6,
      dailyTokenBudget: 0,
      burstPerMinute: 0,
      allowActionSuggestions: true,
      moderationEnabled: false,
    });
    assert(saveSettings.success, 'failed to bootstrap AI tenant settings');

    // Mention flow.
    const mentionResult = await aiAssistantService.ask({
      guildId: TEST_GUILD_ID,
      userId: TEST_USER_ID,
      channelId: TEST_CHANNEL_ID,
      prompt: 'status check mention flow',
      triggerSource: 'mention',
      requesterTag: 'smoke#0001',
      memberRoleNames: ['Member'],
      memberRoleIds: [TEST_ROLE_ID],
      skipKnowledge: true,
    });
    assert(mentionResult.success, `mention ask flow failed: ${mentionResult?.message || mentionResult?.code || 'unknown'}`);
    assert(!/@everyone/i.test(mentionResult.text), 'mention output still contains @everyone');
    assert(!/@here/i.test(mentionResult.text), 'mention output still contains @here');
    assert(!/<@!?\d{17,20}>/.test(mentionResult.text), 'mention output still contains user mention token');
    assert(!/<@&\d{17,20}>/.test(mentionResult.text), 'mention output still contains role mention token');

    // Passive flow.
    const passiveResult = await aiAssistantService.ask({
      guildId: TEST_GUILD_ID,
      userId: TEST_USER_ID,
      channelId: TEST_CHANNEL_ID,
      prompt: 'passive mode question',
      triggerSource: 'passive',
      requesterTag: 'smoke#0001',
      memberRoleNames: ['Member'],
      memberRoleIds: [TEST_ROLE_ID],
      skipKnowledge: true,
    });
    assert(passiveResult.success, `passive ask flow failed: ${passiveResult?.message || passiveResult?.code || 'unknown'}`);

    // Slash flow.
    const slashResult = await aiAssistantService.ask({
      guildId: TEST_GUILD_ID,
      userId: TEST_USER_ID,
      channelId: TEST_CHANNEL_ID,
      prompt: 'slash mode question',
      triggerSource: 'slash',
      requesterTag: 'smoke#0001',
      memberRoleNames: ['Member'],
      memberRoleIds: [TEST_ROLE_ID],
      skipKnowledge: true,
    });
    assert(slashResult.success, `slash ask flow failed: ${slashResult?.message || slashResult?.code || 'unknown'}`);

    // Briefing flow.
    const briefing = await aiAssistantService.generateInstantBriefing(TEST_GUILD_ID, {
      userId: TEST_USER_ID,
      channelId: TEST_CHANNEL_ID,
      requesterTag: 'smoke#0001',
      memberRoleNames: ['Member'],
      memberRoleIds: [TEST_ROLE_ID],
    });
    assert(briefing && briefing.success, `briefing flow failed: ${briefing?.message || 'unknown error'}`);
    assert(String(briefing.text || '').trim().length > 0, 'briefing flow returned empty text');

    // Burst limit enforcement.
    db.prepare('DELETE FROM ai_assistant_usage_events WHERE guild_id = ?').run(TEST_GUILD_ID);
    const burstSettings = aiAssistantService.saveTenantSettings(TEST_GUILD_ID, { burstPerMinute: 1 });
    assert(burstSettings.success, 'failed to update burst settings');
    const burstOne = await aiAssistantService.ask({
      guildId: TEST_GUILD_ID,
      userId: TEST_USER_ID,
      channelId: TEST_CHANNEL_ID,
      prompt: 'burst check first',
      triggerSource: 'slash',
      requesterTag: 'smoke#0001',
      memberRoleNames: ['Member'],
      memberRoleIds: [TEST_ROLE_ID],
      skipKnowledge: true,
    });
    assert(burstOne.success, 'burst first call should succeed');
    const burstTwo = await aiAssistantService.ask({
      guildId: TEST_GUILD_ID,
      userId: TEST_USER_ID,
      channelId: TEST_CHANNEL_ID,
      prompt: 'burst check second',
      triggerSource: 'slash',
      requesterTag: 'smoke#0001',
      memberRoleNames: ['Member'],
      memberRoleIds: [TEST_ROLE_ID],
      skipKnowledge: true,
    });
    assert(!burstTwo.success && burstTwo.code === 'burst_limited', 'burst limit did not trigger on second request');

    // Role request limit enforcement.
    db.prepare('DELETE FROM ai_assistant_usage_events WHERE guild_id = ?').run(TEST_GUILD_ID);
    const unlimitedBurst = aiAssistantService.saveTenantSettings(TEST_GUILD_ID, { burstPerMinute: 0, perUserDailyLimit: 0 });
    assert(unlimitedBurst.success, 'failed to reset burst/user limits');
    const roleLimitSave = aiAssistantService.saveRoleLimits(TEST_GUILD_ID, [{
      roleId: TEST_ROLE_ID,
      dailyRequestsPerUser: 1,
      dailyTokensPerUser: 0,
    }]);
    assert(roleLimitSave.success, 'failed to save role limits');
    const roleOne = await aiAssistantService.ask({
      guildId: TEST_GUILD_ID,
      userId: TEST_USER_ID,
      channelId: TEST_CHANNEL_ID,
      prompt: 'role limit first',
      triggerSource: 'slash',
      requesterTag: 'smoke#0001',
      memberRoleNames: ['Member'],
      memberRoleIds: [TEST_ROLE_ID],
      skipKnowledge: true,
    });
    assert(roleOne.success, 'role-limited first call should succeed');
    const roleTwo = await aiAssistantService.ask({
      guildId: TEST_GUILD_ID,
      userId: TEST_USER_ID,
      channelId: TEST_CHANNEL_ID,
      prompt: 'role limit second',
      triggerSource: 'slash',
      requesterTag: 'smoke#0001',
      memberRoleNames: ['Member'],
      memberRoleIds: [TEST_ROLE_ID],
      skipKnowledge: true,
    });
    assert(!roleTwo.success && roleTwo.code === 'user_limit_reached', 'role request limit did not trigger');

    // Token budget enforcement.
    db.prepare('DELETE FROM ai_assistant_usage_events WHERE guild_id = ?').run(TEST_GUILD_ID);
    const tokenBudgetSettings = aiAssistantService.saveTenantSettings(TEST_GUILD_ID, {
      perUserDailyLimit: 0,
      dailyTokenBudget: 1,
    });
    assert(tokenBudgetSettings.success, 'failed to set token budget');
    const tokenBudgetResult = await aiAssistantService.ask({
      guildId: TEST_GUILD_ID,
      userId: TEST_USER_ID,
      channelId: TEST_CHANNEL_ID,
      prompt: 'token budget request',
      triggerSource: 'slash',
      requesterTag: 'smoke#0001',
      memberRoleNames: ['Member'],
      memberRoleIds: [TEST_ROLE_ID],
      skipKnowledge: true,
    });
    assert(!tokenBudgetResult.success && tokenBudgetResult.code === 'token_budget_reached', 'token budget limit did not trigger');

    console.log('[ai-smoke] OK: mention/passive/slash/briefing + limits + mention safety checks passed');
  } finally {
    // Restore patched functions.
    aiAssistantService.getGlobalProviderSettings = originalGetGlobalProviderSettings;
    aiAssistantService.callOpenAi = originalCallOpenAi;
    aiAssistantService.callGemini = originalCallGemini;
    tenantService.isMultitenantEnabled = originalIsMultitenantEnabled;
    entitlementService.getEffectiveLimit = originalGetEffectiveLimit;

    cleanupGuildState();
  }
}

run().catch((error) => {
  console.error(`[ai-smoke] FAIL: ${error.message}`);
  process.exit(1);
});
