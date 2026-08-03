const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');
const { getChain, normalizeAddress } = require('../../utils/chainIdentity');
const evmService = require('../../services/evmService');

async function resolveWithin(promise, timeoutMs) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => {
        timeoutId = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function resolveTrackedCollectionMetadata({ nftActivityService, chainValue, collectionAddress, timeoutMs = 6000 }) {
  const chain = getChain(chainValue || 'solana:mainnet');
  const normalizedAddress = normalizeAddress(collectionAddress, chain?.chainId);
  if (!chain || !normalizedAddress) {
    return { success: false, message: 'A supported network and valid collection address are required' };
  }

  const metadataPromise = chain.family === 'evm'
    ? evmService.getNftCollectionMetadata(normalizedAddress, chain.chainId)
    : nftActivityService.resolveTokenAssetMeta(normalizedAddress);
  const metadata = await resolveWithin(metadataPromise, timeoutMs);
  const name = String(metadata?.name || '').trim();
  if (!name) {
    return {
      success: false,
      message: 'The collection name could not be resolved automatically. Enter it manually to continue.',
      chainId: chain.chainId,
      collectionAddress: normalizedAddress,
    };
  }

  return {
    success: true,
    name,
    symbol: String(metadata?.symbol || '').trim() || null,
    chainId: chain.chainId,
    collectionAddress: normalizedAddress,
  };
}

function createAdminTrackersRouter({
  logger,
  adminAuthMiddleware,
  ensureNftTrackerModule,
  nftActivityService,
  ensureMinigamesModule,
  battleService,
  ensureWalletTrackerModule,
  trackedWalletsService,
  ensureInviteTrackerModule,
  inviteTrackerService,
  ensureTokenTrackerModule,
  treasuryService,
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

  router.post('/api/admin/nft-tracker/collections/resolve-metadata', adminAuthMiddleware, async (req, res) => {
    if (!ensureNftTrackerModule(req, res)) return;
    try {
      const result = await resolveTrackedCollectionMetadata({
        nftActivityService,
        chainValue: req.body?.chain || 'solana:mainnet',
        collectionAddress: req.body?.collectionAddress,
      });
      if (!result.success) {
        return res.status(422).json(toErrorResponse(result.message, 'METADATA_NOT_FOUND', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.warn(`NFT collection metadata resolution failed: ${routeError?.message || routeError}`);
      return res.status(422).json(toErrorResponse(
        'The collection name could not be resolved automatically. Enter it manually to continue.',
        'METADATA_NOT_FOUND'
      ));
    }
  });

  router.post('/api/admin/nft-tracker/collections', adminAuthMiddleware, async (req, res) => {
    if (!ensureNftTrackerModule(req, res)) return;
    try {
      const {
        collectionAddress,
        chain,
        collectionName,
        channelId,
        nftStandard,
        tokenId,
        trackMint,
        trackSale,
        trackList,
        trackDelist,
        trackTransfer,
        trackBid,
        meSymbol
      } = req.body || {};
      const explicitCollectionName = String(collectionName || '').trim();
      let resolvedCollectionName = '';
      try {
        const metadata = await resolveTrackedCollectionMetadata({
          nftActivityService,
          chainValue: chain || 'solana:mainnet',
          collectionAddress,
        });
        resolvedCollectionName = metadata.success ? metadata.name : '';
      } catch (metadataError) {
        logger.warn(`NFT collection name lookup failed while saving: ${metadataError?.message || metadataError}`);
      }
      const effectiveCollectionName = resolvedCollectionName || explicitCollectionName;
      const result = nftActivityService.addTrackedCollection({
        guildId: req.guildId,
        chain: chain || 'solana:mainnet',
        collectionAddress,
        collectionName: effectiveCollectionName,
        channelId,
        nftStandard,
        tokenId,
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
      if (!String(chain || 'solana:mainnet').startsWith('eip155:')) {
        nftActivityService.syncAddressToHelius(collectionAddress, 'add').catch(() => {});
      }
      return res.json(toSuccessResponse({
        ...result,
        collectionName: effectiveCollectionName,
        metadataResolved: Boolean(resolvedCollectionName),
      }));
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
      if (collection && collection.collection_address && String(collection.chain_family || 'solana') === 'solana') {
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

  router.get('/api/admin/treasury', adminAuthMiddleware, (req, res) => {
    if (!ensureWalletTrackerModule(req, res)) return;
    try {
      const summary = treasuryService?.getAdminSummary?.(req.guildId || null);
      if (!summary?.success) {
        return res.status(400).json(toErrorResponse(summary?.message || 'Failed to load treasury config', 'VALIDATION_ERROR', null, summary || null));
      }
      return res.json(toSuccessResponse(summary));
    } catch (routeError) {
      logger.error('Error loading treasury admin summary:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/treasury/config', adminAuthMiddleware, (req, res) => {
    if (!ensureWalletTrackerModule(req, res)) return;
    try {
      const body = req.body || {};
      const result = treasuryService?.updateConfig?.({
        enabled: body.enabled,
        solanaWallet: body.solanaWallet ?? body.walletAddress ?? body.treasuryWalletAddress,
        refreshHours: body.refreshHours ?? body.treasuryRefreshInterval,
        txAlertsEnabled: body.txAlertsEnabled ?? body.treasuryAlerts ?? body.tx_alerts_enabled,
        txAlertChannelId: body.txAlertChannelId ?? body.treasuryAlertsChannel ?? body.tx_alert_channel_id,
        txAlertIncomingOnly: body.txAlertIncomingOnly ?? body.tx_alert_incoming_only,
        txAlertMinSol: body.txAlertMinSol ?? body.tx_alert_min_sol,
        watchChannelId: body.watchChannelId ?? body.watch_channel_id,
      }, req.guildId || null);
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to update treasury config', 'VALIDATION_ERROR', null, result || null));
      }
      const summary = treasuryService?.getAdminSummary?.(req.guildId || null);
      return res.json(toSuccessResponse({
        ...result,
        config: summary?.config || null,
      }));
    } catch (routeError) {
      logger.error('Error updating treasury config:', routeError);
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

  router.get('/api/admin/wallet-tracker/balances', adminAuthMiddleware, async (req, res) => {
    if (!ensureWalletTrackerModule(req, res)) return;
    try {
      const summary = await trackedWalletsService.getTrackedWalletBalanceSummary(req.guildId || null, {
        includeDisabled: false,
      });
      if (!summary.success) {
        return res.status(400).json(toErrorResponse(summary.message || 'Failed to load wallet balances', 'VALIDATION_ERROR', null, summary));
      }
      return res.json(toSuccessResponse(summary));
    } catch (routeError) {
      logger.error('Error fetching tracked wallet balances:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/wallet-tracker/wallets', adminAuthMiddleware, (req, res) => {
    if (!ensureWalletTrackerModule(req, res)) return;
    try {
      const { walletAddress, chain, label, alertChannelId, panelChannelId } = req.body || {};
      const result = trackedWalletsService.addTrackedWallet({
        guildId: req.guildId || '',
        walletAddress,
        chain: chain || 'solana:mainnet',
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

  router.get('/api/admin/invites/summary', adminAuthMiddleware, (req, res) => {
    if (!ensureInviteTrackerModule(req, res)) return;
    try {
      const result = inviteTrackerService.getSummary(req.guildId || null);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to load invite summary', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error loading invite summary:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/invites/settings', adminAuthMiddleware, (req, res) => {
    if (!ensureInviteTrackerModule(req, res)) return;
    try {
      const result = inviteTrackerService.getSettings(req.guildId || null);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to load invite tracker settings', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error loading invite tracker settings:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/invites/settings', adminAuthMiddleware, (req, res) => {
    if (!ensureInviteTrackerModule(req, res)) return;
    try {
      const body = req.body || {};
      const result = inviteTrackerService.saveSettings(req.guildId || null, {
        requiredJoinRoleId: body.requiredJoinRoleId,
        panelChannelId: body.panelChannelId,
        panelMessageId: body.panelMessageId,
        panelPeriodDays: body.panelPeriodDays,
        panelLimit: body.panelLimit,
        panelEnableCreateLink: body.panelEnableCreateLink,
        includeVerificationStats: body.includeVerificationStats,
        excludedCodes: body.excludedCodes,
        panelSortBy: body.panelSortBy,
        inviterAccountAgeFilterEnabled: body.inviterAccountAgeFilterEnabled,
        inviterMinAccountAgeHours: body.inviterMinAccountAgeHours,
      });
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to save invite tracker settings', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error saving invite tracker settings:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/invites/events', adminAuthMiddleware, (req, res) => {
    if (!ensureInviteTrackerModule(req, res)) return;
    try {
      const limit = Number(req.query.limit || 50);
      const days = req.query.days === undefined ? null : Number(req.query.days);
      const result = inviteTrackerService.listEvents(req.guildId || null, { limit, days });
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to load invite events', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error loading invite events:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/invites/leaderboard', adminAuthMiddleware, async (req, res) => {
    if (!ensureInviteTrackerModule(req, res)) return;
    try {
      const limit = Number(req.query.limit || 25);
      const days = req.query.days === undefined ? null : Number(req.query.days);
      const requiredJoinRoleId = req.query.requiredJoinRoleId === undefined
        ? undefined
        : String(req.query.requiredJoinRoleId || '');
      const includeVerificationStats = req.query.includeVerificationStats === undefined
        ? undefined
        : ['1', 'true', 'yes', 'on'].includes(String(req.query.includeVerificationStats).trim().toLowerCase());
      const result = await inviteTrackerService.getLeaderboard(req.guildId || null, { limit, days, requiredJoinRoleId, includeVerificationStats });
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to load invite leaderboard', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error loading invite leaderboard:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/invites/export', adminAuthMiddleware, async (req, res) => {
    if (!ensureInviteTrackerModule(req, res)) return;
    try {
      const days = req.query.days === undefined ? null : Number(req.query.days);
      const result = await inviteTrackerService.exportCsv(req.guildId || null, { days });
      if (!result.success) {
        const status = result.code === 'plan_restricted' ? 403 : 400;
        return res.status(status).json(toErrorResponse(result.message || 'Failed to export invite events', 'VALIDATION_ERROR', null, result));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      return res.send(result.csv);
    } catch (routeError) {
      logger.error('Error exporting invite events:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/invites/panel', adminAuthMiddleware, async (req, res) => {
    if (!ensureInviteTrackerModule(req, res)) return;
    try {
      const body = req.body || {};
      const result = await inviteTrackerService.postOrUpdateLeaderboardPanel(
        req.guildId || null,
        body.channelId || null,
        {
          days: body.days === undefined ? undefined : (body.days === null ? null : Number(body.days)),
          limit: body.limit === undefined ? undefined : Number(body.limit),
          requiredJoinRoleId: body.requiredJoinRoleId === undefined ? undefined : String(body.requiredJoinRoleId || ''),
          enableCreateLink: body.enableCreateLink === undefined ? undefined : !!body.enableCreateLink,
          includeVerificationStats: body.includeVerificationStats === undefined ? undefined : !!body.includeVerificationStats,
        }
      );
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to post invite leaderboard panel', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error posting invite leaderboard panel:', routeError);
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
          chain,
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
          chain: chain || 'solana:mainnet',
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
          const status = result.code === 'limit_exceeded' ? 403 : 400;
          return res.status(status).json(toErrorResponse(result.message || 'Failed to add tracked token', 'VALIDATION_ERROR', null, result));
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
module.exports.resolveTrackedCollectionMetadata = resolveTrackedCollectionMetadata;
