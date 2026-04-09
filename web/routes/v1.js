/**
 * Public API v1 Routes
 * 
 * Versioned, standardized API endpoints for external integrations
 * All responses follow the standard envelope format
 */

const express = require('express');
const router = express.Router();
const db = require('../../database/db');
const treasuryService = require('../../services/treasuryService');
const nftActivityService = require('../../services/nftActivityService');
const tenantService = require('../../services/tenantService');
const { success, error, sanitize, redactWallet } = require('../../utils/apiResponse');
const { asyncHandler, notFoundError, validationError } = require('../../utils/apiErrorHandler');

function normalizeGuildId(guildId) {
  if (typeof guildId !== 'string') return '';
  const trimmed = guildId.trim();
  return /^\d{17,20}$/.test(trimmed) ? trimmed : '';
}

function getRequestedGuildId(req) {
  const queryGuildId = normalizeGuildId(String(req.query?.guildId || req.query?.guild || '').trim());
  if (queryGuildId) return queryGuildId;

  const headerGuildId = normalizeGuildId(String(req.get('x-guild-id') || '').trim());
  if (headerGuildId) return headerGuildId;

  const scopedGuildId = normalizeGuildId(String(req.guildId || '').trim());
  if (scopedGuildId) return scopedGuildId;

  return '';
}

let _hasProposalsGuildColumnCache = null;
function hasProposalsGuildColumn() {
  if (_hasProposalsGuildColumnCache !== null) return _hasProposalsGuildColumnCache;
  try {
    const columns = db.prepare('PRAGMA table_info(proposals)').all();
    _hasProposalsGuildColumnCache = columns.some(column => String(column?.name || '').toLowerCase() === 'guild_id');
  } catch (_error) {
    _hasProposalsGuildColumnCache = false;
  }
  return _hasProposalsGuildColumnCache;
}

let _hasMissionsGuildColumnCache = null;
function hasMissionsGuildColumn() {
  if (_hasMissionsGuildColumnCache !== null) return _hasMissionsGuildColumnCache;
  try {
    const columns = db.prepare('PRAGMA table_info(missions)').all();
    _hasMissionsGuildColumnCache = columns.some(column => String(column?.name || '').toLowerCase() === 'guild_id');
  } catch (_error) {
    _hasMissionsGuildColumnCache = false;
  }
  return _hasMissionsGuildColumnCache;
}

function resolvePublicGovernanceScope(req) {
  const guildId = getRequestedGuildId(req);
  const multiTenantEnabled = tenantService.isMultitenantEnabled();

  if (multiTenantEnabled && !hasProposalsGuildColumn()) {
    validationError('governance schema is not tenant-scoped; run database migrations');
  }

  if (multiTenantEnabled && !guildId) {
    validationError('guildId query parameter (or x-guild-id header) is required in multi-tenant mode');
  }

  return guildId;
}

function resolvePublicScope(req, { requireInMultitenant = true, tableHasGuildColumn = false } = {}) {
  const guildId = getRequestedGuildId(req);
  const multiTenantEnabled = tenantService.isMultitenantEnabled();
  if (requireInMultitenant && multiTenantEnabled && !tableHasGuildColumn) {
    validationError('tenant-scoped schema is required in multi-tenant mode; run database migrations');
  }
  if (requireInMultitenant && multiTenantEnabled && !guildId) {
    validationError('guildId query parameter (or x-guild-id header) is required in multi-tenant mode');
  }
  return guildId;
}

// ==================== GOVERNANCE ENDPOINTS ====================

/**
 * GET /api/public/v1/proposals/active
 * Returns all active proposals
 */
router.get('/proposals/active', asyncHandler(async (req, res) => {
  const guildId = resolvePublicGovernanceScope(req);
  const proposals = (hasProposalsGuildColumn() && guildId)
    ? db.prepare('SELECT * FROM proposals WHERE guild_id = ? AND status = ? ORDER BY created_at DESC').all(guildId, 'voting')
    : db.prepare('SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC').all('voting');
  
  const enrichedProposals = proposals.map(p => {
    const votes = {
      yes: { 
        vp: p.yes_vp, 
        count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(p.proposal_id, 'yes').c 
      },
      no: { 
        vp: p.no_vp, 
        count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(p.proposal_id, 'no').c 
      },
      abstain: { 
        vp: p.abstain_vp, 
        count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(p.proposal_id, 'abstain').c 
      }
    };

    const totalVoted = p.yes_vp + p.no_vp + p.abstain_vp;
    const quorumPercentage = p.total_vp > 0 ? Math.round((totalVoted / p.total_vp) * 100) : 0;

    // Sanitize: Don't expose internal creator_id raw, use a redacted format
    return {
      proposalId: p.proposal_id,
      title: p.title,
      description: p.description,
      status: p.status,
      creatorId: redactWallet(p.creator_id), // Redact Discord ID for privacy
      votes,
      quorum: {
        required: p.quorum_threshold,
        current: quorumPercentage
      },
      deadline: p.end_time,
      createdAt: p.created_at
    };
  });

  res.json(success(
    { proposals: enrichedProposals },
    { count: enrichedProposals.length, guildId: guildId || null }
  ));
}));

/**
 * GET /api/public/v1/proposals/concluded
 * Returns concluded proposals (passed, rejected, quorum_not_met)
 */
router.get('/proposals/concluded', asyncHandler(async (req, res) => {
  const guildId = resolvePublicGovernanceScope(req);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const proposals = (hasProposalsGuildColumn() && guildId)
    ? db.prepare(
      'SELECT * FROM proposals WHERE guild_id = ? AND status IN (?, ?, ?) ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(guildId, 'passed', 'rejected', 'quorum_not_met', limit, offset)
    : db.prepare(
      'SELECT * FROM proposals WHERE status IN (?, ?, ?) ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all('passed', 'rejected', 'quorum_not_met', limit, offset);

  const totalCount = (hasProposalsGuildColumn() && guildId)
    ? db.prepare(
      'SELECT COUNT(*) as count FROM proposals WHERE guild_id = ? AND status IN (?, ?, ?)'
    ).get(guildId, 'passed', 'rejected', 'quorum_not_met').count
    : db.prepare(
      'SELECT COUNT(*) as count FROM proposals WHERE status IN (?, ?, ?)'
    ).get('passed', 'rejected', 'quorum_not_met').count;

  const enrichedProposals = proposals.map(p => {
    const votes = {
      yes: { 
        vp: p.yes_vp, 
        count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(p.proposal_id, 'yes').c 
      },
      no: { 
        vp: p.no_vp, 
        count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(p.proposal_id, 'no').c 
      },
      abstain: { 
        vp: p.abstain_vp, 
        count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(p.proposal_id, 'abstain').c 
      }
    };

    const totalVoted = p.yes_vp + p.no_vp + p.abstain_vp;
    const quorumPercentage = p.total_vp > 0 ? Math.round((totalVoted / p.total_vp) * 100) : 0;

    return {
      proposalId: p.proposal_id,
      title: p.title,
      description: p.description,
      status: p.status,
      creatorId: redactWallet(p.creator_id),
      votes,
      quorum: {
        required: p.quorum_threshold,
        current: quorumPercentage
      },
      startTime: p.start_time,
      endTime: p.end_time,
      createdAt: p.created_at
    };
  });

  res.json(success(
    { proposals: enrichedProposals },
    { 
      count: enrichedProposals.length,
      total: totalCount,
      limit,
      offset,
      guildId: guildId || null
    }
  ));
}));

/**
 * GET /api/public/v1/proposals/:id
 * Returns detailed proposal information
 */
router.get('/proposals/:id', asyncHandler(async (req, res) => {
  const guildId = resolvePublicGovernanceScope(req);
  const { id } = req.params;
  const proposal = (hasProposalsGuildColumn() && guildId)
    ? db.prepare('SELECT * FROM proposals WHERE proposal_id = ? AND guild_id = ?').get(id, guildId)
    : db.prepare('SELECT * FROM proposals WHERE proposal_id = ?').get(id);
  
  if (!proposal) {
    notFoundError('Proposal');
  }

  const votes = {
    yes: { 
      vp: proposal.yes_vp, 
      count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(id, 'yes').c 
    },
    no: { 
      vp: proposal.no_vp, 
      count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(id, 'no').c 
    },
    abstain: { 
      vp: proposal.abstain_vp, 
      count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(id, 'abstain').c 
    }
  };

  const totalVoted = proposal.yes_vp + proposal.no_vp + proposal.abstain_vp;
  const quorumPercentage = proposal.total_vp > 0 ? Math.round((totalVoted / proposal.total_vp) * 100) : 0;

  const proposalData = {
    proposalId: proposal.proposal_id,
    title: proposal.title,
    description: proposal.description,
    status: proposal.status,
    creatorId: redactWallet(proposal.creator_id),
    votes,
    quorum: {
      required: proposal.quorum_threshold,
      current: quorumPercentage
    },
    startTime: proposal.start_time,
    endTime: proposal.end_time,
    createdAt: proposal.created_at
  };

  res.json(success({ proposal: proposalData }));
}));

/**
 * GET /api/public/v1/stats
 * Returns governance statistics
 */
router.get('/stats', asyncHandler(async (req, res) => {
  const guildId = resolvePublicGovernanceScope(req);

  const totalProposals = (hasProposalsGuildColumn() && guildId)
    ? db.prepare('SELECT COUNT(*) as count FROM proposals WHERE guild_id = ?').get(guildId).count
    : db.prepare('SELECT COUNT(*) as count FROM proposals').get().count;

  const passedProposals = (hasProposalsGuildColumn() && guildId)
    ? db.prepare('SELECT COUNT(*) as count FROM proposals WHERE guild_id = ? AND status = ?').get(guildId, 'passed').count
    : db.prepare('SELECT COUNT(*) as count FROM proposals WHERE status = ?').get('passed').count;

  const totalVotes = (hasProposalsGuildColumn() && guildId)
    ? db.prepare(`
      SELECT COUNT(*) as count
      FROM votes v
      INNER JOIN proposals p ON p.proposal_id = v.proposal_id
      WHERE p.guild_id = ?
    `).get(guildId).count
    : db.prepare('SELECT COUNT(*) as count FROM votes').get().count;

  const totalVP = (hasProposalsGuildColumn() && guildId)
    ? db.prepare(`
      SELECT COALESCE(SUM(v.voting_power), 0) as total
      FROM votes v
      INNER JOIN proposals p ON p.proposal_id = v.proposal_id
      WHERE p.guild_id = ?
    `).get(guildId).total
    : db.prepare('SELECT COALESCE(SUM(voting_power), 0) as total FROM votes').get().total;

  const activeVoters = (hasProposalsGuildColumn() && guildId)
    ? db.prepare(`
      SELECT COUNT(DISTINCT v.voter_id) as count
      FROM votes v
      INNER JOIN proposals p ON p.proposal_id = v.proposal_id
      WHERE p.guild_id = ?
    `).get(guildId).count
    : db.prepare('SELECT COUNT(DISTINCT voter_id) as count FROM votes').get().count;

  const passRate = totalProposals > 0 ? Math.round((passedProposals / totalProposals) * 100) : 0;

  res.json(success({
    stats: {
      totalProposals,
      passedProposals,
      passRate,
      totalVotes,
      totalVPUsed: totalVP,
      activeVoters,
      guildId: guildId || null
    }
  }));
}));

// ==================== TREASURY ENDPOINTS ====================

/**
 * GET /api/public/v1/treasury
 * Returns treasury summary (no sensitive wallet addresses)
 */
router.get('/treasury', asyncHandler(async (req, res) => {
  const summary = treasuryService.getSummary();

  if (!summary.success) {
    return res.json(success({}, { message: summary.message || 'Treasury unavailable' }));
  }

  res.json(success(summary.treasury || {}, {
    lastUpdated: summary.treasury?.lastUpdated || null
  }));
}));

/**
 * GET /api/public/v1/treasury/transactions?limit=20
 * Returns recent treasury SOL transactions (signature/time/direction/amount)
 */
router.get('/treasury/transactions', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 50);
  const result = await treasuryService.getRecentTransactions(limit);

  if (!result.success) {
    return res.status(400).json(error('TREASURY_TX_UNAVAILABLE', result.message || 'Could not fetch treasury transactions'));
  }

  const txs = result.transactions.map(tx => ({
    signature: tx.signature,
    blockTime: tx.blockTime,
    direction: tx.direction,
    deltaSol: tx.deltaSol,
    feeSol: tx.feeSol,
    success: tx.success
  }));

  res.json(success({ transactions: txs }, { count: txs.length }));
}));

/**
 * GET /api/public/v1/nft/activity?limit=20
 * Returns recent NFT activity events for watched collections
 */
router.get('/nft/activity', asyncHandler(async (req, res) => {
  const guildId = resolvePublicScope(req, { tableHasGuildColumn: true });
  const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
  const events = nftActivityService.listEventsForGuild(guildId, limit);

  const sanitized = events.map(e => ({
    eventType: e.event_type,
    collectionKey: e.collection_key,
    tokenName: e.token_name,
    tokenMint: e.token_mint,
    fromWallet: e.from_wallet ? redactWallet(e.from_wallet) : null,
    toWallet: e.to_wallet ? redactWallet(e.to_wallet) : null,
    priceSol: e.price_sol,
    txSignature: e.tx_signature,
    source: e.source,
    eventTime: e.event_time || e.created_at
  }));

  res.json(success({ events: sanitized }, { count: sanitized.length, guildId: guildId || null }));
}));

// ==================== MISSIONS ENDPOINTS ====================

/**
 * GET /api/public/v1/missions/active
 * Returns active and recruiting missions
 */
router.get('/missions/active', asyncHandler(async (req, res) => {
  const guildId = resolvePublicScope(req, { tableHasGuildColumn: hasMissionsGuildColumn() });
  const missions = (hasMissionsGuildColumn() && guildId)
    ? db.prepare(
      'SELECT * FROM missions WHERE guild_id = ? AND status IN (?, ?) ORDER BY created_at DESC'
    ).all(guildId, 'recruiting', 'active')
    : db.prepare(
      'SELECT * FROM missions WHERE status IN (?, ?) ORDER BY created_at DESC'
    ).all('recruiting', 'active');
  
  const enrichedMissions = missions.map(m => {
    const participants = db.prepare(
      'SELECT participant_id, assigned_nft_name, assigned_role FROM mission_participants WHERE mission_id = ?'
    ).all(m.mission_id);
    
    return {
      missionId: m.mission_id,
      title: m.title,
      description: m.description,
      status: m.status,
      totalSlots: m.total_slots,
      filledSlots: m.filled_slots,
      rewardPoints: m.reward_points,
      participants: participants.map(p => ({
        // Redact participant IDs for privacy
        participantId: redactWallet(p.participant_id),
        nftName: p.assigned_nft_name,
        role: p.assigned_role
      })),
      createdAt: m.created_at
    };
  });

  res.json(success({ missions: enrichedMissions }, { count: enrichedMissions.length, guildId: guildId || null }));
}));

/**
 * GET /api/public/v1/missions/completed
 * Returns completed missions
 */
router.get('/missions/completed', asyncHandler(async (req, res) => {
  const guildId = resolvePublicScope(req, { tableHasGuildColumn: hasMissionsGuildColumn() });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const missions = (hasMissionsGuildColumn() && guildId)
    ? db.prepare(
      'SELECT * FROM missions WHERE guild_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(guildId, 'completed', limit, offset)
    : db.prepare(
      'SELECT * FROM missions WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all('completed', limit, offset);
  
  const totalCount = (hasMissionsGuildColumn() && guildId)
    ? db.prepare(
      'SELECT COUNT(*) as count FROM missions WHERE guild_id = ? AND status = ?'
    ).get(guildId, 'completed').count
    : db.prepare(
      'SELECT COUNT(*) as count FROM missions WHERE status = ?'
    ).get('completed').count;

  const enrichedMissions = missions.map(m => {
    const participants = db.prepare(
      'SELECT participant_id, assigned_nft_name, assigned_role, points_awarded FROM mission_participants WHERE mission_id = ?'
    ).all(m.mission_id);
    
    return {
      missionId: m.mission_id,
      title: m.title,
      description: m.description,
      status: m.status,
      totalSlots: m.total_slots,
      rewardPoints: m.reward_points,
      participants: participants.map(p => ({
        participantId: redactWallet(p.participant_id),
        nftName: p.assigned_nft_name,
        role: p.assigned_role,
        pointsAwarded: p.points_awarded
      })),
      startTime: m.start_time,
      createdAt: m.created_at
    };
  });

  res.json(success(
    { missions: enrichedMissions },
    { 
      count: enrichedMissions.length,
      total: totalCount,
      limit,
      offset,
      guildId: guildId || null
    }
  ));
}));

/**
 * GET /api/public/v1/missions/:id
 * Returns detailed mission information
 */
router.get('/missions/:id', asyncHandler(async (req, res) => {
  const guildId = resolvePublicScope(req, { tableHasGuildColumn: hasMissionsGuildColumn() });
  const { id } = req.params;
  const mission = (hasMissionsGuildColumn() && guildId)
    ? db.prepare('SELECT * FROM missions WHERE mission_id = ? AND guild_id = ?').get(id, guildId)
    : db.prepare('SELECT * FROM missions WHERE mission_id = ?').get(id);
  
  if (!mission) {
    notFoundError('Mission');
  }

  const participants = db.prepare(
    'SELECT * FROM mission_participants WHERE mission_id = ?'
  ).all(id);

  const missionData = {
    missionId: mission.mission_id,
    title: mission.title,
    description: mission.description,
    status: mission.status,
    totalSlots: mission.total_slots,
    filledSlots: mission.filled_slots,
    rewardPoints: mission.reward_points,
    participants: participants.map(p => ({
      participantId: redactWallet(p.participant_id),
      // Do NOT expose raw wallet addresses or NFT mint addresses in public API
      nftName: p.assigned_nft_name,
      role: p.assigned_role,
      pointsAwarded: p.points_awarded,
      joinedAt: p.joined_at
    })),
    startTime: mission.start_time,
    createdAt: mission.created_at
  };

  res.json(success({ mission: missionData }));
}));

// ==================== LEADERBOARD ENDPOINTS ====================

/**
 * GET /api/public/v1/leaderboard
 * Returns top 100 leaderboard
 */
router.get('/leaderboard', asyncHandler(async (req, res) => {
  const guildId = resolvePublicScope(req, { tableHasGuildColumn: hasMissionsGuildColumn() });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 100);

  const leaderboard = (hasMissionsGuildColumn() && guildId)
    ? db.prepare(`
      SELECT
        u.discord_id,
        u.username,
        u.tier,
        COALESCE(SUM(CASE WHEN m.mission_id IS NOT NULL THEN mp.points_awarded ELSE 0 END), 0) as total_points,
        COUNT(DISTINCT CASE WHEN m.mission_id IS NOT NULL THEN mp.mission_id END) as missions_completed
      FROM users u
      LEFT JOIN mission_participants mp ON u.discord_id = mp.participant_id
      LEFT JOIN missions m ON m.mission_id = mp.mission_id AND m.guild_id = ?
      GROUP BY u.discord_id
      HAVING total_points > 0
      ORDER BY total_points DESC
      LIMIT ?
    `).all(guildId, limit)
    : db.prepare(`
      SELECT
        u.discord_id,
        u.username,
        u.tier,
        COALESCE(SUM(mp.points_awarded), 0) as total_points,
        COUNT(DISTINCT mp.mission_id) as missions_completed
      FROM users u
      LEFT JOIN mission_participants mp ON u.discord_id = mp.participant_id
      GROUP BY u.discord_id
      HAVING total_points > 0
      ORDER BY total_points DESC
      LIMIT ?
    `).all(limit);

  const enrichedLeaderboard = leaderboard.map((entry, index) => ({
    rank: index + 1,
    // Redact Discord IDs for privacy (or use username only)
    userId: redactWallet(entry.discord_id),
    username: entry.username,
    tier: entry.tier,
    totalPoints: entry.total_points,
    missionsCompleted: entry.missions_completed
  }));

  res.json(success({ leaderboard: enrichedLeaderboard }, { count: enrichedLeaderboard.length, guildId: guildId || null }));
}));

/**
 * GET /api/public/v1/leaderboard/:userId
 * Returns specific user's leaderboard position
 */
router.get('/leaderboard/:userId', asyncHandler(async (req, res) => {
  const guildId = resolvePublicScope(req, { tableHasGuildColumn: hasMissionsGuildColumn() });
  const { userId } = req.params;
  
  const userPoints = (hasMissionsGuildColumn() && guildId)
    ? db.prepare(`
      SELECT
        u.discord_id,
        u.username,
        u.tier,
        COALESCE(SUM(CASE WHEN m.mission_id IS NOT NULL THEN mp.points_awarded ELSE 0 END), 0) as total_points,
        COUNT(DISTINCT CASE WHEN m.mission_id IS NOT NULL THEN mp.mission_id END) as missions_completed
      FROM users u
      LEFT JOIN mission_participants mp ON u.discord_id = mp.participant_id
      LEFT JOIN missions m ON m.mission_id = mp.mission_id AND m.guild_id = ?
      WHERE u.discord_id = ?
      GROUP BY u.discord_id
    `).get(guildId, userId)
    : db.prepare(`
      SELECT
        u.discord_id,
        u.username,
        u.tier,
        COALESCE(SUM(mp.points_awarded), 0) as total_points,
        COUNT(DISTINCT mp.mission_id) as missions_completed
      FROM users u
      LEFT JOIN mission_participants mp ON u.discord_id = mp.participant_id
      WHERE u.discord_id = ?
      GROUP BY u.discord_id
    `).get(userId);

  if (!userPoints) {
    // User exists but has no points
    return res.json(success({
      user: {
        userId: redactWallet(userId),
        totalPoints: 0,
        missionsCompleted: 0,
        rank: null
      }
    }));
  }

  // Calculate rank
  const higherRanked = (hasMissionsGuildColumn() && guildId)
    ? db.prepare(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT
          u.discord_id,
          COALESCE(SUM(CASE WHEN m.mission_id IS NOT NULL THEN mp.points_awarded ELSE 0 END), 0) AS total_points
        FROM users u
        LEFT JOIN mission_participants mp ON u.discord_id = mp.participant_id
        LEFT JOIN missions m ON m.mission_id = mp.mission_id AND m.guild_id = ?
        GROUP BY u.discord_id
        HAVING total_points > ?
      ) ranked
    `).get(guildId, userPoints.total_points).count
    : db.prepare(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT
          u.discord_id,
          COALESCE(SUM(mp.points_awarded), 0) AS total_points
        FROM users u
        LEFT JOIN mission_participants mp ON u.discord_id = mp.participant_id
        GROUP BY u.discord_id
        HAVING total_points > ?
      ) ranked
    `).get(userPoints.total_points).count;

  res.json(success({
    user: {
      userId: redactWallet(userPoints.discord_id),
      username: userPoints.username,
      tier: userPoints.tier,
      totalPoints: userPoints.total_points,
      missionsCompleted: userPoints.missions_completed,
      rank: higherRanked + 1,
      guildId: guildId || null
    }
  }));
}));

module.exports = router;
