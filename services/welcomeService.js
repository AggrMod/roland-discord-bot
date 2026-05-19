const crypto = require('crypto');
const db = require('../database/db');
const logger = require('../utils/logger');
const tenantService = require('./tenantService');

const DEFAULT_TEMPLATE = 'Welcome {user_mention} to {server_name}! You are member #{member_count}.';
const DEFAULT_DM_TEMPLATE = 'Welcome to {server_name}, {username}! Check out {channel:verify} to get started.';
const MAX_IMAGE_BYTES = Math.max(200000, Number(process.env.WELCOME_IMAGE_MAX_BYTES || 2 * 1024 * 1024));

const CHALLENGE_TTL_MS = Math.max(5, Number(process.env.WELCOME_CAPTCHA_TTL_MINUTES || 20)) * 60 * 1000;
const VERIFY_BASE_URL = String(process.env.WEB_URL || 'http://localhost:3000').replace(/\/+$/, '');
const CHALLENGE_SIGNING_SECRET = String(process.env.WELCOME_CAPTCHA_SECRET || process.env.SESSION_SECRET || 'welcome-captcha-secret');

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

function normalizeRoleIds(roleIds) {
  const asArray = Array.isArray(roleIds) ? roleIds : safeJsonParse(roleIds, []);
  return Array.from(
    new Set(
      asArray
        .map(value => String(value || '').trim())
        .filter(value => /^\d{17,20}$/.test(value))
    )
  );
}

function normalizeTemplate(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.slice(0, 3000);
}

function normalizeStepFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields
    .map((field) => ({
      name: String(field?.name || '').trim().slice(0, 120),
      value: String(field?.value || '').trim().slice(0, 1000),
      inline: !!field?.inline,
    }))
    .filter(field => field.name && field.value);
}

function normalizeEmbedColor(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.trunc(value);
    return n >= 0 && n <= 0xFFFFFF ? n : null;
  }
  const raw = String(value || '').trim();
  if (!raw) return null;
  const hex = raw.startsWith('#') ? raw.slice(1) : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  const parsed = Number.parseInt(hex, 16);
  return Number.isFinite(parsed) ? parsed : null;
}

function slugifyChannelName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function compactSlug(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function buildChallengeToken(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', CHALLENGE_SIGNING_SECRET).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function readChallengeToken(token) {
  const raw = String(token || '').trim();
  if (!raw.includes('.')) return null;
  const [encodedPayload, signature] = raw.split('.');
  if (!encodedPayload || !signature) return null;
  const expected = crypto.createHmac('sha256', CHALLENGE_SIGNING_SECRET).update(encodedPayload).digest('base64url');
  if (signature !== expected) return null;
  try {
    return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch (_error) {
    return null;
  }
}

class WelcomeService {
  getSettings(guildId) {
    const normalizedGuildId = String(guildId || '').trim();
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };

    const row = db.prepare(`
      SELECT *
      FROM tenant_welcome_settings
      WHERE guild_id = ?
    `).get(normalizedGuildId);

    const settings = {
      guildId: normalizedGuildId,
      enabled: row ? row.enabled === 1 : false,
      welcomeChannelId: row?.welcome_channel_id || null,
      welcomeMessageTemplate: row?.welcome_message_template || DEFAULT_TEMPLATE,
      welcomeEmbed: safeJsonParse(row?.welcome_embed_json || '{}', {}),
      welcomeImageUrl: row?.welcome_image_url || null,
      welcomeImageAssetId: Number(row?.welcome_image_asset_id || 0) || null,
      dynamicAvatarCard: row ? row.dynamic_avatar_card === 1 : false,
      dmEnabled: row ? row.dm_enabled === 1 : false,
      dmMessageTemplate: row?.dm_message_template || DEFAULT_DM_TEMPLATE,
      autoRoleIds: normalizeRoleIds(row?.auto_role_ids || '[]'),
      captchaEnabled: row ? row.captcha_enabled === 1 : false,
      captchaRoleId: row?.captcha_role_id || null,
      updatedAt: row?.updated_at || null,
    };

    return { success: true, settings };
  }

  updateSettings(guildId, patch = {}) {
    const normalizedGuildId = String(guildId || '').trim();
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };

    const current = this.getSettings(normalizedGuildId);
    if (!current.success) return current;
    const now = current.settings;

    const next = {
      enabled: patch.enabled !== undefined ? !!patch.enabled : now.enabled,
      welcomeChannelId: patch.welcomeChannelId !== undefined ? String(patch.welcomeChannelId || '').trim() || null : now.welcomeChannelId,
      welcomeMessageTemplate: patch.welcomeMessageTemplate !== undefined
        ? normalizeTemplate(patch.welcomeMessageTemplate, DEFAULT_TEMPLATE)
        : now.welcomeMessageTemplate,
      welcomeEmbed: patch.welcomeEmbed !== undefined && patch.welcomeEmbed && typeof patch.welcomeEmbed === 'object'
        ? {
          ...patch.welcomeEmbed,
          fields: normalizeStepFields(patch.welcomeEmbed.fields),
        }
        : now.welcomeEmbed,
      welcomeImageUrl: patch.welcomeImageUrl !== undefined ? String(patch.welcomeImageUrl || '').trim() || null : now.welcomeImageUrl,
      welcomeImageAssetId: patch.welcomeImageAssetId !== undefined ? (Number(patch.welcomeImageAssetId) || null) : now.welcomeImageAssetId,
      dynamicAvatarCard: patch.dynamicAvatarCard !== undefined ? !!patch.dynamicAvatarCard : now.dynamicAvatarCard,
      dmEnabled: patch.dmEnabled !== undefined ? !!patch.dmEnabled : now.dmEnabled,
      dmMessageTemplate: patch.dmMessageTemplate !== undefined
        ? normalizeTemplate(patch.dmMessageTemplate, DEFAULT_DM_TEMPLATE)
        : now.dmMessageTemplate,
      autoRoleIds: patch.autoRoleIds !== undefined ? normalizeRoleIds(patch.autoRoleIds) : now.autoRoleIds,
      captchaEnabled: patch.captchaEnabled !== undefined ? !!patch.captchaEnabled : now.captchaEnabled,
      captchaRoleId: patch.captchaRoleId !== undefined ? String(patch.captchaRoleId || '').trim() || null : now.captchaRoleId,
    };

    db.prepare(`
      INSERT INTO tenant_welcome_settings (
        guild_id, enabled, welcome_channel_id, welcome_message_template, welcome_embed_json,
        welcome_image_url, welcome_image_asset_id, dynamic_avatar_card, dm_enabled, dm_message_template, auto_role_ids,
        captcha_enabled, captcha_role_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id) DO UPDATE SET
        enabled = excluded.enabled,
        welcome_channel_id = excluded.welcome_channel_id,
        welcome_message_template = excluded.welcome_message_template,
        welcome_embed_json = excluded.welcome_embed_json,
        welcome_image_url = excluded.welcome_image_url,
        welcome_image_asset_id = excluded.welcome_image_asset_id,
        dynamic_avatar_card = excluded.dynamic_avatar_card,
        dm_enabled = excluded.dm_enabled,
        dm_message_template = excluded.dm_message_template,
        auto_role_ids = excluded.auto_role_ids,
        captcha_enabled = excluded.captcha_enabled,
        captcha_role_id = excluded.captcha_role_id,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      normalizedGuildId,
      next.enabled ? 1 : 0,
      next.welcomeChannelId,
      next.welcomeMessageTemplate,
      JSON.stringify(next.welcomeEmbed || {}),
      next.welcomeImageUrl,
      next.welcomeImageAssetId,
      next.dynamicAvatarCard ? 1 : 0,
      next.dmEnabled ? 1 : 0,
      next.dmMessageTemplate,
      JSON.stringify(next.autoRoleIds),
      next.captchaEnabled ? 1 : 0,
      next.captchaRoleId
    );

    return this.getSettings(normalizedGuildId);
  }

  parseVariables(text, member, channelCollection = null) {
    const template = String(text || '');
    const guild = member?.guild;
    const username = member?.user?.username || member?.displayName || 'Member';
    const withBasics = template
      .replace(/\{user_mention\}/gi, `<@${member?.id || ''}>`)
      .replace(/\{username\}/gi, username)
      .replace(/\{server_name\}/gi, guild?.name || 'Server')
      .replace(/\{member_count\}/gi, String(guild?.memberCount || 0));

    return withBasics.replace(/\{channel:([^}]+)\}/gi, (_match, slugInput) => {
      const slug = slugifyChannelName(slugInput);
      const compact = compactSlug(slug);
      const source = channelCollection || guild?.channels?.cache;
      if (!slug || !source) return `#${slugInput}`;
      const channel = source.find(c => {
        if (!c || typeof c.name !== 'string') return false;
        const channelSlug = slugifyChannelName(c.name);
        const channelCompact = compactSlug(channelSlug);
        return channelSlug === slug || (compact && channelCompact === compact);
      });
      return channel?.id ? `<#${channel.id}>` : `#${slug}`;
    });
  }

  createChallenge(guildId, userId) {
    const payload = {
      guildId: String(guildId || '').trim(),
      userId: String(userId || '').trim(),
      iat: Date.now(),
      exp: Date.now() + CHALLENGE_TTL_MS
    };
    return buildChallengeToken(payload);
  }

  async sendCaptchaPrompt(member, { guildId, channelSource, channel }) {
    const challengeToken = this.createChallenge(guildId, member.id);
    const verifyUrl = `${VERIFY_BASE_URL}/verify?guild=${encodeURIComponent(guildId)}&captcha=${encodeURIComponent(challengeToken)}`;
    const guildName = String(member?.guild?.name || 'your server');
    const embed = {
      color: 0xf8b64c,
      title: 'Security Check Required',
      description: `Welcome to **${guildName}**. Complete a quick verification to unlock full access.`,
      fields: [
        {
          name: 'Why this is needed',
          value: 'This protects the community from raid and bot accounts.',
          inline: false,
        },
      ],
      footer: {
        text: 'GuildPilot Verification',
      },
    };
    const components = [{
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: 'Complete Verification',
        url: verifyUrl,
      }],
    }];

    const dmSent = await member.send({
      content: 'Verification required before full access.',
      embeds: [embed],
      components,
    }).then(() => true).catch(() => false);

    if (dmSent) return { success: true, mode: 'dm' };
    if (!channel || typeof channel.send !== 'function') return { success: false, mode: 'none' };

    await channel.send({
      content: `<@${member.id}> please complete verification to unlock full access.`,
      embeds: [embed],
      components,
    }).catch(() => {});
    return { success: true, mode: 'channel' };
  }

  async handleMemberJoin(member) {
    try {
      const guildId = String(member?.guild?.id || '').trim();
      if (!guildId || !tenantService.isModuleEnabled(guildId, 'welcome')) {
        return { success: false, delivered: false, message: 'Welcome module is disabled for this server.' };
      }
      const settingsResult = this.getSettings(guildId);
      if (!settingsResult.success) return settingsResult;
      if (!settingsResult.settings.enabled) {
        return { success: false, delivered: false, message: 'Welcome settings are disabled.' };
      }
      const settings = settingsResult.settings;
      let delivered = false;

      if (settings.autoRoleIds.length > 0) {
        await member.roles.add(settings.autoRoleIds).catch(() => {});
      }

      const channelId = settings.welcomeChannelId;
      if (!channelId) {
        return { success: false, delivered: false, message: 'No welcome channel configured.' };
      }
      let fetchedChannels = null;
      try {
        fetchedChannels = await member.guild.channels.fetch();
      } catch (_error) {
        fetchedChannels = null;
      }
      const channelSource = fetchedChannels || member.guild.channels.cache;
      const channel = channelId ? channelSource.get(channelId) : null;
      if (!channel) {
        return { success: false, delivered: false, message: `Welcome channel not found: ${channelId}` };
      }
      if (channel && typeof channel.send === 'function') {
        const content = this.parseVariables(settings.welcomeMessageTemplate, member, channelSource);
        const embedPayload = settings.welcomeEmbed && typeof settings.welcomeEmbed === 'object' ? settings.welcomeEmbed : {};
        const parsedFields = normalizeStepFields(embedPayload.fields).map((field) => ({
          name: this.parseVariables(field.name, member, channelSource),
          value: this.parseVariables(field.value, member, channelSource),
          inline: !!field.inline,
        }));
        const footerText = typeof embedPayload.footer === 'string'
          ? embedPayload.footer
          : (embedPayload.footer && typeof embedPayload.footer.text === 'string' ? embedPayload.footer.text : '');
        const embed = {
          title: embedPayload.title ? this.parseVariables(embedPayload.title, member, channelSource) : null,
          description: embedPayload.description ? this.parseVariables(embedPayload.description, member, channelSource) : null,
          color: normalizeEmbedColor(embedPayload.color),
          footer: footerText ? { text: this.parseVariables(footerText, member, channelSource) } : undefined,
          image: settings.welcomeImageUrl ? { url: settings.welcomeImageUrl } : undefined,
          thumbnail: settings.dynamicAvatarCard ? { url: member.user?.displayAvatarURL?.({ extension: 'png', size: 256 }) } : undefined,
          fields: parsedFields.length > 0 ? parsedFields : undefined,
        };
        const files = [];
        if (settings.welcomeImageAssetId) {
          const asset = db.prepare(`
            SELECT id, file_name, mime_type, image_blob
            FROM tenant_welcome_assets
            WHERE id = ? AND guild_id = ?
          `).get(settings.welcomeImageAssetId, guildId);
          if (asset?.image_blob) {
            const fileName = String(asset.file_name || `welcome-${asset.id}.png`);
            files.push({ attachment: Buffer.from(asset.image_blob), name: fileName });
            embed.image = { url: `attachment://${fileName}` };
          }
        }

        const hasEmbed = !!(embed.title || embed.description || embed.color || embed.footer || embed.image || embed.thumbnail);
        await channel.send({
          content,
          embeds: hasEmbed ? [embed] : [],
          files
        });
        delivered = true;
      }

      if (settings.dmEnabled) {
        const dmText = this.parseVariables(settings.dmMessageTemplate, member, channelSource);
        await member.send({ content: dmText }).catch(() => {});
      }

      if (settings.captchaEnabled) {
        await this.sendCaptchaPrompt(member, { guildId, channelSource, channel });
      }
      return { success: true, delivered };
    } catch (error) {
      logger.error('[welcome] handleMemberJoin failed:', error);
      return { success: false, delivered: false, message: error?.message || 'Failed to process welcome flow.' };
    }
  }

  async verifyCaptcha({ challengeToken, captchaToken }) {
    const payload = readChallengeToken(challengeToken);
    if (!payload || !payload.guildId || !payload.userId) {
      return { success: false, message: 'Invalid challenge token' };
    }
    if (Number(payload.exp || 0) < Date.now()) {
      return { success: false, message: 'Challenge has expired' };
    }

    const settingsResult = this.getSettings(payload.guildId);
    if (!settingsResult.success) return settingsResult;
    const settings = settingsResult.settings;
    if (!settings.captchaEnabled || !settings.captchaRoleId) {
      return { success: false, message: 'Captcha is not enabled for this server' };
    }

    const turnstileSecret = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
    if (turnstileSecret) {
      try {
        const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            secret: turnstileSecret,
            response: String(captchaToken || '').trim(),
          }),
        });
        const json = await res.json();
        if (!json?.success) {
          return { success: false, message: 'CAPTCHA verification failed' };
        }
      } catch (error) {
        logger.error('[welcome] captcha provider validation failed:', error);
        return { success: false, message: 'CAPTCHA provider unavailable' };
      }
    }

    try {
      const client = require('../utils/clientProvider').getClient();
      const guild = await client?.guilds?.fetch(payload.guildId).catch(() => null);
      if (!guild) return { success: false, message: 'Guild not found' };
      const member = await guild.members.fetch(payload.userId).catch(() => null);
      if (!member) return { success: false, message: 'Member not found' };
      await member.roles.add(settings.captchaRoleId);
      return { success: true, guildId: payload.guildId, userId: payload.userId };
    } catch (error) {
      logger.error('[welcome] verifyCaptcha role grant failed:', error);
      return { success: false, message: 'Failed to grant captcha role' };
    }
  }

  async sendTestWelcome(guild, actorUser) {
    if (!guild || !actorUser) return { success: false, message: 'Guild and user are required' };
    const member = await guild.members.fetch(actorUser.id).catch(() => null);
    if (!member) return { success: false, message: 'Could not resolve test member' };
    const settingsResult = this.getSettings(guild.id);
    if (!settingsResult.success) return settingsResult;
    const settings = settingsResult.settings;

    const channelId = settings.welcomeChannelId;
    if (!channelId) return { success: false, message: 'No welcome channel configured. Select a channel first.' };
    const channel = guild.channels?.cache?.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || typeof channel.send !== 'function') {
      return { success: false, message: `Configured welcome channel is unavailable (${channelId}).` };
    }

    const originalEnabled = settings.enabled;
    if (!originalEnabled) {
      this.updateSettings(guild.id, { enabled: true });
    }
    const result = await this.handleMemberJoin(member);
    if (!originalEnabled) {
      this.updateSettings(guild.id, { enabled: false });
    }
    if (!result?.success || !result?.delivered) {
      return { success: false, message: result?.message || 'Welcome message was not delivered.' };
    }
    return { success: true, message: 'Test welcome sent successfully.' };
  }

  saveUploadedImage({ guildId, fileName, mimeType, buffer }) {
    const normalizedGuildId = String(guildId || '').trim();
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return { success: false, message: 'Image buffer is required' };
    if (buffer.length > MAX_IMAGE_BYTES) return { success: false, message: `Image exceeds max size (${MAX_IMAGE_BYTES} bytes)` };
    const safeMime = String(mimeType || '').trim().toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(safeMime)) {
      return { success: false, message: 'Unsupported image type. Use PNG/JPG/WEBP/GIF.' };
    }
    const safeName = String(fileName || 'welcome-image').replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'welcome-image';

    const result = db.prepare(`
      INSERT INTO tenant_welcome_assets (guild_id, file_name, mime_type, image_blob, byte_size, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(normalizedGuildId, safeName, safeMime, buffer, buffer.length);

    return {
      success: true,
      asset: {
        id: Number(result.lastInsertRowid),
        fileName: safeName,
        mimeType: safeMime,
        byteSize: buffer.length,
      }
    };
  }
}

module.exports = new WelcomeService();
