const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminVaultRouter({
  logger,
  adminAuthMiddleware,
  ensureVaultModule,
  vaultService,
}) {
  const router = express.Router();

  router.get('/api/admin/vault/config', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const config = vaultService.getConfig(req.guildId || '');
      return res.json(toSuccessResponse({ config }));
    } catch (error) {
      logger.error('Error loading vault config:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/vault/config', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const result = vaultService.saveConfig(req.guildId || '', req.body?.config || req.body || {});
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to save config', 'VALIDATION_ERROR', null, result));
      }
      vaultService.logAdminAction(req.guildId || '', req.session?.discordUser?.id || null, 'config_save', null, { source: 'portal' });
      return res.json(toSuccessResponse({ config: result.config }));
    } catch (error) {
      logger.error('Error saving vault config:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/vault/config/export', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const config = vaultService.getConfig(req.guildId || '');
      const seasons = vaultService.listSeasons(req.guildId || '');
      const payload = {
        guildId: req.guildId || '',
        exportedAt: new Date().toISOString(),
        config,
        seasons,
      };
      return res.json(toSuccessResponse(payload));
    } catch (error) {
      logger.error('Error exporting vault config:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/vault/config/import', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const config = req.body?.config || req.body;
      const seasons = Array.isArray(req.body?.seasons) ? req.body.seasons : [];
      const saveResult = vaultService.saveConfig(req.guildId || '', config || {});
      if (!saveResult.success) {
        return res.status(400).json(toErrorResponse(saveResult.message || 'Failed to import config', 'VALIDATION_ERROR', null, saveResult));
      }
      for (const season of seasons) {
        vaultService.upsertSeason(req.guildId || '', season || {});
      }
      vaultService.logAdminAction(req.guildId || '', req.session?.discordUser?.id || null, 'config_import', null, { seasons: seasons.length });
      return res.json(toSuccessResponse({ config: saveResult.config, seasons: vaultService.listSeasons(req.guildId || '') }));
    } catch (error) {
      logger.error('Error importing vault config:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/vault/seasons', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const seasons = vaultService.listSeasons(req.guildId || '');
      return res.json(toSuccessResponse({ seasons }));
    } catch (error) {
      logger.error('Error listing vault seasons:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/vault/seasons', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const result = vaultService.upsertSeason(req.guildId || '', req.body || {});
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to save season', 'VALIDATION_ERROR', null, result));
      }
      vaultService.logAdminAction(req.guildId || '', req.session?.discordUser?.id || null, 'season_upsert', null, { seasonId: result.season?.season_id || null });
      return res.json(toSuccessResponse({ season: result.season, seasons: vaultService.listSeasons(req.guildId || '') }));
    } catch (error) {
      logger.error('Error saving vault season:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/vault/seasons/:seasonId', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const result = vaultService.upsertSeason(req.guildId || '', {
        ...req.body,
        seasonId: req.params.seasonId,
      });
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update season', 'VALIDATION_ERROR', null, result));
      }
      vaultService.logAdminAction(req.guildId || '', req.session?.discordUser?.id || null, 'season_update', null, { seasonId: req.params.seasonId });
      return res.json(toSuccessResponse({ season: result.season, seasons: vaultService.listSeasons(req.guildId || '') }));
    } catch (error) {
      logger.error('Error updating vault season:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/vault/seasons/:seasonId/activate', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const result = vaultService.activateSeason(req.guildId || '', req.params.seasonId);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to activate season', 'VALIDATION_ERROR', null, result));
      }
      vaultService.logAdminAction(req.guildId || '', req.session?.discordUser?.id || null, 'season_activate', null, { seasonId: req.params.seasonId });
      return res.json(toSuccessResponse({ season: result.season, seasons: vaultService.listSeasons(req.guildId || '') }));
    } catch (error) {
      logger.error('Error activating vault season:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/vault/rewards', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      return res.json(toSuccessResponse({ rewards: vaultService.getRewards(req.guildId || '') }));
    } catch (error) {
      logger.error('Error listing vault rewards:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/vault/rewards', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const result = vaultService.addReward(req.guildId || '', req.body || {});
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to add reward', 'VALIDATION_ERROR', null, result));
      }
      vaultService.logAdminAction(req.guildId || '', req.session?.discordUser?.id || null, 'reward_add', null, { code: req.body?.code || null });
      return res.json(toSuccessResponse({ rewards: vaultService.getRewards(req.guildId || '') }));
    } catch (error) {
      logger.error('Error adding vault reward:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/vault/rewards/:code', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const result = vaultService.updateReward(req.guildId || '', req.params.code, req.body || {});
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update reward', 'VALIDATION_ERROR', null, result));
      }
      vaultService.logAdminAction(req.guildId || '', req.session?.discordUser?.id || null, 'reward_update', null, { code: req.params.code });
      return res.json(toSuccessResponse({ rewards: vaultService.getRewards(req.guildId || '') }));
    } catch (error) {
      logger.error('Error updating vault reward:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/vault/rewards/:code', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const result = vaultService.removeReward(req.guildId || '', req.params.code);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to remove reward', 'VALIDATION_ERROR', null, result));
      }
      vaultService.logAdminAction(req.guildId || '', req.session?.discordUser?.id || null, 'reward_remove', null, { code: req.params.code });
      return res.json(toSuccessResponse({ rewards: vaultService.getRewards(req.guildId || '') }));
    } catch (error) {
      logger.error('Error removing vault reward:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/vault/milestones', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      return res.json(toSuccessResponse({ milestones: vaultService.getMilestones(req.guildId || '') }));
    } catch (error) {
      logger.error('Error listing vault milestones:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/vault/milestones', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const current = vaultService.getMilestones(req.guildId || '');
      const payload = req.body || {};
      const id = String(payload.id || payload.milestone_id || '').trim();
      if (!id) {
        return res.status(400).json(toErrorResponse('Milestone id is required', 'VALIDATION_ERROR'));
      }
      const next = [...current.filter(m => String(m.id || m.milestone_id || '').trim() !== id), payload];
      const saveResult = vaultService.saveMilestones(req.guildId || '', next);
      if (!saveResult.success) {
        return res.status(400).json(toErrorResponse(saveResult.message || 'Failed to save milestone', 'VALIDATION_ERROR', null, saveResult));
      }
      vaultService.logAdminAction(req.guildId || '', req.session?.discordUser?.id || null, 'milestone_upsert', null, { milestoneId: id });
      return res.json(toSuccessResponse({ milestones: vaultService.getMilestones(req.guildId || '') }));
    } catch (error) {
      logger.error('Error saving vault milestone:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/vault/milestones/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const id = String(req.params.id || '').trim();
      const current = vaultService.getMilestones(req.guildId || '');
      const next = current.filter(m => String(m.id || m.milestone_id || '').trim() !== id);
      const saveResult = vaultService.saveMilestones(req.guildId || '', next);
      if (!saveResult.success) {
        return res.status(400).json(toErrorResponse(saveResult.message || 'Failed to remove milestone', 'VALIDATION_ERROR', null, saveResult));
      }
      vaultService.logAdminAction(req.guildId || '', req.session?.discordUser?.id || null, 'milestone_remove', null, { milestoneId: id });
      return res.json(toSuccessResponse({ milestones: vaultService.getMilestones(req.guildId || '') }));
    } catch (error) {
      logger.error('Error removing vault milestone:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/vault/users/:discordId/keys', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const discordId = String(req.params.discordId || '').trim();
      const seasonId = req.body?.seasonId || req.body?.season_id || vaultService.getActiveSeason(req.guildId || '')?.season_id || 'default';
      const amount = Number(req.body?.amount || 0);
      const action = String(req.body?.action || 'add').trim().toLowerCase();
      const reason = String(req.body?.reason || 'portal_manual').trim();
      const result = action === 'remove'
        ? vaultService.removeKeys(req.guildId || '', seasonId, discordId, amount, reason, req.session?.discordUser?.id || null)
        : vaultService.addKeys(req.guildId || '', seasonId, discordId, amount, reason, req.session?.discordUser?.id || null);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to mutate keys', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse({ ok: true }));
    } catch (error) {
      logger.error('Error mutating vault keys:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/vault/backfill', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      let discordUserId = String(req.body?.discordUserId || req.body?.discord_user_id || '').trim();
      const walletAddress = String(req.body?.walletAddress || req.body?.wallet_address || '').trim();
      if (!discordUserId && walletAddress) {
        discordUserId = String(vaultService.findLinkedDiscordUserByWallet(walletAddress) || '').trim();
      }
      const result = vaultService.backfillWalletForActiveSeason(req.guildId || '', walletAddress, discordUserId);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to backfill', 'VALIDATION_ERROR', null, result));
      }
      vaultService.logAdminAction(req.guildId || '', req.session?.discordUser?.id || null, 'manual_backfill', discordUserId || null, { walletAddress, processed: result.processed || 0 });
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error in vault backfill endpoint:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/vault/users/:discordId/rewards', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const discordId = String(req.params.discordId || '').trim();
      const seasonId = req.body?.seasonId || req.body?.season_id || vaultService.getActiveSeason(req.guildId || '')?.season_id || 'default';
      const reward = req.body?.reward || req.body || {};
      const result = vaultService.assignManualReward(req.guildId || '', seasonId, discordId, reward, 'manual_admin');
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to assign reward', 'VALIDATION_ERROR', null, result));
      }
      vaultService.logAdminAction(req.guildId || '', req.session?.discordUser?.id || null, 'reward_assign', discordId, {
        seasonId,
        rewardCode: reward?.code || reward?.reward_code || null,
      });
      return res.json(toSuccessResponse({ rewardId: result.rewardId }));
    } catch (error) {
      logger.error('Error assigning manual vault reward:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/vault/openings', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const seasonId = req.query?.seasonId || req.query?.season_id || null;
      const limit = Number(req.query?.limit || 50);
      const openings = vaultService.listOpenings(req.guildId || '', seasonId, limit);
      return res.json(toSuccessResponse({ openings }));
    } catch (error) {
      logger.error('Error listing vault openings:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/vault/rewards/claims', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const seasonId = req.query?.seasonId || req.query?.season_id || null;
      const claimStatus = req.query?.status || null;
      const limit = Number(req.query?.limit || 100);
      const rewards = vaultService.listRewards(req.guildId || '', seasonId, claimStatus, limit);
      return res.json(toSuccessResponse({ rewards }));
    } catch (error) {
      logger.error('Error listing vault claims:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/vault/rewards/claims/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const claimStatus = String(req.body?.claimStatus || req.body?.claim_status || '').trim();
      const claimNote = req.body?.claimNote || req.body?.claim_note || null;
      const result = vaultService.updateRewardClaimStatus(req.guildId || '', req.params.id, claimStatus, claimNote);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update claim status', 'VALIDATION_ERROR', null, result));
      }
      vaultService.logAdminAction(req.guildId || '', req.session?.discordUser?.id || null, 'reward_claim_status', result.reward?.discord_user_id || null, {
        rewardId: Number(req.params.id),
        claimStatus,
        claimNote: claimNote ? String(claimNote) : null,
      });
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error updating vault claim status:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/vault/audit', adminAuthMiddleware, (req, res) => {
    if (!ensureVaultModule(req, res)) return;
    try {
      const limit = Number(req.query?.limit || 100);
      const logs = vaultService.listAdminLogs(req.guildId || '', limit);
      return res.json(toSuccessResponse({ logs }));
    } catch (error) {
      logger.error('Error listing vault audit logs:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createAdminVaultRouter;
