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
const { success, error, sanitize, redactWallet } = require('../../utils/apiResponse');
const { asyncHandler, notFoundError, validationError } = require('../../utils/apiErrorHandler');

// ==================== GOVERNANCE ENDPOINTS ====================

/**
 * GET /api/public/v1/proposals/active
 * Returns all active proposals
 */
router.get('/proposals/active', asyncHandler(async (req, res) => {
  const proposals = db.prepare('SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC').all('voting');
  
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

  res.json(success({ proposals: enrichedProposals }, { count: enrichedProposals.length }));
}));

/**
 * GET /api/public/v1/proposals/concluded
 * Returns concluded proposals (passed, rejected, quorum_not_met)
 */
router.get('/proposals/concluded', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;

  if (limit > 100) {
    validationError('Limit cannot exceed 100');
  }

  const proposals = db.prepare(
    'SELECT * FROM proposals WHERE status IN (?, ?, ?) ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all('passed', 'rejected', 'quorum_not_met', limit, offset);
  
  const totalCount = db.prepare(
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
      offset
    }
  ));
}));

/**
 * GET /api/public/v1/proposals/:id
 * Returns detailed proposal information
 */
router.get('/proposals/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const proposal = db.prepare('SELECT * FROM proposals WHERE proposal_id = ?').get(id);
  
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
  const totalProposals = db.prepare('SELECT COUNT(*) as count FROM proposals').get().count;
  const passedProposals = db.prepare('SELECT COUNT(*) as count FROM proposals WHERE status = ?').get('passed').count;
  const totalVotes = db.prepare('SELECT COUNT(*) as count FROM votes').get().count;
  const totalVP = db.prepare('SELECT COALESCE(SUM(voting_power), 0) as total FROM votes').get().total;
  const activeVoters = db.prepare('SELECT COUNT(DISTINCT voter_id) as count FROM votes').get().count;

  const passRate = totalProposals > 0 ? Math.round((passedProposals / totalProposals) * 100) : 0;

  res.json(success({
    stats: {
      totalProposals,
      passedProposals,
      passRate,
      totalVotes,
      totalVPUsed: totalVP,
      activeVoters
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

// ==================== MISSIONS ENDPOINTS ====================

/**
 * GET /api/public/v1/missions/active
 * Returns active and recruiting missions
 */
router.get('/missions/active', asyncHandler(async (req, res) => {
  const missions = db.prepare(
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

  res.json(success({ missions: enrichedMissions }, { count: enrichedMissions.length }));
}));

/**
 * GET /api/public/v1/missions/completed
 * Returns completed missions
 */
router.get('/missions/completed', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;

  if (limit > 100) {
    validationError('Limit cannot exceed 100');
  }

  const missions = db.prepare(
    'SELECT * FROM missions WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all('completed', limit, offset);
  
  const totalCount = db.prepare(
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
      offset
    }
  ));
}));

/**
 * GET /api/public/v1/missions/:id
 * Returns detailed mission information
 */
router.get('/missions/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const mission = db.prepare('SELECT * FROM missions WHERE mission_id = ?').get(id);
  
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
  const limit = parseInt(req.query.limit) || 100;

  if (limit > 100) {
    validationError('Limit cannot exceed 100');
  }

  const leaderboard = db.prepare(`
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

  res.json(success({ leaderboard: enrichedLeaderboard }, { count: enrichedLeaderboard.length }));
}));

/**
 * GET /api/public/v1/leaderboard/:userId
 * Returns specific user's leaderboard position
 */
router.get('/leaderboard/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  
  const userPoints = db.prepare(`
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
  const higherRanked = db.prepare(`
    SELECT COUNT(DISTINCT u.discord_id) as count
    FROM users u
    LEFT JOIN mission_participants mp ON u.discord_id = mp.participant_id
    GROUP BY u.discord_id
    HAVING COALESCE(SUM(mp.points_awarded), 0) > ?
  `).get(userPoints.total_points).count;

  res.json(success({
    user: {
      userId: redactWallet(userPoints.discord_id),
      username: userPoints.username,
      tier: userPoints.tier,
      totalPoints: userPoints.total_points,
      missionsCompleted: userPoints.missions_completed,
      rank: higherRanked + 1
    }
  }));
}));

module.exports = router;
