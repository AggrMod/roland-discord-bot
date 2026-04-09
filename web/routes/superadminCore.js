const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createSuperadminCoreRouter({
  superadminGuard,
  superadminService,
  tenantService,
  settingsManager,
  logger,
  getActivityWebhookSecret,
}) {
  const router = express.Router();

  router.get('/me', (req, res) => {
    const userId = req.session?.discordUser?.id || null;

    res.json(toSuccessResponse({
      userId,
      isRootSuperadmin: superadminService.isRootSuperadmin(userId),
      isSuperadmin: superadminService.isSuperadmin(userId),
    }));
  });

  router.get('/env-status', superadminGuard, (_req, res) => {
    res.json(toSuccessResponse({
      mockMode: process.env.MOCK_MODE === 'true',
      heliusConfigured: !!process.env.HELIUS_API_KEY,
      solanaRpc: process.env.SOLANA_RPC_URL || 'default',
      nodeEnv: process.env.NODE_ENV || 'development',
      webhookSecretConfigured: !!getActivityWebhookSecret(),
    }));
  });

  router.get('/global-settings', superadminGuard, (_req, res) => {
    try {
      const settings = settingsManager.getSettings();
      const ogRoleService = require('../../services/ogRoleService');
      const ogCfg = ogRoleService.getConfig();
      const multiTenantEnabled = tenantService.isMultitenantEnabled();

      res.json(toSuccessResponse({
        settings: {
          moduleMicroVerifyEnabled: !!settings.moduleMicroVerifyEnabled,
          verificationReceiveWallet: settings.verificationReceiveWallet || process.env.VERIFICATION_RECEIVE_WALLET || '',
          verifyRequestTtlMinutes: settings.verifyRequestTtlMinutes || 15,
          pollIntervalSeconds: settings.pollIntervalSeconds || 30,
          verifyRateLimitMinutes: settings.verifyRateLimitMinutes || 5,
          maxPendingPerUser: settings.maxPendingPerUser || 1,
          chainEmojiMap: settings.chainEmojiMap || {},
          ogRoleId: multiTenantEnabled ? '' : (ogCfg.roleId || ''),
          ogRoleLimit: multiTenantEnabled ? 0 : (ogCfg.limit || 0),
          ogRoleGlobalEditable: !multiTenantEnabled,
        },
      }));
    } catch (error) {
      logger.error('Error fetching global settings:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/global-settings', superadminGuard, (req, res) => {
    try {
      const ALLOWED = [
        'moduleMicroVerifyEnabled', 'verificationReceiveWallet',
        'verifyRequestTtlMinutes', 'pollIntervalSeconds',
        'verifyRateLimitMinutes', 'maxPendingPerUser', 'chainEmojiMap',
      ];
      const patch = {};
      for (const key of ALLOWED) {
        if (req.body[key] !== undefined) patch[key] = req.body[key];
      }
      const result = settingsManager.updateSettings(patch);
      if (!result.success) return res.status(400).json(toErrorResponse(result.message || 'Failed to update global settings', 'VALIDATION_ERROR', null, result));

      // Sync microVerifyService config overrides in memory
      try {
        const microVerifyService = require('../../services/microVerifyService');
        const syncMap = {
          moduleMicroVerifyEnabled: 'MICRO_VERIFY_ENABLED',
          verificationReceiveWallet: 'VERIFICATION_RECEIVE_WALLET',
          verifyRequestTtlMinutes: 'VERIFY_REQUEST_TTL_MINUTES',
          pollIntervalSeconds: 'POLL_INTERVAL_SECONDS',
        };
        const overrides = {};
        for (const [jsKey, envKey] of Object.entries(syncMap)) {
          if (patch[jsKey] !== undefined) overrides[envKey] = String(patch[jsKey]);
        }
        if (Object.keys(overrides).length) {
          microVerifyService.updateConfig(overrides);
          microVerifyService.stopPolling();
          microVerifyService.startPolling();
        }
      } catch (e) {
        logger.warn('microVerifyService sync warning:', e?.message || e);
      }

      logger.log(`[superadmin] global-settings updated by ${req.session?.discordUser?.id}: ${Object.keys(patch).join(', ')}`);
      res.json(toSuccessResponse({ message: 'Global settings updated' }));
    } catch (error) {
      logger.error('Error updating global settings:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createSuperadminCoreRouter;
