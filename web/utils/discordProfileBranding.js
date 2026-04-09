function normalizeOptionalString(value, { maxLength = 2048 } = {}) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

async function getGuildBotProfileSnapshot({ client, guildId }) {
  const normalizedGuildId = String(guildId || '').trim();
  if (!client || !normalizedGuildId) return null;

  const guild = await client.guilds.fetch(normalizedGuildId).catch(() => null);
  if (!guild) return null;

  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me) return null;

  return {
    nickname: me.nickname || null,
    avatar_url: me.avatarURL({ extension: 'png', size: 1024 }) || null,
    banner_url: me.bannerURL({ extension: 'png', size: 1024 }) || null,
    display_avatar_url: me.displayAvatarURL({ extension: 'png', size: 1024 }) || null,
    display_banner_url: me.displayBannerURL({ extension: 'png', size: 1024 }) || null,
  };
}

async function applyGuildBotProfileBranding({
  client,
  guildId,
  brandingPatch,
  logger,
  reason = 'Updated bot server profile from branding settings',
}) {
  const normalizedGuildId = String(guildId || '').trim();
  if (!client || !normalizedGuildId || !brandingPatch || typeof brandingPatch !== 'object') {
    return { success: false, skipped: true, message: 'Missing client/guild/patch' };
  }

  const profileKeys = [
    'bot_display_name',
    'bot_server_avatar_url',
    'bot_server_banner_url',
    'bot_server_bio',
  ];

  const hasProfileUpdate = profileKeys.some(key => Object.prototype.hasOwnProperty.call(brandingPatch, key));
  if (!hasProfileUpdate) {
    return { success: false, skipped: true, message: 'No profile fields in patch' };
  }

  const editPayload = {};
  if (Object.prototype.hasOwnProperty.call(brandingPatch, 'bot_display_name')) {
    editPayload.nick = normalizeOptionalString(brandingPatch.bot_display_name, { maxLength: 32 });
  }
  if (Object.prototype.hasOwnProperty.call(brandingPatch, 'bot_server_avatar_url')) {
    editPayload.avatar = normalizeOptionalString(brandingPatch.bot_server_avatar_url, { maxLength: 2048 });
  }
  if (Object.prototype.hasOwnProperty.call(brandingPatch, 'bot_server_banner_url')) {
    editPayload.banner = normalizeOptionalString(brandingPatch.bot_server_banner_url, { maxLength: 2048 });
  }
  if (Object.prototype.hasOwnProperty.call(brandingPatch, 'bot_server_bio')) {
    editPayload.bio = normalizeOptionalString(brandingPatch.bot_server_bio, { maxLength: 190 });
  }

  if (Object.keys(editPayload).length === 0) {
    return { success: false, skipped: true, message: 'No effective profile update values' };
  }

  try {
    const guild = await client.guilds.fetch(normalizedGuildId).catch(() => null);
    if (!guild) {
      return { success: false, skipped: true, message: 'Guild not available for profile edit' };
    }

    await guild.members.editMe({ ...editPayload, reason });
    return { success: true, skipped: false };
  } catch (error) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`Unable to apply guild bot profile branding for guild ${normalizedGuildId}: ${error?.message || error}`);
    }
    return {
      success: false,
      skipped: false,
      message: String(error?.message || 'Failed to apply guild bot profile branding'),
    };
  }
}

module.exports = {
  getGuildBotProfileSnapshot,
  applyGuildBotProfileBranding,
};
