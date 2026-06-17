const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminTicketsRouter({
  logger,
  adminAuthMiddleware,
  ensureTicketingModule,
  ticketService,
  vaultService,
}) {
  const router = express.Router();

  function parseTicketTemplateResponses(ticket) {
    try {
      const parsed = JSON.parse(ticket?.template_responses || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function getVaultRewardIdFromTicket(ticket) {
    const responses = parseTicketTemplateResponses(ticket);
    const direct = responses['Vault Reward ID'] || responses.vaultRewardId || responses.rewardId || responses['Vault Claim ID'] || responses.vaultClaimId || responses.claimId;
    const parsedDirect = Number.parseInt(String(direct || '').trim(), 10);
    if (Number.isFinite(parsedDirect) && parsedDirect > 0) return parsedDirect;
    const combined = Object.values(responses).map(value => String(value || '')).join('\n');
    const match = combined.match(/Vault (?:Reward|Claim) ID:\s*(\d+)/i);
    if (match) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  }

  router.get('/api/admin/tickets/categories', adminAuthMiddleware, (req, res) => {
    if (!ensureTicketingModule(req, res)) return;
    try {
      const categories = ticketService.getAllCategories(req.guildId);
      return res.json(toSuccessResponse({ categories }));
    } catch (routeError) {
      logger.error('Error fetching ticket categories:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/tickets/categories', adminAuthMiddleware, (req, res) => {
    if (!ensureTicketingModule(req, res)) return;
    try {
      const {
        name,
        emoji,
        description,
        parentChannelId,
        closedParentChannelId,
        allowedRoleIds,
        handlerRoleIds,
        pingRoleIds,
        templateFields
      } = req.body || {};

      if (!name) {
        return res.status(400).json(toErrorResponse('Name is required', 'VALIDATION_ERROR'));
      }
      const result = ticketService.addCategory(
        { name, emoji, description, parentChannelId, closedParentChannelId, allowedRoleIds, handlerRoleIds, pingRoleIds, templateFields },
        req.guildId
      );
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to add category', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error adding ticket category:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/tickets/categories/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureTicketingModule(req, res)) return;
    try {
      const result = ticketService.updateCategory(parseInt(req.params.id, 10), req.body, req.guildId);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update category', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error updating ticket category:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/tickets/categories/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureTicketingModule(req, res)) return;
    try {
      const result = ticketService.deleteCategory(parseInt(req.params.id, 10), req.guildId);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to delete category', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error deleting ticket category:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/tickets', adminAuthMiddleware, (req, res) => {
    if (!ensureTicketingModule(req, res)) return;
    try {
      const { status, statuses, category, opener, q, from, to } = req.query;
      const statusList = typeof statuses === 'string' && statuses.trim()
        ? statuses.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      const allTickets = ticketService.getAllTickets({
        guildId: req.guildId || '',
        status,
        statuses: statusList,
        category: category ? parseInt(category, 10) : undefined,
        opener,
        q,
        from,
        to
      });
      const totalCount = allTickets.length;
      const tickets = allTickets.slice(offset, offset + limit);

      return res.json(toSuccessResponse({ tickets, total: totalCount, limit, offset }));
    } catch (routeError) {
      logger.error('Error fetching tickets:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/tickets/:id/transcript', adminAuthMiddleware, async (req, res) => {
    if (!ensureTicketingModule(req, res)) return;
    try {
      const ticket = ticketService.getTicketById(parseInt(req.params.id, 10), req.guildId);
      if (!ticket) {
        return res.status(404).json(toErrorResponse('Ticket not found', 'NOT_FOUND'));
      }
      const result = await ticketService.getTranscript(ticket.channel_id);
      if (!result.success) {
        return res.status(404).json(toErrorResponse(result.message || 'Transcript not found', 'NOT_FOUND', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error fetching ticket transcript:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/tickets/:id/vault-claim-status', adminAuthMiddleware, async (req, res) => {
    if (!ensureTicketingModule(req, res)) return;
    try {
      if (!vaultService || typeof vaultService.updateRewardClaimStatus !== 'function') {
        return res.status(503).json(toErrorResponse('Vault service is unavailable', 'SERVICE_UNAVAILABLE'));
      }
      const ticket = ticketService.getTicketById(parseInt(req.params.id, 10), req.guildId);
      if (!ticket) {
        return res.status(404).json(toErrorResponse('Ticket not found', 'NOT_FOUND'));
      }
      const claimId = getVaultRewardIdFromTicket(ticket);
      if (!claimId) {
        return res.status(400).json(toErrorResponse('This ticket is not linked to a Vault reward', 'VALIDATION_ERROR'));
      }
      const claimStatus = String(req.body?.claimStatus || req.body?.claim_status || '').trim();
      const claimNote = req.body?.claimNote || req.body?.claim_note || `Updated from ticket #${ticket.ticket_number || ticket.id}`;
      const result = await vaultService.updateRewardClaimStatus(req.guildId || '', claimId, claimStatus, claimNote);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update Vault claim status', 'VALIDATION_ERROR', null, result));
      }
      vaultService.logAdminAction(req.guildId || '', req.session?.discordUser?.id || null, 'reward_claim_status_from_ticket', result.reward?.discord_user_id || null, {
        ticketId: Number(ticket.id),
        ticketNumber: Number(ticket.ticket_number || 0) || null,
        rewardId: claimId,
        claimStatus,
        claimNote: claimNote ? String(claimNote) : null,
      });
      return res.json(toSuccessResponse({ ...result, claimId, ticketId: ticket.id }));
    } catch (routeError) {
      logger.error('Error updating Vault claim status from ticket:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/tickets/panel', adminAuthMiddleware, async (req, res) => {
    if (!ensureTicketingModule(req, res)) return;
    try {
      const { channelId, title, description } = req.body || {};
      if (!channelId) {
        return res.status(400).json(toErrorResponse('channelId is required', 'VALIDATION_ERROR'));
      }
      const result = await ticketService.postOrUpdatePanel(channelId, { title, description }, req.guildId);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to post ticket panel', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error posting ticket panel:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createAdminTicketsRouter;
