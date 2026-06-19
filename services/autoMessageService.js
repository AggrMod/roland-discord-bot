const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database/db');
const logger = require('../utils/logger');
const tenantService = require('./tenantService');
const entitlementService = require('./entitlementService');
const clientProvider = require('../utils/clientProvider');

const DEFAULT_TIMEZONE = 'Europe/Amsterdam';
const DEFAULT_COLOR = 0x2AABEE;
const MIN_INTERVAL_MINUTES = 15;
const MAX_FAILURE_BACKOFF_MINUTES = 15;
const VALID_SCHEDULE_TYPES = new Set(['interval', 'daily', 'weekly']);
const WEEKDAY_INDEX = Object.freeze({
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
});

function normalizeGuildId(guildId) {
  const value = String(guildId || '').trim();
  return /^\d{17,20}$/.test(value) ? value : '';
}

function normalizeId(value) {
  const id = String(value || '').trim();
  return /^\d{17,20}$/.test(id) ? id : '';
}

function parseJsonObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { ...fallback };
  } catch (_error) {
    return { ...fallback };
  }
}

function clampString(value, max, fallback = '') {
  const raw = String(value ?? '').trim();
  const text = raw || fallback;
  return text.slice(0, max);
}

function isValidTimezone(timezone) {
  try {
    global.Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch (_error) {
    return false;
  }
}

function normalizeTimezone(value) {
  const timezone = String(value || '').trim() || DEFAULT_TIMEZONE;
  return isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
}

function normalizeTime(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return '09:00';
  return `${String(match[1]).padStart(2, '0')}:${match[2]}`;
}

function normalizeWeekdays(value) {
  const input = Array.isArray(value) ? value : [];
  const days = input
    .map(day => String(day || '').trim().toLowerCase().slice(0, 3))
    .filter(day => Object.prototype.hasOwnProperty.call(WEEKDAY_INDEX, day));
  return Array.from(new Set(days)).sort((a, b) => WEEKDAY_INDEX[a] - WEEKDAY_INDEX[b]);
}

function normalizeSchedule(type, config = {}) {
  const scheduleType = VALID_SCHEDULE_TYPES.has(String(type || '').trim()) ? String(type).trim() : 'interval';
  if (scheduleType === 'interval') {
    const unit = ['minutes', 'hours', 'days'].includes(String(config.unit || '').trim()) ? String(config.unit).trim() : 'hours';
    const minValue = unit === 'minutes' ? MIN_INTERVAL_MINUTES : 1;
    const value = Math.max(minValue, Math.min(365, Math.floor(Number(config.value || (unit === 'minutes' ? MIN_INTERVAL_MINUTES : 1)))));
    return { scheduleType, scheduleConfig: { value, unit } };
  }
  if (scheduleType === 'weekly') {
    const weekdays = normalizeWeekdays(config.weekdays);
    return {
      scheduleType,
      scheduleConfig: {
        time: normalizeTime(config.time),
        weekdays: weekdays.length ? weekdays : ['mon'],
      },
    };
  }
  return {
    scheduleType,
    scheduleConfig: {
      time: normalizeTime(config.time),
    },
  };
}

function normalizeEmbed(value) {
  const embed = parseJsonObject(value, {});
  const title = clampString(embed.title, 256, 'Announcement');
  const description = clampString(embed.description, 4096, 'Message coming soon.');
  const colorRaw = String(embed.color || '').trim();
  const color = /^#?[0-9a-f]{6}$/i.test(colorRaw) ? (colorRaw.startsWith('#') ? colorRaw : `#${colorRaw}`) : '#2AABEE';
  const normalized = { title, description, color };
  const imageUrl = clampString(embed.imageUrl || embed.image_url, 2048);
  const thumbnailUrl = clampString(embed.thumbnailUrl || embed.thumbnail_url, 2048);
  const footer = clampString(embed.footer, 2048);
  if (imageUrl) normalized.imageUrl = imageUrl;
  if (thumbnailUrl) normalized.thumbnailUrl = thumbnailUrl;
  if (footer) normalized.footer = footer;
  return normalized;
}

function rowToMessage(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    name: row.name,
    channelId: row.channel_id,
    enabled: row.enabled !== 0,
    scheduleType: row.schedule_type,
    scheduleConfig: parseJsonObject(row.schedule_config_json, {}),
    timezone: row.timezone || DEFAULT_TIMEZONE,
    embed: parseJsonObject(row.embed_json, {}),
    contentText: row.content_text || '',
    allowEveryone: row.allow_everyone === 1,
    lastSentAt: row.last_sent_at || null,
    nextRunAt: row.next_run_at || null,
    lastError: row.last_error || null,
    failureCount: Number(row.failure_count || 0),
    sendCount: Number(row.send_count || 0),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function rowToAudit(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    autoMessageId: row.auto_message_id === null || row.auto_message_id === undefined ? null : Number(row.auto_message_id),
    channelId: row.channel_id || '',
    status: row.status,
    eventType: row.event_type,
    discordMessageId: row.discord_message_id || '',
    message: row.message || '',
    details: parseJsonObject(row.details_json, {}),
    createdAt: row.created_at || null,
  };
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function intervalToMinutes(config) {
  const value = Math.max(1, Math.floor(Number(config?.value || 1)));
  const unit = String(config?.unit || 'hours');
  if (unit === 'days') return value * 24 * 60;
  if (unit === 'hours') return value * 60;
  return Math.max(MIN_INTERVAL_MINUTES, value);
}

function getZonedParts(date, timezone) {
  const parts = new global.Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function zonedDateTimeToUtc({ year, month, day, hour, minute, second = 0 }, timezone) {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  for (let index = 0; index < 3; index += 1) {
    const parts = getZonedParts(guess, timezone);
    const wanted = Date.UTC(year, month - 1, day, hour, minute, second);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const diff = actual - wanted;
    if (diff === 0) break;
    guess = new Date(guess.getTime() - diff);
  }
  return guess;
}

function addLocalDays(parts, days) {
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function localWeekday(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0)).getUTCDay();
}

function computeNextDailyOrWeekly(scheduleType, config, timezone, fromDate) {
  const [hour, minute] = normalizeTime(config?.time).split(':').map(Number);
  const fromParts = getZonedParts(fromDate, timezone);
  const allowed = scheduleType === 'weekly'
    ? new Set(normalizeWeekdays(config?.weekdays).map(day => WEEKDAY_INDEX[day]))
    : null;

  for (let offset = 0; offset <= 14; offset += 1) {
    const day = addLocalDays(fromParts, offset);
    if (allowed && !allowed.has(localWeekday(day))) continue;
    const candidate = zonedDateTimeToUtc({ ...day, hour, minute, second: 0 }, timezone);
    if (candidate.getTime() > fromDate.getTime()) return candidate;
  }
  return addMinutes(fromDate, 24 * 60);
}

function computeNextRunFromConfig(scheduleType, scheduleConfig, timezone, fromDate = new Date()) {
  const base = fromDate instanceof Date ? fromDate : new Date(fromDate);
  const safeBase = Number.isNaN(base.getTime()) ? new Date() : base;
  if (scheduleType === 'interval') {
    return addMinutes(safeBase, intervalToMinutes(scheduleConfig));
  }
  return computeNextDailyOrWeekly(scheduleType, scheduleConfig, timezone, safeBase);
}

function toSqlDate(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

class AutoMessageService {
  constructor() {
    this.scheduler = null;
    this.schedulerRunning = false;
  }

  getSettings(guildId) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return { enabled: false };
    db.prepare('INSERT OR IGNORE INTO auto_message_settings (guild_id) VALUES (?)').run(gid);
    const row = db.prepare('SELECT * FROM auto_message_settings WHERE guild_id = ?').get(gid);
    return {
      guildId: gid,
      enabled: row ? row.enabled !== 0 : true,
      updatedAt: row?.updated_at || null,
    };
  }

  updateSettings(guildId, payload = {}) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return { success: false, code: 'invalid_guild', message: 'Valid guild is required' };
    const enabled = payload.enabled === undefined ? this.getSettings(gid).enabled : !!payload.enabled;
    db.prepare(`
      INSERT INTO auto_message_settings (guild_id, enabled, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id) DO UPDATE SET enabled = excluded.enabled, updated_at = CURRENT_TIMESTAMP
    `).run(gid, enabled ? 1 : 0);
    return { success: true, settings: this.getSettings(gid) };
  }

  getMessages(guildId, { includeDisabled = true } = {}) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return [];
    const rows = includeDisabled
      ? db.prepare('SELECT * FROM auto_messages WHERE guild_id = ? ORDER BY enabled DESC, next_run_at ASC, id DESC').all(gid)
      : db.prepare('SELECT * FROM auto_messages WHERE guild_id = ? AND enabled = 1 ORDER BY next_run_at ASC, id DESC').all(gid);
    return rows.map(rowToMessage);
  }

  getMessage(guildId, messageId) {
    const gid = normalizeGuildId(guildId);
    const id = Number(messageId);
    if (!gid || !Number.isInteger(id) || id <= 0) return null;
    return rowToMessage(db.prepare('SELECT * FROM auto_messages WHERE guild_id = ? AND id = ?').get(gid, id));
  }

  checkLimit(guildId) {
    const currentCount = Number(db.prepare('SELECT COUNT(1) AS count FROM auto_messages WHERE guild_id = ?').get(guildId)?.count || 0);
    return entitlementService.enforceLimit({
      guildId,
      moduleKey: 'automessages',
      limitKey: 'max_auto_messages',
      currentCount,
      incrementBy: 1,
      itemLabel: 'auto messages',
    });
  }

  normalizePayload(payload = {}, existing = null) {
    const schedule = normalizeSchedule(payload.scheduleType || payload.schedule_type || existing?.scheduleType, payload.scheduleConfig || payload.schedule_config || existing?.scheduleConfig || {});
    const timezone = normalizeTimezone(payload.timezone || existing?.timezone || DEFAULT_TIMEZONE);
    const embed = normalizeEmbed(payload.embed || existing?.embed || {});
    const contentText = clampString(payload.contentText ?? payload.content_text ?? existing?.contentText ?? '', 1900);
    const allowEveryone = payload.allowEveryone ?? payload.allow_everyone ?? existing?.allowEveryone ?? false;
    return {
      name: clampString(payload.name ?? existing?.name, 120, embed.title || 'Auto Message'),
      channelId: normalizeId(payload.channelId || payload.channel_id || existing?.channelId),
      enabled: payload.enabled === undefined ? (existing ? !!existing.enabled : true) : !!payload.enabled,
      scheduleType: schedule.scheduleType,
      scheduleConfig: schedule.scheduleConfig,
      timezone,
      embed,
      contentText,
      allowEveryone: !!allowEveryone,
    };
  }

  createMessage(guildId, payload = {}) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return { success: false, code: 'invalid_guild', message: 'Valid guild is required' };
    const limit = this.checkLimit(gid);
    if (!limit.allowed) {
      return { success: false, code: 'limit_exceeded', message: limit.message, limit };
    }
    const normalized = this.normalizePayload(payload);
    if (!normalized.channelId) return { success: false, code: 'invalid_channel', message: 'Valid Discord channel is required' };
    const nextRunAt = toSqlDate(this.computeNextRun(normalized, new Date()));
    const result = db.prepare(`
      INSERT INTO auto_messages (
        guild_id, name, channel_id, enabled, schedule_type, schedule_config_json, timezone,
        embed_json, content_text, allow_everyone, next_run_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      gid,
      normalized.name,
      normalized.channelId,
      normalized.enabled ? 1 : 0,
      normalized.scheduleType,
      JSON.stringify(normalized.scheduleConfig),
      normalized.timezone,
      JSON.stringify(normalized.embed),
      normalized.contentText || null,
      normalized.allowEveryone ? 1 : 0,
      nextRunAt
    );
    return { success: true, message: this.getMessage(gid, result.lastInsertRowid) };
  }

  updateMessage(guildId, messageId, payload = {}) {
    const current = this.getMessage(guildId, messageId);
    if (!current) return { success: false, code: 'not_found', message: 'Auto message not found' };
    const normalized = this.normalizePayload(payload, current);
    if (!normalized.channelId) return { success: false, code: 'invalid_channel', message: 'Valid Discord channel is required' };
    const nextRunAt = toSqlDate(this.computeNextRun(normalized, new Date()));
    db.prepare(`
      UPDATE auto_messages
      SET name = ?, channel_id = ?, enabled = ?, schedule_type = ?, schedule_config_json = ?,
          timezone = ?, embed_json = ?, content_text = ?, allow_everyone = ?, next_run_at = ?,
          last_error = NULL, failure_count = 0, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND id = ?
    `).run(
      normalized.name,
      normalized.channelId,
      normalized.enabled ? 1 : 0,
      normalized.scheduleType,
      JSON.stringify(normalized.scheduleConfig),
      normalized.timezone,
      JSON.stringify(normalized.embed),
      normalized.contentText || null,
      normalized.allowEveryone ? 1 : 0,
      nextRunAt,
      current.guildId,
      current.id
    );
    return { success: true, message: this.getMessage(current.guildId, current.id) };
  }

  deleteMessage(guildId, messageId) {
    const current = this.getMessage(guildId, messageId);
    if (!current) return { success: false, code: 'not_found', message: 'Auto message not found' };
    db.prepare('DELETE FROM auto_messages WHERE guild_id = ? AND id = ?').run(current.guildId, current.id);
    return { success: true };
  }

  getAudit(guildId, { messageId = null, status = '', limit = 100 } = {}) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return [];
    const clauses = ['guild_id = ?'];
    const params = [gid];
    if (messageId) {
      clauses.push('auto_message_id = ?');
      params.push(Number(messageId));
    }
    if (status) {
      clauses.push('status = ?');
      params.push(String(status));
    }
    params.push(Math.max(1, Math.min(250, Number(limit) || 100)));
    return db.prepare(`
      SELECT * FROM auto_message_audit
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params).map(rowToAudit);
  }

  recordAudit({ guildId, autoMessageId = null, channelId = '', status, eventType = 'send', discordMessageId = '', message = '', details = null }) {
    const gid = normalizeGuildId(guildId) || String(guildId || '');
    db.prepare(`
      INSERT INTO auto_message_audit (guild_id, auto_message_id, channel_id, status, event_type, discord_message_id, message, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      gid,
      autoMessageId,
      channelId || null,
      String(status || 'unknown'),
      String(eventType || 'send'),
      discordMessageId || null,
      String(message || '').slice(0, 1000),
      details ? JSON.stringify(details).slice(0, 4000) : null
    );
  }

  buildPayload(message) {
    const embedConfig = normalizeEmbed(message.embed);
    const embed = new EmbedBuilder()
      .setColor(Number.parseInt(embedConfig.color.replace('#', ''), 16) || DEFAULT_COLOR)
      .setTitle(embedConfig.title)
      .setDescription(embedConfig.description)
      .setTimestamp();
    if (embedConfig.imageUrl) embed.setImage(embedConfig.imageUrl);
    if (embedConfig.thumbnailUrl) embed.setThumbnail(embedConfig.thumbnailUrl);
    if (embedConfig.footer) embed.setFooter({ text: embedConfig.footer });
    const allowedMentions = message.allowEveryone
      ? { parse: ['users', 'roles', 'everyone'] }
      : { parse: ['users', 'roles'] };
    return {
      content: message.contentText || undefined,
      embeds: [embed],
      allowedMentions,
    };
  }

  async resolveChannel(message) {
    const client = clientProvider.getClient();
    if (!client) return null;
    return client.channels?.fetch ? client.channels.fetch(message.channelId).catch(() => null) : null;
  }

  async sendMessage(message, { test = false } = {}) {
    const settings = this.getSettings(message.guildId);
    if (!test && (!settings.enabled || !message.enabled)) {
      this.recordAudit({ guildId: message.guildId, autoMessageId: message.id, channelId: message.channelId, status: 'skipped', eventType: 'send', message: 'Auto message is disabled' });
      return { success: true, skipped: true };
    }
    if (!test && tenantService.isMultitenantEnabled() && !tenantService.isModuleEnabled(message.guildId, 'automessages')) {
      this.recordAudit({ guildId: message.guildId, autoMessageId: message.id, channelId: message.channelId, status: 'skipped', eventType: 'send', message: 'Auto Messages module is disabled' });
      return { success: true, skipped: true };
    }

    const channel = await this.resolveChannel(message);
    if (!channel || !channel.isTextBased?.()) {
      throw new Error('Discord channel not found or not text-based');
    }
    const sent = await channel.send(this.buildPayload(message));
    this.recordAudit({
      guildId: message.guildId,
      autoMessageId: message.id,
      channelId: message.channelId,
      status: test ? 'test' : 'sent',
      eventType: test ? 'test' : 'send',
      discordMessageId: sent?.id || '',
      message: test ? 'Test auto message sent' : 'Auto message sent',
    });
    return { success: true, discordMessageId: sent?.id || null };
  }

  computeNextRun(message, fromDate = new Date()) {
    const scheduleType = VALID_SCHEDULE_TYPES.has(message?.scheduleType) ? message.scheduleType : 'interval';
    const scheduleConfig = message?.scheduleConfig || {};
    const timezone = normalizeTimezone(message?.timezone);
    return computeNextRunFromConfig(scheduleType, scheduleConfig, timezone, fromDate);
  }

  async sendTestMessage(guildId, messageId) {
    const message = this.getMessage(guildId, messageId);
    if (!message) return { success: false, code: 'not_found', message: 'Auto message not found' };
    try {
      const result = await this.sendMessage(message, { test: true });
      return { success: true, ...result };
    } catch (error) {
      this.recordAudit({ guildId: message.guildId, autoMessageId: message.id, channelId: message.channelId, status: 'failed', eventType: 'test', message: error?.message || 'Test send failed' });
      return { success: false, code: 'send_failed', message: error?.message || 'Failed to send test message' };
    }
  }

  async processDueMessage(message) {
    try {
      const result = await this.sendMessage(message, { test: false });
      const nextRunAt = toSqlDate(this.computeNextRun(message, new Date()));
      db.prepare(`
        UPDATE auto_messages
        SET last_sent_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_sent_at END,
            next_run_at = ?, last_error = NULL, failure_count = 0,
            send_count = send_count + CASE WHEN ? = 1 THEN 1 ELSE 0 END,
            updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND id = ?
      `).run(result.skipped ? 0 : 1, nextRunAt, result.skipped ? 0 : 1, message.guildId, message.id);
      return { success: true, skipped: !!result.skipped };
    } catch (error) {
      const failureCount = Math.min(10, Number(message.failureCount || 0) + 1);
      const backoff = Math.min(MAX_FAILURE_BACKOFF_MINUTES, failureCount * 2);
      const retryAt = toSqlDate(addMinutes(new Date(), backoff));
      db.prepare(`
        UPDATE auto_messages
        SET last_error = ?, failure_count = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND id = ?
      `).run(String(error?.message || 'Send failed').slice(0, 1000), failureCount, retryAt, message.guildId, message.id);
      this.recordAudit({ guildId: message.guildId, autoMessageId: message.id, channelId: message.channelId, status: 'failed', eventType: 'send', message: error?.message || 'Send failed', details: { retryAt } });
      return { success: false, error };
    }
  }

  async runDueMessages(now = new Date()) {
    const nowSql = toSqlDate(now);
    const rows = db.prepare(`
      SELECT * FROM auto_messages
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND datetime(next_run_at) <= datetime(?)
      ORDER BY datetime(next_run_at) ASC, id ASC
      LIMIT 100
    `).all(nowSql);
    const summary = { scanned: rows.length, sent: 0, skipped: 0, failed: 0 };
    for (const row of rows) {
      const message = rowToMessage(row);
      const result = await this.processDueMessage(message);
      if (result.success && result.skipped) summary.skipped += 1;
      else if (result.success) summary.sent += 1;
      else summary.failed += 1;
    }
    return summary;
  }

  startScheduler({ intervalMs = 60 * 1000 } = {}) {
    if (this.scheduler) return;
    const tick = async () => {
      if (this.schedulerRunning) return;
      this.schedulerRunning = true;
      try {
        const summary = await this.runDueMessages(new Date());
        if (summary.sent || summary.failed) {
          logger.log(`[auto-messages] sent=${summary.sent} skipped=${summary.skipped} failed=${summary.failed}`);
        }
      } catch (error) {
        logger.error('[auto-messages] scheduler failed:', error);
      } finally {
        this.schedulerRunning = false;
      }
    };
    this.scheduler = setInterval(tick, Math.max(15 * 1000, Number(intervalMs) || 60 * 1000));
    this.scheduler.unref?.();
    setTimeout(tick, 10 * 1000).unref?.();
    logger.log('[auto-messages] scheduler started');
  }

  stopScheduler() {
    if (this.scheduler) {
      clearInterval(this.scheduler);
      this.scheduler = null;
      logger.log('[auto-messages] scheduler stopped');
    }
  }
}

module.exports = new AutoMessageService();
module.exports._private = {
  normalizeSchedule,
  normalizeEmbed,
  normalizeTimezone,
  computeNextRunFromConfig,
  getZonedParts,
  zonedDateTimeToUtc,
  PermissionFlagsBits,
};
