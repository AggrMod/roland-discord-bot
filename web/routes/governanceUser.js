const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createGovernanceUserRouter({
  logger,
  roleService,
  proposalService,
  tenantService,
  getRequestedGuildId,
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
    const { title, description } = body || {};
    if (!title?.trim()) return 'Title is required';
    if (title.length > 200) return 'Title must be 200 characters or less';
    if (!description?.trim()) return 'Description is required';
    if (description.length > 5000) return 'Description must be 5000 characters or less';
    return null;
  };

  const createProposalHandler = async (req, res, sourceLabel = 'user') => {
    if (!requireSession(req, res)) return;

    try {
      const discordId = req.session.discordUser.id;
      const allowFallback = !tenantService.isMultitenantEnabled();
      const requestedGuildId = getRequestedGuildId(req, { allowFallback });
      const { title, description, category, costIndication } = req.body || {};

      if (!requestedGuildId) {
        return res.status(409).json(toErrorResponse('Select a server to continue', 'TENANT_REQUIRED', null, { success: false }));
      }

      const validationErr = validateProposalInput(req.body || {});
      if (validationErr) {
        return res.status(400).json(toErrorResponse(validationErr, 'VALIDATION_ERROR', null, { success: false }));
      }

      const userInfo = await roleService.getUserInfo(discordId);
      if (!userInfo || !userInfo.voting_power || userInfo.voting_power < 1) {
        return res.status(403).json(toErrorResponse('You need at least 1 verified NFT to create proposals', 'FORBIDDEN', null, { success: false }));
      }

      const result = proposalService.createProposal(discordId, {
        title,
        description,
        category: category || 'Other',
        costIndication: costIndication || null,
        guildId: requestedGuildId || ''
      });

      if (result?.success) {
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

      if (!proposalId || !choice) {
        return res.status(400).json(toErrorResponse('proposalId and choice are required', 'VALIDATION_ERROR', null, { success: false }));
      }

      if (!['yes', 'no', 'abstain'].includes(String(choice).toLowerCase())) {
        return res.status(400).json(toErrorResponse('Choice must be yes, no, or abstain', 'VALIDATION_ERROR', null, { success: false }));
      }

      const userInfo = await roleService.getUserInfo(discordId);
      if (!userInfo || !userInfo.voting_power || userInfo.voting_power < 1) {
        return res.status(403).json(toErrorResponse('You need at least 1 verified NFT to vote', 'FORBIDDEN', null, { success: false }));
      }

      const result = proposalService.castVote(proposalId, discordId, String(choice).toLowerCase(), userInfo.voting_power);
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
      const requestedGuildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!requestedGuildId) {
        return res.status(409).json(toErrorResponse('Select a server to continue', 'TENANT_REQUIRED', null, { success: false }));
      }
      if (!isProposalInGuildScope(req.params.id, requestedGuildId)) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND', null, { success: false }));
      }

      const result = proposalService.addSupporter(req.params.id, req.session.discordUser.id);
      if (result?.success) {
        return res.json(toSuccessResponse(result));
      }
      return res.status(400).json(toErrorResponse(result?.message || 'Failed to support proposal', 'VALIDATION_ERROR', null, result));
    } catch (routeError) {
      logger.error('Error adding support:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

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

  router.post('/api/governance/proposals/:id/comments', commentLimiter, (req, res) => {
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

      const { reason } = req.body || {};
      const result = proposalService.vetoProposal(req.params.id, req.session.discordUser.id, reason);
      if (result?.success) {
        return res.json(toSuccessResponse(result));
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
