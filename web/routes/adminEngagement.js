const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminEngagementRouter({
  logger,
  adminAuthMiddleware,
  ensureEngagementModule,
}) {
  const router = express.Router();

  router.get('/api/admin/engagement/config', adminAuthMiddleware, (req, res) => {
    if (!ensureEngagementModule(req, res)) return;

    try {
      const guildId = req.guildId;
      const eng = require('../../services/engagementService');
      return res.json(toSuccessResponse({ config: eng.getConfig(guildId) }));
    } catch (routeError) {
      logger.error('Error loading engagement config:', routeError);
      return res.status(500).json(toErrorResponse(routeError?.message || 'Internal server error'));
    }
  });

  router.put('/api/admin/engagement/config', adminAuthMiddleware, (req, res) => {
    if (!ensureEngagementModule(req, res)) return;

    try {
      const guildId = req.guildId;
      const eng = require('../../services/engagementService');
      const allowed = ['enabled', 'points_message', 'points_reaction', 'cooldown_message_mins', 'cooldown_reaction_daily'];
      const patch = {};
      for (const key of allowed) {
        if (req.body?.[key] !== undefined) patch[key] = req.body[key];
      }
      const updated = eng.setConfig(guildId, patch);
      return res.json(toSuccessResponse({ config: updated }));
    } catch (routeError) {
      logger.error('Error updating engagement config:', routeError);
      return res.status(500).json(toErrorResponse(routeError?.message || 'Internal server error'));
    }
  });

  router.get('/api/admin/engagement/leaderboard', adminAuthMiddleware, (req, res) => {
    if (!ensureEngagementModule(req, res)) return;

    try {
      const guildId = req.guildId;
      const limit = Math.min(parseInt(req.query.limit || '25', 10), 100);
      const eng = require('../../services/engagementService');
      return res.json(toSuccessResponse({ leaderboard: eng.getLeaderboard(guildId, limit) }));
    } catch (routeError) {
      logger.error('Error loading engagement leaderboard:', routeError);
      return res.status(500).json(toErrorResponse(routeError?.message || 'Internal server error'));
    }
  });

  router.get('/api/admin/engagement/shop', adminAuthMiddleware, (req, res) => {
    if (!ensureEngagementModule(req, res)) return;

    try {
      const guildId = req.guildId;
      const eng = require('../../services/engagementService');
      return res.json(toSuccessResponse({ items: eng.getShopItems(guildId) }));
    } catch (routeError) {
      logger.error('Error loading engagement shop:', routeError);
      return res.status(500).json(toErrorResponse(routeError?.message || 'Internal server error'));
    }
  });

  router.post('/api/admin/engagement/shop', adminAuthMiddleware, (req, res) => {
    if (!ensureEngagementModule(req, res)) return;

    try {
      const guildId = req.guildId;
      const { name, description, type, cost, roleId, codes, quantity } = req.body || {};
      if (!name || cost === null || cost === undefined) {
        return res.status(400).json(toErrorResponse('name and cost are required', 'VALIDATION_ERROR'));
      }

      const eng = require('../../services/engagementService');
      const result = eng.addShopItem(guildId, {
        name,
        description,
        type: type || 'role',
        cost: parseInt(cost, 10),
        roleId,
        codes,
        quantity_remaining: quantity !== null && quantity !== undefined ? parseInt(quantity, 10) : -1
      });

      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to create shop item', 'VALIDATION_ERROR', null, result || { success: false }));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error creating engagement shop item:', routeError);
      return res.status(500).json(toErrorResponse(routeError?.message || 'Internal server error'));
    }
  });

  router.delete('/api/admin/engagement/shop/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureEngagementModule(req, res)) return;

    try {
      const guildId = req.guildId;
      const itemId = parseInt(req.params.id, 10);
      const eng = require('../../services/engagementService');
      const result = eng.removeShopItem(guildId, itemId);
      if (result?.success === false) {
        return res.json(toErrorResponse(result.message || 'Failed to delete shop item', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error deleting engagement shop item:', routeError);
      return res.status(500).json(toErrorResponse(routeError?.message || 'Internal server error'));
    }
  });

  return router;
}

module.exports = createAdminEngagementRouter;
