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
const { applyEmbedBranding } = require('./embedBranding');

const CREATE_LINK_BUTTON_ID = 'invite_tracker_create_link';

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

class InviteTrackerService {
  constructor() {
    this.client = null;
    this.inviteCache = new Map();
    this.panelRefreshTimers = new Map();
  }

  setClient(client) {
    this.client = client;
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
        include_verification_stats
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
        panelPeriodDays: Number.isFinite(Number(row.panel_period_days)) ? clampInt(row.panel_period_days, 1, 3650, null) : null,
        panelLimit: clampInt(row.panel_limit, 1, 100, defaults.panelLimit),
        panelEnableCreateLink: Number(row.panel_enable_create_link || 0) === 1,
        includeVerificationStats: Number(row.include_verification_stats || 0) === 1,
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
        ? (payload.panelPeriodDays === null || payload.panelPeriodDays === '' ? null : clampInt(payload.panelPeriodDays, 1, 3650, null))
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
    };

    db.prepare(`
      INSERT INTO invite_tracker_settings (
        guild_id, required_join_role_id, panel_channel_id, panel_message_id,
        panel_period_days, panel_limit, panel_enable_create_link, include_verification_stats,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id) DO UPDATE SET
        required_join_role_id = excluded.required_join_role_id,
        panel_channel_id = excluded.panel_channel_id,
        panel_message_id = excluded.panel_message_id,
        panel_period_days = excluded.panel_period_days,
        panel_limit = excluded.panel_limit,
        panel_enable_create_link = excluded.panel_enable_create_link,
        include_verification_stats = excluded.include_verification_stats,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      normalizedGuildId,
      merged.requiredJoinRoleId,
      merged.panelChannelId,
      merged.panelMessageId,
      merged.panelPeriodDays,
      merged.panelLimit,
      merged.panelEnableCreateLink ? 1 : 0,
      merged.includeVerificationStats ? 1 : 0
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

    const recentDupe = db.prepare(`
      SELECT id
      FROM invite_events
      WHERE guild_id = ?
        AND joined_user_id = ?
        AND joined_at >= datetime('now', '-30 seconds')
      ORDER BY id DESC
      LIMIT 1
    `).get(normalizedGuildId, normalizedJoinedId);
    if (recentDupe?.id) {
      return { success: true, duplicate: true };
    }

    db.prepare(`
      INSERT INTO invite_events (
        guild_id, joined_user_id, joined_username,
        inviter_user_id, inviter_username,
        invite_code, source
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizedGuildId,
      normalizedJoinedId,
      joinedUsername ? String(joinedUsername).slice(0, 128) : null,
      normalizeUserId(inviterUserId || '') || null,
      inviterUsername ? String(inviterUsername).slice(0, 128) : null,
      inviteCode ? String(inviteCode).slice(0, 64) : null,
      String(source || 'invite').slice(0, 32)
    );

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

    const result = this._recordInviteEvent({
      guildId,
      joinedUserId: member.id,
      joinedUsername: member.user?.username || member.user?.globalName || null,
      inviterUserId: matched?.inviterId || null,
      inviterUsername: matched?.inviterUsername || null,
      inviteCode: matched?.code || null,
      source: matched?.code ? 'invite' : 'unknown',
    });

    if (!result.success) return result;
    return {
      success: true,
      inviterUserId: matched?.inviterId || null,
      inviteCode: matched?.code || null,
      source: matched?.code ? 'invite' : 'unknown',
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

    return {
      success: true,
      events: rows.map(row => ({
        id: row.id,
        joinedUserId: row.joined_user_id,
        joinedUsername: row.joined_username || null,
        inviterUserId: row.inviter_user_id || null,
        inviterUsername: row.inviter_username || null,
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

  _lookupUserNftTotals(userIds) {
    const normalized = Array.from(new Set((userIds || []).map(normalizeUserId).filter(Boolean)));
    if (normalized.length === 0) return new Map();

    const result = new Map();
    for (const chunk of chunkArray(normalized, 400)) {
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT discord_id, total_nfts
        FROM users
        WHERE discord_id IN (${placeholders})
      `).all(...chunk);
      for (const row of rows) {
        result.set(String(row.discord_id), Math.max(0, Number(row.total_nfts || 0)));
      }
    }
    return result;
  }

  _buildLeaderboardRowsFromCounter(counter, inviterJoinedSetMap, { includeVerificationStats = false, limit = 10 } = {}) {
    const inviters = Array.from(counter.entries())
      .map(([inviterUserId, value]) => ({
        inviterUserId,
        inviterUsername: value.inviterUsername || null,
        inviteCount: Number(value.inviteCount || 0),
      }))
      .sort((a, b) => b.inviteCount - a.inviteCount || a.inviterUserId.localeCompare(b.inviterUserId))
      .slice(0, Math.max(1, Number(limit) || 10));

    if (!includeVerificationStats) {
      return inviters.map((row, idx) => ({
        ...row,
        rank: idx + 1,
      }));
    }

    const allJoinedUsers = [];
    for (const row of inviters) {
      const joinedSet = inviterJoinedSetMap.get(row.inviterUserId) || new Set();
      for (const userId of joinedSet) allJoinedUsers.push(userId);
    }
    const nftTotals = this._lookupUserNftTotals(allJoinedUsers);

    return inviters.map((row, idx) => {
      const joinedSet = inviterJoinedSetMap.get(row.inviterUserId) || new Set();
      let inviteeNftsTotal = 0;
      let inviteesWithNfts = 0;
      for (const joinedUserId of joinedSet) {
        const nfts = Math.max(0, Number(nftTotals.get(joinedUserId) || 0));
        inviteeNftsTotal += nfts;
        if (nfts > 0) inviteesWithNfts += 1;
      }
      const inviteesCount = joinedSet.size;
      const inviteeNftsAverage = inviteesCount > 0 ? Number((inviteeNftsTotal / inviteesCount).toFixed(2)) : 0;

      return {
        ...row,
        rank: idx + 1,
        inviteesCount,
        inviteesWithNfts,
        inviteeNftsTotal,
        inviteeNftsAverage,
      };
    });
  }

  async getLeaderboard(guildId, { limit = 10, days = null, requiredJoinRoleId = undefined, includeVerificationStats = undefined } = {}) {
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

    const safeLimit = this._getLeaderboardLimit(normalizedGuildId, limit);
    const periodPolicy = this._getInvitePeriodPolicy(normalizedGuildId, days);
    const wherePeriod = periodPolicy.days ? `AND joined_at >= datetime('now', ?)` : '';
    const params = [normalizedGuildId];
    if (periodPolicy.days) params.push(`-${periodPolicy.days} days`);

    if (!effectiveRoleId && !effectiveIncludeVerificationStats) {
      params.push(safeLimit);
      const rows = db.prepare(`
        SELECT
          inviter_user_id,
          MAX(inviter_username) AS inviter_username,
          COUNT(*) AS invite_count
        FROM invite_events
        WHERE guild_id = ?
          AND inviter_user_id IS NOT NULL
        ${wherePeriod}
        GROUP BY inviter_user_id
        ORDER BY invite_count DESC, inviter_user_id ASC
        LIMIT ?
      `).all(...params);

      return {
        success: true,
        rows: rows.map((row, idx) => ({
          rank: idx + 1,
          inviterUserId: row.inviter_user_id,
          inviterUsername: row.inviter_username || null,
          inviteCount: Number(row.invite_count || 0),
        })),
        limitedByPlan: periodPolicy.limitedByPlan,
        periodDays: periodPolicy.days,
        effectiveLimit: safeLimit,
        requiredJoinRoleId: null,
        includeVerificationStats: false,
      };
    }

    const eventRows = db.prepare(`
      SELECT
        joined_user_id,
        inviter_user_id,
        inviter_username
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
    const inviterJoinedSetMap = new Map();
    for (const row of eventRows) {
      const joinedUserId = normalizeUserId(row.joined_user_id);
      const inviterUserId = normalizeUserId(row.inviter_user_id);
      if (!joinedUserId || !inviterUserId) continue;
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

    const rows = this._buildLeaderboardRowsFromCounter(counter, inviterJoinedSetMap, {
      includeVerificationStats: effectiveIncludeVerificationStats,
      limit: safeLimit,
    });

    return {
      success: true,
      rows,
      limitedByPlan: periodPolicy.limitedByPlan,
      periodDays: periodPolicy.days,
      effectiveLimit: safeLimit,
      requiredJoinRoleId: effectiveRoleId,
      includeVerificationStats: effectiveIncludeVerificationStats,
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
    const boardResult = await this.getLeaderboard(guildId, {
      days: effectiveDays,
      limit: effectiveLimit,
      requiredJoinRoleId,
      includeVerificationStats,
    });
    if (!boardResult.success) return boardResult;

    const periodLabel = boardResult.periodDays ? `Last ${boardResult.periodDays} days` : 'All-time';
    const roleFilterText = boardResult.requiredJoinRoleId ? `<@&${boardResult.requiredJoinRoleId}>` : 'None';
    const lines = (boardResult.rows || []).length > 0
      ? boardResult.rows.map(row => {
          const inviter = row.inviterUserId ? `<@${row.inviterUserId}>` : (row.inviterUsername || 'Unknown');
          if (boardResult.includeVerificationStats) {
            return `**#${row.rank}** ${inviter} - **${row.inviteCount}** invites | NFT total: **${Number(row.inviteeNftsTotal || 0)}**`;
          }
          return `**#${row.rank}** ${inviter} - **${row.inviteCount}**`;
        }).join('\n')
      : 'No invite data yet.';

    const embed = new EmbedBuilder()
      .setTitle('Invite Leaderboard')
      .setDescription(lines)
      .addFields(
        { name: 'Period', value: periodLabel, inline: true },
        { name: 'Counted Rows', value: String((boardResult.rows || []).length), inline: true },
        { name: 'Required Join Role', value: roleFilterText, inline: true },
        { name: 'Verification NFT Stats', value: boardResult.includeVerificationStats ? 'Enabled' : 'Disabled', inline: true },
      )
      .setTimestamp();

    applyEmbedBranding(embed, {
      guildId: normalizeGuildId(guildId),
      moduleKey: 'invites',
      defaultColor: '#22C55E',
      defaultFooter: 'Powered by Guild Pilot',
      fallbackLogoUrl: this.client?.user?.displayAvatarURL?.() || null,
    });

    const components = [];
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
            .setEmoji('🔗')
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

    const invite = await channel.createInvite({
      maxAge: 0,
      maxUses: 0,
      temporary: false,
      unique: false,
      reason: `Invite Tracker panel link requested by ${interaction.user?.tag || interaction.user?.id || 'unknown user'}`,
    });

    return {
      success: true,
      inviteUrl: invite?.url || `https://discord.gg/${invite.code}`,
      inviteCode: invite?.code || null,
    };
  }
}

const inviteTrackerService = new InviteTrackerService();
inviteTrackerService.CREATE_LINK_BUTTON_ID = CREATE_LINK_BUTTON_ID;

module.exports = inviteTrackerService;
module.exports.CREATE_LINK_BUTTON_ID = CREATE_LINK_BUTTON_ID;
