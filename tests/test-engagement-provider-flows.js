const assert = require('assert');
const db = require('../database/db');
const engagementService = require('../services/engagementService');
const entitlementService = require('../services/entitlementService');
const xProviderService = require('../services/xProviderService');

async function run() {
  const suffix = String(Date.now());
  const guildId = `guild-eng-provider-${suffix}`;
  const userId = `user-eng-provider-${suffix}`;

  db.prepare('DELETE FROM engagement_social_accounts WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM engagement_social_tasks WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM engagement_task_completions WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM points_ledger WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM points_totals WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM engagement_config WHERE guild_id = ?').run(guildId);

  const originalGetEffectiveLimit = entitlementService.getEffectiveLimit.bind(entitlementService);
  entitlementService.getEffectiveLimit = (testGuildId, moduleKey, limitKey) => {
    if (String(testGuildId) === guildId && moduleKey === 'engagement' && limitKey === 'allow_x_provider') {
      return 0;
    }
    return originalGetEffectiveLimit(testGuildId, moduleKey, limitKey);
  };

  const blockedTask = engagementService.createTask(guildId, {
    provider: 'x',
    trigger_type: 'manual',
    required_actions: ['x_follow'],
    reward_config: { x_follow: 15 },
    source_account_id: '123456',
    title: 'Follow us on X',
  });
  assert.strictEqual(blockedTask.success, false, 'X task creation should be blocked on starter');
  assert.strictEqual(blockedTask.code, 'plan_restricted', 'starter block should return plan_restricted');

  const blockedLink = engagementService.upsertLinkedAccount(guildId, userId, {
    provider: 'x',
    handle: 'starter_user',
    access_token: 'plain_token_should_not_store',
  });
  assert.strictEqual(blockedLink.success, false, 'X account linking should be blocked on starter');
  assert.strictEqual(blockedLink.code, 'plan_restricted', 'starter link block should return plan_restricted');

  const blockedMonitoredAccount = engagementService.upsertMonitoredAccount(guildId, {
    provider: 'x',
    account_handle: '@starter_account',
  });
  assert.strictEqual(blockedMonitoredAccount.success, false, 'X monitored-account save should be blocked on starter');
  assert.strictEqual(blockedMonitoredAccount.code, 'plan_restricted', 'starter monitored-account block should return plan_restricted');

  const blockedHashtag = engagementService.upsertHashtagMonitor(guildId, {
    provider: 'x',
    hashtag: '#starter',
  });
  assert.strictEqual(blockedHashtag.success, false, 'X hashtag monitor save should be blocked on starter');
  assert.strictEqual(blockedHashtag.code, 'plan_restricted', 'starter hashtag block should return plan_restricted');

  const blockedIngest = await engagementService.ingestProviderPost(guildId, 'x', {
    source_post_id: 'starter-ingest',
    source_post_url: 'https://x.com/example/status/starter-ingest',
    source_account_handle: '@starter_account',
    title: 'Starter ingest',
    body: 'Should be blocked',
  });
  assert.strictEqual(blockedIngest.success, false, 'X provider ingest should be blocked on starter');
  assert.strictEqual(blockedIngest.code, 'plan_restricted', 'starter ingest block should return plan_restricted');

  entitlementService.getEffectiveLimit = (testGuildId, moduleKey, limitKey) => {
    if (String(testGuildId) === guildId && moduleKey === 'engagement' && limitKey === 'allow_x_provider') {
      return 1;
    }
    return originalGetEffectiveLimit(testGuildId, moduleKey, limitKey);
  };

  const linkResult = engagementService.upsertLinkedAccount(guildId, userId, {
    provider: 'x',
    handle: 'growth_user',
    provider_user_id: '998877',
    display_name: 'Growth User',
    access_token: 'growth_access_token',
    refresh_token: 'growth_refresh_token',
    status: 'linked',
  });
  assert.strictEqual(linkResult.success, true, 'X account linking should succeed on growth');

  const stored = db.prepare(`
    SELECT access_token, refresh_token
    FROM engagement_social_accounts
    WHERE (guild_id = ? OR guild_id = '__profile__') AND user_id = ? AND provider = 'x'
    LIMIT 1
  `).get(guildId, userId);
  assert.ok(stored, 'stored linked account row should exist');

  const linkedAccounts = engagementService.listLinkedAccounts(guildId, userId);
  assert.ok(Array.isArray(linkedAccounts) && linkedAccounts.length > 0, 'linked accounts should be listed');
  assert.strictEqual(String(linkedAccounts[0].provider || ''), 'x', 'linked provider should be x');
  assert.strictEqual(String(linkedAccounts[0].access_token || ''), '[stored]', 'access token should be masked in API payload');
  assert.strictEqual(String(linkedAccounts[0].refresh_token || ''), '[stored]', 'refresh token should be masked in API payload');

  const xTask = engagementService.createTask(guildId, {
    provider: 'x',
    trigger_type: 'manual',
    required_actions: ['x_follow'],
    reward_config: { x_follow: 20 },
    source_account_id: '123456',
    title: 'Follow on X',
    status: 'active',
  });
  assert.strictEqual(xTask.success, true, 'X task creation should succeed on growth');

  const account = engagementService.getLinkedAccountRecord(guildId, userId, 'x');
  assert.ok(account?.id, 'linked account record should be retrievable');

  const completion = engagementService.recordTaskCompletion(
    guildId,
    Number(xTask.id),
    userId,
    'growth-user',
    {
      action_type: 'x_follow',
      linked_account_id: account.id,
      status: 'verified',
      metadata: { source: 'provider-flow-test' },
    }
  );
  assert.strictEqual(completion.success, true, 'task completion should succeed for linked provider action');
  assert.strictEqual(Number(completion.rewardPoints || 0), 20, 'reward points should match task config');

  const points = engagementService.getUserPoints(guildId, userId);
  assert.strictEqual(Number(points?.total_points || 0), 20, 'verified X completion should award points');

  const autoVerifyTask = engagementService.createTask(guildId, {
    provider: 'x',
    trigger_type: 'manual',
    required_actions: ['x_like', 'x_repost', 'x_reply', 'x_follow', 'x_hashtag_post'],
    reward_config: {
      x_like: 5,
      x_repost: 4,
      x_reply: 3,
      x_follow: 2,
      x_hashtag_post: 1,
    },
    source_post_id: 'post-verify-1',
    source_account_id: 'source-account-1',
    hashtag: '#guildpilot',
    title: 'Complete all X actions',
    status: 'active',
  });
  assert.strictEqual(autoVerifyTask.success, true, 'multi-action X task should be created');

  const originalX = {
    getLikedPosts: xProviderService.getLikedPosts,
    getRetweetingUsers: xProviderService.getRetweetingUsers,
    getFollowing: xProviderService.getFollowing,
    searchRecentPosts: xProviderService.searchRecentPosts,
    getRuntimeConfig: xProviderService.getRuntimeConfig,
  };
  xProviderService.getLikedPosts = async () => ({ posts: [{ id: 'post-verify-1' }] });
  xProviderService.getRetweetingUsers = async () => ({ users: [{ id: '998877' }] });
  xProviderService.getFollowing = async () => ({ users: [{ id: 'source-account-1' }] });
  xProviderService.searchRecentPosts = async query => {
    if (String(query).startsWith('conversation_id:')) {
      return { posts: [{ id: 'reply-1', in_reply_to_user_id: 'user-x', conversation_id: 'post-verify-1' }] };
    }
    return { posts: [{ id: 'hash-post-1' }] };
  };
  xProviderService.getRuntimeConfig = () => ({ bearerToken: 'test-bearer' });

  const verifyResult = await engagementService.verifyXTaskAction(
    guildId,
    Number(autoVerifyTask.id),
    userId,
    'growth-user'
  );
  assert.strictEqual(verifyResult.success, true, 'verifyXTaskAction should succeed');
  assert.strictEqual(Number(verifyResult.verifiedCount || 0), 5, 'all required X actions should verify');
  const verifiedActions = new Set((verifyResult.results || []).filter(entry => entry.verified).map(entry => entry.actionType));
  ['x_like', 'x_repost', 'x_reply', 'x_follow', 'x_hashtag_post'].forEach(action => {
    assert.ok(verifiedActions.has(action), `missing verified action: ${action}`);
  });

  xProviderService.getLikedPosts = originalX.getLikedPosts;
  xProviderService.getRetweetingUsers = originalX.getRetweetingUsers;
  xProviderService.getFollowing = originalX.getFollowing;
  xProviderService.searchRecentPosts = originalX.searchRecentPosts;
  xProviderService.getRuntimeConfig = originalX.getRuntimeConfig;

  const pointsAfterVerify = engagementService.getUserPoints(guildId, userId);
  assert.strictEqual(
    Number(pointsAfterVerify?.total_points || 0),
    35,
    'auto-verified actions should award cumulative configured points'
  );

  const disconnected = engagementService.disconnectLinkedAccount(guildId, userId, 'x');
  assert.strictEqual(disconnected.success, true, 'linked account should disconnect');
  const afterDisconnect = engagementService.getLinkedAccountRecord(guildId, userId, 'x');
  assert.strictEqual(afterDisconnect, null, 'linked account should be removed');

  entitlementService.getEffectiveLimit = originalGetEffectiveLimit;

  console.log('engagement provider flow assertions passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
