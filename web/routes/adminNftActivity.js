const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminNftActivityRouter({
  logger,
  adminAuthMiddleware,
  ensureNftTrackerModule,
  nftActivityService,
}) {
  const router = express.Router();

  router.get('/api/admin/nft-activity/events', adminAuthMiddleware, (req, res) => {
    if (!ensureNftTrackerModule(req, res)) return;

    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
      const events = nftActivityService.listEventsForGuild(req.guildId, limit);
      return res.json(toSuccessResponse({ events }));
    } catch (routeError) {
      logger.error('Error fetching nft activity events:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/nft-activity/config', adminAuthMiddleware, (req, res) => {
    if (!ensureNftTrackerModule(req, res)) return;

    try {
      const config = nftActivityService.getAlertConfig(req.guildId);
      if (!config) {
        return res.status(500).json(toErrorResponse('Failed to load NFT activity config'));
      }
      return res.json(toSuccessResponse({ config }));
    } catch (routeError) {
      logger.error('Error getting NFT activity config:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/nft-activity/config', adminAuthMiddleware, (req, res) => {
    if (!ensureNftTrackerModule(req, res)) return;

    try {
      const { enabled, channelId, eventTypes, minSol } = req.body || {};
      const result = nftActivityService.updateAlertConfig(req.guildId, { enabled, channelId, eventTypes, minSol });
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update NFT activity config', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse({ message: 'NFT activity config updated' }));
    } catch (routeError) {
      logger.error('Error updating NFT activity config:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createAdminNftActivityRouter;
