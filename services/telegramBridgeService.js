const db = require('../database/db');
const logger = require('../utils/logger');
const tenantService = require('./tenantService');
const entitlementService = require('./entitlementService');
const clientProvider = require('../utils/clientProvider');
const { AttachmentBuilder, EmbedBuilder } = require('discord.js');

const DISCORD_MESSAGE_LIMIT = 2000;
const DISCORD_SAFE_CHUNK = 1850;
const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;
const DISCORD_EMBED_SAFE_CHUNK = 3900;
const TELEGRAM_BRIDGE_COLOR = 0x2AABEE;
const MEDIA_MAX_BYTES = Math.max(1, Math.min(25, Number(process.env.TELEGRAM_BRIDGE_MAX_MEDIA_MB || 8))) * 1024 * 1024;
const VALID_DIRECTION_MODES = new Set(['telegram_to_discord', 'discord_to_telegram', 'two_way']);
const VALID_CHAT_TYPES = new Set(['group', 'supergroup', 'channel', 'private']);

function normalizeGuildId(guildId) {
  const normalized = String(guildId || '').trim();
  return /^\d{17,20}$/.test(normalized) ? normalized : '';
}

function normalizeDiscordChannelId(channelId) {
  const normalized = String(channelId || '').trim();
  return /^\d{17,20}$/.test(normalized) ? normalized : '';
}

function normalizeTelegramChatId(chatId) {
  const normalized = String(chatId || '').trim();
  return /^-?\d{3,32}$/.test(normalized) ? normalized : '';
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return !!fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
  return !!fallback;
}

function truncate(value, max) {
  const text = String(value || '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function rowToMapping(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    guildId: String(row.guild_id || ''),
    name: row.name || '',
    telegramChatId: String(row.telegram_chat_id || ''),
    telegramChatTitle: row.telegram_chat_title || '',
    telegramChatType: row.telegram_chat_type || 'group',
    discordChannelId: String(row.discord_channel_id || ''),
    directionMode: row.direction_mode || 'telegram_to_discord',
    enabled: !!row.enabled,
    includeSourceHeader: row.include_source_header !== 0,
    includeAuthor: row.include_author !== 0,
    mirrorMedia: row.mirror_media !== 0,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function splitDiscordText(text, limit = DISCORD_MESSAGE_LIMIT, safeChunk = DISCORD_SAFE_CHUNK) {
  const input = String(text || '');
  if (!input) return [''];
  const chunks = [];
  let remaining = input;
  while (remaining.length > limit) {
    let idx = remaining.lastIndexOf('\n', safeChunk);
    if (idx < 500) idx = remaining.lastIndexOf(' ', safeChunk);
    if (idx < 500) idx = safeChunk;
    chunks.push(remaining.slice(0, idx).trimEnd());
    remaining = remaining.slice(idx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : [''];
}

function telegramAuthorName(message) {
  const from = message?.from || message?.sender_chat || {};
  const parts = [from.first_name, from.last_name].map(v => String(v || '').trim()).filter(Boolean);
  return parts.join(' ') || from.title || from.username || '';
}

function pickLargestPhoto(message) {
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  if (!photos.length) return null;
  return photos.slice().sort((a, b) => Number(b.file_size || 0) - Number(a.file_size || 0))[0];
}

function safeFileName(value, fallback) {
  const raw = String(value || fallback || 'telegram-file').trim() || 'telegram-file';
  return raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

function truncateEmbedField(value, max = 1024) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function normalizeTelegramMessage(update) {
  const eventType = update?.channel_post ? 'channel_post'
    : update?.edited_channel_post ? 'edited_channel_post'
      : update?.edited_message ? 'edited_message'
        : update?.message ? 'message'
          : '';
  const message = update?.channel_post || update?.edited_channel_post || update?.edited_message || update?.message || null;
  if (!message?.chat?.id || !message?.message_id) return null;
  const chatId = normalizeTelegramChatId(message.chat.id);
  if (!chatId) return null;
  const text = String(message.text || message.caption || '').trim();
  const photo = pickLargestPhoto(message);
  const document = message.document || null;
  const video = message.video || null;
  const media = [];
  if (photo?.file_id) media.push({ type: 'photo', fileId: photo.file_id, fileName: 'telegram-photo.jpg', fileSize: Number(photo.file_size || 0) || null });
  if (video?.file_id) media.push({ type: 'video', fileId: video.file_id, fileName: video.file_name || 'telegram-video.mp4', fileSize: Number(video.file_size || 0) || null });
  if (document?.file_id) media.push({ type: 'document', fileId: document.file_id, fileName: document.file_name || 'telegram-document', fileSize: Number(document.file_size || 0) || null });
  return {
    updateId: update?.update_id === undefined ? null : String(update.update_id),
    eventType,
    isEdit: eventType.startsWith('edited_'),
    chatId,
    chatTitle: message.chat.title || message.chat.username || '',
    chatType: message.chat.type || 'group',
    messageId: String(message.message_id),
    date: message.date || null,
    authorName: telegramAuthorName(message),
    text,
    media,
    mediaGroupId: message.media_group_id ? String(message.media_group_id) : null,
    raw: message,
  };
}

class TelegramBridgeService {
  getSettings(guildId) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return { enabled: true, webhookStatus: 'unknown' };
    db.prepare(`
      INSERT OR IGNORE INTO telegram_bridge_settings (guild_id)
      VALUES (?)
    `).run(gid);
    const row = db.prepare('SELECT * FROM telegram_bridge_settings WHERE guild_id = ?').get(gid);
    return {
      guildId: gid,
      enabled: row?.enabled !== 0,
      webhookStatus: row?.webhook_status || 'unknown',
      webhookLastUpdateAt: row?.webhook_last_update_at || null,
      webhookLastError: row?.webhook_last_error || null,
    };
  }

  updateSettings(guildId, patch = {}) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return { success: false, message: 'Invalid guild id' };
    const enabled = normalizeBoolean(patch.enabled, true) ? 1 : 0;
    db.prepare(`
      INSERT INTO telegram_bridge_settings (guild_id, enabled, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id) DO UPDATE SET
        enabled = excluded.enabled,
        updated_at = CURRENT_TIMESTAMP
    `).run(gid, enabled);
    return { success: true, settings: this.getSettings(gid) };
  }

  getMappings(guildId, { includeDisabled = true } = {}) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return [];
    const rows = includeDisabled
      ? db.prepare('SELECT * FROM telegram_bridge_mappings WHERE guild_id = ? ORDER BY enabled DESC, updated_at DESC, id DESC').all(gid)
      : db.prepare('SELECT * FROM telegram_bridge_mappings WHERE guild_id = ? AND enabled = 1 ORDER BY updated_at DESC, id DESC').all(gid);
    return rows.map(rowToMapping);
  }

  getMappingById(guildId, mappingId) {
    const gid = normalizeGuildId(guildId);
    const id = Number(mappingId);
    if (!gid || !Number.isFinite(id) || id <= 0) return null;
    return rowToMapping(db.prepare('SELECT * FROM telegram_bridge_mappings WHERE guild_id = ? AND id = ?').get(gid, id));
  }

  normalizeMappingPayload(payload = {}, current = null) {
    const telegramChatId = normalizeTelegramChatId(payload.telegramChatId ?? payload.telegram_chat_id ?? current?.telegramChatId);
    const discordChannelId = normalizeDiscordChannelId(payload.discordChannelId ?? payload.discord_channel_id ?? current?.discordChannelId);
    const rawDirection = String(payload.directionMode ?? payload.direction_mode ?? current?.directionMode ?? 'telegram_to_discord').trim().toLowerCase();
    const directionMode = VALID_DIRECTION_MODES.has(rawDirection) ? rawDirection : 'telegram_to_discord';
    const rawType = String(payload.telegramChatType ?? payload.telegram_chat_type ?? current?.telegramChatType ?? 'group').trim().toLowerCase();
    const telegramChatType = VALID_CHAT_TYPES.has(rawType) ? rawType : 'group';
    return {
      name: truncate(payload.name ?? current?.name ?? '', 120),
      telegramChatId,
      telegramChatTitle: truncate(payload.telegramChatTitle ?? payload.telegram_chat_title ?? current?.telegramChatTitle ?? '', 180),
      telegramChatType,
      discordChannelId,
      directionMode,
      enabled: normalizeBoolean(payload.enabled, current ? current.enabled : true),
      includeSourceHeader: normalizeBoolean(payload.includeSourceHeader ?? payload.include_source_header, current ? current.includeSourceHeader : true),
      includeAuthor: normalizeBoolean(payload.includeAuthor ?? payload.include_author, current ? current.includeAuthor : true),
      mirrorMedia: normalizeBoolean(payload.mirrorMedia ?? payload.mirror_media, current ? current.mirrorMedia : true),
    };
  }

  createMapping(guildId, payload = {}) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return { success: false, message: 'Invalid guild id' };
    const normalized = this.normalizeMappingPayload(payload);
    if (!normalized.telegramChatId) return { success: false, message: 'Telegram chat ID is required' };
    if (!normalized.discordChannelId) return { success: false, message: 'Discord channel ID is required' };

    const currentCount = Number(db.prepare('SELECT COUNT(1) AS count FROM telegram_bridge_mappings WHERE guild_id = ?').get(gid)?.count || 0);
    const limitCheck = entitlementService.enforceLimit({
      guildId: gid,
      moduleKey: 'telegrambridge',
      limitKey: 'max_sync_mappings',
      currentCount,
      incrementBy: 1,
      itemLabel: 'Telegram bridge syncs',
    });
    if (!limitCheck.success) return { ...limitCheck, success: false, code: 'limit_exceeded' };

    const duplicate = db.prepare(`
      SELECT id FROM telegram_bridge_mappings
      WHERE guild_id = ? AND telegram_chat_id = ? AND discord_channel_id = ? AND enabled = 1
    `).get(gid, normalized.telegramChatId, normalized.discordChannelId);
    if (duplicate && normalized.enabled) {
      return { success: false, code: 'duplicate_mapping', message: 'An active sync already exists for this Telegram chat and Discord channel' };
    }

    const result = db.prepare(`
      INSERT INTO telegram_bridge_mappings (
        guild_id, name, telegram_chat_id, telegram_chat_title, telegram_chat_type, discord_channel_id,
        direction_mode, enabled, include_source_header, include_author, mirror_media, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      gid,
      normalized.name,
      normalized.telegramChatId,
      normalized.telegramChatTitle,
      normalized.telegramChatType,
      normalized.discordChannelId,
      normalized.directionMode,
      normalized.enabled ? 1 : 0,
      normalized.includeSourceHeader ? 1 : 0,
      normalized.includeAuthor ? 1 : 0,
      normalized.mirrorMedia ? 1 : 0
    );
    return { success: true, mapping: this.getMappingById(gid, result.lastInsertRowid) };
  }

  updateMapping(guildId, mappingId, payload = {}) {
    const current = this.getMappingById(guildId, mappingId);
    if (!current) return { success: false, message: 'Sync mapping not found' };
    const normalized = this.normalizeMappingPayload(payload, current);
    if (!normalized.telegramChatId) return { success: false, message: 'Telegram chat ID is required' };
    if (!normalized.discordChannelId) return { success: false, message: 'Discord channel ID is required' };
    const duplicate = db.prepare(`
      SELECT id FROM telegram_bridge_mappings
      WHERE guild_id = ? AND telegram_chat_id = ? AND discord_channel_id = ? AND enabled = 1 AND id != ?
    `).get(current.guildId, normalized.telegramChatId, normalized.discordChannelId, current.id);
    if (duplicate && normalized.enabled) {
      return { success: false, code: 'duplicate_mapping', message: 'An active sync already exists for this Telegram chat and Discord channel' };
    }
    db.prepare(`
      UPDATE telegram_bridge_mappings
      SET name = ?, telegram_chat_id = ?, telegram_chat_title = ?, telegram_chat_type = ?, discord_channel_id = ?,
          direction_mode = ?, enabled = ?, include_source_header = ?, include_author = ?, mirror_media = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND id = ?
    `).run(
      normalized.name,
      normalized.telegramChatId,
      normalized.telegramChatTitle,
      normalized.telegramChatType,
      normalized.discordChannelId,
      normalized.directionMode,
      normalized.enabled ? 1 : 0,
      normalized.includeSourceHeader ? 1 : 0,
      normalized.includeAuthor ? 1 : 0,
      normalized.mirrorMedia ? 1 : 0,
      current.guildId,
      current.id
    );
    return { success: true, mapping: this.getMappingById(current.guildId, current.id) };
  }

  deleteMapping(guildId, mappingId) {
    const current = this.getMappingById(guildId, mappingId);
    if (!current) return { success: false, message: 'Sync mapping not found' };
    db.prepare('DELETE FROM telegram_bridge_mappings WHERE guild_id = ? AND id = ?').run(current.guildId, current.id);
    return { success: true };
  }

  getAudit(guildId, { mappingId = null, status = '', limit = 100 } = {}) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return [];
    const clauses = ['guild_id = ?'];
    const params = [gid];
    const mid = Number(mappingId);
    if (Number.isFinite(mid) && mid > 0) {
      clauses.push('mapping_id = ?');
      params.push(mid);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(String(status).trim());
    }
    params.push(Math.max(1, Math.min(250, Number(limit) || 100)));
    return db.prepare(`
      SELECT * FROM telegram_bridge_audit
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params).map(row => ({
      id: Number(row.id),
      guildId: row.guild_id || '',
      mappingId: row.mapping_id ? Number(row.mapping_id) : null,
      telegramChatId: row.telegram_chat_id || '',
      discordChannelId: row.discord_channel_id || '',
      status: row.status || '',
      eventType: row.event_type || '',
      message: row.message || '',
      details: row.details_json ? JSON.parse(row.details_json) : null,
      createdAt: row.created_at || null,
    }));
  }

  recordAudit({ guildId = null, mappingId = null, telegramChatId = null, discordChannelId = null, status, eventType = null, message = '', details = null }) {
    db.prepare(`
      INSERT INTO telegram_bridge_audit (guild_id, mapping_id, telegram_chat_id, discord_channel_id, status, event_type, message, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      guildId || null,
      mappingId || null,
      telegramChatId || null,
      discordChannelId || null,
      String(status || 'unknown').slice(0, 40),
      eventType || null,
      String(message || '').slice(0, 500),
      details ? JSON.stringify(details) : null
    );
  }

  formatTelegramForDiscord(mapping, message) {
    return String(message.text || (message.media.length ? 'Media from Telegram' : 'Telegram message')).trim();
  }

  buildTelegramEmbeds(mapping, message, fallbackLines = [], options = {}) {
    const source = message.chatTitle || mapping.telegramChatTitle || mapping.name || message.chatId;
    const description = this.formatTelegramForDiscord(mapping, message);
    const chunks = splitDiscordText(description, DISCORD_EMBED_DESCRIPTION_LIMIT, DISCORD_EMBED_SAFE_CHUNK);
    const total = chunks.length;
    return chunks.map((chunk, index) => {
      const embed = new EmbedBuilder()
        .setColor(TELEGRAM_BRIDGE_COLOR)
        .setTitle(mapping.includeSourceHeader ? `Telegram: ${source}` : 'Telegram Bridge')
        .setDescription(chunk || 'Telegram message')
        .setFooter({
          text: `Telegram ${message.chatType || 'chat'} ${message.chatId}${total > 1 ? ` • part ${index + 1}/${total}` : ''}`,
        });

      if (mapping.includeAuthor && message.authorName) {
        embed.setAuthor({ name: truncateEmbedField(message.authorName, 256) });
      }
      if (message.date) {
        const ts = new Date(Number(message.date) * 1000);
        if (!Number.isNaN(ts.getTime())) embed.setTimestamp(ts);
      }
      if (message.isEdit) {
        embed.addFields({ name: 'Status', value: 'Edited on Telegram', inline: true });
      }
      if (index === 0 && fallbackLines.length) {
        embed.addFields({
          name: 'Media note',
          value: truncateEmbedField(fallbackLines.join('\n')),
          inline: false,
        });
      }
      if (index === 0 && options.imageFileName) {
        embed.setImage(`attachment://${options.imageFileName}`);
      }
      return embed;
    });
  }

  insertMessageLog(mapping, message, discordMessageId, dedupeKey, editState = 'original') {
    db.prepare(`
      INSERT OR IGNORE INTO telegram_bridge_message_log (
        mapping_id, guild_id, source_platform, target_platform, telegram_chat_id, telegram_message_id,
        telegram_update_id, discord_channel_id, discord_message_id, dedupe_key, origin_platform,
        origin_message_key, created_by_bridge, media_group_id, edit_state, updated_at
      )
      VALUES (?, ?, 'telegram', 'discord', ?, ?, ?, ?, ?, ?, 'telegram', ?, 1, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      mapping.id,
      mapping.guildId,
      message.chatId,
      message.messageId,
      message.updateId,
      mapping.discordChannelId,
      discordMessageId || null,
      dedupeKey,
      `telegram:${message.chatId}:${message.messageId}`,
      message.mediaGroupId || null,
      editState
    );
  }

  async downloadTelegramMedia(media) {
    const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (!token || !global.fetch) {
      return { success: false, skipped: true, reason: 'telegram_bot_token_missing' };
    }
    if (media.fileSize && Number(media.fileSize) > MEDIA_MAX_BYTES) {
      return { success: false, skipped: true, reason: 'file_too_large', fileSize: media.fileSize };
    }

    const getFileResponse = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: media.fileId }),
    });
    if (!getFileResponse.ok) {
      return { success: false, reason: `getFile_failed_${getFileResponse.status}` };
    }
    const getFileJson = await getFileResponse.json().catch(() => null);
    const filePath = getFileJson?.result?.file_path;
    const fileSize = Number(getFileJson?.result?.file_size || media.fileSize || 0) || 0;
    if (!filePath) return { success: false, reason: 'file_path_missing' };
    if (fileSize && fileSize > MEDIA_MAX_BYTES) {
      return { success: false, skipped: true, reason: 'file_too_large', fileSize };
    }

    const fileResponse = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!fileResponse.ok) {
      return { success: false, reason: `file_download_failed_${fileResponse.status}` };
    }
    const arrayBuffer = await fileResponse.arrayBuffer();
    if (arrayBuffer.byteLength > MEDIA_MAX_BYTES) {
      return { success: false, skipped: true, reason: 'file_too_large', fileSize: arrayBuffer.byteLength };
    }
    const fileName = safeFileName(media.fileName || filePath.split('/').pop(), `${media.type || 'telegram'}-${media.fileId}`);
    return {
      success: true,
      attachment: new AttachmentBuilder(Buffer.from(arrayBuffer), { name: fileName }),
      fileName,
      fileSize: arrayBuffer.byteLength,
      type: media.type || 'file',
    };
  }

  async mirrorTelegramToDiscord(mapping, message) {
    const dedupeKey = `telegram:${message.chatId}:${message.messageId}`;
    const existing = db.prepare('SELECT * FROM telegram_bridge_message_log WHERE mapping_id = ? AND dedupe_key = ? ORDER BY id ASC LIMIT 1').get(mapping.id, dedupeKey);
    if (existing && !message.isEdit) {
      this.recordAudit({ guildId: mapping.guildId, mappingId: mapping.id, telegramChatId: message.chatId, discordChannelId: mapping.discordChannelId, status: 'duplicate', eventType: message.eventType, message: 'Duplicate Telegram message skipped' });
      return { success: true, skipped: true, reason: 'duplicate' };
    }

    if (tenantService.isMultitenantEnabled() && !tenantService.isModuleEnabled(mapping.guildId, 'telegrambridge')) {
      this.recordAudit({ guildId: mapping.guildId, mappingId: mapping.id, telegramChatId: message.chatId, discordChannelId: mapping.discordChannelId, status: 'skipped', eventType: message.eventType, message: 'Telegram Bridge module is disabled' });
      return { success: true, skipped: true, reason: 'module_disabled' };
    }

    const settings = this.getSettings(mapping.guildId);
    if (!settings.enabled || !mapping.enabled || mapping.directionMode === 'discord_to_telegram') {
      this.recordAudit({ guildId: mapping.guildId, mappingId: mapping.id, telegramChatId: message.chatId, discordChannelId: mapping.discordChannelId, status: 'skipped', eventType: message.eventType, message: 'Sync is disabled or direction does not allow Telegram to Discord' });
      return { success: true, skipped: true, reason: 'disabled' };
    }

    const client = clientProvider.getClient();
    const channel = client ? await client.channels.fetch(mapping.discordChannelId).catch(() => null) : null;
    if (!channel || !channel.isTextBased?.()) {
      this.recordAudit({ guildId: mapping.guildId, mappingId: mapping.id, telegramChatId: message.chatId, discordChannelId: mapping.discordChannelId, status: 'failed', eventType: message.eventType, message: 'Discord channel not found or not text-based' });
      return { success: false, message: 'Discord channel not found or not text-based' };
    }

    const sentIds = [];
    try {
      if (message.isEdit && existing?.discord_message_id) {
        const target = await channel.messages?.fetch?.(existing.discord_message_id).catch(() => null);
        if (target?.edit) {
          const [embed] = this.buildTelegramEmbeds(mapping, message);
          const edited = await target.edit({ content: null, embeds: [embed] });
          sentIds.push(edited?.id || existing.discord_message_id);
          db.prepare('UPDATE telegram_bridge_message_log SET edit_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('edited', existing.id);
          this.recordAudit({ guildId: mapping.guildId, mappingId: mapping.id, telegramChatId: message.chatId, discordChannelId: mapping.discordChannelId, status: 'mirrored', eventType: message.eventType, message: 'Edited Telegram message updated in Discord' });
          return { success: true, edited: true, discordMessageIds: sentIds };
        }
      }

      const attachments = [];
      const fallbackLines = [];
      let embedImageFileName = '';
      if (mapping.mirrorMedia && message.media.length) {
        for (const item of message.media) {
          const downloaded = await this.downloadTelegramMedia(item).catch(error => ({
            success: false,
            reason: error?.message || 'download_failed',
          }));
          if (downloaded.success && downloaded.attachment) {
            attachments.push(downloaded.attachment);
            if (!embedImageFileName && item.type === 'photo' && downloaded.fileName) {
              embedImageFileName = downloaded.fileName;
            }
          } else {
            fallbackLines.push(`${item.type}: ${item.fileName || item.fileId}${downloaded.reason ? ` (${downloaded.reason})` : ''}`);
          }
        }
        if (!attachments.length && fallbackLines.length) {
          const mediaText = message.media.map(item => `${item.type}: ${item.fileName || item.fileId}${item.fileSize ? ` (${item.fileSize} bytes)` : ''}`).join('\n');
          fallbackLines.push(`Could not attach media:\n${mediaText}`);
        }
      }

      const embeds = this.buildTelegramEmbeds(mapping, message, fallbackLines, { imageFileName: embedImageFileName });
      for (let index = 0; index < embeds.length; index++) {
        const sent = await channel.send({
          embeds: [embeds[index]],
          files: index === 0 ? attachments : [],
        });
        sentIds.push(sent?.id || null);
      }

      this.insertMessageLog(mapping, message, sentIds[0] || null, dedupeKey, message.isEdit ? 'edited_without_original' : 'original');
      this.recordAudit({ guildId: mapping.guildId, mappingId: mapping.id, telegramChatId: message.chatId, discordChannelId: mapping.discordChannelId, status: 'mirrored', eventType: message.eventType, message: `Mirrored Telegram message to Discord (${sentIds.length} Discord message${sentIds.length === 1 ? '' : 's'})` });
      return { success: true, discordMessageIds: sentIds };
    } catch (error) {
      this.recordAudit({ guildId: mapping.guildId, mappingId: mapping.id, telegramChatId: message.chatId, discordChannelId: mapping.discordChannelId, status: 'failed', eventType: message.eventType, message: error?.message || 'Failed to mirror Telegram message' });
      logger.error('[telegram-bridge] mirror failed:', error);
      return { success: false, message: error?.message || 'Failed to mirror Telegram message' };
    }
  }

  async ingestTelegramUpdate(update) {
    const normalized = normalizeTelegramMessage(update);
    if (!normalized) {
      this.recordAudit({ status: 'skipped', eventType: 'unknown', message: 'Unsupported Telegram update', details: { updateId: update?.update_id ?? null } });
      return { success: true, skipped: true, reason: 'unsupported_update' };
    }

    if (/^\/bridgeid(?:@\w+)?(?:\s|$)/i.test(normalized.text)) {
      await this.sendTelegramBridgeIdResponse(normalized);
      this.recordAudit({ telegramChatId: normalized.chatId, status: 'skipped', eventType: normalized.eventType, message: 'Answered Telegram /bridgeid setup command', details: { chatTitle: normalized.chatTitle, chatType: normalized.chatType } });
      return { success: true, skipped: true, reason: 'bridgeid_command' };
    }

    const mappings = db.prepare(`
      SELECT * FROM telegram_bridge_mappings
      WHERE telegram_chat_id = ? AND enabled = 1 AND direction_mode IN ('telegram_to_discord', 'two_way')
      ORDER BY id ASC
    `).all(normalized.chatId).map(rowToMapping);

    if (!mappings.length) {
      this.recordAudit({ telegramChatId: normalized.chatId, status: 'unknown_source', eventType: normalized.eventType, message: 'No enabled sync mapping for Telegram chat', details: { chatTitle: normalized.chatTitle, updateId: normalized.updateId } });
      return { success: true, skipped: true, reason: 'unknown_source', matchedMappings: 0 };
    }

    const results = [];
    for (const mapping of mappings) {
      results.push(await this.mirrorTelegramToDiscord(mapping, normalized));
    }
    const guildIds = Array.from(new Set(mappings.map(mapping => mapping.guildId)));
    db.prepare(`
      UPDATE telegram_bridge_settings
      SET webhook_status = 'ok', webhook_last_update_at = CURRENT_TIMESTAMP, webhook_last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id IN (${guildIds.map(() => '?').join(',')})
    `).run(...guildIds);
    return { success: true, matchedMappings: mappings.length, results };
  }

  async sendTestMessage(guildId, mappingId) {
    const mapping = this.getMappingById(guildId, mappingId);
    if (!mapping) return { success: false, message: 'Sync mapping not found' };
    return this.mirrorTelegramToDiscord(mapping, {
      updateId: `test-${Date.now()}`,
      eventType: 'test',
      isEdit: false,
      chatId: mapping.telegramChatId,
      chatTitle: mapping.telegramChatTitle || mapping.name || 'Telegram source',
      chatType: mapping.telegramChatType,
      messageId: `test-${Date.now()}`,
      authorName: 'GuildPilot setup test',
      text: 'Telegram Bridge test message. This sync is ready for Telegram to Discord mirroring.',
      media: [],
      mediaGroupId: null,
      raw: {},
    });
  }

  async mirrorDiscordToTelegram() {
    return { success: false, skipped: true, reason: 'not_implemented_v1' };
  }

  async sendTelegramBridgeIdResponse(message) {
    const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (!token || !global.fetch) return { success: false, skipped: true, reason: 'telegram_bot_token_missing' };
    const title = message.chatTitle || '(no title)';
    const text = [
      'Telegram Bridge setup',
      `Chat ID: ${message.chatId}`,
      `Title: ${title}`,
      `Type: ${message.chatType || 'unknown'}`,
      'Copy this Chat ID into the GuildPilot Telegram Bridge sync form.',
    ].join('\n');
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: message.chatId,
          text,
          reply_to_message_id: /^\d+$/.test(String(message.messageId || '')) ? Number(message.messageId) : undefined,
          disable_web_page_preview: true,
        }),
      });
      if (!response.ok) throw new Error(`Telegram sendMessage failed (${response.status})`);
      return { success: true };
    } catch (error) {
      this.recordAudit({ telegramChatId: message.chatId, status: 'failed', eventType: message.eventType, message: error?.message || 'Failed to answer /bridgeid' });
      return { success: false, message: error?.message || 'Failed to answer /bridgeid' };
    }
  }
}

module.exports = new TelegramBridgeService();
module.exports._private = {
  normalizeTelegramMessage,
  splitDiscordText,
  safeFileName,
};
