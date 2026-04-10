const db = require('../database/db');
const logger = require('../utils/logger');
const entitlementService = require('./entitlementService');
const tenantService = require('./tenantService');

function normalizeGuildId(guildId) {
  const normalized = String(guildId || '').trim();
  return /^\d{17,20}$/.test(normalized) ? normalized : '';
}

function normalizeUserId(userId) {
  const normalized = String(userId || '').trim();
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

class InviteTrackerService {
  constructor() {
    this.client = null;
    this.inviteCache = new Map();
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

    // Prevent accidental duplicate inserts for the same join event burst.
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

    return {
      success: true,
      summary: {
        totalJoins: Number(totals?.total_joins || 0),
        resolvedJoins: Number(totals?.resolved_joins || 0),
        unknownJoins: Number(totals?.unknown_joins || 0),
        uniqueInviters: Number(uniqueInviters?.inviter_count || 0),
        canExport: this._canExport(normalizedGuildId),
        maxLeaderboardRows: this._getLeaderboardLimit(normalizedGuildId, 9999),
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

  getLeaderboard(guildId, { limit = 10, days = null } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };

    const safeLimit = this._getLeaderboardLimit(normalizedGuildId, limit);
    const periodPolicy = this._getInvitePeriodPolicy(normalizedGuildId, days);
    const wherePeriod = periodPolicy.days ? `AND joined_at >= datetime('now', ?)` : '';
    const params = [normalizedGuildId];
    if (periodPolicy.days) params.push(`-${periodPolicy.days} days`);
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

    if (!row) {
      return { success: true, record: null };
    }

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

  exportCsv(guildId, { days = null } = {}) {
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
}

module.exports = new InviteTrackerService();
