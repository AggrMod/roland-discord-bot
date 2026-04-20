const db = require('../database/db');
const vpService = require('./vpService');
const logger = require('../utils/logger');
const { applyEmbedBranding } = require('./embedBranding');
const governanceLogger = require('../utils/governanceLogger');
const settingsManager = require('../config/settings');

// Default tier-based VP thresholds (used only if no role_vp_mappings configured)
const DEFAULT_TIER_VP = [
  { name: 'Associate', min: 1, max: 2, vp: 1 },
  { name: 'Soldato', min: 3, max: 6, vp: 3 },
  { name: 'Capo', min: 7, max: 14, vp: 6 },
  { name: 'Elite', min: 15, max: 49, vp: 10 },
  { name: 'Underboss Holder', min: 50, max: 149, vp: 14 },
  { name: 'Don Holder', min: 150, max: Infinity, vp: 18 }
];

function getConfiguredVPForUser(discordId, nftCount, roleMappings) {
  // If role_vp_mappings has entries, use getUserVotingPower via roleService
  // (called at vote time with live member). For snapshot we use tier-based
  // settings config when available, else DEFAULT_TIER_VP.
  if (!nftCount || nftCount < 1) return 0;
  try {
    const roleService = require('./roleService');
    const tiers = roleService.tiersConfig && roleService.tiersConfig.tiers;
    if (tiers && tiers.length > 0) {
      // Use configured tiers from settings (which may have custom VP values)
      for (const t of [...tiers].sort((a, b) => b.minNFTs - a.minNFTs)) {
        if (nftCount >= t.minNFTs) return t.votingPower || 0;
      }
    }
  } catch (e) { /* fall through to defaults */ }
  // Fallback to hardcoded defaults
  for (const t of DEFAULT_TIER_VP) {
    if (nftCount >= t.min && nftCount <= t.max) return t.vp;
  }
  return DEFAULT_TIER_VP[DEFAULT_TIER_VP.length - 1].vp;
}

let _hasProposalsGuildColumnCache = null;
function hasProposalsGuildColumn() {
  if (_hasProposalsGuildColumnCache !== null) return _hasProposalsGuildColumnCache;
  try {
    const columns = db.prepare("PRAGMA table_info(proposals)").all();
    _hasProposalsGuildColumnCache = columns.some(c => String(c?.name || '').toLowerCase() === 'guild_id');
  } catch (_error) {
    _hasProposalsGuildColumnCache = false;
  }
  return _hasProposalsGuildColumnCache;
}

let _hasRoleVPGuildColumnCache = null;
function hasRoleVPGuildColumn() {
  if (_hasRoleVPGuildColumnCache !== null) return _hasRoleVPGuildColumnCache;
  try {
    const columns = db.prepare("PRAGMA table_info(role_vp_mappings)").all();
    _hasRoleVPGuildColumnCache = columns.some(c => String(c?.name || '').toLowerCase() === 'guild_id');
  } catch (_error) {
    _hasRoleVPGuildColumnCache = false;
  }
  return _hasRoleVPGuildColumnCache;
}

function getRoleMappingCountForGuild(guildId = '') {
  const normalizedGuildId = String(guildId || '').trim();
  try {
    if (hasRoleVPGuildColumn()) {
      if (!normalizedGuildId) {
        return Number(
          db.prepare("SELECT COUNT(*) AS cnt FROM role_vp_mappings WHERE COALESCE(guild_id, '') = ''").get()?.cnt || 0
        );
      }
      const scopedCount = Number(
        db.prepare('SELECT COUNT(*) AS cnt FROM role_vp_mappings WHERE guild_id = ?').get(normalizedGuildId)?.cnt || 0
      );
      const legacyCount = Number(
        db.prepare("SELECT COUNT(*) AS cnt FROM role_vp_mappings WHERE COALESCE(guild_id, '') = ''").get()?.cnt || 0
      );
      return scopedCount + legacyCount;
    }
    return Number(db.prepare('SELECT COUNT(*) AS cnt FROM role_vp_mappings').get()?.cnt || 0);
  } catch (_error) {
    return 0;
  }
}

function resolveGovernanceQuorumPercentage(settings = {}) {
  const quorumCandidates = [
    settings?.governanceQuorum,
    settings?.quorumPercentage,
  ];
  for (const value of quorumCandidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
      return parsed;
    }
  }
  return 25;
}

function resolveVoteDurationDays(settings = {}) {
  const days = Number(settings?.voteDurationDays);
  if (Number.isFinite(days) && days > 0) {
    return days;
  }

  const hours = Number(settings?.voteDurationHours);
  if (Number.isFinite(hours) && hours > 0) {
    return hours / 24;
  }

  return 7;
}

class ProposalService {
  constructor() {
    this.client = null;
  }

  setClient(client) {
    this.client = client;
  }

  generateProposalId() {
    const row = db.prepare(`
      SELECT COALESCE(
        MAX(
          CASE
            WHEN proposal_id GLOB '[0-9]*' AND proposal_id <> ''
              THEN CAST(proposal_id AS INTEGER)
            ELSE NULL
          END
        ),
        0
      ) AS max_id
      FROM proposals
    `).get();
    const nextId = Number(row?.max_id || 0) + 1;
    return String(nextId);
  }

  // ==================== PROPOSAL LIFECYCLE ====================

  createProposal(creatorId, { title, description, category, costIndication, guildId = '', initialStatus = 'draft' }) {
    try {
      const validCategories = settingsManager.getSettings().proposalCategories || ['Partnership', 'Treasury Allocation', 'Rule Change', 'Community Event', 'Other'];
      const safeCategory = validCategories.includes(category) ? category : 'Other';
      const normalizedGuildId = String(guildId || '').trim();
      const safeInitialStatus = initialStatus === 'supporting' ? 'supporting' : 'draft';
      const normalizedCost = String(costIndication || '').trim() || null;

      let proposalId = '';
      let inserted = false;
      let lastInsertError = null;
      for (let attempt = 0; attempt < 5 && !inserted; attempt += 1) {
        proposalId = this.generateProposalId();
        try {
          if (hasProposalsGuildColumn()) {
            db.prepare(`
              INSERT INTO proposals (proposal_id, guild_id, creator_id, title, description, status, category, cost_indication)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(proposalId, normalizedGuildId, creatorId, title, description, safeInitialStatus, safeCategory, normalizedCost);
          } else {
            db.prepare(`
              INSERT INTO proposals (proposal_id, creator_id, title, description, status, category, cost_indication)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(proposalId, creatorId, title, description, safeInitialStatus, safeCategory, normalizedCost);
          }
          inserted = true;
        } catch (insertError) {
          const errorMessage = String(insertError?.message || '').toLowerCase();
          if (errorMessage.includes('unique constraint failed') && errorMessage.includes('proposals.proposal_id')) {
            lastInsertError = insertError;
            continue;
          }
          throw insertError;
        }
      }

      if (!inserted) {
        throw (lastInsertError || new Error('Unable to allocate proposal ID'));
      }

      logger.log(`Proposal ${proposalId} created by ${creatorId}`);
      governanceLogger.log('proposal_created', { proposalId, guildId: normalizedGuildId || null, creatorId, title, category: safeCategory });

      return { success: true, proposalId };
    } catch (error) {
      logger.error('Error creating proposal:', error);
      return { success: false, message: 'Failed to create proposal' };
    }
  }

  // Legacy compat: support old 4-arg call from Discord commands
  createProposalLegacy(creatorId, creatorWallet, title, description) {
    return this.createProposal(creatorId, { title, description, category: 'Other', costIndication: null });
  }

  submitForReview(proposalId, discordId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (proposal.creator_id !== discordId) return { success: false, message: 'Only the author can submit for review' };
      if (proposal.status !== 'draft') return { success: false, message: 'Only draft proposals can be submitted for review' };

      db.prepare("UPDATE proposals SET status = 'pending_review' WHERE proposal_id = ?").run(proposalId);
      governanceLogger.log('proposal_submitted_for_review', { proposalId, discordId });
      return { success: true };
    } catch (error) {
      logger.error('Error submitting for review:', error);
      return { success: false, message: 'Failed to submit for review' };
    }
  }

  approveProposal(proposalId, adminId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (proposal.status !== 'pending_review' && proposal.status !== 'on_hold') {
        return { success: false, message: 'Proposal must be pending review or on hold to approve' };
      }

      db.prepare("UPDATE proposals SET status = 'supporting' WHERE proposal_id = ?").run(proposalId);
      governanceLogger.log('proposal_approved', { proposalId, adminId });
      return { success: true };
    } catch (error) {
      logger.error('Error approving proposal:', error);
      return { success: false, message: 'Failed to approve proposal' };
    }
  }

  holdProposal(proposalId, adminId, reason) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (proposal.status !== 'pending_review') {
        return { success: false, message: 'Only pending_review proposals can be placed on hold' };
      }

      db.prepare("UPDATE proposals SET status = 'on_hold', on_hold_reason = ? WHERE proposal_id = ?").run(reason || '', proposalId);
      governanceLogger.log('proposal_on_hold', { proposalId, adminId, reason });
      return { success: true };
    } catch (error) {
      logger.error('Error holding proposal:', error);
      return { success: false, message: 'Failed to place on hold' };
    }
  }

  async promoteToVoting(proposalId, adminId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (proposal.status !== 'supporting') {
        return { success: false, message: 'Only supporting proposals can be promoted to voting' };
      }

      // Take VP snapshot
      const snapshot = await this.takeVPSnapshot(proposal.guild_id || '');
      const totalVP = snapshot.totalVP;
      const settings = settingsManager.getSettings();
      const quorumPercentage = resolveGovernanceQuorumPercentage(settings);
      const quorumRequired = Math.ceil(totalVP * (quorumPercentage / 100));

      const startTime = new Date();
      const voteDays = resolveVoteDurationDays(settings);
      const endTime = new Date(startTime.getTime() + voteDays * 24 * 60 * 60 * 1000);

      db.prepare(`
        UPDATE proposals
        SET status = 'voting', start_time = ?, end_time = ?, total_vp = ?,
            vp_snapshot = ?, quorum_required = ?, promoted_by = ?
        WHERE proposal_id = ?
      `).run(
        startTime.toISOString(), endTime.toISOString(), totalVP,
        JSON.stringify(snapshot), quorumRequired, adminId || null,
        proposalId
      );

      logger.log(`Proposal ${proposalId} promoted to voting. Total VP: ${totalVP}, Quorum: ${quorumRequired}`);
      governanceLogger.log('proposal_promoted', { proposalId, totalVP, quorumRequired, adminId, title: proposal.title });

      // Generate AI Brief if possible
      try {
        const aiAssistantService = require('./aiAssistantService');
        const brief = await aiAssistantService.generateProposalBrief(proposal.guild_id || '', proposal);
        if (brief) {
          db.prepare('UPDATE proposals SET ai_brief = ? WHERE proposal_id = ?').run(brief, proposalId);
        }
      } catch (e) {
        logger.error(`[ai-assistant] failed to generate brief for ${proposalId}:`, e);
      }

      if (this.client) {
        await this.postToVotingChannel(proposalId);
      }

      return { success: true, totalVP, quorumRequired };
    } catch (error) {
      logger.error('Error promoting proposal:', error);
      return { success: false, message: 'Failed to promote to voting' };
    }
  }

  async takeVPSnapshot(guildId = '') {
    const normalizedGuildId = String(guildId || '').trim();
    const voterVPs = {};
    let totalVP = 0;
    const roleMappingCount = getRoleMappingCountForGuild(normalizedGuildId);

    // Preferred path: compute VP from live guild roles so role->VP mappings are applied.
    if (normalizedGuildId && this.client && roleMappingCount > 0) {
      try {
        const roleService = require('./roleService');
        const guild = this.client.guilds.cache.get(normalizedGuildId)
          || await this.client.guilds.fetch(normalizedGuildId).catch(() => null);

        if (guild) {
          // Build candidate voter ids from tenant memberships + known verified users.
          // This avoids depending on full-member-list fetch availability.
          const candidateIds = new Set();
          const membershipRows = db.prepare('SELECT DISTINCT discord_id FROM user_tenant_memberships WHERE guild_id = ?').all(normalizedGuildId);
          for (const row of membershipRows) {
            const discordId = String(row?.discord_id || '').trim();
            if (discordId) candidateIds.add(discordId);
          }
          const walletRows = db.prepare('SELECT DISTINCT discord_id FROM wallets').all();
          for (const row of walletRows) {
            const discordId = String(row?.discord_id || '').trim();
            if (discordId) candidateIds.add(discordId);
          }
          const nftRows = db.prepare('SELECT discord_id FROM users WHERE total_nfts > 0').all();
          for (const row of nftRows) {
            const discordId = String(row?.discord_id || '').trim();
            if (discordId) candidateIds.add(discordId);
          }

          let resolvedAnyCandidate = false;
          for (const discordId of candidateIds) {
            const member = guild.members.cache.get(discordId)
              || await guild.members.fetch(discordId).catch(() => null);
            if (!member) continue;
            resolvedAnyCandidate = true;
            const vp = Number(roleService.getUserVotingPower(discordId, member, normalizedGuildId) || 0);
            if (vp > 0) {
              voterVPs[discordId] = vp;
              totalVP += vp;
            }
          }
          if (resolvedAnyCandidate) {
            return { totalVP, voterVPs, source: 'role_mapping_snapshot', guildId: normalizedGuildId };
          }

          // Last resort: full member fetch (may require privileged intent).
          const members = await guild.members.fetch();
          for (const member of members.values()) {
            const vp = Number(roleService.getUserVotingPower(member.id, member, normalizedGuildId) || 0);
            if (vp > 0) {
              voterVPs[member.id] = vp;
              totalVP += vp;
            }
          }
          return { totalVP, voterVPs, source: 'role_mapping_snapshot_bulk', guildId: normalizedGuildId };
        }
      } catch (error) {
        logger.warn(`Failed to take guild-scoped VP snapshot for ${normalizedGuildId}: ${error?.message || error}`);
      }
    }

    // Fallback path: legacy snapshot from stored NFT totals/tier-based VP.
    const users = db.prepare('SELECT discord_id, total_nfts FROM users WHERE total_nfts > 0').all();
    for (const user of users) {
      const vp = getConfiguredVPForUser(user.discord_id, user.total_nfts, []);
      if (vp > 0) {
        voterVPs[user.discord_id] = vp;
        totalVP += vp;
      }
    }

    return { totalVP, voterVPs, source: 'tier_fallback', guildId: normalizedGuildId || null };
  }

  castVote(proposalId, discordId, choice, votingPower) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (proposal.status !== 'voting') return { success: false, message: 'Proposal is not in voting phase' };
      if (proposal.paused) return { success: false, message: 'Voting is currently paused on this proposal' };

      // Use snapshotted VP if available, otherwise fall back to provided VP.
      // Compatibility: if a legacy/tier snapshot underestimates mapped role VP,
      // allow the live mapped VP passed by caller.
      const providedVP = Number(votingPower || 0);
      let effectiveVP = providedVP;
      if (proposal.vp_snapshot) {
        try {
          const snapshot = JSON.parse(proposal.vp_snapshot);
          const snapshotSource = String(snapshot?.source || '').trim();
          const snapshotMayBeLegacy = !snapshotSource || snapshotSource === 'tier_fallback';
          const hasSnapshotEntry = snapshot?.voterVPs && snapshot.voterVPs[discordId] !== undefined;
          if (snapshot.voterVPs && snapshot.voterVPs[discordId] !== undefined) {
            const snapshotVP = Number(snapshot.voterVPs[discordId] || 0);
            effectiveVP = snapshotVP;

            const mappingsConfigured = getRoleMappingCountForGuild(proposal.guild_id || '') > 0;
            if (
              mappingsConfigured
              && snapshotMayBeLegacy
              && Number.isFinite(providedVP)
              && providedVP > snapshotVP
            ) {
              effectiveVP = providedVP;
              logger.warn(
                `Using live mapped VP (${providedVP}) over legacy snapshot VP (${snapshotVP}) for proposal ${proposalId}, voter ${discordId}`
              );
            }
          } else if (snapshotMayBeLegacy && Number.isFinite(providedVP) && providedVP > 0 && !hasSnapshotEntry) {
            effectiveVP = providedVP;
          }
        } catch (e) {
          logger.warn(`Failed to parse VP snapshot for ${proposalId}, using provided VP`);
        }
      }

      if (!effectiveVP || effectiveVP < 1) {
        return { success: false, message: 'You have no voting power for this proposal' };
      }

      const existingVote = db.prepare(
        'SELECT * FROM votes WHERE proposal_id = ? AND voter_id = ?'
      ).get(proposalId, discordId);

      if (existingVote) {
        db.prepare(`
          UPDATE votes
          SET vote_choice = ?, voting_power = ?, updated_at = CURRENT_TIMESTAMP
          WHERE proposal_id = ? AND voter_id = ?
        `).run(choice, effectiveVP, proposalId, discordId);
        governanceLogger.log('vote_changed', { proposalId, voterId: discordId, voteChoice: choice, votingPower: effectiveVP });
      } else {
        db.prepare(`
          INSERT INTO votes (proposal_id, voter_id, vote_choice, voting_power)
          VALUES (?, ?, ?, ?)
        `).run(proposalId, discordId, choice, effectiveVP);
        governanceLogger.log('vote_cast', { proposalId, voterId: discordId, voteChoice: choice, votingPower: effectiveVP });
      }

      this.updateProposalTally(proposalId);
      this.checkAutoClose(proposalId);

      return { success: true, votingPower: effectiveVP };
    } catch (error) {
      logger.error('Error casting vote:', error);
      return { success: false, message: 'Failed to cast vote' };
    }
  }

  concludeProposal(proposalId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (proposal.status !== 'voting') return { success: false, message: 'Only voting proposals can be concluded' };

      return this.closeVote(proposalId);
    } catch (error) {
      logger.error('Error concluding proposal:', error);
      return { success: false, message: 'Failed to conclude proposal' };
    }
  }

  vetoProposal(proposalId, discordId, reason) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (!['supporting', 'voting', 'concluded', 'passed', 'rejected', 'quorum_not_met'].includes(proposal.status)) {
        return { success: false, message: 'This proposal cannot be vetoed in its current state' };
      }

      // Record veto vote
      try {
        db.prepare(`
          INSERT INTO proposal_veto_votes (proposal_id, voter_id, reason)
          VALUES (?, ?, ?)
        `).run(proposalId, discordId, reason || '');
      } catch (e) {
        if (e.message.includes('UNIQUE constraint failed')) {
          return { success: false, message: 'You have already cast a veto vote' };
        }
        throw e;
      }

      // Get all veto votes for this proposal
      const vetoVotes = db.prepare('SELECT * FROM proposal_veto_votes WHERE proposal_id = ?').all(proposalId);
      const vetoVoterIds = vetoVotes.map(v => v.voter_id);

      // Update the proposal's veto_votes field
      db.prepare('UPDATE proposals SET veto_votes = ? WHERE proposal_id = ?')
        .run(JSON.stringify(vetoVoterIds), proposalId);

      governanceLogger.log('veto_vote_cast', { proposalId, discordId, reason, totalVetoVotes: vetoVotes.length });

      // Note: The caller (API endpoint) is responsible for checking if ALL council members
      // have voted and then setting status to 'vetoed'. This service just records the vote.
      return { success: true, vetoCount: vetoVotes.length, vetoVoterIds };
    } catch (error) {
      logger.error('Error vetoing proposal:', error);
      return { success: false, message: 'Failed to record veto vote' };
    }
  }

  applyVeto(proposalId, reason) {
    try {
      db.prepare("UPDATE proposals SET status = 'vetoed', veto_reason = ? WHERE proposal_id = ?")
        .run(reason || 'Unanimous council veto', proposalId);
      governanceLogger.log('proposal_vetoed', { proposalId, reason });
      return { success: true };
    } catch (error) {
      logger.error('Error applying veto:', error);
      return { success: false, message: 'Failed to apply veto' };
    }
  }

  emergencyPause(proposalId, discordId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (proposal.status !== 'voting') return { success: false, message: 'Only voting proposals can be paused' };

      const newPaused = proposal.paused ? 0 : 1;
      db.prepare('UPDATE proposals SET paused = ? WHERE proposal_id = ?').run(newPaused, proposalId);

      governanceLogger.log(newPaused ? 'proposal_paused' : 'proposal_unpaused', { proposalId, discordId });
      return { success: true, paused: !!newPaused };
    } catch (error) {
      logger.error('Error toggling emergency pause:', error);
      return { success: false, message: 'Failed to toggle pause' };
    }
  }

  cancelProposal(proposalId, requesterId, guildId = '') {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (String(proposal.creator_id || '') !== String(requesterId || '')) {
        return { success: false, message: 'Only the proposal creator can cancel this proposal' };
      }

      const currentStatus = String(proposal.status || '').toLowerCase();
      if (currentStatus === 'cancelled') {
        return { success: true, proposalId, status: 'cancelled' };
      }
      const disallowedStatuses = ['vetoed'];
      if (disallowedStatuses.includes(currentStatus)) {
        return { success: false, message: `Proposal cannot be cancelled in status "${proposal.status}"` };
      }

      const normalizedGuildId = String(guildId || '').trim();
      const proposalGuildId = String(proposal.guild_id || '').trim();
      let result;
      if (hasProposalsGuildColumn()) {
        if (proposalGuildId) {
          result = db.prepare('UPDATE proposals SET status = ? WHERE proposal_id = ? AND creator_id = ? AND guild_id = ?')
            .run('cancelled', proposalId, requesterId, proposalGuildId);
        } else {
          // Legacy rows may have an empty guild_id; cancel by proposal+creator in that case.
          result = db.prepare('UPDATE proposals SET status = ? WHERE proposal_id = ? AND creator_id = ?')
            .run('cancelled', proposalId, requesterId);
        }
      } else {
        result = db.prepare('UPDATE proposals SET status = ? WHERE proposal_id = ? AND creator_id = ?')
          .run('cancelled', proposalId, requesterId);
      }

      if (!result?.changes) {
        return { success: false, message: 'Failed to cancel proposal' };
      }

      governanceLogger.log('proposal_cancelled_by_creator', {
        proposalId,
        requesterId,
        fromStatus: proposal.status,
        guildId: proposalGuildId || normalizedGuildId || null,
      });
      logger.log(`Proposal ${proposalId} cancelled by creator ${requesterId}`);

      return { success: true, proposalId, status: 'cancelled' };
    } catch (error) {
      logger.error('Error cancelling proposal:', error);
      return { success: false, message: 'Failed to cancel proposal' };
    }
  }

  // ==================== COMMENTS ====================

  addComment(proposalId, authorId, authorName, content) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };

      db.prepare(`
        INSERT INTO proposal_comments (proposal_id, author_id, author_name, content)
        VALUES (?, ?, ?, ?)
      `).run(proposalId, authorId, authorName || 'Unknown', content);

      return { success: true };
    } catch (error) {
      logger.error('Error adding comment:', error);
      return { success: false, message: 'Failed to add comment' };
    }
  }

  getComments(proposalId) {
    try {
      return db.prepare('SELECT * FROM proposal_comments WHERE proposal_id = ? ORDER BY created_at ASC').all(proposalId);
    } catch (error) {
      logger.error('Error fetching comments:', error);
      return [];
    }
  }

  // ==================== SUPPORT ====================

  addSupporter(proposalId, supporterId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (proposal.status !== 'supporting') {
        return { success: false, message: 'Can only support proposals in the supporting phase' };
      }
      if (proposal.creator_id === supporterId) {
        governanceLogger.log('support_blocked', { proposalId, userId: supporterId });
        return { success: false, message: 'You cannot support your own proposal' };
      }

      // DB-005: proposal_supporters is the canonical table
      try {
        db.prepare('INSERT INTO proposal_supporters (proposal_id, supporter_id) VALUES (?, ?)').run(proposalId, supporterId);
      } catch (e) {
        if (e.message.includes('UNIQUE constraint failed')) {
          return { success: false, message: 'You already support this proposal' };
        }
        throw e;
      }

      const supporterCount = db.prepare('SELECT COUNT(*) as count FROM proposal_supporters WHERE proposal_id = ?').get(proposalId).count;

      governanceLogger.log('support_added', { proposalId, supporterId, supporterCount });
      logger.log(`User ${supporterId} supported proposal ${proposalId} (${supporterCount} supporters)`);

      return { success: true, supporterCount };
    } catch (error) {
      logger.error('Error adding supporter:', error);
      return { success: false, message: 'Failed to add support' };
    }
  }

  getSupporterCount(proposalId) {
    try {
      // DB-005: proposal_supporters is the canonical table
      return db.prepare('SELECT COUNT(*) as count FROM proposal_supporters WHERE proposal_id = ?').get(proposalId).count;
    } catch (e) {
      return 0;
    }
  }

  // ==================== CORE HELPERS ====================

  getProposal(proposalId) {
    try {
      return db.prepare('SELECT * FROM proposals WHERE proposal_id = ?').get(proposalId);
    } catch (error) {
      logger.error('Error fetching proposal:', error);
      return null;
    }
  }

  updateProposalTally(proposalId) {
    try {
      const votes = db.prepare('SELECT vote_choice, SUM(voting_power) as vp FROM votes WHERE proposal_id = ? GROUP BY vote_choice').all(proposalId);

      let yesVP = 0, noVP = 0, abstainVP = 0;
      votes.forEach(v => {
        if (v.vote_choice === 'yes') yesVP = v.vp;
        if (v.vote_choice === 'no') noVP = v.vp;
        if (v.vote_choice === 'abstain') abstainVP = v.vp;
      });

      db.prepare('UPDATE proposals SET yes_vp = ?, no_vp = ?, abstain_vp = ? WHERE proposal_id = ?')
        .run(yesVP, noVP, abstainVP, proposalId);

      return { yesVP, noVP, abstainVP };
    } catch (error) {
      logger.error('Error updating tally:', error);
      return { yesVP: 0, noVP: 0, abstainVP: 0 };
    }
  }

  checkAutoClose(proposalId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal || proposal.status !== 'voting' || proposal.paused) return;

      const totalVoted = proposal.yes_vp + proposal.no_vp + proposal.abstain_vp;
      const halfVP = Math.floor(proposal.total_vp / 2);

      if (totalVoted > halfVP) {
        this.closeVote(proposalId);
        logger.log(`Proposal ${proposalId} auto-closed: >50% VP voted`);
        return;
      }

      const now = new Date();
      const endTime = new Date(proposal.end_time);
      if (now >= endTime) {
        this.closeVote(proposalId);
        logger.log(`Proposal ${proposalId} auto-closed: voting period elapsed`);
      }
    } catch (error) {
      logger.error('Error checking auto-close:', error);
    }
  }

  async closeVote(proposalId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false };

      const totalVoted = proposal.yes_vp + proposal.no_vp + proposal.abstain_vp;
      const quorumReq = proposal.quorum_required || Math.ceil(proposal.total_vp * 0.25);
      const quorumMet = totalVoted >= quorumReq;

      let result = 'quorum_not_met';

      if (quorumMet) {
        const passed = vpService.hasVotePassed(proposal.yes_vp, proposal.no_vp, proposal.abstain_vp);
        result = passed ? 'passed' : 'rejected';
      }

      db.prepare('UPDATE proposals SET status = ? WHERE proposal_id = ?').run(result, proposalId);

      governanceLogger.log('vote_closed', {
        proposalId, status: result, result, quorumMet,
        quorumRequired: quorumReq, totalVoted,
        yesVP: proposal.yes_vp, noVP: proposal.no_vp, abstainVP: proposal.abstain_vp
      });

      await this.updateVotingMessageFinal(proposalId, result, quorumMet);
      await this.postToResultsChannel(proposalId, result, quorumMet);

      logger.log(`Proposal ${proposalId} concluded: ${result} (quorum ${quorumMet ? 'met' : 'not met'})`);
      return { success: true, status: result, result, quorumMet };
    } catch (error) {
      logger.error('Error closing vote:', error);
      return { success: false };
    }
  }

  getActiveProposals() {
    return db.prepare("SELECT * FROM proposals WHERE status IN ('supporting', 'voting') ORDER BY created_at DESC").all();
  }

  getConcludedProposals() {
    return db.prepare("SELECT * FROM proposals WHERE status IN ('concluded', 'vetoed', 'passed', 'rejected', 'quorum_not_met') ORDER BY created_at DESC").all();
  }

  // ==================== DISCORD CHANNEL POSTING ====================

  async postToVotingChannel(proposalId) {
    try {
      const settings = settingsManager.getSettings();
      const votingChannelId = settings.votingChannelId || process.env.VOTING_CHANNEL_ID;
      if (!votingChannelId) {
        logger.warn('votingChannelId not set in settings or .env');
        return;
      }

      const proposal = this.getProposal(proposalId);
      if (!proposal) return;

      const votingChannel = await this.client.channels.fetch(votingChannelId);
      if (!votingChannel || !votingChannel.isTextBased()) return;

      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

      const endDate = new Date(proposal.end_time);
      const embed = new EmbedBuilder()
        .setTitle(`🗳️ ${proposal.title}`)
        .setDescription(proposal.description)
        .addFields(
          { name: '🆔 Proposal ID', value: proposal.proposal_id, inline: true },
          { name: '👤 Creator', value: `<@${proposal.creator_id}>`, inline: true },
          { name: '💪 Total VP', value: proposal.total_vp.toString(), inline: true },
          { name: '📂 Category', value: proposal.category || 'Other', inline: true },
          { name: '💰 Cost', value: proposal.cost_indication || 'N/A', inline: true },
          { name: '🎯 Quorum Required', value: `${proposal.quorum_required} VP`, inline: true }
        );

      if (proposal.ai_brief) {
        embed.addFields({ name: '📜 Consigliere\'s Family Brief', value: proposal.ai_brief, inline: false });
      }

      embed.addFields(
        { name: '⏰ Deadline', value: `<t:${Math.floor(endDate.getTime() / 1000)}:R>`, inline: false },
        { name: '📊 Current Votes', value: '✅ Yes: 0 VP\n❌ No: 0 VP\n⚖️ Abstain: 0 VP', inline: false }
      )
      .setFooter({ text: 'Vote below! VP is locked at snapshot.' })
      .setTimestamp();

      const brandingGuildId = String(
        proposal?.guild_id || process.env.GUILD_ID || process.env.DISCORD_GUILD_ID || ''
      ).trim();

      applyEmbedBranding(embed, {
        guildId: brandingGuildId,
        moduleKey: 'governance',
        defaultColor: '#FFD700',
        defaultFooter: 'Powered by Guild Pilot',
        fallbackLogoUrl: this.client?.user?.displayAvatarURL?.() || null,
      });

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder().setCustomId(`vote_yes_${proposalId}`).setLabel('Yes').setStyle(ButtonStyle.Success).setEmoji('✅'),
          new ButtonBuilder().setCustomId(`vote_no_${proposalId}`).setLabel('No').setStyle(ButtonStyle.Danger).setEmoji('❌'),
          new ButtonBuilder().setCustomId(`vote_abstain_${proposalId}`).setLabel('Abstain').setStyle(ButtonStyle.Secondary).setEmoji('⚖️')
        );

      const message = await votingChannel.send({ embeds: [embed], components: [row] });
      db.prepare('UPDATE proposals SET voting_message_id = ? WHERE proposal_id = ?').run(message.id, proposalId);
      logger.log(`Proposal ${proposalId} posted to voting channel, message ${message.id}`);
    } catch (error) {
      logger.error('Error posting to voting channel:', error);
    }
  }

  async updateVotingMessage(proposalId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal || !proposal.voting_message_id || !this.client) return;

      const settings = settingsManager.getSettings();
      const votingChannelId = settings.votingChannelId || process.env.VOTING_CHANNEL_ID;
      if (!votingChannelId) return;

      const channel = await this.client.channels.fetch(votingChannelId);
      if (!channel || !channel.isTextBased()) return;

      const message = await channel.messages.fetch(proposal.voting_message_id);
      if (!message) return;

      const { EmbedBuilder } = require('discord.js');
      const embed = message.embeds[0];
      const newEmbed = EmbedBuilder.from(embed);
      const fieldIndex = newEmbed.data.fields.findIndex(f => f.name === '📊 Current Votes');

      if (fieldIndex >= 0) {
        newEmbed.data.fields[fieldIndex].value =
          `✅ Yes: ${proposal.yes_vp} VP\n❌ No: ${proposal.no_vp} VP\n⚖️ Abstain: ${proposal.abstain_vp} VP`;
      }

      await message.edit({ embeds: [newEmbed] });
    } catch (error) {
      logger.error('Error updating voting message:', error);
    }
  }

  async updateVotingMessageFinal(proposalId, finalResult, quorumMet) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal || !proposal.voting_message_id || !this.client) return;

      const settings = settingsManager.getSettings();
      const votingChannelId = settings.votingChannelId || process.env.VOTING_CHANNEL_ID;
      if (!votingChannelId) return;

      const channel = await this.client.channels.fetch(votingChannelId);
      if (!channel || !channel.isTextBased()) return;

      const message = await channel.messages.fetch(proposal.voting_message_id);
      if (!message) return;

      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

      let statusText = '', color = '#808080';
      if (finalResult === 'passed') { statusText = '✅ PASSED'; color = '#00FF00'; }
      else if (finalResult === 'rejected') { statusText = '❌ REJECTED'; color = '#FF0000'; }
      else { statusText = '⚠️ QUORUM NOT MET'; color = '#808080'; }

      const embed = EmbedBuilder.from(message.embeds[0])
        .setTitle(`🗳️ ${proposal.title} - ${statusText}`)
        .setFooter({ text: 'Voting has closed. See results channel for full summary.' });

      const brandingGuildId = String(
        proposal?.guild_id || process.env.GUILD_ID || process.env.DISCORD_GUILD_ID || ''
      ).trim();

      applyEmbedBranding(embed, {
        guildId: brandingGuildId,
        moduleKey: 'governance',
        defaultColor: color,
        defaultFooter: 'Powered by Guild Pilot',
        fallbackLogoUrl: this.client?.user?.displayAvatarURL?.() || null,
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`vote_yes_${proposalId}_disabled`).setLabel('Yes').setStyle(ButtonStyle.Success).setEmoji('✅').setDisabled(true),
        new ButtonBuilder().setCustomId(`vote_no_${proposalId}_disabled`).setLabel('No').setStyle(ButtonStyle.Danger).setEmoji('❌').setDisabled(true),
        new ButtonBuilder().setCustomId(`vote_abstain_${proposalId}_disabled`).setLabel('Abstain').setStyle(ButtonStyle.Secondary).setEmoji('⚖️').setDisabled(true)
      );

      await message.edit({ embeds: [embed], components: [row] });
    } catch (error) {
      logger.error('Error updating final voting message:', error);
    }
  }

  async postToResultsChannel(proposalId, finalResult, quorumMet) {
    try {
      const settings = settingsManager.getSettings();
      const resultsChannelId = settings.resultsChannelId || process.env.RESULTS_CHANNEL_ID;
      if (!resultsChannelId || !this.client) return;

      const proposal = this.getProposal(proposalId);
      if (!proposal) return;

      const channel = await this.client.channels.fetch(resultsChannelId);
      if (!channel || !channel.isTextBased()) return;

      const { EmbedBuilder } = require('discord.js');

      const totalVoted = proposal.yes_vp + proposal.no_vp + proposal.abstain_vp;
      const quorumPercent = proposal.total_vp > 0 ? Math.round((totalVoted / proposal.total_vp) * 100) : 0;
      const voterCount = db.prepare('SELECT COUNT(DISTINCT voter_id) as count FROM votes WHERE proposal_id = ?').get(proposalId).count;

      let statusText = '', color = '#808080';
      if (finalResult === 'passed') { statusText = '✅ PASSED'; color = '#FFD700'; }
      else if (finalResult === 'rejected') { statusText = '❌ REJECTED'; color = '#FF0000'; }
      else { statusText = '⚠️ QUORUM NOT MET'; color = '#808080'; }

      const embed = new EmbedBuilder()
        .setTitle(`📊 Vote Results: ${proposal.title}`)
        .setDescription(`**${statusText}**`)
        .addFields(
          { name: '🆔 Proposal ID', value: proposal.proposal_id, inline: true },
          { name: '👤 Creator', value: `<@${proposal.creator_id}>`, inline: true },
          { name: '📂 Category', value: proposal.category || 'Other', inline: true },
          { name: '✅ Yes Votes', value: `${proposal.yes_vp} VP`, inline: true },
          { name: '❌ No Votes', value: `${proposal.no_vp} VP`, inline: true },
          { name: '⚖️ Abstain', value: `${proposal.abstain_vp} VP`, inline: true },
          { name: '📊 Total Voted', value: `${totalVoted} VP`, inline: true },
          { name: '🎯 Quorum', value: `${quorumPercent}% (needed ${proposal.quorum_required || '25%'})`, inline: true },
          { name: '👥 Voters', value: voterCount.toString(), inline: true }
        )
        .setFooter({ text: `Proposal concluded: ${new Date().toLocaleString()}` })
        .setTimestamp();

      const brandingGuildId = String(
        proposal?.guild_id || process.env.GUILD_ID || process.env.DISCORD_GUILD_ID || ''
      ).trim();

      applyEmbedBranding(embed, {
        guildId: brandingGuildId,
        moduleKey: 'governance',
        defaultColor: color,
        defaultFooter: 'Powered by Guild Pilot',
        fallbackLogoUrl: this.client?.user?.displayAvatarURL?.() || null,
      });

      await channel.send({ embeds: [embed] });
    } catch (error) {
      logger.error('Error posting to results channel:', error);
    }
  }

  // ==================== STALE EXPIRY ====================

  async expireStaleProposals() {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const staleDrafts = db.prepare(`
        SELECT * FROM proposals
        WHERE status = 'draft'
        AND created_at < ?
      `).all(sevenDaysAgo.toISOString());

      for (const proposal of staleDrafts) {
        db.prepare("UPDATE proposals SET status = 'expired' WHERE proposal_id = ?").run(proposal.proposal_id);
        logger.log(`Proposal ${proposal.proposal_id} expired (stale draft)`);
        governanceLogger.log('proposal_expired', { proposalId: proposal.proposal_id, title: proposal.title });
      }
    } catch (error) {
      logger.error('Error expiring stale proposals:', error);
    }
  }
}

module.exports = new ProposalService();
