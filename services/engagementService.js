const { EmbedBuilder } = require('discord.js');
const db = require('../database/db');
const logger = require('../utils/logger');
const entitlementService = require('./entitlementService');
const tenantService = require('./tenantService');
const clientProvider = require('../utils/clientProvider');
const ticketService = require('./ticketService');
const { applyEmbedBranding } = require('./embedBranding');

const DEFAULTS = Object.freeze({
  enabled: 1,
  leaderboard_channel: null,
  currency_name_singular: 'point',
  currency_name_plural: 'points',
  currency_symbol: 'pts',
  currency_icon: null,
  task_feed_channel_id: null,
  social_log_channel_id: null,
  purchase_log_channel_id: null,
  achievement_channel_id: null,
  fulfillment_ticket_category_id: null,
  discord_messages_enabled: 1,
  discord_replies_enabled: 1,
  discord_reactions_enabled: 1,
  points_message: 5,
  points_reply: 3,
  points_reaction: 2,
  cooldown_message_mins: 60,
  cooldown_reply_mins: 30,
  cooldown_reaction_daily: 5,
});

const PROVIDERS = Object.freeze({
  discord: {
    key: 'discord',
    label: 'Discord',
    supportsSourceMonitoring: true,
    supportsHashtagMonitoring: false,
    supportsAccountLinking: false,
    supportsAutomaticVerification: true,
    supportedTaskTypes: ['discord_message', 'discord_reply', 'discord_reaction'],
  },
  x: {
    key: 'x',
    label: 'X',
    supportsSourceMonitoring: true,
    supportsHashtagMonitoring: true,
    supportsAccountLinking: true,
    supportsAutomaticVerification: true,
    supportedTaskTypes: ['x_like', 'x_repost', 'x_reply', 'x_follow', 'x_hashtag_post'],
  },
  bluesky: {
    key: 'bluesky',
    label: 'Bluesky',
    supportsSourceMonitoring: true,
    supportsHashtagMonitoring: true,
    supportsAccountLinking: true,
    supportsAutomaticVerification: true,
    supportedTaskTypes: ['bluesky_like', 'bluesky_repost', 'bluesky_reply', 'bluesky_follow'],
  },
});

const ACTION = Object.freeze({
  MESSAGE: 'discord_message',
  REPLY: 'discord_reply',
  REACTION: 'discord_reaction',
  GAME_WIN: 'game_win',
  GAME_PLACE: 'game_place',
  GAME_NIGHT: 'game_night_champion',
  ADMIN_GRANT: 'admin_grant',
  ADMIN_DEDUCT: 'admin_deduct',
  SHOP_REDEEM: 'shop_redeem',
  ACHIEVEMENT_REWARD: 'achievement_reward',
  SOCIAL_TASK: 'social_task_reward',
});

const ACHIEVEMENT_METRICS = Object.freeze({
  POINTS_TOTAL: 'points_total',
  DISCORD_MESSAGES: 'discord_messages',
  DISCORD_REPLIES: 'discord_replies',
  DISCORD_REACTIONS: 'discord_reactions',
  SOCIAL_TASKS: 'social_task_completions',
  SHOP_PURCHASES: 'shop_purchases',
  ADMIN_GRANTS: 'admin_grants',
});

function normalizeGuildId(guildId) {
  return String(guildId || '').trim();
}

function normalizeProvider(provider) {
  const key = String(provider || '').trim().toLowerCase();
  return PROVIDERS[key] ? key : '';
}

function safeJsonParse(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function uniqStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(v => String(v || '').trim()).filter(Boolean))];
}

function boolToInt(value, fallback = 0) {
  if (value === undefined || value === null) return fallback ? 1 : 0;
  return value ? 1 : 0;
}

function formatHandle(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function formatHashtag(value) {
  const clean = String(value || '').trim().replace(/^#+/, '').toLowerCase();
  return clean ? `#${clean}` : '';
}

function withJsonFields(row, fields) {
  if (!row) return null;
  const clone = { ...row };
  for (const field of fields) {
    clone[field] = safeJsonParse(clone[field], field.endsWith('_json') ? {} : clone[field]);
  }
  return clone;
}

function getProviderConnectionStatus(providerKey) {
  if (providerKey === 'discord') {
    return { configured: true, mode: 'native' };
  }
  if (providerKey === 'x') {
    return {
      configured: !!(process.env.X_CLIENT_ID || process.env.X_BEARER_TOKEN || process.env.X_API_KEY),
      mode: 'deployment-managed',
    };
  }
  if (providerKey === 'bluesky') {
    return {
      configured: !!(process.env.BLUESKY_IDENTIFIER || process.env.BLUESKY_CLIENT_ID || process.env.BLUESKY_APP_PASSWORD),
      mode: 'deployment-managed',
    };
  }
  return { configured: false, mode: 'unknown' };
}

function getConfig(guildId) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const row = normalizedGuildId
    ? db.prepare('SELECT * FROM engagement_config WHERE guild_id = ?').get(normalizedGuildId)
    : null;
  return { ...DEFAULTS, ...(row || {}) };
}

function setConfig(guildId, patch = {}) {
  const normalizedGuildId = normalizeGuildId(guildId);
  if (!normalizedGuildId) throw new Error('guildId is required');

  const current = getConfig(normalizedGuildId);
  const merged = {
    ...current,
    ...patch,
  };

  db.prepare(`
    INSERT INTO engagement_config (
      guild_id, enabled, points_message, points_reaction, cooldown_message_mins, cooldown_reaction_daily,
      leaderboard_channel, currency_name_singular, currency_name_plural, currency_symbol, currency_icon,
      task_feed_channel_id, social_log_channel_id, purchase_log_channel_id, achievement_channel_id,
      fulfillment_ticket_category_id, discord_messages_enabled, discord_replies_enabled, discord_reactions_enabled,
      points_reply, cooldown_reply_mins, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO UPDATE SET
      enabled = excluded.enabled,
      points_message = excluded.points_message,
      points_reaction = excluded.points_reaction,
      cooldown_message_mins = excluded.cooldown_message_mins,
      cooldown_reaction_daily = excluded.cooldown_reaction_daily,
      leaderboard_channel = excluded.leaderboard_channel,
      currency_name_singular = excluded.currency_name_singular,
      currency_name_plural = excluded.currency_name_plural,
      currency_symbol = excluded.currency_symbol,
      currency_icon = excluded.currency_icon,
      task_feed_channel_id = excluded.task_feed_channel_id,
      social_log_channel_id = excluded.social_log_channel_id,
      purchase_log_channel_id = excluded.purchase_log_channel_id,
      achievement_channel_id = excluded.achievement_channel_id,
      fulfillment_ticket_category_id = excluded.fulfillment_ticket_category_id,
      discord_messages_enabled = excluded.discord_messages_enabled,
      discord_replies_enabled = excluded.discord_replies_enabled,
      discord_reactions_enabled = excluded.discord_reactions_enabled,
      points_reply = excluded.points_reply,
      cooldown_reply_mins = excluded.cooldown_reply_mins,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    normalizedGuildId,
    boolToInt(merged.enabled, true),
    Number(merged.points_message || 0),
    Number(merged.points_reaction || 0),
    Number(merged.cooldown_message_mins || 0),
    Number(merged.cooldown_reaction_daily || 0),
    merged.leaderboard_channel || null,
    String(merged.currency_name_singular || DEFAULTS.currency_name_singular).trim() || DEFAULTS.currency_name_singular,
    String(merged.currency_name_plural || DEFAULTS.currency_name_plural).trim() || DEFAULTS.currency_name_plural,
    String(merged.currency_symbol || DEFAULTS.currency_symbol).trim() || DEFAULTS.currency_symbol,
    String(merged.currency_icon || '').trim() || null,
    String(merged.task_feed_channel_id || '').trim() || null,
    String(merged.social_log_channel_id || '').trim() || null,
    String(merged.purchase_log_channel_id || '').trim() || null,
    String(merged.achievement_channel_id || '').trim() || null,
    merged.fulfillment_ticket_category_id ? Number(merged.fulfillment_ticket_category_id) : null,
    boolToInt(merged.discord_messages_enabled, true),
    boolToInt(merged.discord_replies_enabled, true),
    boolToInt(merged.discord_reactions_enabled, true),
    Number(merged.points_reply || 0),
    Number(merged.cooldown_reply_mins || 0)
  );

  return getConfig(normalizedGuildId);
}

function getCurrencyMeta(guildId) {
  const cfg = getConfig(guildId);
  return {
    singular: String(cfg.currency_name_singular || DEFAULTS.currency_name_singular).trim() || DEFAULTS.currency_name_singular,
    plural: String(cfg.currency_name_plural || DEFAULTS.currency_name_plural).trim() || DEFAULTS.currency_name_plural,
    symbol: String(cfg.currency_symbol || DEFAULTS.currency_symbol).trim() || DEFAULTS.currency_symbol,
    icon: String(cfg.currency_icon || '').trim() || null,
  };
}

function formatCurrency(guildId, amount, { includeAmount = true } = {}) {
  const meta = getCurrencyMeta(guildId);
  const absolute = Math.abs(Number(amount || 0));
  const label = absolute === 1 ? meta.singular : meta.plural;
  const prefix = meta.icon ? `${meta.icon} ` : '';
  if (!includeAmount) return `${prefix}${label}`;
  return `${Number(amount || 0).toLocaleString()} ${prefix}${label}`.trim();
}

function getProviderCatalog() {
  return Object.values(PROVIDERS).map(provider => ({
    ...provider,
    ...getProviderConnectionStatus(provider.key),
  }));
}

function normalizeRewardConfig(value) {
  const parsed = safeJsonParse(value, value && typeof value === 'object' ? value : {});
  const output = {};
  for (const [key, raw] of Object.entries(parsed || {})) {
    const amount = Number(raw || 0);
    if (!Number.isFinite(amount)) continue;
    output[String(key || '').trim()] = Math.trunc(amount);
  }
  return output;
}

function normalizeRequirements(value) {
  const parsed = safeJsonParse(value, value && typeof value === 'object' ? value : {});
  return typeof parsed === 'object' && parsed ? parsed : {};
}

function normalizeTaskTypes(providerKey, taskTypes) {
  const provider = PROVIDERS[providerKey];
  if (!provider) return [];
  const requested = uniqStrings(safeJsonParse(taskTypes, Array.isArray(taskTypes) ? taskTypes : []));
  return requested.filter(taskType => provider.supportedTaskTypes.includes(taskType));
}

function listMonitoredAccounts(guildId, provider = '') {
  const normalizedGuildId = normalizeGuildId(guildId);
  const normalizedProvider = normalizeProvider(provider);
  const rows = normalizedProvider
    ? db.prepare('SELECT * FROM engagement_monitored_accounts WHERE guild_id = ? AND provider = ? ORDER BY updated_at DESC, id DESC').all(normalizedGuildId, normalizedProvider)
    : db.prepare('SELECT * FROM engagement_monitored_accounts WHERE guild_id = ? ORDER BY updated_at DESC, id DESC').all(normalizedGuildId);
  return rows.map(row => ({
    ...row,
    task_types: safeJsonParse(row.task_types_json, []),
    reward_config: safeJsonParse(row.reward_config_json, {}),
    requirements: safeJsonParse(row.requirements_json, {}),
  }));
}

function upsertMonitoredAccount(guildId, payload = {}) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const providerKey = normalizeProvider(payload.provider);
  if (!normalizedGuildId || !providerKey) return { success: false, message: 'Valid guildId and provider are required' };

  const accountHandle = formatHandle(payload.account_handle || payload.accountHandle);
  if (!accountHandle) return { success: false, message: 'account_handle is required' };

  const taskTypes = normalizeTaskTypes(providerKey, payload.task_types || payload.taskTypes);
  const rewardConfig = normalizeRewardConfig(payload.reward_config || payload.rewardConfig);
  const requirements = normalizeRequirements(payload.requirements);
  const id = payload.id ? Number(payload.id) : null;

  if (id) {
    db.prepare(`
      UPDATE engagement_monitored_accounts
      SET account_handle = ?, provider_account_id = ?, display_name = ?, enabled = ?, mirror_channel_id = ?,
          task_types_json = ?, reward_config_json = ?, requirements_json = ?, auto_create_task = ?, mirror_posts = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?
    `).run(
      accountHandle,
      String(payload.provider_account_id || payload.providerAccountId || '').trim() || null,
      String(payload.display_name || payload.displayName || '').trim() || null,
      boolToInt(payload.enabled, true),
      String(payload.mirror_channel_id || payload.mirrorChannelId || '').trim() || null,
      JSON.stringify(taskTypes),
      JSON.stringify(rewardConfig),
      JSON.stringify(requirements),
      boolToInt(payload.auto_create_task !== false, true),
      boolToInt(payload.mirror_posts !== false, true),
      id,
      normalizedGuildId
    );
    return { success: true, id };
  }

  const result = db.prepare(`
    INSERT INTO engagement_monitored_accounts (
      guild_id, provider, account_handle, provider_account_id, display_name, enabled, mirror_channel_id,
      task_types_json, reward_config_json, requirements_json, auto_create_task, mirror_posts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    normalizedGuildId,
    providerKey,
    accountHandle,
    String(payload.provider_account_id || payload.providerAccountId || '').trim() || null,
    String(payload.display_name || payload.displayName || '').trim() || null,
    boolToInt(payload.enabled, true),
    String(payload.mirror_channel_id || payload.mirrorChannelId || '').trim() || null,
    JSON.stringify(taskTypes),
    JSON.stringify(rewardConfig),
    JSON.stringify(requirements),
    boolToInt(payload.auto_create_task !== false, true),
    boolToInt(payload.mirror_posts !== false, true)
  );
  return { success: true, id: Number(result.lastInsertRowid) };
}

function deleteMonitoredAccount(guildId, id) {
  const result = db.prepare('DELETE FROM engagement_monitored_accounts WHERE guild_id = ? AND id = ?').run(normalizeGuildId(guildId), Number(id));
  return { success: result.changes > 0 };
}

function listHashtagMonitors(guildId, provider = '') {
  const normalizedGuildId = normalizeGuildId(guildId);
  const normalizedProvider = normalizeProvider(provider);
  const rows = normalizedProvider
    ? db.prepare('SELECT * FROM engagement_hashtag_monitors WHERE guild_id = ? AND provider = ? ORDER BY updated_at DESC, id DESC').all(normalizedGuildId, normalizedProvider)
    : db.prepare('SELECT * FROM engagement_hashtag_monitors WHERE guild_id = ? ORDER BY updated_at DESC, id DESC').all(normalizedGuildId);
  return rows.map(row => ({
    ...row,
    task_types: safeJsonParse(row.task_types_json, []),
    reward_config: safeJsonParse(row.reward_config_json, {}),
    requirements: safeJsonParse(row.requirements_json, {}),
  }));
}

function upsertHashtagMonitor(guildId, payload = {}) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const providerKey = normalizeProvider(payload.provider);
  if (!normalizedGuildId || !providerKey) return { success: false, message: 'Valid guildId and provider are required' };

  const hashtag = formatHashtag(payload.hashtag);
  if (!hashtag) return { success: false, message: 'hashtag is required' };

  const taskTypes = normalizeTaskTypes(providerKey, payload.task_types || payload.taskTypes);
  const rewardConfig = normalizeRewardConfig(payload.reward_config || payload.rewardConfig);
  const requirements = normalizeRequirements(payload.requirements);
  const id = payload.id ? Number(payload.id) : null;

  if (id) {
    db.prepare(`
      UPDATE engagement_hashtag_monitors
      SET hashtag = ?, enabled = ?, mirror_channel_id = ?, task_types_json = ?, reward_config_json = ?,
          requirements_json = ?, auto_create_task = ?, mirror_posts = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?
    `).run(
      hashtag,
      boolToInt(payload.enabled, true),
      String(payload.mirror_channel_id || payload.mirrorChannelId || '').trim() || null,
      JSON.stringify(taskTypes),
      JSON.stringify(rewardConfig),
      JSON.stringify(requirements),
      boolToInt(payload.auto_create_task !== false, true),
      boolToInt(payload.mirror_posts !== false, true),
      id,
      normalizedGuildId
    );
    return { success: true, id };
  }

  const result = db.prepare(`
    INSERT INTO engagement_hashtag_monitors (
      guild_id, provider, hashtag, enabled, mirror_channel_id,
      task_types_json, reward_config_json, requirements_json, auto_create_task, mirror_posts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    normalizedGuildId,
    providerKey,
    hashtag,
    boolToInt(payload.enabled, true),
    String(payload.mirror_channel_id || payload.mirrorChannelId || '').trim() || null,
    JSON.stringify(taskTypes),
    JSON.stringify(rewardConfig),
    JSON.stringify(requirements),
    boolToInt(payload.auto_create_task !== false, true),
    boolToInt(payload.mirror_posts !== false, true)
  );
  return { success: true, id: Number(result.lastInsertRowid) };
}

function deleteHashtagMonitor(guildId, id) {
  const result = db.prepare('DELETE FROM engagement_hashtag_monitors WHERE guild_id = ? AND id = ?').run(normalizeGuildId(guildId), Number(id));
  return { success: result.changes > 0 };
}

function listLinkedAccounts(guildId, userId = null) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const normalizedUserId = String(userId || '').trim();
  const rows = normalizedUserId
    ? db.prepare('SELECT * FROM engagement_social_accounts WHERE guild_id = ? AND user_id = ? ORDER BY updated_at DESC').all(normalizedGuildId, normalizedUserId)
    : db.prepare('SELECT * FROM engagement_social_accounts WHERE guild_id = ? ORDER BY updated_at DESC').all(normalizedGuildId);
  return rows.map(row => ({
    ...row,
    metadata: safeJsonParse(row.metadata_json, {}),
    access_token: row.access_token ? '[stored]' : null,
    refresh_token: row.refresh_token ? '[stored]' : null,
  }));
}

function upsertLinkedAccount(guildId, userId, payload = {}) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const normalizedUserId = String(userId || '').trim();
  const providerKey = normalizeProvider(payload.provider);
  if (!normalizedGuildId || !normalizedUserId || !providerKey) {
    return { success: false, message: 'Valid guildId, userId, and provider are required' };
  }

  const handle = formatHandle(payload.handle || payload.username || payload.account_handle);
  const providerUserId = String(payload.provider_user_id || payload.providerUserId || '').trim() || null;
  const displayName = String(payload.display_name || payload.displayName || '').trim() || null;
  const metadata = normalizeRequirements(payload.metadata);

  const existing = db.prepare('SELECT id FROM engagement_social_accounts WHERE guild_id = ? AND user_id = ? AND provider = ?').get(normalizedGuildId, normalizedUserId, providerKey);
  if (existing) {
    db.prepare(`
      UPDATE engagement_social_accounts
      SET provider_user_id = ?, handle = ?, display_name = ?, access_token = ?, refresh_token = ?, token_expires_at = ?,
          status = ?, metadata_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      providerUserId,
      handle || null,
      displayName,
      payload.access_token || payload.accessToken || null,
      payload.refresh_token || payload.refreshToken || null,
      payload.token_expires_at || payload.tokenExpiresAt || null,
      String(payload.status || 'linked').trim() || 'linked',
      JSON.stringify(metadata),
      existing.id
    );
    return { success: true, id: existing.id };
  }

  const result = db.prepare(`
    INSERT INTO engagement_social_accounts (
      guild_id, user_id, provider, provider_user_id, handle, display_name,
      access_token, refresh_token, token_expires_at, status, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    normalizedGuildId,
    normalizedUserId,
    providerKey,
    providerUserId,
    handle || null,
    displayName,
    payload.access_token || payload.accessToken || null,
    payload.refresh_token || payload.refreshToken || null,
    payload.token_expires_at || payload.tokenExpiresAt || null,
    String(payload.status || 'linked').trim() || 'linked',
    JSON.stringify(metadata)
  );
  return { success: true, id: Number(result.lastInsertRowid) };
}

function disconnectLinkedAccount(guildId, userId, provider) {
  const result = db.prepare('DELETE FROM engagement_social_accounts WHERE guild_id = ? AND user_id = ? AND provider = ?').run(
    normalizeGuildId(guildId),
    String(userId || '').trim(),
    normalizeProvider(provider)
  );
  return { success: result.changes > 0 };
}

function normalizeTaskPayload(providerKey, payload = {}) {
  const requiredActions = normalizeTaskTypes(providerKey, payload.required_actions || payload.requiredActions || payload.task_types || payload.taskTypes);
  return {
    provider: providerKey,
    triggerType: String(payload.trigger_type || payload.triggerType || 'manual').trim() || 'manual',
    sourcePostId: String(payload.source_post_id || payload.sourcePostId || '').trim() || null,
    sourcePostUrl: String(payload.source_post_url || payload.sourcePostUrl || '').trim() || null,
    sourceAccountHandle: formatHandle(payload.source_account_handle || payload.sourceAccountHandle),
    sourceAccountId: String(payload.source_account_id || payload.sourceAccountId || '').trim() || null,
    hashtag: formatHashtag(payload.hashtag),
    title: String(payload.title || '').trim() || null,
    body: String(payload.body || '').trim() || null,
    requiredActions,
    rewardConfig: normalizeRewardConfig(payload.reward_config || payload.rewardConfig),
    requirements: normalizeRequirements(payload.requirements),
    status: String(payload.status || 'active').trim() || 'active',
    startsAt: payload.starts_at || payload.startsAt || null,
    endsAt: payload.ends_at || payload.endsAt || null,
    mirroredChannelId: String(payload.mirrored_channel_id || payload.mirroredChannelId || '').trim() || null,
    mirroredMessageId: String(payload.mirrored_message_id || payload.mirroredMessageId || '').trim() || null,
    metadata: normalizeRequirements(payload.metadata),
  };
}

function createTask(guildId, payload = {}) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const providerKey = normalizeProvider(payload.provider);
  if (!normalizedGuildId || !providerKey) return { success: false, message: 'Valid guildId and provider are required' };

  const normalized = normalizeTaskPayload(providerKey, payload);
  const existing = normalized.sourcePostId
    ? db.prepare(`
        SELECT id
        FROM engagement_social_tasks
        WHERE guild_id = ? AND provider = ? AND source_post_id = ? AND trigger_type = ?
        LIMIT 1
      `).get(normalizedGuildId, providerKey, normalized.sourcePostId, normalized.triggerType)
    : null;

  if (existing) {
    db.prepare(`
      UPDATE engagement_social_tasks
      SET source_post_url = ?, source_account_handle = ?, source_account_id = ?, hashtag = ?, title = ?, body = ?,
          required_actions_json = ?, reward_config_json = ?, requirements_json = ?, status = ?, starts_at = ?, ends_at = ?,
          mirrored_channel_id = ?, mirrored_message_id = ?, metadata_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      normalized.sourcePostUrl,
      normalized.sourceAccountHandle || null,
      normalized.sourceAccountId,
      normalized.hashtag || null,
      normalized.title,
      normalized.body,
      JSON.stringify(normalized.requiredActions),
      JSON.stringify(normalized.rewardConfig),
      JSON.stringify(normalized.requirements),
      normalized.status,
      normalized.startsAt,
      normalized.endsAt,
      normalized.mirroredChannelId,
      normalized.mirroredMessageId,
      JSON.stringify(normalized.metadata),
      existing.id
    );
    return { success: true, id: existing.id, updated: true };
  }

  const result = db.prepare(`
    INSERT INTO engagement_social_tasks (
      guild_id, provider, trigger_type, source_post_id, source_post_url, source_account_handle, source_account_id, hashtag,
      title, body, required_actions_json, reward_config_json, requirements_json, status, starts_at, ends_at,
      mirrored_channel_id, mirrored_message_id, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    normalizedGuildId,
    providerKey,
    normalized.triggerType,
    normalized.sourcePostId,
    normalized.sourcePostUrl,
    normalized.sourceAccountHandle || null,
    normalized.sourceAccountId,
    normalized.hashtag || null,
    normalized.title,
    normalized.body,
    JSON.stringify(normalized.requiredActions),
    JSON.stringify(normalized.rewardConfig),
    JSON.stringify(normalized.requirements),
    normalized.status,
    normalized.startsAt,
    normalized.endsAt,
    normalized.mirroredChannelId,
    normalized.mirroredMessageId,
    JSON.stringify(normalized.metadata)
  );
  return { success: true, id: Number(result.lastInsertRowid), updated: false };
}

function listTasks(guildId, { provider, status, userId, limit = 50 } = {}) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const normalizedProvider = normalizeProvider(provider);
  let sql = 'SELECT * FROM engagement_social_tasks WHERE guild_id = ?';
  const params = [normalizedGuildId];
  if (normalizedProvider) {
    sql += ' AND provider = ?';
    params.push(normalizedProvider);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(String(status).trim());
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.max(1, Math.min(Number(limit || 50), 200)));

  const rows = db.prepare(sql).all(...params).map(row => ({
    ...row,
    required_actions: safeJsonParse(row.required_actions_json, []),
    reward_config: safeJsonParse(row.reward_config_json, {}),
    requirements: safeJsonParse(row.requirements_json, {}),
    metadata: safeJsonParse(row.metadata_json, {}),
  }));

  if (!userId) return rows;

  const normalizedUserId = String(userId || '').trim();
  return rows.map(row => {
    const completions = db.prepare(`
      SELECT action_type, status, reward_points, verified_at, created_at
      FROM engagement_task_completions
      WHERE task_id = ? AND user_id = ?
      ORDER BY created_at DESC
    `).all(row.id, normalizedUserId);
    return { ...row, completions };
  });
}

function listTaskCompletions(guildId, { taskId = null, userId = null, limit = 100 } = {}) {
  const normalizedGuildId = normalizeGuildId(guildId);
  let sql = 'SELECT * FROM engagement_task_completions WHERE guild_id = ?';
  const params = [normalizedGuildId];
  if (taskId) {
    sql += ' AND task_id = ?';
    params.push(Number(taskId));
  }
  if (userId) {
    sql += ' AND user_id = ?';
    params.push(String(userId).trim());
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.max(1, Math.min(Number(limit || 100), 500)));
  return db.prepare(sql).all(...params).map(row => ({
    ...row,
    metadata: safeJsonParse(row.metadata_json, {}),
  }));
}

async function postTaskMirror(guildId, taskRecord, source) {
  const client = clientProvider.getClient();
  const targetChannelId = taskRecord.mirrored_channel_id || getConfig(guildId).task_feed_channel_id || getConfig(guildId).social_log_channel_id;
  if (!client || !targetChannelId) return { channelId: targetChannelId || null, messageId: null };

  try {
    const channel = await client.channels.fetch(targetChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return { channelId: targetChannelId, messageId: null };

    const meta = getCurrencyMeta(guildId);
    const actions = (taskRecord.required_actions || []).join(', ') || 'activity';
    const rewardLines = Object.entries(taskRecord.reward_config || {})
      .map(([action, value]) => `${action}: ${formatCurrency(guildId, value)}`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setTitle(taskRecord.title || `${PROVIDERS[taskRecord.provider]?.label || taskRecord.provider} engagement task`)
      .setDescription(taskRecord.body || 'A new engagement task is available.')
      .addFields(
        { name: 'Provider', value: PROVIDERS[taskRecord.provider]?.label || taskRecord.provider, inline: true },
        { name: 'Actions', value: actions.slice(0, 1024), inline: true },
        { name: 'Currency', value: `${meta.icon ? `${meta.icon} ` : ''}${meta.plural}`, inline: true }
      )
      .setTimestamp();
    if (rewardLines) {
      embed.addFields({ name: 'Rewards', value: rewardLines.slice(0, 1024), inline: false });
    }
    if (source?.url || taskRecord.source_post_url) {
      embed.addFields({ name: 'Source', value: source?.url || taskRecord.source_post_url, inline: false });
    }
    applyEmbedBranding(embed, {
      guildId,
      moduleKey: 'engagement',
      defaultColor: '#f59e0b',
      defaultFooter: 'GuildPilot · Engagement Task',
    });

    const message = await channel.send({ embeds: [embed] }).catch(() => null);
    return { channelId: targetChannelId, messageId: message?.id || null };
  } catch (error) {
    logger.warn(`[engagement] could not mirror social task: ${error.message}`);
    return { channelId: targetChannelId, messageId: null };
  }
}

function findMatchingHashtags(text, providerKey, guildId) {
  const haystack = String(text || '').toLowerCase();
  return listHashtagMonitors(guildId, providerKey).filter(monitor => haystack.includes(String(monitor.hashtag || '').toLowerCase()));
}

async function ingestProviderPost(guildId, provider, payload = {}) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const providerKey = normalizeProvider(provider);
  if (!normalizedGuildId || !providerKey) return { success: false, message: 'Valid guildId and provider are required' };

  const sourceHandle = formatHandle(payload.account_handle || payload.accountHandle || payload.author_handle || payload.authorHandle);
  const sourcePostId = String(payload.source_post_id || payload.sourcePostId || payload.id || '').trim();
  if (!sourcePostId) return { success: false, message: 'source_post_id is required' };

  const body = String(payload.body || payload.text || '').trim();
  const title = String(payload.title || '').trim() || `${PROVIDERS[providerKey].label} post from @${sourceHandle || 'source'}`;
  const url = String(payload.url || payload.source_post_url || payload.sourcePostUrl || '').trim() || null;

  const matchingAccounts = listMonitoredAccounts(normalizedGuildId, providerKey).filter(account => account.enabled && formatHandle(account.account_handle) === sourceHandle);
  const matchingHashtags = findMatchingHashtags(`${title}\n${body}`, providerKey, normalizedGuildId).filter(monitor => monitor.enabled);
  const triggered = [...matchingAccounts, ...matchingHashtags];
  if (!triggered.length) return { success: true, createdTasks: [], matched: false };

  const createdTasks = [];
  for (const trigger of triggered) {
    const result = createTask(normalizedGuildId, {
      provider: providerKey,
      trigger_type: matchingAccounts.some(account => account.id === trigger.id) ? 'account_post' : 'hashtag_match',
      source_post_id: sourcePostId,
      source_post_url: url,
      source_account_handle: sourceHandle,
      source_account_id: payload.account_id || payload.accountId || null,
      hashtag: trigger.hashtag || null,
      title,
      body,
      required_actions: trigger.task_types,
      reward_config: trigger.reward_config,
      requirements: {
        ...(trigger.requirements || {}),
        trigger_id: trigger.id,
      },
      status: 'active',
      metadata: {
        raw: payload.raw || null,
      },
    });

    if (!result.success) continue;

    const task = listTasks(normalizedGuildId, { limit: 1 }).find(row => row.id === result.id)
      || db.prepare('SELECT * FROM engagement_social_tasks WHERE id = ?').get(result.id);
    const normalizedTask = {
      ...task,
      required_actions: safeJsonParse(task.required_actions_json, []),
      reward_config: safeJsonParse(task.reward_config_json, {}),
    };

    let mirror = { channelId: trigger.mirror_channel_id || getConfig(normalizedGuildId).task_feed_channel_id, messageId: null };
    if (trigger.mirror_posts || trigger.auto_create_task) {
      mirror = await postTaskMirror(normalizedGuildId, normalizedTask, { url });
      db.prepare(`
        UPDATE engagement_social_tasks
        SET mirrored_channel_id = COALESCE(?, mirrored_channel_id),
            mirrored_message_id = COALESCE(?, mirrored_message_id),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(mirror.channelId, mirror.messageId, result.id);
    }
    createdTasks.push({ id: result.id, mirror });
  }

  return { success: true, createdTasks, matched: true };
}

function isOnCooldown(guildId, userId, actionType, cooldownMins) {
  const row = db.prepare(
    'SELECT last_at FROM action_cooldowns WHERE guild_id = ? AND user_id = ? AND action_type = ?'
  ).get(guildId, userId, actionType);
  if (!row) return false;
  const elapsed = (Date.now() - new Date(row.last_at).getTime()) / 60000;
  return elapsed < cooldownMins;
}

function stampCooldown(guildId, userId, actionType) {
  db.prepare(`
    INSERT INTO action_cooldowns (guild_id, user_id, action_type, last_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id, user_id, action_type) DO UPDATE SET last_at = CURRENT_TIMESTAMP
  `).run(guildId, userId, actionType);
}

function dailyCount(guildId, userId, actionType) {
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM points_ledger
    WHERE guild_id = ? AND user_id = ? AND action_type = ?
      AND date(created_at) = date('now')
  `).get(guildId, userId, actionType);
  return Number(row?.cnt || 0);
}

function computeAchievementMetric(guildId, userId, metricType) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedGuildId || !normalizedUserId) return 0;

  if (metricType === ACHIEVEMENT_METRICS.POINTS_TOTAL) {
    const row = db.prepare('SELECT total_points FROM points_totals WHERE guild_id = ? AND user_id = ?').get(normalizedGuildId, normalizedUserId);
    return Number(row?.total_points || 0);
  }

  if (metricType === ACHIEVEMENT_METRICS.SHOP_PURCHASES) {
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM shop_redemptions WHERE guild_id = ? AND user_id = ?').get(normalizedGuildId, normalizedUserId);
    return Number(row?.cnt || 0);
  }

  if (metricType === ACHIEVEMENT_METRICS.SOCIAL_TASKS) {
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM engagement_task_completions
      WHERE guild_id = ? AND user_id = ? AND status = 'verified'
    `).get(normalizedGuildId, normalizedUserId);
    return Number(row?.cnt || 0);
  }

  const actionMap = {
    [ACHIEVEMENT_METRICS.DISCORD_MESSAGES]: ACTION.MESSAGE,
    [ACHIEVEMENT_METRICS.DISCORD_REPLIES]: ACTION.REPLY,
    [ACHIEVEMENT_METRICS.DISCORD_REACTIONS]: ACTION.REACTION,
    [ACHIEVEMENT_METRICS.ADMIN_GRANTS]: ACTION.ADMIN_GRANT,
  };
  const actionType = actionMap[metricType];
  if (!actionType) return 0;
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM points_ledger WHERE guild_id = ? AND user_id = ? AND action_type = ?').get(normalizedGuildId, normalizedUserId, actionType);
  return Number(row?.cnt || 0);
}

async function announceAchievement(guildId, userId, achievement, rewardPoints = 0) {
  const client = clientProvider.getClient();
  const cfg = getConfig(guildId);
  if (!client || !cfg.achievement_channel_id) return null;

  try {
    const channel = await client.channels.fetch(cfg.achievement_channel_id).catch(() => null);
    if (!channel || !channel.isTextBased()) return null;

    const rewardText = rewardPoints > 0 ? `\nReward: ${formatCurrency(guildId, rewardPoints)}` : '';
    const embed = new EmbedBuilder()
      .setTitle(achievement.icon ? `${achievement.icon} Achievement Unlocked` : 'Achievement Unlocked')
      .setDescription(`<@${userId}> unlocked **${achievement.name}**.${rewardText}`)
      .setTimestamp();
    if (achievement.description) {
      embed.addFields({ name: 'Details', value: String(achievement.description).slice(0, 1024), inline: false });
    }
    applyEmbedBranding(embed, {
      guildId,
      moduleKey: 'engagement',
      defaultColor: '#f59e0b',
      defaultFooter: 'GuildPilot · Achievement',
    });
    const message = await channel.send({ embeds: [embed] }).catch(() => null);
    return message?.id || null;
  } catch (error) {
    logger.warn(`[engagement] could not announce achievement: ${error.message}`);
    return null;
  }
}

async function evaluateAchievementsForUser(guildId, userId, username) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const normalizedUserId = String(userId || '').trim();
  const achievements = db.prepare('SELECT * FROM engagement_achievements WHERE guild_id = ? AND enabled = 1 ORDER BY id ASC').all(normalizedGuildId);
  const awarded = [];

  for (const achievement of achievements) {
    const already = db.prepare('SELECT id FROM engagement_achievement_awards WHERE achievement_id = ? AND user_id = ?').get(achievement.id, normalizedUserId);
    if (already) continue;

    const threshold = Number(achievement.threshold || 0);
    const currentValue = computeAchievementMetric(normalizedGuildId, normalizedUserId, achievement.metric_type);
    if (currentValue < threshold) continue;

    const rewardPoints = Math.max(0, Number(achievement.reward_points || 0));
    let announceMessageId = null;

    const transaction = db.transaction(() => {
      db.prepare(`
        INSERT INTO engagement_achievement_awards (achievement_id, guild_id, user_id, reward_points, announced_message_id)
        VALUES (?, ?, ?, ?, NULL)
      `).run(achievement.id, normalizedGuildId, normalizedUserId, rewardPoints);

      if (rewardPoints > 0) {
        awardPoints(normalizedGuildId, normalizedUserId, username, ACTION.ACHIEVEMENT_REWARD, rewardPoints, `achievement:${achievement.id}:${normalizedUserId}`, `Achievement unlocked: ${achievement.name}`);
      }
    });

    try {
      transaction();
      if (achievement.announce_enabled) {
        announceMessageId = await announceAchievement(normalizedGuildId, normalizedUserId, achievement, rewardPoints);
        if (announceMessageId) {
          db.prepare('UPDATE engagement_achievement_awards SET announced_message_id = ? WHERE achievement_id = ? AND user_id = ?')
            .run(announceMessageId, achievement.id, normalizedUserId);
        }
      }
      awarded.push({ ...achievement, reward_points: rewardPoints, announced_message_id: announceMessageId });
    } catch (error) {
      logger.error('[engagement] achievement evaluation failed:', error);
    }
  }

  return awarded;
}

function awardPoints(guildId, userId, username, actionType, points, refId = null, note = null, channelId = null) {
  if (!points || Number(points) === 0) return { awarded: false, reason: 'zero' };

  if (refId) {
    const exists = db.prepare(
      'SELECT id FROM points_ledger WHERE guild_id = ? AND user_id = ? AND reference_id = ?'
    ).get(guildId, userId, refId);
    if (exists) return { awarded: false, reason: 'duplicate' };
  }

  db.prepare(`
    INSERT INTO points_ledger (guild_id, user_id, username, action_type, points, reference_id, note, channel_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, userId, username, actionType, Math.trunc(Number(points)), refId, note, channelId);

  db.prepare(`
    INSERT INTO points_totals (guild_id, user_id, username, total_points, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      total_points = total_points + ?,
      username = excluded.username,
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, userId, username, Math.trunc(Number(points)), Math.trunc(Number(points)));

  evaluateAchievementsForUser(guildId, userId, username).catch(error => {
    logger.warn(`[engagement] achievement follow-up failed: ${error.message}`);
  });

  return { awarded: true, points: Math.trunc(Number(points)) };
}

function tryAwardDiscordMessage(guildId, userId, username, messageId, channelId = null, { isReply = false } = {}) {
  const cfg = getConfig(guildId);
  if (!cfg.enabled) return { awarded: false, reason: 'disabled' };

  const actionType = isReply ? ACTION.REPLY : ACTION.MESSAGE;
  const enabled = isReply ? cfg.discord_replies_enabled : cfg.discord_messages_enabled;
  const cooldown = isReply ? cfg.cooldown_reply_mins : cfg.cooldown_message_mins;
  const rewardPoints = isReply ? cfg.points_reply : cfg.points_message;
  if (!enabled) return { awarded: false, reason: 'disabled' };
  if (isOnCooldown(guildId, userId, actionType, cooldown)) return { awarded: false, reason: 'cooldown' };

  const result = awardPoints(guildId, userId, username, actionType, rewardPoints, `${actionType}:${messageId}`, null, channelId);
  if (result.awarded) stampCooldown(guildId, userId, actionType);
  return result;
}

function tryAwardMessage(guildId, userId, username, messageId, channelId = null, options = {}) {
  return tryAwardDiscordMessage(guildId, userId, username, messageId, channelId, options);
}

function tryAwardReaction(guildId, userId, username, refId, channelId = null) {
  const cfg = getConfig(guildId);
  if (!cfg.enabled || !cfg.discord_reactions_enabled) return { awarded: false, reason: 'disabled' };
  const dayCount = dailyCount(guildId, userId, ACTION.REACTION);
  if (dayCount >= Number(cfg.cooldown_reaction_daily || 0)) return { awarded: false, reason: 'daily_cap' };
  return awardPoints(guildId, userId, username, ACTION.REACTION, cfg.points_reaction, `rxn:${refId}`, null, channelId);
}

function awardGamePoints(guildId, userId, username, points, gameKey, place) {
  return awardPoints(guildId, userId, username, ACTION.GAME_PLACE, points, `game:${gameKey}:${userId}:${Date.now()}`, `${gameKey} place ${place}`);
}

function adminGrant(guildId, userId, username, points, adminId, reason) {
  const refId = `admin:${adminId}:${Date.now()}`;
  const result = awardPoints(
    guildId,
    userId,
    username,
    Number(points) > 0 ? ACTION.ADMIN_GRANT : ACTION.ADMIN_DEDUCT,
    points,
    refId,
    reason || null
  );
  const summary = getUserPoints(guildId, userId);
  return { ...result, newTotal: summary.total_points };
}

function getLeaderboard(guildId, limit = 10) {
  return db.prepare(`
    SELECT user_id, username, total_points
    FROM points_totals
    WHERE guild_id = ?
    ORDER BY total_points DESC, username ASC
    LIMIT ?
  `).all(normalizeGuildId(guildId), Math.max(1, Math.min(Number(limit || 10), 100)));
}

function getUserPoints(guildId, userId) {
  const row = db.prepare('SELECT * FROM points_totals WHERE guild_id = ? AND user_id = ?').get(normalizeGuildId(guildId), String(userId || '').trim());
  const total = Number(row?.total_points || 0);
  const rank = row ? (db.prepare('SELECT COUNT(*) AS r FROM points_totals WHERE guild_id = ? AND total_points > ?').get(normalizeGuildId(guildId), total)?.r || 0) + 1 : null;
  return { ...(row || {}), row: row || null, total_points: total, rank };
}

function getUserHistory(guildId, userId, limit = 10) {
  return db.prepare(`
    SELECT action_type, points, note, channel_id, created_at
    FROM points_ledger
    WHERE guild_id = ? AND user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(normalizeGuildId(guildId), String(userId || '').trim(), Math.max(1, Math.min(Number(limit || 10), 100)));
}

function getShopItems(guildId, { includeDisabled = false } = {}) {
  const sql = includeDisabled
    ? 'SELECT * FROM shop_items WHERE guild_id = ? ORDER BY enabled DESC, cost ASC, id ASC'
    : 'SELECT * FROM shop_items WHERE guild_id = ? AND enabled = 1 ORDER BY cost ASC, id ASC';
  return db.prepare(sql).all(normalizeGuildId(guildId)).map(item => ({
    ...item,
    code_pool: safeJsonParse(item.code_pool, []),
    reward_type: item.reward_type || (item.type === 'code' ? 'auto_code' : 'auto_role'),
    fulfillment_mode: item.fulfillment_mode || (item.type === 'custom' ? 'manual' : 'auto'),
  }));
}

function addShopItem(guildId, payload = {}) {
  const normalizedGuildId = normalizeGuildId(guildId);
  if (normalizedGuildId) {
    const countRow = db.prepare(`
      SELECT COUNT(1) AS count
      FROM shop_items
      WHERE guild_id = ? AND enabled = 1
    `).get(normalizedGuildId);
    const limitCheck = entitlementService.enforceLimit({
      guildId: normalizedGuildId,
      moduleKey: 'engagement',
      limitKey: 'max_shop_items',
      currentCount: Number(countRow?.count || 0),
      incrementBy: 1,
      itemLabel: 'shop items',
    });
    if (!limitCheck.success) {
      return {
        success: false,
        code: 'limit_exceeded',
        message: limitCheck.message,
        limit: limitCheck.limit,
        used: limitCheck.used,
      };
    }
  }

  const type = String(payload.type || 'role').trim() || 'role';
  const rewardType = String(payload.reward_type || payload.rewardType || (type === 'code' ? 'auto_code' : (type === 'role' ? 'auto_role' : 'manual'))).trim();
  const fulfillmentMode = String(payload.fulfillment_mode || payload.fulfillmentMode || (rewardType === 'manual' || type === 'custom' ? 'manual' : 'auto')).trim();
  const codes = uniqStrings(payload.codes || payload.code_pool || []);
  const quantityRemaining = Number.isFinite(Number(payload.quantity_remaining))
    ? Number(payload.quantity_remaining)
    : (type === 'code' ? codes.length : -1);

  const result = db.prepare(`
    INSERT INTO shop_items (
      guild_id, name, description, type, cost, role_id, code_pool, quantity_remaining,
      reward_type, fulfillment_mode, fulfillment_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    normalizedGuildId,
    String(payload.name || '').trim(),
    String(payload.description || '').trim(),
    type,
    Math.max(0, Number(payload.cost || 0)),
    String(payload.roleId || payload.role_id || '').trim() || null,
    JSON.stringify(codes),
    quantityRemaining,
    rewardType,
    fulfillmentMode,
    String(payload.fulfillment_notes || payload.fulfillmentNotes || '').trim() || null
  );
  return { success: true, id: Number(result.lastInsertRowid) };
}

function updateShopItem(guildId, itemId, payload = {}) {
  const existing = db.prepare('SELECT * FROM shop_items WHERE guild_id = ? AND id = ?').get(normalizeGuildId(guildId), Number(itemId));
  if (!existing) return { success: false, message: 'Shop item not found' };
  const merged = {
    ...existing,
    ...payload,
  };
  const codes = uniqStrings(payload.codes !== undefined ? payload.codes : safeJsonParse(existing.code_pool, []));
  db.prepare(`
    UPDATE shop_items
    SET name = ?, description = ?, type = ?, cost = ?, role_id = ?, code_pool = ?, quantity_remaining = ?,
        reward_type = ?, fulfillment_mode = ?, fulfillment_notes = ?, enabled = ?
    WHERE guild_id = ? AND id = ?
  `).run(
    String(merged.name || '').trim(),
    String(merged.description || '').trim(),
    String(merged.type || 'role').trim(),
    Math.max(0, Number(merged.cost || 0)),
    String(merged.roleId || merged.role_id || '').trim() || null,
    JSON.stringify(codes),
    Number.isFinite(Number(merged.quantity_remaining)) ? Number(merged.quantity_remaining) : -1,
    String(merged.reward_type || merged.rewardType || 'auto_role').trim(),
    String(merged.fulfillment_mode || merged.fulfillmentMode || 'auto').trim(),
    String(merged.fulfillment_notes || merged.fulfillmentNotes || '').trim() || null,
    boolToInt(merged.enabled !== false, true),
    normalizeGuildId(guildId),
    Number(itemId)
  );
  return { success: true, id: Number(itemId) };
}

function removeShopItem(guildId, itemId) {
  const result = db.prepare('UPDATE shop_items SET enabled = 0 WHERE guild_id = ? AND id = ?').run(normalizeGuildId(guildId), Number(itemId));
  return { success: result.changes > 0 };
}

async function createManualFulfillment(guildId, redemption, item, purchaser) {
  const cfg = getConfig(guildId);
  const client = clientProvider.getClient();
  const ticketModuleEnabled = tenantService.isModuleEnabled ? tenantService.isModuleEnabled(guildId, 'ticketing') : false;
  const noteText = item.fulfillment_notes
    ? `\nNotes: ${item.fulfillment_notes}`
    : '';

  if (ticketModuleEnabled && cfg.fulfillment_ticket_category_id) {
    const ticketResult = await ticketService.createSystemTicketFromCategory(
      cfg.fulfillment_ticket_category_id,
      {
        guildId,
        openerId: purchaser.userId,
        openerName: purchaser.username,
        title: `Marketplace fulfillment | ${item.name}`,
        intro: `<@${purchaser.userId}> purchased **${item.name}** for **${formatCurrency(guildId, item.cost)}**.${noteText}`,
        templateResponses: {
          Item: item.name,
          Cost: formatCurrency(guildId, item.cost),
          Redemption: `#${redemption.redemptionId}`,
          Buyer: purchaser.username,
          Notes: item.fulfillment_notes || 'None',
        },
      }
    ).catch(error => ({ success: false, message: error.message }));

    if (ticketResult?.success) {
      db.prepare(`
        UPDATE shop_redemptions
        SET fulfillment_status = ?, ticket_channel_id = ?, metadata_json = ?, fulfilled_at = NULL
        WHERE id = ?
      `).run(
        'ticket_created',
        ticketResult.channelId || null,
        JSON.stringify({ ticketNumber: ticketResult.ticketNumber || null }),
        redemption.redemptionId
      );
      return { mode: 'ticket', ticketChannelId: ticketResult.channelId || null, ticketNumber: ticketResult.ticketNumber || null };
    }
  }

  if (client && cfg.purchase_log_channel_id) {
    try {
      const channel = await client.channels.fetch(cfg.purchase_log_channel_id).catch(() => null);
      if (channel && channel.isTextBased()) {
        const embed = new EmbedBuilder()
          .setTitle('Marketplace Redemption')
          .setDescription(`<@${purchaser.userId}> purchased **${item.name}**.`)
          .addFields(
            { name: 'Cost', value: formatCurrency(guildId, item.cost), inline: true },
            { name: 'Redemption', value: `#${redemption.redemptionId}`, inline: true },
            { name: 'Fulfillment', value: item.fulfillment_notes || 'Manual follow-up required', inline: false }
          )
          .setTimestamp();
        applyEmbedBranding(embed, {
          guildId,
          moduleKey: 'engagement',
          defaultColor: '#22c55e',
          defaultFooter: 'GuildPilot · Marketplace',
        });
        const message = await channel.send({ embeds: [embed] }).catch(() => null);
        db.prepare(`
          UPDATE shop_redemptions
          SET fulfillment_status = ?, log_message_id = ?, metadata_json = ?, fulfilled_at = NULL
          WHERE id = ?
        `).run(
          'logged',
          message?.id || null,
          JSON.stringify({ purchaseLogChannelId: cfg.purchase_log_channel_id }),
          redemption.redemptionId
        );
        return { mode: 'log', logMessageId: message?.id || null };
      }
    } catch (error) {
      logger.warn(`[engagement] could not log manual redemption: ${error.message}`);
    }
  }

  return { mode: 'pending' };
}

async function redeemItem(guildId, userId, username, itemId) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const item = db.prepare('SELECT * FROM shop_items WHERE guild_id = ? AND id = ? AND enabled = 1').get(normalizedGuildId, Number(itemId));
  if (!item) return { success: false, reason: 'not_found' };
  if (Number(item.quantity_remaining) === 0) return { success: false, reason: 'out_of_stock' };

  const userPts = getUserPoints(normalizedGuildId, userId);
  if (!userPts.row || userPts.total_points < Number(item.cost || 0)) {
    return { success: false, reason: 'insufficient_points' };
  }

  const normalizedItem = {
    ...item,
    code_pool: safeJsonParse(item.code_pool, []),
    reward_type: item.reward_type || (item.type === 'code' ? 'auto_code' : 'auto_role'),
    fulfillment_mode: item.fulfillment_mode || (item.type === 'custom' ? 'manual' : 'auto'),
  };

  const transaction = db.transaction(() => {
    db.prepare('UPDATE points_totals SET total_points = total_points - ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND user_id = ?')
      .run(item.cost, normalizedGuildId, userId);
    db.prepare(`
      INSERT INTO points_ledger (guild_id, user_id, username, action_type, points, reference_id, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizedGuildId,
      userId,
      username,
      ACTION.SHOP_REDEEM,
      -Math.abs(Number(item.cost || 0)),
      `redeem:${itemId}:${Date.now()}`,
      `Redeemed: ${item.name}`
    );

    let code = null;
    if (Number(item.quantity_remaining) > 0) {
      db.prepare('UPDATE shop_items SET quantity_remaining = quantity_remaining - 1 WHERE id = ?').run(Number(itemId));
    }
    if (normalizedItem.reward_type === 'auto_code' || item.type === 'code') {
      const pool = safeJsonParse(item.code_pool, []);
      code = pool.shift() || null;
      db.prepare('UPDATE shop_items SET code_pool = ? WHERE id = ?').run(JSON.stringify(pool), Number(itemId));
    }

    const fulfillmentStatus = normalizedItem.fulfillment_mode === 'manual' ? 'pending' : 'completed';
    const redemption = db.prepare(`
      INSERT INTO shop_redemptions (guild_id, user_id, item_id, cost, fulfillment_status, metadata_json, fulfilled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizedGuildId,
      userId,
      Number(itemId),
      Number(item.cost || 0),
      fulfillmentStatus,
      JSON.stringify({ rewardType: normalizedItem.reward_type, fulfillmentMode: normalizedItem.fulfillment_mode }),
      fulfillmentStatus === 'completed' ? new Date().toISOString() : null
    );

    return {
      redemptionId: Number(redemption.lastInsertRowid),
      code,
    };
  });

  try {
    const redemption = transaction();
    let fulfillment = { mode: normalizedItem.fulfillment_mode === 'manual' ? 'pending' : 'auto' };
    if (normalizedItem.fulfillment_mode === 'manual') {
      fulfillment = await createManualFulfillment(
        normalizedGuildId,
        redemption,
        normalizedItem,
        { userId: String(userId || '').trim(), username }
      );
    }
    evaluateAchievementsForUser(normalizedGuildId, userId, username).catch(() => {});
    return {
      success: true,
      item: normalizedItem,
      code: redemption.code,
      redemptionId: redemption.redemptionId,
      newTotal: userPts.total_points - Number(item.cost || 0),
      fulfillment,
    };
  } catch (err) {
    logger.error('[engagement] redeem error:', err);
    return { success: false, reason: 'error' };
  }
}

function listRedemptions(guildId, { userId = null, limit = 100 } = {}) {
  let sql = `
    SELECT sr.*, si.name AS item_name, si.description AS item_description, si.reward_type, si.fulfillment_mode
    FROM shop_redemptions sr
    LEFT JOIN shop_items si ON si.id = sr.item_id
    WHERE sr.guild_id = ?
  `;
  const params = [normalizeGuildId(guildId)];
  if (userId) {
    sql += ' AND sr.user_id = ?';
    params.push(String(userId || '').trim());
  }
  sql += ' ORDER BY sr.created_at DESC LIMIT ?';
  params.push(Math.max(1, Math.min(Number(limit || 100), 500)));
  return db.prepare(sql).all(...params).map(row => ({
    ...row,
    metadata: safeJsonParse(row.metadata_json, {}),
  }));
}

function getAchievements(guildId, { includeDisabled = false } = {}) {
  const sql = includeDisabled
    ? 'SELECT * FROM engagement_achievements WHERE guild_id = ? ORDER BY created_at DESC, id DESC'
    : 'SELECT * FROM engagement_achievements WHERE guild_id = ? AND enabled = 1 ORDER BY created_at DESC, id DESC';
  return db.prepare(sql).all(normalizeGuildId(guildId)).map(row => ({
    ...row,
    filters: safeJsonParse(row.filters_json, {}),
  }));
}

function upsertAchievement(guildId, payload = {}) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const metricType = String(payload.metric_type || payload.metricType || '').trim();
  if (!normalizedGuildId || !metricType) return { success: false, message: 'guildId and metric_type are required' };
  if (!Object.values(ACHIEVEMENT_METRICS).includes(metricType)) return { success: false, message: 'Unsupported metric_type' };

  const id = payload.id ? Number(payload.id) : null;
  const values = [
    String(payload.name || '').trim(),
    String(payload.description || '').trim() || null,
    String(payload.icon || '').trim() || null,
    metricType,
    Math.max(1, Number(payload.threshold || 1)),
    Math.max(0, Number(payload.reward_points || payload.rewardPoints || 0)),
    boolToInt(payload.enabled !== false, true),
    JSON.stringify(normalizeRequirements(payload.filters)),
    boolToInt(payload.announce_enabled !== false, true),
  ];

  if (id) {
    db.prepare(`
      UPDATE engagement_achievements
      SET name = ?, description = ?, icon = ?, metric_type = ?, threshold = ?, reward_points = ?,
          enabled = ?, filters_json = ?, announce_enabled = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?
    `).run(...values, id, normalizedGuildId);
    return { success: true, id };
  }

  const result = db.prepare(`
    INSERT INTO engagement_achievements (
      guild_id, name, description, icon, metric_type, threshold, reward_points, enabled, filters_json, announce_enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(normalizedGuildId, ...values);
  return { success: true, id: Number(result.lastInsertRowid) };
}

function deleteAchievement(guildId, id) {
  const result = db.prepare('DELETE FROM engagement_achievements WHERE guild_id = ? AND id = ?').run(normalizeGuildId(guildId), Number(id));
  return { success: result.changes > 0 };
}

function listUserAchievements(guildId, userId) {
  return db.prepare(`
    SELECT aa.*, a.name, a.description, a.icon, a.metric_type, a.threshold
    FROM engagement_achievement_awards aa
    INNER JOIN engagement_achievements a ON a.id = aa.achievement_id
    WHERE aa.guild_id = ? AND aa.user_id = ?
    ORDER BY aa.created_at DESC
  `).all(normalizeGuildId(guildId), String(userId || '').trim());
}

function listUserEngagementSummary(guildId, userId) {
  return {
    points: getUserPoints(guildId, userId),
    linkedAccounts: listLinkedAccounts(guildId, userId),
    tasks: listTasks(guildId, { userId, status: 'active', limit: 20 }),
    achievements: listUserAchievements(guildId, userId),
    redemptions: listRedemptions(guildId, { userId, limit: 20 }),
  };
}

function recordTaskCompletion(guildId, taskId, userId, username, payload = {}) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const task = db.prepare('SELECT * FROM engagement_social_tasks WHERE guild_id = ? AND id = ?').get(normalizedGuildId, Number(taskId));
  if (!task) return { success: false, message: 'Task not found' };

  const actionType = String(payload.action_type || payload.actionType || '').trim();
  const requiredActions = safeJsonParse(task.required_actions_json, []);
  if (!requiredActions.includes(actionType)) return { success: false, message: 'Action is not configured for this task' };

  const existing = db.prepare(`
    SELECT id
    FROM engagement_task_completions
    WHERE task_id = ? AND user_id = ? AND action_type = ?
  `).get(Number(taskId), String(userId || '').trim(), actionType);
  if (existing) return { success: false, message: 'Task action already recorded' };

  const rewardConfig = safeJsonParse(task.reward_config_json, {});
  const rewardPoints = Math.max(0, Number(rewardConfig[actionType] || 0));
  const linkedAccount = payload.linked_account_id
    ? db.prepare('SELECT * FROM engagement_social_accounts WHERE id = ? AND guild_id = ? AND user_id = ?').get(Number(payload.linked_account_id), normalizedGuildId, String(userId || '').trim())
    : null;

  const status = String(payload.status || 'verified').trim() || 'verified';
  const referenceId = String(payload.reference_id || payload.referenceId || `${task.provider}:${task.id}:${userId}:${actionType}`).trim();

  db.prepare(`
    INSERT INTO engagement_task_completions (
      task_id, guild_id, user_id, provider, action_type, linked_account_id, status,
      reward_points, reference_id, verified_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(taskId),
    normalizedGuildId,
    String(userId || '').trim(),
    task.provider,
    actionType,
    linkedAccount?.id || null,
    status,
    rewardPoints,
    referenceId,
    status === 'verified' ? new Date().toISOString() : null,
    JSON.stringify(normalizeRequirements(payload.metadata))
  );

  if (status === 'verified' && rewardPoints > 0) {
    awardPoints(
      normalizedGuildId,
      String(userId || '').trim(),
      username,
      ACTION.SOCIAL_TASK,
      rewardPoints,
      `task:${taskId}:${actionType}:${userId}`,
      `Completed social task: ${task.title || task.provider}`,
      task.mirrored_channel_id || null
    );
  }

  return { success: true, rewardPoints, status };
}

module.exports = {
  ACTION,
  ACHIEVEMENT_METRICS,
  getConfig,
  setConfig,
  getCurrencyMeta,
  formatCurrency,
  getProviderCatalog,
  listMonitoredAccounts,
  upsertMonitoredAccount,
  deleteMonitoredAccount,
  listHashtagMonitors,
  upsertHashtagMonitor,
  deleteHashtagMonitor,
  listLinkedAccounts,
  upsertLinkedAccount,
  disconnectLinkedAccount,
  createTask,
  listTasks,
  listTaskCompletions,
  ingestProviderPost,
  tryAwardDiscordMessage,
  tryAwardMessage,
  tryAwardReaction,
  awardGamePoints,
  adminGrant,
  getLeaderboard,
  getUserPoints,
  getUserHistory,
  getShopItems,
  addShopItem,
  updateShopItem,
  removeShopItem,
  redeemItem,
  listRedemptions,
  getAchievements,
  upsertAchievement,
  deleteAchievement,
  listUserAchievements,
  listUserEngagementSummary,
  recordTaskCompletion,
  evaluateAchievementsForUser,
};
