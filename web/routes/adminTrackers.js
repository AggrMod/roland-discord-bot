const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminTrackersRouter({
  logger,
  adminAuthMiddleware,
  ensureNftTrackerModule,
  nftActivityService,
  ensureMinigamesModule,
  battleService,
  ensureWalletTrackerModule,
  trackedWalletsService,
  ensureTokenTrackerModule,
}) {
  const router = express.Router();

  router.get('/api/admin/nft-tracker/collections', adminAuthMiddleware, (req, res) => {
    if (!ensureNftTrackerModule(req, res)) return;
    try {
      const collections = nftActivityService.getTrackedCollections(req.guildId);
      return res.json(toSuccessResponse({ collections }));
    } catch (routeError) {
      logger.error('Error getting tracked collections:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/nft-tracker/collections', adminAuthMiddleware, (req, res) => {
    if (!ensureNftTrackerModule(req, res)) return;
    try {
      const {
        collectionAddress,
        collectionName,
        channelId,
        trackMint,
        trackSale,
        trackList,
        trackDelist,
        trackTransfer,
        trackBid,
        meSymbol
      } = req.body || {};
      const result = nftActivityService.addTrackedCollection({
        guildId: req.guildId,
        collectionAddress,
        collectionName,
        channelId,
        trackMint,
        trackSale,
        trackList,
        trackDelist,
        trackTransfer,
        trackBid,
        meSymbol
      });
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to add tracked collection', 'VALIDATION_ERROR', null, result));
      }
      nftActivityService.syncAddressToHelius(collectionAddress, 'add').catch(() => {});
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error adding tracked collection:', routeError);
      return res.status(500).json(toErrorResponse('Failed to add tracked collection', 'INTERNAL_ERROR', { detail: routeError?.message || 'unknown_error' }));
    }
  });

  router.delete('/api/admin/nft-tracker/collections/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureNftTrackerModule(req, res)) return;
    try {
      const collections = nftActivityService.getTrackedCollections(req.guildId);
      const collection = collections && collections.find(c => String(c.id) === String(req.params.id));
      const result = nftActivityService.removeTrackedCollection(req.params.id, req.guildId);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to remove tracked collection', 'VALIDATION_ERROR', null, result));
      }
      if (collection && collection.collection_address) {
        nftActivityService.syncAddressToHelius(collection.collection_address, 'remove').catch(() => {});
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error removing tracked collection:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/nft-tracker/collections/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureNftTrackerModule(req, res)) return;
    try {
      const result = nftActivityService.updateTrackedCollection(req.params.id, req.body, req.guildId);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update tracked collection', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error updating tracked collection:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/battle/eras', adminAuthMiddleware, (req, res) => {
    if (!ensureMinigamesModule(req, res)) return;
    try {
      const eras = battleService.getAvailableEras(req.guildId);
      return res.json(toSuccessResponse({ eras }));
    } catch (routeError) {
      logger.error('Error fetching battle eras for tenant:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/wallet-tracker/wallets', adminAuthMiddleware, (req, res) => {
    if (!ensureWalletTrackerModule(req, res)) return;
    try {
      const wallets = trackedWalletsService.getTrackedWallets(req.guildId || null);
      return res.json(toSuccessResponse({ wallets }));
    } catch (routeError) {
      logger.error('Error fetching tracked wallets:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/wallet-tracker/wallets', adminAuthMiddleware, (req, res) => {
    if (!ensureWalletTrackerModule(req, res)) return;
    try {
      const { walletAddress, label, alertChannelId, panelChannelId } = req.body || {};
      const result = trackedWalletsService.addTrackedWallet({
        guildId: req.guildId || '',
        walletAddress,
        label: label || null,
        alertChannelId: alertChannelId || null,
        panelChannelId: panelChannelId || null,
      });

      if (!result.success) {
        const status = result.code === 'limit_exceeded' ? 403 : 400;
        return res.status(status).json(toErrorResponse(result.message || 'Failed to add tracked wallet', 'VALIDATION_ERROR', null, result));
      }

      const createdWallet = trackedWalletsService.getTrackedWalletById(result.id, req.guildId || null);
      if (createdWallet?.panel_channel_id) {
        trackedWalletsService
          .postHoldingsPanel(createdWallet, createdWallet.panel_channel_id, req.guildId || null)
          .catch((panelError) => logger.warn('[wallet-panel] auto-post failed after add:', panelError?.message || panelError));
      }

      return res.json(toSuccessResponse({
        id: result.id,
        wallet: createdWallet || null,
      }));
    } catch (routeError) {
      logger.error('Error adding tracked wallet:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/wallet-tracker/wallets/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureWalletTrackerModule(req, res)) return;
    try {
      const updates = {};
      const body = req.body || {};
      if (body.label !== undefined) updates.label = body.label;
      if (body.alertChannelId !== undefined) updates.alertChannelId = body.alertChannelId;
      if (body.panelChannelId !== undefined) updates.panelChannelId = body.panelChannelId;
      if (body.enabled !== undefined) updates.enabled = !!body.enabled;

      const result = trackedWalletsService.updateTrackedWallet(req.params.id, updates, req.guildId || null);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update tracked wallet', 'VALIDATION_ERROR', null, result));
      }

      const wallet = trackedWalletsService.getTrackedWalletById(req.params.id, req.guildId || null);
      return res.json(toSuccessResponse({ wallet }));
    } catch (routeError) {
      logger.error('Error updating tracked wallet:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/wallet-tracker/wallets/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureWalletTrackerModule(req, res)) return;
    try {
      const result = trackedWalletsService.removeTrackedWallet(req.params.id, req.guildId || null);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to remove tracked wallet', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error removing tracked wallet:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/wallet-tracker/wallets/:id/panel', adminAuthMiddleware, async (req, res) => {
    if (!ensureWalletTrackerModule(req, res)) return;
    try {
      const wallet = trackedWalletsService.getTrackedWalletById(req.params.id, req.guildId || null);
      if (!wallet) {
        return res.status(404).json(toErrorResponse('Tracked wallet not found', 'NOT_FOUND'));
      }

      const channelId = String(req.body?.channelId || wallet.panel_channel_id || '').trim();
      if (!channelId) {
        return res.status(400).json(toErrorResponse('No panel channel configured for this wallet', 'VALIDATION_ERROR'));
      }

      const result = await trackedWalletsService.postHoldingsPanel(wallet, channelId, req.guildId || null);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to post wallet panel', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error posting tracked wallet panel:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  const registerTokenTrackerRoutes = (basePath) => {
    router.get(`${basePath}/tokens`, adminAuthMiddleware, (req, res) => {
      if (!ensureTokenTrackerModule(req, res)) return;
      try {
        const tokens = trackedWalletsService.getTrackedTokens(req.guildId || null);
        return res.json(toSuccessResponse({ tokens }));
      } catch (routeError) {
        logger.error(`Error getting tracked tokens (${basePath}):`, routeError);
        return res.status(500).json(toErrorResponse('Internal server error'));
      }
    });

    router.post(`${basePath}/tokens`, adminAuthMiddleware, (req, res) => {
      if (!ensureTokenTrackerModule(req, res)) return;
      try {
        const {
          tokenMint,
          tokenSymbol,
          tokenName,
          decimals,
          enabled,
          alertChannelId,
          alertChannelIds,
          alertBuys,
          alertSells,
          alertTransfers,
          minAlertAmount,
        } = req.body || {};
        const result = trackedWalletsService.addTrackedToken({
          guildId: req.guildId || '',
          tokenMint,
          tokenSymbol: tokenSymbol || null,
          tokenName: tokenName || null,
          decimals: decimals === undefined ? null : decimals,
          enabled: enabled !== false,
          alertChannelId: alertChannelId || null,
          alertChannelIds: Array.isArray(alertChannelIds) ? alertChannelIds : null,
          alertBuys: alertBuys !== false,
          alertSells: alertSells !== false,
          alertTransfers: alertTransfers === true,
          minAlertAmount: minAlertAmount === undefined ? 0 : minAlertAmount,
        });
        if (!result.success) {
          return res.status(400).json(toErrorResponse(result.message || 'Failed to add tracked token', 'VALIDATION_ERROR', null, result));
        }
        return res.json(toSuccessResponse(result));
      } catch (routeError) {
        logger.error(`Error adding tracked token (${basePath}):`, routeError);
        return res.status(500).json(toErrorResponse('Internal server error'));
      }
    });

    router.put(`${basePath}/tokens/:id`, adminAuthMiddleware, (req, res) => {
      if (!ensureTokenTrackerModule(req, res)) return;
      try {
        const updates = {};
        const body = req.body || {};
        if (body.tokenMint !== undefined) updates.tokenMint = body.tokenMint;
        if (body.tokenSymbol !== undefined) updates.tokenSymbol = body.tokenSymbol;
        if (body.tokenName !== undefined) updates.tokenName = body.tokenName;
        if (body.decimals !== undefined) updates.decimals = body.decimals;
        if (body.enabled !== undefined) updates.enabled = !!body.enabled;
        if (body.alertChannelId !== undefined) updates.alertChannelId = body.alertChannelId || null;
        if (body.alertChannelIds !== undefined) updates.alertChannelIds = Array.isArray(body.alertChannelIds) ? body.alertChannelIds : [];
        if (body.alertBuys !== undefined) updates.alertBuys = !!body.alertBuys;
        if (body.alertSells !== undefined) updates.alertSells = !!body.alertSells;
        if (body.alertTransfers !== undefined) updates.alertTransfers = !!body.alertTransfers;
        if (body.minAlertAmount !== undefined) updates.minAlertAmount = body.minAlertAmount;

        const result = trackedWalletsService.updateTrackedToken(req.params.id, updates, req.guildId || null);
        if (!result.success) {
          return res.status(400).json(toErrorResponse(result.message || 'Failed to update tracked token', 'VALIDATION_ERROR', null, result));
        }
        return res.json(toSuccessResponse(result));
      } catch (routeError) {
        logger.error(`Error updating tracked token (${basePath}):`, routeError);
        return res.status(500).json(toErrorResponse('Internal server error'));
      }
    });

    router.delete(`${basePath}/tokens/:id`, adminAuthMiddleware, (req, res) => {
      if (!ensureTokenTrackerModule(req, res)) return;
      try {
        const result = trackedWalletsService.removeTrackedToken(req.params.id, req.guildId || null);
        if (!result.success) {
          return res.status(400).json(toErrorResponse(result.message || 'Failed to remove tracked token', 'VALIDATION_ERROR', null, result));
        }
        return res.json(toSuccessResponse(result));
      } catch (routeError) {
        logger.error(`Error removing tracked token (${basePath}):`, routeError);
        return res.status(500).json(toErrorResponse('Internal server error'));
      }
    });

    router.get(`${basePath}/token-events`, adminAuthMiddleware, (req, res) => {
      if (!ensureTokenTrackerModule(req, res)) return;
      try {
        const limit = Number(req.query.limit || 30);
        const events = trackedWalletsService.listTrackedTokenEvents(req.guildId || null, limit);
        return res.json(toSuccessResponse({ events }));
      } catch (routeError) {
        logger.error(`Error listing tracked token events (${basePath}):`, routeError);
        return res.status(500).json(toErrorResponse('Internal server error'));
      }
    });
  };

  registerTokenTrackerRoutes('/api/admin/token-tracker');

  return router;
}

module.exports = createAdminTrackersRouter;
