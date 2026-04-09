const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminTicketsRouter({
  logger,
  adminAuthMiddleware,
  ensureTicketingModule,
  ticketService,
}) {
  const router = express.Router();

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
