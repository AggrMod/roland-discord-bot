const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');
const { decryptSecret, encryptSecret, maskSecret } = require('../../utils/secretVault');
const billingService = require('../../services/billingService');
const xProviderService = require('../../services/xProviderService');

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
      const openaiApiKey = decryptSecret(settings.openaiApiKeyEncrypted)
        || decryptSecret(settings.aiAssistantApiKeyEncrypted)
        || String(settings.openaiApiKey || '').trim();
      const geminiApiKey = decryptSecret(settings.geminiApiKeyEncrypted) || String(settings.geminiApiKey || '').trim();
      const xClientId = String(settings.xClientId || process.env.X_CLIENT_ID || '').trim();
      const xClientSecret = decryptSecret(settings.xClientSecretEncrypted) || String(settings.xClientSecret || '').trim();
      const xBearerToken = decryptSecret(settings.xBearerTokenEncrypted) || String(settings.xBearerToken || '').trim();
      const defaultProvider = ['openai', 'gemini'].includes(String(settings.aiAssistantDefaultProvider || '').toLowerCase())
        ? String(settings.aiAssistantDefaultProvider).toLowerCase()
        : 'openai';
      const fallbackProviderRaw = String(settings.aiAssistantFallbackProvider || '').toLowerCase();
      const fallbackProvider = ['openai', 'gemini'].includes(fallbackProviderRaw) ? fallbackProviderRaw : '';

      res.json(toSuccessResponse({
        settings: {
          moduleMicroVerifyEnabled: !!settings.moduleMicroVerifyEnabled,
          verificationReceiveWallet: settings.verificationReceiveWallet || process.env.VERIFICATION_RECEIVE_WALLET || '',
          verifyRequestTtlMinutes: settings.verifyRequestTtlMinutes || 15,
          pollIntervalSeconds: settings.pollIntervalSeconds || 30,
          verifyRateLimitMinutes: settings.verifyRateLimitMinutes || 5,
          maxPendingPerUser: settings.maxPendingPerUser || 1,
          billingReceiveWallet: settings.billingReceiveWallet || process.env.BILLING_RECEIVE_WALLET || billingService.getBillingReceiveWallet() || '',
          billingOnchainVerifyEnabled: Object.prototype.hasOwnProperty.call(settings, 'billingOnchainVerifyEnabled')
            ? !!settings.billingOnchainVerifyEnabled
            : billingService.isOnchainVerificationEnabled(),
          billingSupportUrl: settings.billingSupportUrl || process.env.BILLING_SUPPORT_URL || process.env.SUPPORT_URL || '',
          chainEmojiMap: settings.chainEmojiMap || {},
          openaiApiKeyConfigured: !!openaiApiKey,
          openaiApiKeyMasked: openaiApiKey ? maskSecret(openaiApiKey) : '',
          geminiApiKeyConfigured: !!geminiApiKey,
          geminiApiKeyMasked: geminiApiKey ? maskSecret(geminiApiKey) : '',
          xClientId: xClientId || '',
          xRedirectUri: settings.xRedirectUri || process.env.X_REDIRECT_URI || '',
          xClientSecretConfigured: !!xClientSecret,
          xClientSecretMasked: xClientSecret ? maskSecret(xClientSecret) : '',
          xBearerTokenConfigured: !!xBearerToken,
          xBearerTokenMasked: xBearerToken ? maskSecret(xBearerToken) : '',
          xPollingEnabled: !!settings.xPollingEnabled,
          xPollingIntervalSeconds: Number(settings.xPollingIntervalSeconds || 300),
          aiAssistantDefaultProvider: defaultProvider,
          aiAssistantFallbackProvider: fallbackProvider,
          aiAssistantDefaultModelOpenai: String(settings.aiAssistantDefaultModelOpenai || 'gpt-5.4'),
          aiAssistantDefaultModelGemini: String(settings.aiAssistantDefaultModelGemini || 'gemini-2.0-flash'),
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
        'billingReceiveWallet', 'billingOnchainVerifyEnabled', 'billingSupportUrl',
        'openaiApiKey', 'geminiApiKey',
        'xClientId', 'xRedirectUri', 'xClientSecret', 'xBearerToken', 'xPollingEnabled', 'xPollingIntervalSeconds',
        'aiAssistantDefaultProvider', 'aiAssistantFallbackProvider',
        'aiAssistantDefaultModelOpenai', 'aiAssistantDefaultModelGemini',
      ];
      const patch = {};
      for (const key of ALLOWED) {
        if (req.body[key] !== undefined) patch[key] = req.body[key];
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'openaiApiKey')) {
        const rawKey = String(patch.openaiApiKey || '').trim();
        const encrypted = rawKey ? encryptSecret(rawKey) : '';
        if (rawKey && !encrypted) {
          return res.status(500).json(toErrorResponse('Unable to store OpenAI API key securely; check server secret configuration'));
        }
        patch.openaiApiKeyEncrypted = encrypted;
        patch.openaiApiKey = '';
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'geminiApiKey')) {
        const rawKey = String(patch.geminiApiKey || '').trim();
        const encrypted = rawKey ? encryptSecret(rawKey) : '';
        if (rawKey && !encrypted) {
          return res.status(500).json(toErrorResponse('Unable to store Gemini API key securely; check server secret configuration'));
        }
        patch.geminiApiKeyEncrypted = encrypted;
        patch.geminiApiKey = '';
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'xClientSecret')) {
        const rawSecret = String(patch.xClientSecret || '').trim();
        const encrypted = rawSecret ? encryptSecret(rawSecret) : '';
        if (rawSecret && !encrypted) {
          return res.status(500).json(toErrorResponse('Unable to store X client secret securely; check server secret configuration'));
        }
        patch.xClientSecretEncrypted = encrypted;
        patch.xClientSecret = '';
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'xBearerToken')) {
        const rawToken = String(patch.xBearerToken || '').trim();
        const encrypted = rawToken ? encryptSecret(rawToken) : '';
        if (rawToken && !encrypted) {
          return res.status(500).json(toErrorResponse('Unable to store X bearer token securely; check server secret configuration'));
        }
        patch.xBearerTokenEncrypted = encrypted;
        patch.xBearerToken = '';
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

  router.post('/x-provider/test', superadminGuard, async (_req, res) => {
    try {
      const runtime = xProviderService.getRuntimeConfig();
      if (!runtime.clientId) {
        return res.status(400).json(toErrorResponse('X client ID is not configured', 'VALIDATION_ERROR'));
      }
      if (!runtime.bearerToken) {
        return res.status(400).json(toErrorResponse('X bearer token is not configured', 'VALIDATION_ERROR'));
      }

      const probe = await xProviderService.searchRecentPosts('guildpilot', {
        maxResults: 10,
        bearerToken: runtime.bearerToken,
      });

      res.json(toSuccessResponse({
        ok: true,
        scanned: Array.isArray(probe.posts) ? probe.posts.length : 0,
        message: 'X API probe succeeded.',
      }));
    } catch (error) {
      logger.error('X provider test failed:', error);
      const status = Number(error?.status || 0);
      if (status === 402) {
        return res.json(toSuccessResponse({
          ok: false,
          restricted: true,
          scanned: 0,
          message: 'X credentials are accepted, but this X API plan cannot access search endpoints (HTTP 402).',
        }));
      }
      const message = error?.message || 'X API probe failed';
      res.status(status >= 400 && status < 600 ? status : 500).json(
        toErrorResponse(message, 'X_PROVIDER_TEST_FAILED')
      );
    }
  });

  return router;
}

module.exports = createSuperadminCoreRouter;
