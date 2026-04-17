const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Collection,
  PermissionFlagsBits,
} = require('discord.js');
const db = require('../database/db');
const logger = require('../utils/logger');
const entitlementService = require('./entitlementService');
const tenantService = require('./tenantService');
const walletService = require('./walletService');
const nftService = require('./nftService');
const tokenService = require('./tokenService');
const roleService = require('./roleService');
const { applyEmbedBranding } = require('./embedBranding');

const CREATE_LINK_BUTTON_ID = 'invite_tracker_create_link';
const REFRESH_BUTTON_ID = 'invite_tracker_refresh';
const SORT_BUTTON_PREFIX = 'invite_tracker_sort_';
const SORT_BY_INVITES = 'invites';
const SORT_BY_NFTS = 'nfts';
const SORT_BY_TOKENS = 'tokens';

function normalizePanelSortBy(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === SORT_BY_NFTS || normalized === SORT_BY_TOKENS) return normalized;
  return SORT_BY_INVITES;
}

function normalizeGuildId(guildId) {
  const normalized = String(guildId || '').trim();
  return /^\d{17,20}$/.test(normalized) ? normalized : '';
}

function normalizeUserId(userId) {
  const normalized = String(userId || '').trim();
  return /^\d{17,20}$/.test(normalized) ? normalized : '';
}

function normalizeRoleId(roleId) {
  const normalized = String(roleId || '').trim();
  return /^\d{17,20}$/.test(normalized) ? normalized : '';
}

function normalizeChannelId(channelId) {
  const normalized = String(channelId || '').trim();
  return /^\d{17,20}$/.test(normalized) ? normalized : '';
}

function clampInt(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (!text.includes(',') && !text.includes('"') && !text.includes('\n')) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function chunkArray(arr, size = 100) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function normalizeInviteCode(code) {
  const normalized = String(code || '').trim();
  return normalized ? normalized.slice(0, 64) : '';
}

function normalizeInviteCodeCompare(code) {
  const normalized = normalizeInviteCode(code);
  return normalized ? normalized.toLowerCase() : '';
}

function parseExcludedCodesInput(value) {
  let source = [];
  if (Array.isArray(value)) {
    source = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      source = [];
    } else {
      try {
        const parsed = JSON.parse(trimmed);
        source = Array.isArray(parsed) ? parsed : trimmed.split(/[\n,;]/g);
      } catch (_error) {
        source = trimmed.split(/[\n,;]/g);
      }
    }
  }

  const uniq = new Map();
  for (const raw of source) {
    const code = normalizeInviteCode(raw);
    const key = normalizeInviteCodeCompare(code);
    if (!key || uniq.has(key)) continue;
    uniq.set(key, code);
  }
  return Array.from(uniq.values());
}

function isDiscordSnowflake(value) {
  return /^\d{17,20}$/.test(String(value || '').trim());
}

function normalizeDisplayName(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (isDiscordSnowflake(normalized)) return null;
  return normalized;
}

class InviteTrackerService {
  constructor() {
    this.client = null;
    this.inviteCache = new Map();
    this.panelRefreshTimers = new Map();
    this.periodicPanelRefreshInterval = null;
    this.verificationSnapshotCache = new Map();
    this.verificationSnapshotTtlMs = Math.max(60, Number(process.env.INVITE_VERIFICATION_SNAPSHOT_TTL_SEC || 600)) * 1000;
  }

  setClient(client) {
    this.client = client;
  }

  startAutoPanelRefresh(intervalMs = null) {
    if (this.periodicPanelRefreshInterval) {
      clearInterval(this.periodicPanelRefreshInterval);
      this.periodicPanelRefreshInterval = null;
    }
    const configuredSeconds = Number(process.env.INVITE_LEADERBOARD_REFRESH_SEC || 300);
    const resolvedMs = intervalMs || Math.max(60, Number.isFinite(configuredSeconds) ? configuredSeconds : 300) * 1000;
    this.periodicPanelRefreshInterval = setInterval(() => {
      this.refreshAllLeaderboardPanels().catch((error) => {
        logger.warn(`[invite-tracker] periodic panel refresh failed: ${error?.message || error}`);
      });
    }, resolvedMs);
    return resolvedMs;
  }

  async refreshAllLeaderboardPanels() {
    const rows = db.prepare(`
      SELECT guild_id, panel_channel_id
      FROM invite_tracker_settings
      WHERE panel_channel_id IS NOT NULL
        AND trim(panel_channel_id) <> ''
    `).all();

    for (const row of rows) {
      const guildId = normalizeGuildId(row.guild_id);
      const channelId = normalizeChannelId(row.panel_channel_id);
      if (!guildId || !channelId) continue;
      if (!this.isModuleEnabled(guildId)) continue;
      await this.postOrUpdateLeaderboardPanel(guildId, channelId).catch((error) => {
        logger.warn(`[invite-tracker] refresh panel failed for guild ${guildId}: ${error?.message || error}`);
      });
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  isModuleEnabled(guildId) {
    try {
      if (tenantService.isMultitenantEnabled()) {
        return tenantService.isModuleEnabled(guildId, 'invites');
      }
    } catch (_error) {}
    return true;
  }

  _getDefaultSettings() {
    return {
      requiredJoinRoleId: null,
      panelChannelId: null,
      panelMessageId: null,
      panelPeriodDays: null,
      panelLimit: 10,
      panelEnableCreateLink: true,
      includeVerificationStats: false,
      excludedCodes: [],
      panelSortBy: SORT_BY_INVITES,
    };
  }

  getSettings(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };

    const row = db.prepare(`
      SELECT
        required_join_role_id,
        panel_channel_id,
        panel_message_id,
        panel_period_days,
        panel_limit,
        panel_enable_create_link,
        include_verification_stats,
        excluded_codes,
        panel_sort_by
      FROM invite_tracker_settings
      WHERE guild_id = ?
      LIMIT 1
    `).get(normalizedGuildId);

    const defaults = this._getDefaultSettings();
    if (!row) return { success: true, settings: defaults };

    return {
      success: true,
      settings: {
        requiredJoinRoleId: normalizeRoleId(row.required_join_role_id || '') || null,
        panelChannelId: normalizeChannelId(row.panel_channel_id || '') || null,
        panelMessageId: String(row.panel_message_id || '').trim() || null,
        panelPeriodDays: (row.panel_period_days === null || row.panel_period_days === undefined || row.panel_period_days === 0)
          ? null
          : clampInt(row.panel_period_days, 1, 3650, null),
        panelLimit: clampInt(row.panel_limit, 1, 100, defaults.panelLimit),
        panelEnableCreateLink: Number(row.panel_enable_create_link || 0) === 1,
        includeVerificationStats: Number(row.include_verification_stats || 0) === 1,
        excludedCodes: parseExcludedCodesInput(row.excluded_codes || '[]'),
        panelSortBy: normalizePanelSortBy(row.panel_sort_by || defaults.panelSortBy),
      },
    };
  }

  saveSettings(guildId, payload = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };

    const existingResult = this.getSettings(normalizedGuildId);
    if (!existingResult.success) return existingResult;
    const existing = existingResult.settings;

    const merged = {
      requiredJoinRoleId: payload.requiredJoinRoleId !== undefined
        ? (normalizeRoleId(payload.requiredJoinRoleId || '') || null)
        : existing.requiredJoinRoleId,
      panelChannelId: payload.panelChannelId !== undefined
        ? (normalizeChannelId(payload.panelChannelId || '') || null)
        : existing.panelChannelId,
      panelMessageId: payload.panelMessageId !== undefined
        ? (String(payload.panelMessageId || '').trim() || null)
        : existing.panelMessageId,
      panelPeriodDays: payload.panelPeriodDays !== undefined
        ? (payload.panelPeriodDays === null || payload.panelPeriodDays === '' || payload.panelPeriodDays === 0 || payload.panelPeriodDays === 'all' ? null : clampInt(payload.panelPeriodDays, 1, 3650, null))
        : existing.panelPeriodDays,
      panelLimit: payload.panelLimit !== undefined
        ? clampInt(payload.panelLimit, 1, 100, existing.panelLimit)
        : existing.panelLimit,
      panelEnableCreateLink: payload.panelEnableCreateLink !== undefined
        ? !!payload.panelEnableCreateLink
        : !!existing.panelEnableCreateLink,
      includeVerificationStats: payload.includeVerificationStats !== undefined
        ? !!payload.includeVerificationStats
        : !!existing.includeVerificationStats,
      excludedCodes: payload.excludedCodes !== undefined
        ? parseExcludedCodesInput(payload.excludedCodes)
        : parseExcludedCodesInput(existing.excludedCodes),
      panelSortBy: payload.panelSortBy !== undefined
        ? normalizePanelSortBy(payload.panelSortBy)
        : normalizePanelSortBy(existing.panelSortBy),
    };

    db.prepare(`
      INSERT INTO invite_tracker_settings (
        guild_id, required_join_role_id, panel_channel_id, panel_message_id,
        panel_period_days, panel_limit, panel_enable_create_link, include_verification_stats, excluded_codes, panel_sort_by,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id) DO UPDATE SET
        required_join_role_id = excluded.required_join_role_id,
        panel_channel_id = excluded.panel_channel_id,
        panel_message_id = excluded.panel_message_id,
        panel_period_days = excluded.panel_period_days,
        panel_limit = excluded.panel_limit,
        panel_enable_create_link = excluded.panel_enable_create_link,
        include_verification_stats = excluded.include_verification_stats,
        excluded_codes = excluded.excluded_codes,
        panel_sort_by = excluded.panel_sort_by,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      normalizedGuildId,
      merged.requiredJoinRoleId,
      merged.panelChannelId,
      merged.panelMessageId,
      merged.panelPeriodDays,
      merged.panelLimit,
      merged.panelEnableCreateLink ? 1 : 0,
      merged.includeVerificationStats ? 1 : 0,
      JSON.stringify(merged.excludedCodes || []),
      merged.panelSortBy
    );

    return { success: true, settings: merged };
  }

  _setGuildCacheFromInvites(guildId, invitesCollection) {
    const nextCache = new Map();
    for (const invite of invitesCollection.values()) {
      if (!invite?.code) continue;
      nextCache.set(String(invite.code), {
        uses: Number(invite.uses || 0),
        inviterId: normalizeUserId(invite.inviter?.id || ''),
        inviterUsername: invite.inviter?.username || invite.inviter?.globalName || null,
      });
    }
    this.inviteCache.set(guildId, nextCache);
  }

  async primeGuildInvites(guild) {
    const guildId = normalizeGuildId(guild?.id);
    if (!guildId || !guild?.invites?.fetch) return { success: false, skipped: true };
    try {
      const invites = await guild.invites.fetch();
      this._setGuildCacheFromInvites(guildId, invites);
      return { success: true, count: invites.size };
    } catch (error) {
      logger.warn(`[invite-tracker] Could not prime invites for guild ${guildId}: ${error?.message || error}`);
      return { success: false, message: error?.message || 'invite_fetch_failed' };
    }
  }

  async primeAllGuilds() {
    const guilds = this.client?.guilds?.cache ? Array.from(this.client.guilds.cache.values()) : [];
    for (const guild of guilds) {
      await this.primeGuildInvites(guild);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  handleInviteCreate(invite) {
    const guildId = normalizeGuildId(invite?.guild?.id);
    if (!guildId || !invite?.code) return;
    const cache = this.inviteCache.get(guildId) || new Map();
    cache.set(String(invite.code), {
      uses: Number(invite.uses || 0),
      inviterId: normalizeUserId(invite.inviter?.id || ''),
      inviterUsername: invite.inviter?.username || invite.inviter?.globalName || null,
    });
    this.inviteCache.set(guildId, cache);
  }

  handleInviteDelete(invite) {
    const guildId = normalizeGuildId(invite?.guild?.id);
    if (!guildId || !invite?.code) return;
    const cache = this.inviteCache.get(guildId) || new Map();
    cache.delete(String(invite.code));
    this.inviteCache.set(guildId, cache);
    this._deactivateOwnedInviteCode(guildId, invite.code);
  }

  _saveOwnedInviteCode({ guildId, inviteCode, ownerUserId, ownerUsername = null, channelId = null }) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedCode = normalizeInviteCode(inviteCode);
    const normalizedOwner = normalizeUserId(ownerUserId);
    const normalizedChannel = normalizeChannelId(channelId || '') || null;
    if (!normalizedGuildId || !normalizedCode || !normalizedOwner) return;

    db.prepare(`
      INSERT INTO invite_tracker_user_codes (
        guild_id, invite_code, owner_user_id, owner_username, channel_id, active, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id, invite_code) DO UPDATE SET
        owner_user_id = excluded.owner_user_id,
        owner_username = excluded.owner_username,
        channel_id = excluded.channel_id,
        active = 1,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      normalizedGuildId,
      normalizedCode,
      normalizedOwner,
      ownerUsername ? String(ownerUsername).slice(0, 128) : null,
      normalizedChannel
    );
  }

  _deactivateOwnedInviteCode(guildId, inviteCode) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedCode = normalizeInviteCode(inviteCode);
    if (!normalizedGuildId || !normalizedCode) return;
    db.prepare(`
      UPDATE invite_tracker_user_codes
      SET active = 0, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ?
        AND lower(invite_code) = lower(?)
    `).run(normalizedGuildId, normalizedCode);
  }

  _getOwnedInviteContext(guildId, inviteCode) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedCode = normalizeInviteCode(inviteCode);
    if (!normalizedGuildId || !normalizedCode) return null;
    const row = db.prepare(`
      SELECT owner_user_id, owner_username
      FROM invite_tracker_user_codes
      WHERE guild_id = ?
        AND lower(invite_code) = lower(?)
        AND active = 1
      ORDER BY id DESC
      LIMIT 1
    `).get(normalizedGuildId, normalizedCode);
    if (!row) return null;
    return {
      ownerUserId: normalizeUserId(row.owner_user_id || '') || null,
      ownerUsername: row.owner_username || null,
    };
  }

  _getActiveOwnedInviteCodeForUser(guildId, ownerUserId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedOwner = normalizeUserId(ownerUserId);
    if (!normalizedGuildId || !normalizedOwner) return null;
    const row = db.prepare(`
      SELECT invite_code
      FROM invite_tracker_user_codes
      WHERE guild_id = ?
        AND owner_user_id = ?
        AND active = 1
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(normalizedGuildId, normalizedOwner);
    return row?.invite_code ? String(row.invite_code) : null;
  }

  handleMemberRoleUpdate(oldMember, newMember) {
    const guildId = normalizeGuildId(newMember?.guild?.id || oldMember?.guild?.id);
    if (!guildId) return;
    const settings = this.getSettings(guildId);
    if (!settings.success || !settings.settings.requiredJoinRoleId) return;
    const roleId = settings.settings.requiredJoinRoleId;
    const hadRole = !!oldMember?.roles?.cache?.has(roleId);
    const hasRole = !!newMember?.roles?.cache?.has(roleId);
    if (hadRole !== hasRole) this.queuePanelRefresh(guildId, 1500);
  }

  _getInvitePeriodPolicy(guildId, requestedDays = null) {
    const requested = requestedDays === null || requestedDays === undefined
      ? null
      : clampInt(requestedDays, 1, 3650, null);

    const allowTimeFilters = Number(entitlementService.getEffectiveLimit(guildId, 'invites', 'allow_time_filters') || 0) > 0;
    if (requested && !allowTimeFilters) {
      return { days: null, limitedByPlan: true };
    }
    return { days: requested, limitedByPlan: false };
  }

  _getLeaderboardLimit(guildId, requestedLimit = 10) {
    const fallback = clampInt(requestedLimit, 1, 500, 10);
    const planMax = entitlementService.getEffectiveLimit(guildId, 'invites', 'max_leaderboard_rows');
    if (planMax === null || planMax === undefined) return fallback;
    return Math.max(1, Math.min(fallback, Number(planMax)));
  }

  _canExport(guildId) {
    return Number(entitlementService.getEffectiveLimit(guildId, 'invites', 'allow_export') || 0) > 0;
  }

  applyRetentionPolicy(guildId) {
    const historyDays = entitlementService.getEffectiveLimit(guildId, 'invites', 'max_history_days');
    if (historyDays === null || historyDays === undefined) return { success: true, pruned: 0 };

    const safeDays = Math.max(1, Math.min(3650, Number(historyDays)));
    const result = db.prepare(`
      DELETE FROM invite_events
      WHERE guild_id = ?
        AND joined_at < datetime('now', ?)
    `).run(guildId, `-${safeDays} days`);

    return { success: true, pruned: Number(result?.changes || 0), historyDays: safeDays };
  }

  _recordInviteEvent({
    guildId,
    joinedUserId,
    joinedUsername,
    inviterUserId = null,
    inviterUsername = null,
    inviteCode = null,
    source = 'invite',
  }) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedJoinedId = normalizeUserId(joinedUserId);
    if (!normalizedGuildId || !normalizedJoinedId) {
      return { success: false, message: 'Invalid guild/user id' };
    }

    const writeResult = db.prepare(`
      INSERT INTO invite_events (
        guild_id, joined_user_id, joined_username,
        inviter_user_id, inviter_username,
        invite_code, source, joined_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id, joined_user_id) DO NOTHING
    `).run(
      normalizedGuildId,
      normalizedJoinedId,
      joinedUsername ? String(joinedUsername).slice(0, 128) : null,
      normalizeUserId(inviterUserId || '') || null,
      inviterUsername ? String(inviterUsername).slice(0, 128) : null,
      inviteCode ? String(inviteCode).slice(0, 64) : null,
      String(source || 'invite').slice(0, 32)
    );

    if (Number(writeResult?.changes || 0) === 0) {
      return { success: true, duplicate: true };
    }

    this.applyRetentionPolicy(normalizedGuildId);
    this.queuePanelRefresh(normalizedGuildId);
    return { success: true };
  }

  async trackMemberJoin(member) {
    const guild = member?.guild;
    const guildId = normalizeGuildId(guild?.id);
    if (!guildId || !member?.user) return { success: false, ignored: true, reason: 'invalid_member' };
    if (!this.isModuleEnabled(guildId)) return { success: true, ignored: true, reason: 'module_disabled' };

    const beforeCache = this.inviteCache.get(guildId) || new Map();
    let matched = null;

    try {
      const currentInvites = await guild.invites.fetch();

      for (const invite of currentInvites.values()) {
        const code = String(invite.code || '');
        if (!code) continue;
        const prevUses = Number(beforeCache.get(code)?.uses || 0);
        const currentUses = Number(invite.uses || 0);
        const delta = currentUses - prevUses;
        if (delta <= 0) continue;

        const candidate = {
          code,
          inviterId: normalizeUserId(invite.inviter?.id || ''),
          inviterUsername: invite.inviter?.username || invite.inviter?.globalName || null,
          delta,
        };
        if (!matched || candidate.delta > matched.delta) {
          matched = candidate;
        }
      }

      this._setGuildCacheFromInvites(guildId, currentInvites);
    } catch (error) {
      logger.warn(`[invite-tracker] Could not resolve invite source for guild ${guildId}: ${error?.message || error}`);
    }

    const ownedInvite = matched?.code ? this._getOwnedInviteContext(guildId, matched.code) : null;
    const resolvedInviterUserId = ownedInvite?.ownerUserId || matched?.inviterId || null;
    const resolvedInviterUsername = ownedInvite?.ownerUsername || matched?.inviterUsername || null;
    const resolvedSource = ownedInvite?.ownerUserId ? 'user_invite' : (matched?.code ? 'invite' : 'unknown');

    const result = this._recordInviteEvent({
      guildId,
      joinedUserId: member.id,
      joinedUsername: member.user?.username || member.user?.globalName || null,
      inviterUserId: resolvedInviterUserId,
      inviterUsername: resolvedInviterUsername,
      inviteCode: matched?.code || null,
      source: resolvedSource,
    });

    if (!result.success) return result;
    return {
      success: true,
      inviterUserId: resolvedInviterUserId,
      inviteCode: matched?.code || null,
      source: resolvedSource,
    };
  }

  getSummary(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };

    const totals = db.prepare(`
      SELECT
        COUNT(*) AS total_joins,
        SUM(CASE WHEN inviter_user_id IS NOT NULL THEN 1 ELSE 0 END) AS resolved_joins,
        SUM(CASE WHEN inviter_user_id IS NULL THEN 1 ELSE 0 END) AS unknown_joins
      FROM invite_events
      WHERE guild_id = ?
    `).get(normalizedGuildId);

    const uniqueInviters = db.prepare(`
      SELECT COUNT(DISTINCT inviter_user_id) AS inviter_count
      FROM invite_events
      WHERE guild_id = ?
        AND inviter_user_id IS NOT NULL
    `).get(normalizedGuildId);

    const settingsResult = this.getSettings(normalizedGuildId);
    const settings = settingsResult.success ? settingsResult.settings : this._getDefaultSettings();

    return {
      success: true,
      summary: {
        totalJoins: Number(totals?.total_joins || 0),
        resolvedJoins: Number(totals?.resolved_joins || 0),
        unknownJoins: Number(totals?.unknown_joins || 0),
        uniqueInviters: Number(uniqueInviters?.inviter_count || 0),
        canExport: this._canExport(normalizedGuildId),
        maxLeaderboardRows: this._getLeaderboardLimit(normalizedGuildId, 9999),
        requiredJoinRoleId: settings.requiredJoinRoleId || null,
        includeVerificationStats: !!settings.includeVerificationStats,
        excludedCodes: Array.isArray(settings.excludedCodes) ? settings.excludedCodes : [],
        panelSortBy: normalizePanelSortBy(settings.panelSortBy),
      },
    };
  }

  listEvents(guildId, { limit = 50, days = null } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };

    const safeLimit = clampInt(limit, 1, 500, 50);
    const periodPolicy = this._getInvitePeriodPolicy(normalizedGuildId, days);
    const wherePeriod = periodPolicy.days ? `AND joined_at >= datetime('now', ?)` : '';
    const params = [normalizedGuildId];
    if (periodPolicy.days) params.push(`-${periodPolicy.days} days`);
    params.push(safeLimit);

    const rows = db.prepare(`
      SELECT
        id,
        guild_id,
        joined_user_id,
        joined_username,
        inviter_user_id,
        inviter_username,
        invite_code,
        source,
        joined_at
      FROM invite_events
      WHERE guild_id = ?
      ${wherePeriod}
      ORDER BY joined_at DESC, id DESC
      LIMIT ?
    `).all(...params);
    const knownNames = this._lookupKnownUsernames([
      ...rows.map(row => row.joined_user_id),
      ...rows.map(row => row.inviter_user_id),
    ]);

    return {
      success: true,
      events: rows.map(row => ({
        id: row.id,
        joinedUserId: row.joined_user_id,
        joinedUsername: row.joined_username || knownNames.get(String(row.joined_user_id || '')) || null,
        inviterUserId: row.inviter_user_id || null,
        inviterUsername: row.inviter_username || knownNames.get(String(row.inviter_user_id || '')) || null,
        inviteCode: row.invite_code || null,
        source: row.source || 'unknown',
        joinedAt: row.joined_at,
      })),
      limitedByPlan: periodPolicy.limitedByPlan,
      periodDays: periodPolicy.days,
    };
  }

  async _resolveEligibleJoinedUserIds(guild, joinedUserIds, requiredRoleId) {
    if (!requiredRoleId) return new Set(joinedUserIds);
    if (!guild) return new Set();

    const uniqueJoined = Array.from(new Set((joinedUserIds || []).map(normalizeUserId).filter(Boolean)));
    if (uniqueJoined.length === 0) return new Set();

    const eligible = new Set();
    const missing = [];
    for (const userId of uniqueJoined) {
      const cached = guild.members?.cache?.get(userId);
      if (!cached) {
        missing.push(userId);
        continue;
      }
      if (cached.roles?.cache?.has(requiredRoleId)) eligible.add(userId);
    }

    for (const chunk of chunkArray(missing, 100)) {
      try {
        const fetched = await guild.members.fetch({ user: chunk, force: true });
        if (fetched instanceof Collection) {
          for (const member of fetched.values()) {
            if (member.roles?.cache?.has(requiredRoleId)) eligible.add(member.id);
          }
        } else if (fetched?.id && fetched.roles?.cache?.has(requiredRoleId)) {
          eligible.add(fetched.id);
        }
      } catch (_error) {
        // Ignore fetch misses (user left guild, no access, etc.)
      }
    }

    return eligible;
  }

  _pickDisplayName(...candidates) {
    for (const candidate of candidates) {
      const normalized = normalizeDisplayName(candidate);
      if (normalized) return normalized;
    }
    return null;
  }

  _getCachedVerificationSnapshot(guildId, userId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedGuildId || !normalizedUserId) return null;
    const key = `${normalizedGuildId}:${normalizedUserId}`;
    const cached = this.verificationSnapshotCache.get(key);
    if (!cached) return null;
    if ((Date.now() - Number(cached.cachedAt || 0)) > this.verificationSnapshotTtlMs) {
      this.verificationSnapshotCache.delete(key);
      return null;
    }
    return {
      totalNfts: Math.max(0, Number(cached.totalNfts || 0)),
      totalTokens: Math.max(0, Number(cached.totalTokens || 0)),
    };
  }

  _setCachedVerificationSnapshot(guildId, userId, snapshot) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedGuildId || !normalizedUserId || !snapshot) return;

    if (this.verificationSnapshotCache.size > 10000) {
      const cutoff = Date.now() - this.verificationSnapshotTtlMs;
      for (const [key, value] of this.verificationSnapshotCache.entries()) {
        if (Number(value?.cachedAt || 0) < cutoff) {
          this.verificationSnapshotCache.delete(key);
        }
      }
    }

    this.verificationSnapshotCache.set(`${normalizedGuildId}:${normalizedUserId}`, {
      totalNfts: Math.max(0, Number(snapshot.totalNfts || 0)),
      totalTokens: Math.max(0, Number(snapshot.totalTokens || 0)),
      cachedAt: Date.now(),
    });
  }

  async _lookupUserVerificationSnapshots(userIds, {
    guildId = null,
    includeTokenStats = false,
  } = {}) {
    const normalized = Array.from(new Set((userIds || []).map(normalizeUserId).filter(Boolean)));
    if (normalized.length === 0) return new Map();

    const result = new Map();
    for (const chunk of chunkArray(normalized, 400)) {
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT discord_id, total_nfts, total_tokens
        FROM users
        WHERE discord_id IN (${placeholders})
      `).all(...chunk);
      for (const row of rows) {
        result.set(String(row.discord_id), {
          totalNfts: Math.max(0, Number(row.total_nfts || 0)),
          totalTokens: Math.max(0, Number(row.total_tokens || 0)),
        });
      }
    }

    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return result;

    const tokenRules = includeTokenStats
      ? roleService.getTokenRoleRules(normalizedGuildId).filter(rule => rule.enabled !== false)
      : [];
    const trackedMints = includeTokenStats
      ? [...new Set(tokenRules.map(rule => String(rule.tokenMint || '').trim()).filter(Boolean))]
      : [];

    const walletsByUser = new Map();
    for (const chunk of chunkArray(normalized, 400)) {
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT discord_id, wallet_address
        FROM wallets
        WHERE discord_id IN (${placeholders})
      `).all(...chunk);
      for (const row of rows) {
        const userId = normalizeUserId(row.discord_id);
        const wallet = String(row.wallet_address || '').trim();
        if (!userId || !wallet) continue;
        if (!walletsByUser.has(userId)) walletsByUser.set(userId, []);
        walletsByUser.get(userId).push(wallet);
      }
    }

    for (const userId of normalized) {
      const cached = this._getCachedVerificationSnapshot(normalizedGuildId, userId);
      if (cached) {
        result.set(userId, cached);
        continue;
      }

      const wallets = walletsByUser.get(userId)
        || walletService.getAllUserWallets(userId)
        || [];
      if (!wallets.length) {
        const emptySnapshot = { totalNfts: 0, totalTokens: 0 };
        result.set(userId, emptySnapshot);
        this._setCachedVerificationSnapshot(normalizedGuildId, userId, emptySnapshot);
        continue;
      }

      try {
        const nfts = await nftService.getAllNFTsForWallets(wallets, { guildId: normalizedGuildId });
        const tierInfo = roleService.getTierForNFTs(nfts, normalizedGuildId);
        const totalNfts = Math.max(0, Number(tierInfo?.count || 0));

        let totalTokens = 0;
        if (trackedMints.length > 0) {
          const tokenTotals = await tokenService.getAggregateBalancesForWallets(wallets, trackedMints, { guildId: normalizedGuildId });
          totalTokens = Object.values(tokenTotals || {}).reduce((sum, amount) => sum + Number(amount || 0), 0);
        }

        const snapshot = {
          totalNfts,
          totalTokens: trackedMints.length > 0 ? Number(totalTokens.toFixed(6)) : 0,
        };
        result.set(userId, snapshot);
        this._setCachedVerificationSnapshot(normalizedGuildId, userId, snapshot);
      } catch (error) {
        logger.warn(`[invite-tracker] failed to build scoped verification snapshot for ${userId} in guild ${normalizedGuildId}: ${error?.message || error}`);
      }
    }

    return result;
  }

  _lookupKnownUsernames(userIds) {
    const normalized = Array.from(new Set((userIds || []).map(normalizeUserId).filter(Boolean)));
    if (normalized.length === 0) return new Map();

    const result = new Map();
    for (const chunk of chunkArray(normalized, 400)) {
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT discord_id, username
        FROM users
        WHERE discord_id IN (${placeholders})
      `).all(...chunk);
      for (const row of rows) {
        const id = String(row.discord_id || '').trim();
        const name = String(row.username || '').trim();
        if (id) result.set(id, name);
      }
    }
    return result;
  }

  async _resolveLeaderboardDisplayNames(guildId, rows = []) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const userIds = Array.from(new Set((rows || []).map(row => normalizeUserId(row?.inviterUserId)).filter(Boolean)));
    const displayMap = new Map();
    if (userIds.length === 0) return displayMap;

    const knownNames = this._lookupKnownUsernames(userIds);
    for (const row of rows || []) {
      const userId = normalizeUserId(row?.inviterUserId);
      if (!userId) continue;
      const picked = this._pickDisplayName(row?.inviterUsername, knownNames.get(userId));
      if (picked) displayMap.set(userId, picked);
    }

    const guild = normalizedGuildId
      ? (this.client?.guilds?.cache?.get(normalizedGuildId) || await this.client?.guilds?.fetch?.(normalizedGuildId).catch(() => null))
      : null;
    if (guild?.members?.cache) {
      for (const userId of userIds) {
        if (displayMap.has(userId)) continue;
        const member = guild.members.cache.get(userId);
        const picked = this._pickDisplayName(member?.displayName, member?.user?.globalName, member?.user?.username);
        if (picked) displayMap.set(userId, picked);
      }
    }

    const missing = userIds.filter(userId => !displayMap.has(userId));
    await Promise.all(missing.map(async (userId) => {
      try {
        const user = await this.client?.users?.fetch?.(userId, { force: false });
        const picked = this._pickDisplayName(user?.globalName, user?.displayName, user?.username, knownNames.get(userId));
        if (picked) displayMap.set(userId, picked);
      } catch (_error) {
        // Best-effort only.
      }
    }));

    return displayMap;
  }

  _formatLeaderboardInviterLabel(row, displayMap = new Map()) {
    const inviterUserId = normalizeUserId(row?.inviterUserId);
    const inviterName = this._pickDisplayName(
      row?.inviterUsername,
      inviterUserId ? displayMap.get(inviterUserId) : null
    );

    if (inviterName && inviterUserId) {
      return `${inviterName} (<@${inviterUserId}>)`;
    }
    if (inviterName) return inviterName;
    if (inviterUserId) return `<@${inviterUserId}>`;
    return 'Unknown';
  }

  _tenantHasEnabledTokenVerificationRules(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return false;
    const row = db.prepare(`
      SELECT COUNT(1) AS count
      FROM token_role_rules
      WHERE guild_id = ?
        AND enabled = 1
    `).get(normalizedGuildId);
    return Number(row?.count || 0) > 0;
  }

  async _buildLeaderboardRowsFromCounter(counter, inviterJoinedSetMap, {
    totalInviteCounter = null,
    guildId = null,
    includeVerificationStats = false,
    includeTokenStats = false,
    sortBy = SORT_BY_INVITES,
    limit = 10,
  } = {}) {
    const sortMode = normalizePanelSortBy(sortBy);
    const safeLimit = Math.max(1, Number(limit) || 10);
    const totalCounterMap = totalInviteCounter instanceof Map ? totalInviteCounter : null;
    const inviterIds = new Set([
      ...Array.from(counter.keys()),
      ...(totalCounterMap ? Array.from(totalCounterMap.keys()) : []),
    ]);
    const inviters = Array.from(inviterIds).map((inviterUserId) => {
      const qualified = counter.get(inviterUserId) || { inviterUsername: null, inviteCount: 0 };
      const total = totalCounterMap?.get(inviterUserId) || qualified;
      const qualifiedInviteCount = Number(qualified.inviteCount || 0);
      const totalInviteCount = Number(total.inviteCount || qualifiedInviteCount);
      return {
        inviterUserId,
        inviterUsername: qualified.inviterUsername || total.inviterUsername || null,
        inviteCount: qualifiedInviteCount,
        qualifiedInviteCount,
        totalInviteCount,
      };
    });

    const compareRows = (a, b) => {
      if (sortMode === SORT_BY_TOKENS && includeTokenStats) {
        const tokenDelta = Number(b.inviteeTokensTotal || 0) - Number(a.inviteeTokensTotal || 0);
        if (tokenDelta !== 0) return tokenDelta;
      } else if (sortMode === SORT_BY_NFTS && includeVerificationStats) {
        const nftDelta = Number(b.inviteeNftsTotal || 0) - Number(a.inviteeNftsTotal || 0);
        if (nftDelta !== 0) return nftDelta;
      }
      const inviteDelta = Number(b.inviteCount || 0) - Number(a.inviteCount || 0);
      if (inviteDelta !== 0) return inviteDelta;
      const totalInviteDelta = Number(b.totalInviteCount || 0) - Number(a.totalInviteCount || 0);
      if (totalInviteDelta !== 0) return totalInviteDelta;
      return String(a.inviterUserId || '').localeCompare(String(b.inviterUserId || ''));
    };

    if (!includeVerificationStats) {
      return inviters
        .sort(compareRows)
        .slice(0, safeLimit)
        .map((row, idx) => ({
          ...row,
          rank: idx + 1,
        }));
    }

    const allJoinedUsers = [];
    for (const row of inviters) {
      const joinedSet = inviterJoinedSetMap.get(row.inviterUserId) || new Set();
      for (const userId of joinedSet) allJoinedUsers.push(userId);
    }
    const userSnapshots = await this._lookupUserVerificationSnapshots(allJoinedUsers, {
      guildId,
      includeTokenStats,
    });

    const rowsWithStats = inviters.map((row) => {
      const joinedSet = inviterJoinedSetMap.get(row.inviterUserId) || new Set();
      let inviteeNftsTotal = 0;
      let inviteesWithNfts = 0;
      let inviteeTokensTotal = 0;
      let inviteesWithTokens = 0;
      for (const joinedUserId of joinedSet) {
        const snapshot = userSnapshots.get(joinedUserId) || { totalNfts: 0, totalTokens: 0 };
        const nfts = Math.max(0, Number(snapshot.totalNfts || 0));
        const tokens = Math.max(0, Number(snapshot.totalTokens || 0));
        inviteeNftsTotal += nfts;
        inviteeTokensTotal += tokens;
        if (nfts > 0) inviteesWithNfts += 1;
        if (tokens > 0) inviteesWithTokens += 1;
      }
      const inviteesCount = joinedSet.size;
      const inviteeNftsAverage = inviteesCount > 0 ? Number((inviteeNftsTotal / inviteesCount).toFixed(2)) : 0;
      const inviteeTokensAverage = inviteesCount > 0 ? Number((inviteeTokensTotal / inviteesCount).toFixed(6)) : 0;

      return {
        ...row,
        inviteesCount,
        inviteesWithNfts,
        inviteeNftsTotal,
        inviteeNftsAverage,
        inviteesWithTokens: includeTokenStats ? inviteesWithTokens : 0,
        inviteeTokensTotal: includeTokenStats ? Number(inviteeTokensTotal.toFixed(6)) : 0,
        inviteeTokensAverage: includeTokenStats ? inviteeTokensAverage : 0,
      };
    });

    return rowsWithStats
      .sort(compareRows)
      .slice(0, safeLimit)
      .map((row, idx) => ({
        ...row,
        rank: idx + 1,
      }));
  }

  async getLeaderboard(guildId, {
    limit = 10,
    days = null,
    requiredJoinRoleId = undefined,
    includeVerificationStats = undefined,
    sortBy = undefined,
  } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };

    const settingsResult = this.getSettings(normalizedGuildId);
    const settings = settingsResult.success ? settingsResult.settings : this._getDefaultSettings();
    const effectiveRoleId = requiredJoinRoleId === undefined
      ? (settings.requiredJoinRoleId || null)
      : (normalizeRoleId(requiredJoinRoleId || '') || null);
    const effectiveIncludeVerificationStats = includeVerificationStats === undefined
      ? !!settings.includeVerificationStats
      : !!includeVerificationStats;
    const effectiveIncludeTokenStats = effectiveIncludeVerificationStats && this._tenantHasEnabledTokenVerificationRules(normalizedGuildId);
    const requestedSortBy = sortBy === undefined ? settings.panelSortBy : sortBy;
    let effectiveSortBy = normalizePanelSortBy(requestedSortBy);
    if (effectiveSortBy === SORT_BY_NFTS && !effectiveIncludeVerificationStats) {
      effectiveSortBy = SORT_BY_INVITES;
    }
    if (effectiveSortBy === SORT_BY_TOKENS && !effectiveIncludeTokenStats) {
      effectiveSortBy = effectiveIncludeVerificationStats ? SORT_BY_NFTS : SORT_BY_INVITES;
    }
    const excludedCodes = parseExcludedCodesInput(settings.excludedCodes || []);
    const excludedCodeCompareValues = excludedCodes.map(normalizeInviteCodeCompare).filter(Boolean);
    const excludedCodeSet = new Set(excludedCodeCompareValues);

    const safeLimit = this._getLeaderboardLimit(normalizedGuildId, limit);
    const periodPolicy = this._getInvitePeriodPolicy(normalizedGuildId, days);
    const wherePeriod = periodPolicy.days ? `AND joined_at >= datetime('now', ?)` : '';
    const params = [normalizedGuildId];
    if (periodPolicy.days) params.push(`-${periodPolicy.days} days`);

    if (!effectiveRoleId && !effectiveIncludeVerificationStats) {
      const excludeSql = excludedCodeCompareValues.length
        ? `AND (invite_code IS NULL OR lower(invite_code) NOT IN (${excludedCodeCompareValues.map(() => '?').join(',')}))`
        : '';
      const queryParams = [...params];
      if (excludedCodeCompareValues.length) queryParams.push(...excludedCodeCompareValues);
      queryParams.push(safeLimit);
      const rows = db.prepare(`
        SELECT
          inviter_user_id,
          MAX(inviter_username) AS inviter_username,
          COUNT(*) AS invite_count
        FROM invite_events
        WHERE guild_id = ?
          AND inviter_user_id IS NOT NULL
        ${wherePeriod}
        ${excludeSql}
        GROUP BY inviter_user_id
        ORDER BY invite_count DESC, inviter_user_id ASC
        LIMIT ?
      `).all(...queryParams);
      const knownNames = this._lookupKnownUsernames(rows.map(row => row.inviter_user_id));

      return {
        success: true,
        rows: rows.map((row, idx) => ({
          rank: idx + 1,
          inviterUserId: row.inviter_user_id,
          inviterUsername: this._pickDisplayName(
            row.inviter_username,
            knownNames.get(String(row.inviter_user_id || ''))
          ),
          inviteCount: Number(row.invite_count || 0),
          qualifiedInviteCount: Number(row.invite_count || 0),
          totalInviteCount: Number(row.invite_count || 0),
        })),
        limitedByPlan: periodPolicy.limitedByPlan,
        periodDays: periodPolicy.days,
        effectiveLimit: safeLimit,
        requiredJoinRoleId: null,
        includeVerificationStats: false,
        includeTokenStats: false,
        excludedCodes,
        sortBy: SORT_BY_INVITES,
      };
    }

    const eventRows = db.prepare(`
      SELECT
        joined_user_id,
        inviter_user_id,
        inviter_username,
        invite_code
      FROM invite_events
      WHERE guild_id = ?
        AND inviter_user_id IS NOT NULL
      ${wherePeriod}
      ORDER BY id DESC
    `).all(...params);

    const guild = this.client?.guilds?.cache?.get(normalizedGuildId) || await this.client?.guilds?.fetch?.(normalizedGuildId).catch(() => null);
    const eligibleJoined = await this._resolveEligibleJoinedUserIds(
      guild,
      eventRows.map(row => row.joined_user_id),
      effectiveRoleId
    );

    const counter = new Map();
    const totalCounter = new Map();
    const inviterJoinedSetMap = new Map();
    for (const row of eventRows) {
      const joinedUserId = normalizeUserId(row.joined_user_id);
      const inviterUserId = normalizeUserId(row.inviter_user_id);
      const inviteCode = normalizeInviteCode(row.invite_code || '');
      if (!joinedUserId || !inviterUserId) continue;
      if (inviteCode && excludedCodeSet.has(normalizeInviteCodeCompare(inviteCode))) continue;

      const totalEntry = totalCounter.get(inviterUserId) || { inviterUsername: null, inviteCount: 0 };
      totalEntry.inviteCount += 1;
      if (!totalEntry.inviterUsername && row.inviter_username) totalEntry.inviterUsername = row.inviter_username;
      totalCounter.set(inviterUserId, totalEntry);

      if (!eligibleJoined.has(joinedUserId)) continue;

      const key = inviterUserId;
      const existing = counter.get(key) || { inviterUsername: null, inviteCount: 0 };
      existing.inviteCount += 1;
      if (!existing.inviterUsername && row.inviter_username) existing.inviterUsername = row.inviter_username;
      counter.set(key, existing);

      const joinedSet = inviterJoinedSetMap.get(key) || new Set();
      joinedSet.add(joinedUserId);
      inviterJoinedSetMap.set(key, joinedSet);
    }

    const rows = await this._buildLeaderboardRowsFromCounter(counter, inviterJoinedSetMap, {
      totalInviteCounter: totalCounter,
      guildId: normalizedGuildId,
      includeVerificationStats: effectiveIncludeVerificationStats,
      includeTokenStats: effectiveIncludeTokenStats,
      sortBy: effectiveSortBy,
      limit: safeLimit,
    });
    const knownNames = this._lookupKnownUsernames(rows.map(row => row.inviterUserId));
    const hydratedRows = rows.map(row => ({
      ...row,
      inviterUsername: this._pickDisplayName(
        row.inviterUsername,
        knownNames.get(String(row.inviterUserId || ''))
      ),
    }));

    return {
      success: true,
      rows: hydratedRows,
      limitedByPlan: periodPolicy.limitedByPlan,
      periodDays: periodPolicy.days,
      effectiveLimit: safeLimit,
      requiredJoinRoleId: effectiveRoleId,
      includeVerificationStats: effectiveIncludeVerificationStats,
      includeTokenStats: effectiveIncludeTokenStats,
      excludedCodes,
      sortBy: effectiveSortBy,
    };
  }

  getInviterForUser(guildId, joinedUserId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedJoinedId = normalizeUserId(joinedUserId);
    if (!normalizedGuildId || !normalizedJoinedId) return { success: false, message: 'guildId and userId are required' };

    const row = db.prepare(`
      SELECT
        joined_user_id,
        joined_username,
        inviter_user_id,
        inviter_username,
        invite_code,
        source,
        joined_at
      FROM invite_events
      WHERE guild_id = ?
        AND joined_user_id = ?
      ORDER BY joined_at DESC, id DESC
      LIMIT 1
    `).get(normalizedGuildId, normalizedJoinedId);

    if (!row) return { success: true, record: null };

    return {
      success: true,
      record: {
        joinedUserId: row.joined_user_id,
        joinedUsername: row.joined_username || null,
        inviterUserId: row.inviter_user_id || null,
        inviterUsername: row.inviter_username || null,
        inviteCode: row.invite_code || null,
        source: row.source || 'unknown',
        joinedAt: row.joined_at,
      },
    };
  }

  async exportCsv(guildId, { days = null } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    if (!this._canExport(normalizedGuildId)) {
      return { success: false, code: 'plan_restricted', message: 'CSV export is available on paid plans.' };
    }

    const eventsResult = this.listEvents(normalizedGuildId, { limit: 5000, days });
    if (!eventsResult.success) return eventsResult;

    const header = [
      'joined_at',
      'joined_user_id',
      'joined_username',
      'inviter_user_id',
      'inviter_username',
      'invite_code',
      'source',
    ];

    const lines = [header.join(',')];
    for (const row of eventsResult.events) {
      lines.push([
        csvEscape(row.joinedAt || ''),
        csvEscape(row.joinedUserId || ''),
        csvEscape(row.joinedUsername || ''),
        csvEscape(row.inviterUserId || ''),
        csvEscape(row.inviterUsername || ''),
        csvEscape(row.inviteCode || ''),
        csvEscape(row.source || ''),
      ].join(','));
    }

    return {
      success: true,
      csv: lines.join('\n'),
      filename: `invite-tracker-${normalizedGuildId}-${new Date().toISOString().slice(0, 10)}.csv`,
      limitedByPlan: eventsResult.limitedByPlan,
      periodDays: eventsResult.periodDays,
    };
  }

  async buildLeaderboardPanelEmbed(guildId, options = {}) {
    const settingsResult = this.getSettings(guildId);
    const settings = settingsResult.success ? settingsResult.settings : this._getDefaultSettings();
    const effectiveDays = options.days !== undefined ? options.days : settings.panelPeriodDays;
    const effectiveLimit = options.limit !== undefined ? options.limit : settings.panelLimit;
    const requiredJoinRoleId = options.requiredJoinRoleId !== undefined ? options.requiredJoinRoleId : settings.requiredJoinRoleId;
    const includeVerificationStats = options.includeVerificationStats !== undefined ? !!options.includeVerificationStats : !!settings.includeVerificationStats;
    const sortBy = options.sortBy !== undefined ? options.sortBy : settings.panelSortBy;
    const boardResult = await this.getLeaderboard(guildId, {
      days: effectiveDays,
      limit: effectiveLimit,
      requiredJoinRoleId,
      includeVerificationStats,
      sortBy,
    });
    if (!boardResult.success) return boardResult;
    const inviterDisplayMap = await this._resolveLeaderboardDisplayNames(guildId, boardResult.rows || []);

    const lines = (boardResult.rows || []).length > 0
      ? boardResult.rows.map(row => {
          const inviter = this._formatLeaderboardInviterLabel(row, inviterDisplayMap);
          const totalInvites = Number(row.totalInviteCount ?? row.inviteCount ?? 0);
          const qualifiedInvites = Number(row.qualifiedInviteCount ?? row.inviteCount ?? 0);
          if (boardResult.includeVerificationStats) {
            if (boardResult.includeTokenStats) {
              return `**#${row.rank}** ${inviter} | Total: **${totalInvites}** | Qualified: **${qualifiedInvites}** | NFTs: **${Number(row.inviteeNftsTotal || 0)}** | Tokens: **${Number(row.inviteeTokensTotal || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}**`;
            }
            return `**#${row.rank}** ${inviter} | Total: **${totalInvites}** | Qualified: **${qualifiedInvites}** | NFTs: **${Number(row.inviteeNftsTotal || 0)}**`;
          }
          return `**#${row.rank}** ${inviter} | Total: **${totalInvites}** | Qualified: **${qualifiedInvites}**`;
        }).join('\n')
      : 'No invite data yet.';

    const embed = new EmbedBuilder()
      .setTitle('Invite Leaderboard')
      .setDescription(lines)
      .setTimestamp();

    applyEmbedBranding(embed, {
      guildId: normalizeGuildId(guildId),
      moduleKey: 'invites',
      defaultColor: '#22C55E',
      defaultFooter: 'Powered by Guild Pilot',
      fallbackLogoUrl: this.client?.user?.displayAvatarURL?.() || null,
    });

    const components = [];
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(REFRESH_BUTTON_ID)
          .setLabel('Refresh')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`${SORT_BUTTON_PREFIX}${SORT_BY_INVITES}`)
          .setLabel('Sort: Invites')
          .setStyle(boardResult.sortBy === SORT_BY_INVITES ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`${SORT_BUTTON_PREFIX}${SORT_BY_NFTS}`)
          .setLabel('Sort: NFTs')
          .setStyle(boardResult.sortBy === SORT_BY_NFTS ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(!boardResult.includeVerificationStats),
        new ButtonBuilder()
          .setCustomId(`${SORT_BUTTON_PREFIX}${SORT_BY_TOKENS}`)
          .setLabel('Sort: Tokens')
          .setStyle(boardResult.sortBy === SORT_BY_TOKENS ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(!boardResult.includeTokenStats)
      )
    );

    const settingsEnableCreateLink = options.enableCreateLink !== undefined
      ? !!options.enableCreateLink
      : !!settings.panelEnableCreateLink;
    if (settingsEnableCreateLink) {
      components.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(CREATE_LINK_BUTTON_ID)
            .setLabel('Create My Invite Link')
            .setStyle(ButtonStyle.Success)
        )
      );
    }

    return {
      success: true,
      embed,
      components,
      metadata: {
        periodDays: boardResult.periodDays,
        effectiveLimit: boardResult.effectiveLimit,
        requiredJoinRoleId: boardResult.requiredJoinRoleId || null,
        includeVerificationStats: !!boardResult.includeVerificationStats,
        includeTokenStats: !!boardResult.includeTokenStats,
        excludedCodes: Array.isArray(boardResult.excludedCodes) ? boardResult.excludedCodes : [],
        sortBy: normalizePanelSortBy(boardResult.sortBy),
      },
    };
  }

  async postOrUpdateLeaderboardPanel(guildId, channelId = null, options = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedChannelId = normalizeChannelId(channelId || '');
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    if (!this.client) return { success: false, message: 'Discord client is not ready' };

    const settingsResult = this.getSettings(normalizedGuildId);
    const settings = settingsResult.success ? settingsResult.settings : this._getDefaultSettings();
    const targetChannelId = normalizedChannelId || settings.panelChannelId;
    if (!targetChannelId) {
      return { success: false, message: 'No panel channel configured for invite leaderboard' };
    }

    const guild = this.client.guilds.cache.get(normalizedGuildId) || await this.client.guilds.fetch(normalizedGuildId).catch(() => null);
    if (!guild) return { success: false, message: 'Guild not found on bot client' };

    const channel = guild.channels.cache.get(targetChannelId) || await guild.channels.fetch(targetChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return { success: false, message: 'Channel not found or not text-based' };
    if ([ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) {
      return { success: false, message: 'Cannot post panel to voice/stage channels' };
    }

    const panelResult = await this.buildLeaderboardPanelEmbed(normalizedGuildId, options);
    if (!panelResult.success) return panelResult;

    let postedMessage = null;
    let action = 'posted';
    if (settings.panelMessageId && settings.panelChannelId === targetChannelId) {
      try {
        const existing = await channel.messages.fetch(settings.panelMessageId);
        if (existing) {
          postedMessage = await existing.edit({
            embeds: [panelResult.embed],
            components: panelResult.components,
          });
          action = 'updated';
        }
      } catch (_error) {
        postedMessage = null;
      }
    }

    if (!postedMessage) {
      postedMessage = await channel.send({
        embeds: [panelResult.embed],
        components: panelResult.components,
      });
      action = 'posted';
    }

    this.saveSettings(normalizedGuildId, {
      panelChannelId: targetChannelId,
      panelMessageId: postedMessage?.id || null,
    });

    return {
      success: true,
      action,
      channelId: targetChannelId,
      messageId: postedMessage?.id || null,
      metadata: panelResult.metadata || {},
    };
  }

  queuePanelRefresh(guildId, delayMs = 3000) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return;

    if (this.panelRefreshTimers.has(normalizedGuildId)) return;
    const timer = setTimeout(async () => {
      this.panelRefreshTimers.delete(normalizedGuildId);
      try {
        const settingsResult = this.getSettings(normalizedGuildId);
        if (!settingsResult.success || !settingsResult.settings.panelChannelId) return;
        await this.postOrUpdateLeaderboardPanel(normalizedGuildId, settingsResult.settings.panelChannelId);
      } catch (error) {
        logger.warn(`[invite-tracker] panel refresh failed for guild ${normalizedGuildId}: ${error?.message || error}`);
      }
    }, Math.max(500, Number(delayMs) || 3000));

    this.panelRefreshTimers.set(normalizedGuildId, timer);
  }

  async createUserInviteLink(interaction) {
    const guildId = normalizeGuildId(interaction?.guildId);
    if (!guildId) return { success: false, message: 'Guild context required' };
    if (!this.isModuleEnabled(guildId)) return { success: false, message: 'Invite tracker module is disabled here' };

    const channel = interaction?.channel;
    if (!channel || !channel.isTextBased()) return { success: false, message: 'This button can only be used in a server text channel.' };
    if (typeof channel.createInvite !== 'function') {
      return { success: false, message: 'Invite links can only be created from standard server channels.' };
    }

    const guild = interaction.guild;
    const me = guild?.members?.me || await guild?.members?.fetchMe?.().catch(() => null);
    const canCreateInvite = !!channel.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite);
    if (!canCreateInvite) {
      return { success: false, message: 'I need the "Create Invite" permission in this channel.' };
    }

    const existingCode = this._getActiveOwnedInviteCodeForUser(guildId, interaction.user?.id || null);
    if (existingCode) {
      const fallbackUrl = `https://discord.gg/${existingCode}`;
      try {
        const existingInvite = await interaction.guild?.invites?.fetch?.({ code: existingCode });
        if (existingInvite?.code) {
          return {
            success: true,
            inviteUrl: existingInvite.url || `https://discord.gg/${existingInvite.code}`,
            inviteCode: existingInvite.code,
          };
        }
      } catch (fetchError) {
        const errorCode = Number(fetchError?.code || fetchError?.rawError?.code || 0);
        const statusCode = Number(fetchError?.status || fetchError?.rawError?.status || 0);
        const permissionScopedError = errorCode === 50013 || errorCode === 50001 || statusCode === 403;
        const unknownInvite = errorCode === 10006 || statusCode === 404;

        if (permissionScopedError) {
          return {
            success: true,
            inviteUrl: fallbackUrl,
            inviteCode: existingCode,
          };
        }
        if (!unknownInvite) {
          logger.warn(`[invite-tracker] could not validate existing invite for guild ${guildId}: ${fetchError?.message || fetchError}`);
          return {
            success: true,
            inviteUrl: fallbackUrl,
            inviteCode: existingCode,
          };
        }
        this._deactivateOwnedInviteCode(guildId, existingCode);
      }
    }

    const invite = await channel.createInvite({
      maxAge: 0,
      maxUses: 0,
      temporary: false,
      unique: true,
      reason: `Invite Tracker panel link requested by ${interaction.user?.tag || interaction.user?.id || 'unknown user'}`,
    });

    this._saveOwnedInviteCode({
      guildId,
      inviteCode: invite?.code || null,
      ownerUserId: interaction.user?.id || null,
      ownerUsername: interaction.user?.username || interaction.user?.globalName || null,
      channelId: channel.id,
    });

    return {
      success: true,
      inviteUrl: invite?.url || `https://discord.gg/${invite.code}`,
      inviteCode: invite?.code || null,
    };
  }

  async handlePanelInteraction(interaction) {
    const guildId = normalizeGuildId(interaction?.guildId);
    if (!guildId) return { success: false, message: 'Guild context required.' };
    const customId = String(interaction?.customId || '').trim();

    const isSortAction = customId.startsWith(SORT_BUTTON_PREFIX);
    const isRefreshAction = customId === REFRESH_BUTTON_ID;

    if (!isSortAction && !isRefreshAction) {
      return { success: false, message: 'Unsupported invite leaderboard action.' };
    }

    const settingsResult = this.getSettings(guildId);
    const settings = settingsResult.success ? settingsResult.settings : this._getDefaultSettings();

    let nextSortBy = settings.panelSortBy;
    if (isSortAction) {
      nextSortBy = normalizePanelSortBy(customId.slice(SORT_BUTTON_PREFIX.length));
    }

    const includeVerificationStats = !!settings.includeVerificationStats;
    const includeTokenStats = includeVerificationStats && this._tenantHasEnabledTokenVerificationRules(guildId);

    // Validate sort mode against available data
    if (nextSortBy === SORT_BY_NFTS && !includeVerificationStats) nextSortBy = SORT_BY_INVITES;
    if (nextSortBy === SORT_BY_TOKENS && !includeTokenStats) nextSortBy = includeVerificationStats ? SORT_BY_NFTS : SORT_BY_INVITES;

    if (isSortAction) {
      this.saveSettings(guildId, {
        panelSortBy: nextSortBy,
        panelChannelId: interaction?.channelId || settings.panelChannelId || null,
        panelMessageId: interaction?.message?.id || settings.panelMessageId || null,
      });
    }

    const panelResult = await this.buildLeaderboardPanelEmbed(guildId, {
      days: settings.panelPeriodDays,
      limit: settings.panelLimit,
      requiredJoinRoleId: settings.requiredJoinRoleId,
      includeVerificationStats,
      enableCreateLink: settings.panelEnableCreateLink,
      sortBy: nextSortBy,
    });

    if (!panelResult.success) {
      return { success: false, message: panelResult.message || 'Could not refresh invite leaderboard panel.' };
    }

    await interaction.update({
      embeds: [panelResult.embed],
      components: panelResult.components,
    });

    return {
      success: true,
      action: isRefreshAction ? 'refresh' : 'sort',
      sortBy: normalizePanelSortBy(panelResult.metadata?.sortBy || nextSortBy),
    };
  }
}

const inviteTrackerService = new InviteTrackerService();
inviteTrackerService.CREATE_LINK_BUTTON_ID = CREATE_LINK_BUTTON_ID;
inviteTrackerService.REFRESH_BUTTON_ID = REFRESH_BUTTON_ID;
inviteTrackerService.SORT_BUTTON_PREFIX = SORT_BUTTON_PREFIX;

module.exports = inviteTrackerService;
module.exports.CREATE_LINK_BUTTON_ID = CREATE_LINK_BUTTON_ID;
module.exports.REFRESH_BUTTON_ID = REFRESH_BUTTON_ID;
module.exports.SORT_BUTTON_PREFIX = SORT_BUTTON_PREFIX;

