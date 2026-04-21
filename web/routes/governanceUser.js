const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createGovernanceUserRouter({
  logger,
  roleService,
  proposalService,
  tenantService,
  getRequestedGuildId,
  fetchGuildById,
  settingsManager,
  isProposalInGuildScope,
  ensurePublicGovernanceScope,
  commentLimiter,
}) {
  const router = express.Router();

  const requireSession = (req, res) => {
    if (req.session?.discordUser) return true;
    res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED', null, { success: false }));
    return false;
  };

  const validateProposalInput = (body) => {
    const { title, goal, description, costIndication } = body || {};
    if (!title?.trim()) return 'Title is required';
    if (title.length > 200) return 'Title must be 200 characters or less';
    if (!goal?.trim()) return 'Goal is required';
    if (String(goal).length > 500) return 'Goal must be 500 characters or less';
    if (!description?.trim()) return 'Description is required';
    if (description.length > 5000) return 'Description must be 5000 characters or less';
    if (!String(costIndication || '').trim()) return 'Cost indication is required';
    if (String(costIndication || '').trim().length > 200) return 'Cost indication must be 200 characters or less';
    return null;
  };

  const isCreatorCancellableStatus = (status) => (
    (() => {
      const normalizedStatus = String(status || '').toLowerCase();
      return ['draft', 'pending_review', 'on_hold', 'supporting', 'voting'].includes(normalizedStatus);
    })()
  );

  const resolveEffectiveVotingPower = async (discordId, guildId) => {
    const normalizedGuildId = String(guildId || '').trim();
    const userInfo = await roleService.getUserInfo(discordId);
    let votingPower = Number(userInfo?.voting_power || 0);

    if (normalizedGuildId && typeof fetchGuildById === 'function') {
      try {
        const guild = await fetchGuildById(normalizedGuildId);
        if (guild) {
          const member = await guild.members.fetch(discordId).catch(() => null);
          if (member) {
            votingPower = Number(roleService.getUserVotingPower(discordId, member, normalizedGuildId) || 0);
          }
        }
      } catch (_error) {
        // Fallback to stored voting power if Discord member lookup fails.
      }
    }

    return { userInfo, votingPower };
  };

  const normalizeRoleName = (value) => String(value || '').trim().toLowerCase();
  const normalizeComparableDiscordId = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const numericMatch = raw.match(/\d{17,20}/);
    if (numericMatch) return numericMatch[0];
    return raw;
  };

  const getCouncilMemberIds = async (guildId) => {
    const normalizedGuildId = String(guildId || '').trim();
    if (!normalizedGuildId || typeof fetchGuildById !== 'function') return [];

    const guild = await fetchGuildById(normalizedGuildId).catch(() => null);
    if (!guild) return [];

    const trusteeRoleNames = Array.isArray(settingsManager?.getSettings?.()?.staffTrusteeRoles)
      ? settingsManager.getSettings().staffTrusteeRoles.map(normalizeRoleName).filter(Boolean)
      : [];

    let membersCollection = guild.members?.cache;
    try {
      membersCollection = await guild.members.fetch();
    } catch (_error) {
      // fall back to current cache
    }

    const council = new Set();
    for (const member of membersCollection.values()) {
      if (
        member.permissions?.has?.(PermissionFlagsBits.Administrator)
        || member.permissions?.has?.(PermissionFlagsBits.ManageGuild)
      ) {
        council.add(member.id);
        continue;
      }
      if (
        trusteeRoleNames.length
        && member.roles?.cache?.some((role) => trusteeRoleNames.includes(normalizeRoleName(role?.name)))
      ) {
        council.add(member.id);
      }
    }
    return [...council];
  };

  const canMemberVetoProposal = async (discordId, guildId) => {
    const councilMemberIds = await getCouncilMemberIds(guildId);
    return councilMemberIds.includes(String(discordId || '').trim());
  };

  const createProposalHandler = async (req, res, sourceLabel = 'user') => {
    if (!requireSession(req, res)) return;

    try {
      const discordId = req.session.discordUser.id;
      const allowFallback = !tenantService.isMultitenantEnabled();
      const requestedGuildId = getRequestedGuildId(req, { allowFallback });
      const { title, goal, description, category, costIndication } = req.body || {};

      if (!requestedGuildId) {
        return res.status(409).json(toErrorResponse('Select a server to continue', 'TENANT_REQUIRED', null, { success: false }));
      }

      const validationErr = validateProposalInput(req.body || {});
      if (validationErr) {
        return res.status(400).json(toErrorResponse(validationErr, 'VALIDATION_ERROR', null, { success: false }));
      }

      const { userInfo, votingPower } = await resolveEffectiveVotingPower(discordId, requestedGuildId);
      if (!userInfo || votingPower < 1) {
        return res.status(403).json(toErrorResponse('You need at least 1 verified NFT to create proposals', 'FORBIDDEN', null, { success: false }));
      }

      const result = proposalService.createProposal(discordId, {
        title,
        goal,
        description,
        category: category || 'Other',
        costIndication: String(costIndication || '').trim(),
        guildId: requestedGuildId || '',
        initialStatus: 'supporting'
      });

      if (result?.success) {
        await proposalService.postToProposalsChannel(result.proposalId, {
          creatorDisplayName: req.session?.discordUser?.username || ''
        });
        return res.json(toSuccessResponse(result));
      }
      return res.status(400).json(toErrorResponse(result?.message || 'Failed to create proposal', 'VALIDATION_ERROR', null, result));
    } catch (routeError) {
      logger.error(`Error creating proposal via ${sourceLabel}:`, routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  };

  router.post('/api/user/vote', async (req, res) => {
    if (!requireSession(req, res)) return;

    try {
      const discordId = req.session.discordUser.id;
      const { proposalId, choice } = req.body || {};
      const requestedGuildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });

      if (!proposalId || !choice) {
        return res.status(400).json(toErrorResponse('proposalId and choice are required', 'VALIDATION_ERROR', null, { success: false }));
      }
      if (!requestedGuildId) {
        return res.status(409).json(toErrorResponse('Select a server to continue', 'TENANT_REQUIRED', null, { success: false }));
      }
      if (!isProposalInGuildScope(proposalId, requestedGuildId)) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND', null, { success: false }));
      }

      if (!['yes', 'no', 'abstain'].includes(String(choice).toLowerCase())) {
        return res.status(400).json(toErrorResponse('Choice must be yes, no, or abstain', 'VALIDATION_ERROR', null, { success: false }));
      }

      const { userInfo, votingPower } = await resolveEffectiveVotingPower(discordId, requestedGuildId);
      if (!userInfo || votingPower < 1) {
        return res.status(403).json(toErrorResponse('You need at least 1 verified NFT to vote', 'FORBIDDEN', null, { success: false }));
      }

      const result = proposalService.castVote(proposalId, discordId, String(choice).toLowerCase(), votingPower);
      if (result?.success) {
        proposalService.updateVotingMessage(proposalId).catch(() => {});
        return res.json(toSuccessResponse(result));
      }
      return res.status(400).json(toErrorResponse(result?.message || 'Failed to cast vote', 'VALIDATION_ERROR', null, result));
    } catch (routeError) {
      logger.error('Error casting vote via web:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/user/proposals', async (req, res) => {
    return createProposalHandler(req, res, 'user');
  });

  router.post('/api/governance/proposals', async (req, res) => {
    return createProposalHandler(req, res, 'governance');
  });

  router.post('/api/governance/proposals/:id/submit', (req, res) => {
    if (!requireSession(req, res)) return;

    try {
      const requestedGuildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!requestedGuildId) {
        return res.status(409).json(toErrorResponse('Select a server to continue', 'TENANT_REQUIRED', null, { success: false }));
      }
      if (!isProposalInGuildScope(req.params.id, requestedGuildId)) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND', null, { success: false }));
      }

      const result = proposalService.submitForReview(req.params.id, req.session.discordUser.id);
      if (result?.success) {
        return res.json(toSuccessResponse(result));
      }
      return res.status(400).json(toErrorResponse(result?.message || 'Failed to submit proposal', 'VALIDATION_ERROR', null, result));
    } catch (routeError) {
      logger.error('Error submitting proposal for review:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/governance/proposals/:id/support', async (req, res) => {
    if (!requireSession(req, res)) return;

    try {
      const discordId = req.session.discordUser.id;
      const requestedGuildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!requestedGuildId) {
        return res.status(409).json(toErrorResponse('Select a server to continue', 'TENANT_REQUIRED', null, { success: false }));
      }
      if (!isProposalInGuildScope(req.params.id, requestedGuildId)) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND', null, { success: false }));
      }

      const { userInfo, votingPower } = await resolveEffectiveVotingPower(discordId, requestedGuildId);
      if (!userInfo || votingPower < 1) {
        return res.status(403).json(toErrorResponse('You need at least 1 verified NFT to support proposals', 'FORBIDDEN', null, { success: false }));
      }

      const proposal = proposalService.getProposal(req.params.id);
      const result = proposalService.addSupporter(req.params.id, discordId);
      if (result?.success) {
        let promoted = false;
        const supportThreshold = Number(settingsManager?.getSettings?.()?.supportThreshold || 4);

        if (String(proposal?.status || '').toLowerCase() === 'supporting' && Number(result.supporterCount || 0) >= supportThreshold) {
          const promoteResult = await proposalService.promoteToVoting(req.params.id, discordId);
          if (promoteResult?.success) {
            promoted = true;
          }
        }

        if (!promoted) {
          const refreshedProposal = proposalService.getProposal(req.params.id);
          promoted = String(refreshedProposal?.status || '').toLowerCase() === 'voting';
          if (!promoted && String(refreshedProposal?.status || '').toLowerCase() === 'supporting') {
            proposalService.postToProposalsChannel(req.params.id).catch(() => {});
          }
        }

        return res.json(toSuccessResponse({ ...result, promoted }));
      }
      return res.status(400).json(toErrorResponse(result?.message || 'Failed to support proposal', 'VALIDATION_ERROR', null, result));
    } catch (routeError) {
      logger.error('Error adding support:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  const cancelProposalHandler = async (req, res) => {
    if (!requireSession(req, res)) return;

    try {
      const discordId = req.session.discordUser.id;

      const proposal = proposalService.getProposal(req.params.id);
      if (!proposal) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND', null, { success: false }));
      }
      const requestedGuildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      const proposalGuildId = String(proposal.guild_id || '').trim();
      if (proposalGuildId && requestedGuildId && proposalGuildId !== String(requestedGuildId || '').trim()) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND', null, { success: false }));
      }
      if (normalizeComparableDiscordId(proposal.creator_id) !== normalizeComparableDiscordId(discordId)) {
        return res.status(403).json(toErrorResponse('Only the proposal creator can cancel this proposal', 'FORBIDDEN', null, { success: false }));
      }
      if (!isCreatorCancellableStatus(proposal.status)) {
        return res.status(400).json(toErrorResponse(`Proposal cannot be cancelled in status "${proposal.status}"`, 'VALIDATION_ERROR', null, { success: false }));
      }

      const effectiveGuildId = requestedGuildId || proposalGuildId || '';
      const result = proposalService.cancelProposal(req.params.id, discordId, effectiveGuildId);
      if (result?.success) {
        return res.json(toSuccessResponse(result));
      }
      return res.status(400).json(toErrorResponse(result?.message || 'Failed to cancel proposal', 'VALIDATION_ERROR', null, result));
    } catch (routeError) {
      logger.error('Error cancelling proposal:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  };

  router.post('/api/governance/proposals/:id/cancel', cancelProposalHandler);
  router.post('/api/user/proposals/:id/cancel', cancelProposalHandler);

  router.get('/api/governance/proposals/:id/comments', (req, res) => {
    try {
      const scopedGuildId = ensurePublicGovernanceScope(req, res);
      if (scopedGuildId === null) return;
      if (!isProposalInGuildScope(req.params.id, scopedGuildId)) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND', null, { success: false }));
      }

      const comments = proposalService.getComments(req.params.id);
      return res.json(toSuccessResponse({ comments }, null));
    } catch (routeError) {
      logger.error('Error fetching proposal comments:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/governance/proposals/:id/comments', commentLimiter, async (req, res) => {
    if (!requireSession(req, res)) return;

    try {
      const requestedGuildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!requestedGuildId) {
        return res.status(409).json(toErrorResponse('Select a server to continue', 'TENANT_REQUIRED', null, { success: false }));
      }
      if (!isProposalInGuildScope(req.params.id, requestedGuildId)) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND', null, { success: false }));
      }

      const { content } = req.body || {};
      if (!content || !String(content).trim()) {
        return res.status(400).json(toErrorResponse('Content is required', 'VALIDATION_ERROR', null, { success: false }));
      }
      if (String(content).length > 1000) {
        return res.status(400).json(toErrorResponse('Comment must be 1000 characters or less', 'VALIDATION_ERROR', null, { success: false }));
      }

      const result = proposalService.addComment(
        req.params.id,
        req.session.discordUser.id,
        req.session.discordUser.username,
        String(content).trim()
      );
      if (result?.success) {
        proposalService.postCommentToDiscussion(req.params.id, result.comment, { source: 'web' }).catch((error) => {
          logger.warn(`Failed to mirror proposal comment ${req.params.id} to Discord discussion: ${error?.message || error}`);
        });
        return res.json(toSuccessResponse(result));
      }
      return res.status(400).json(toErrorResponse(result?.message || 'Failed to add comment', 'VALIDATION_ERROR', null, result));
    } catch (routeError) {
      logger.error('Error adding proposal comment:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/governance/proposals/:id/veto', async (req, res) => {
    if (!requireSession(req, res)) return;

    try {
      const requestedGuildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!requestedGuildId) {
        return res.status(409).json(toErrorResponse('Select a server to continue', 'TENANT_REQUIRED', null, { success: false }));
      }
      if (!isProposalInGuildScope(req.params.id, requestedGuildId)) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND', null, { success: false }));
      }
      const proposal = proposalService.getProposal(req.params.id);
      if (!proposal) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND', null, { success: false }));
      }
      if (String(proposal.status || '').toLowerCase() !== 'passed') {
        return res.status(400).json(toErrorResponse('Veto is only available for passed proposals', 'VALIDATION_ERROR', null, { success: false }));
      }
      const canVeto = await canMemberVetoProposal(req.session.discordUser.id, requestedGuildId);
      if (!canVeto) {
        return res.status(403).json(toErrorResponse('Only governance trustees can cast veto votes', 'FORBIDDEN', null, { success: false }));
      }

      const { reason } = req.body || {};
      const result = proposalService.vetoProposal(req.params.id, req.session.discordUser.id, reason);
      if (result?.success) {
        const councilMemberIds = await getCouncilMemberIds(requestedGuildId);
        const vetoVoterIds = Array.isArray(result.vetoVoterIds) ? result.vetoVoterIds.map(String) : [];
        const vetoSet = new Set(vetoVoterIds);
        const outstandingCouncil = councilMemberIds.filter((memberId) => !vetoSet.has(String(memberId)));
        let vetoApplied = false;
        if (councilMemberIds.length > 0 && outstandingCouncil.length === 0) {
          const applyResult = proposalService.applyVeto(req.params.id, reason || 'Unanimous council veto');
          vetoApplied = !!applyResult?.success;
        }

        return res.json(toSuccessResponse({
          ...result,
          vetoApplied,
          councilRequired: councilMemberIds.length,
          councilRemaining: outstandingCouncil.length,
        }));
      }
      return res.status(400).json(toErrorResponse(result?.message || 'Failed to veto proposal', 'VALIDATION_ERROR', null, result));
    } catch (routeError) {
      logger.error('Error vetoing proposal:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createGovernanceUserRouter;
