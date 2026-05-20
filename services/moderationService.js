const db = require('../database/db');
const logger = require('../utils/logger');

const DEFAULTS = Object.freeze({
  antiRaidEnabled: false,
  antiRaidWindowSeconds: 30,
  antiRaidJoinThreshold: 8,
  antiRaidAction: 'timeout',
  antiRaidTimeoutMinutes: 10,
  keywordFilterEnabled: false,
  keywordFilterDelete: true,
  keywordFilterWarn: true,
  logChannelId: null,
});

const joinWindowState = new Map();

function toBool(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  return Number(value) === 1 || value === true;
}

function normalizeSettings(row) {
  const src = row || {};
  return {
    antiRaidEnabled: toBool(src.anti_raid_enabled, DEFAULTS.antiRaidEnabled),
    antiRaidWindowSeconds: Math.max(10, Math.min(300, Number(src.anti_raid_window_seconds || DEFAULTS.antiRaidWindowSeconds) || DEFAULTS.antiRaidWindowSeconds)),
    antiRaidJoinThreshold: Math.max(2, Math.min(50, Number(src.anti_raid_join_threshold || DEFAULTS.antiRaidJoinThreshold) || DEFAULTS.antiRaidJoinThreshold)),
    antiRaidAction: ['timeout', 'kick'].includes(String(src.anti_raid_action || '').toLowerCase()) ? String(src.anti_raid_action).toLowerCase() : DEFAULTS.antiRaidAction,
    antiRaidTimeoutMinutes: Math.max(1, Math.min(120, Number(src.anti_raid_timeout_minutes || DEFAULTS.antiRaidTimeoutMinutes) || DEFAULTS.antiRaidTimeoutMinutes)),
    keywordFilterEnabled: toBool(src.keyword_filter_enabled, DEFAULTS.keywordFilterEnabled),
    keywordFilterDelete: toBool(src.keyword_filter_delete, DEFAULTS.keywordFilterDelete),
    keywordFilterWarn: toBool(src.keyword_filter_warn, DEFAULTS.keywordFilterWarn),
    logChannelId: src.log_channel_id ? String(src.log_channel_id) : null,
  };
}

function getSettings(guildId) {
  const gid = String(guildId || '').trim();
  if (!gid) return { ...DEFAULTS };
  const row = db.prepare('SELECT * FROM tenant_moderation_settings WHERE guild_id = ?').get(gid);
  return normalizeSettings(row);
}

function saveSettings(guildId, patch = {}) {
  const gid = String(guildId || '').trim();
  if (!gid) return { success: false, message: 'Missing guild id' };
  const current = getSettings(gid);
  const next = {
    antiRaidEnabled: patch.antiRaidEnabled !== undefined ? !!patch.antiRaidEnabled : current.antiRaidEnabled,
    antiRaidWindowSeconds: patch.antiRaidWindowSeconds !== undefined ? Math.max(10, Math.min(300, Number(patch.antiRaidWindowSeconds) || current.antiRaidWindowSeconds)) : current.antiRaidWindowSeconds,
    antiRaidJoinThreshold: patch.antiRaidJoinThreshold !== undefined ? Math.max(2, Math.min(50, Number(patch.antiRaidJoinThreshold) || current.antiRaidJoinThreshold)) : current.antiRaidJoinThreshold,
    antiRaidAction: patch.antiRaidAction !== undefined && ['timeout', 'kick'].includes(String(patch.antiRaidAction).toLowerCase()) ? String(patch.antiRaidAction).toLowerCase() : current.antiRaidAction,
    antiRaidTimeoutMinutes: patch.antiRaidTimeoutMinutes !== undefined ? Math.max(1, Math.min(120, Number(patch.antiRaidTimeoutMinutes) || current.antiRaidTimeoutMinutes)) : current.antiRaidTimeoutMinutes,
    keywordFilterEnabled: patch.keywordFilterEnabled !== undefined ? !!patch.keywordFilterEnabled : current.keywordFilterEnabled,
    keywordFilterDelete: patch.keywordFilterDelete !== undefined ? !!patch.keywordFilterDelete : current.keywordFilterDelete,
    keywordFilterWarn: patch.keywordFilterWarn !== undefined ? !!patch.keywordFilterWarn : current.keywordFilterWarn,
    logChannelId: patch.logChannelId !== undefined ? (patch.logChannelId ? String(patch.logChannelId) : null) : current.logChannelId,
  };

  db.prepare(`
    INSERT INTO tenant_moderation_settings (
      guild_id, anti_raid_enabled, anti_raid_window_seconds, anti_raid_join_threshold,
      anti_raid_action, anti_raid_timeout_minutes, keyword_filter_enabled,
      keyword_filter_delete, keyword_filter_warn, log_channel_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO UPDATE SET
      anti_raid_enabled = excluded.anti_raid_enabled,
      anti_raid_window_seconds = excluded.anti_raid_window_seconds,
      anti_raid_join_threshold = excluded.anti_raid_join_threshold,
      anti_raid_action = excluded.anti_raid_action,
      anti_raid_timeout_minutes = excluded.anti_raid_timeout_minutes,
      keyword_filter_enabled = excluded.keyword_filter_enabled,
      keyword_filter_delete = excluded.keyword_filter_delete,
      keyword_filter_warn = excluded.keyword_filter_warn,
      log_channel_id = excluded.log_channel_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    gid,
    next.antiRaidEnabled ? 1 : 0,
    next.antiRaidWindowSeconds,
    next.antiRaidJoinThreshold,
    next.antiRaidAction,
    next.antiRaidTimeoutMinutes,
    next.keywordFilterEnabled ? 1 : 0,
    next.keywordFilterDelete ? 1 : 0,
    next.keywordFilterWarn ? 1 : 0,
    next.logChannelId,
  );

  return { success: true, settings: next };
}

function listKeywords(guildId) {
  const gid = String(guildId || '').trim();
  if (!gid) return [];
  return db.prepare('SELECT keyword FROM tenant_moderation_keywords WHERE guild_id = ? ORDER BY keyword ASC').all(gid).map((row) => String(row.keyword || ''));
}

function addKeyword(guildId, keyword) {
  const gid = String(guildId || '').trim();
  const normalized = String(keyword || '').trim().toLowerCase();
  if (!gid || !normalized) return { success: false, message: 'Keyword is required.' };
  if (normalized.length < 2 || normalized.length > 64) return { success: false, message: 'Keyword must be 2-64 characters.' };
  db.prepare('INSERT OR IGNORE INTO tenant_moderation_keywords (guild_id, keyword) VALUES (?, ?)').run(gid, normalized);
  return { success: true };
}

function removeKeyword(guildId, keyword) {
  const gid = String(guildId || '').trim();
  const normalized = String(keyword || '').trim().toLowerCase();
  if (!gid || !normalized) return { success: false, message: 'Keyword is required.' };
  const result = db.prepare('DELETE FROM tenant_moderation_keywords WHERE guild_id = ? AND keyword = ?').run(gid, normalized);
  return { success: result.changes > 0 };
}

function checkMessageForKeywords(guildId, content) {
  const settings = getSettings(guildId);
  if (!settings.keywordFilterEnabled) return { matched: false };
  const text = String(content || '').toLowerCase();
  if (!text) return { matched: false };
  const keywords = listKeywords(guildId);
  const hit = keywords.find((keyword) => text.includes(keyword));
  if (!hit) return { matched: false };
  return { matched: true, keyword: hit, settings };
}

async function processJoin(member) {
  const guildId = String(member?.guild?.id || '').trim();
  if (!guildId) return { triggered: false };
  const settings = getSettings(guildId);
  if (!settings.antiRaidEnabled) return { triggered: false };

  const now = Date.now();
  const windowMs = settings.antiRaidWindowSeconds * 1000;
  const key = guildId;
  const buffer = joinWindowState.get(key) || [];
  const pruned = buffer.filter((ts) => now - ts <= windowMs);
  pruned.push(now);
  joinWindowState.set(key, pruned);

  if (pruned.length < settings.antiRaidJoinThreshold) return { triggered: false };

  try {
    if (settings.antiRaidAction === 'kick') {
      await member.kick('Anti-raid auto action');
    } else {
      await member.timeout(settings.antiRaidTimeoutMinutes * 60 * 1000, 'Anti-raid auto action');
    }
    logger.warn(`[moderation] anti-raid action=${settings.antiRaidAction} guild=${guildId} user=${member.id}`);
    return { triggered: true, action: settings.antiRaidAction };
  } catch (error) {
    logger.warn(`[moderation] anti-raid failed guild=${guildId} user=${member.id} error=${error?.message || error}`);
    return { triggered: false, error: error?.message || 'unknown' };
  }
}

module.exports = {
  getSettings,
  saveSettings,
  listKeywords,
  addKeyword,
  removeKeyword,
  checkMessageForKeywords,
  processJoin,
};
