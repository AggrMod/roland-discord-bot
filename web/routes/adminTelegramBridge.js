const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function normalizeWebhookSecretHeader(value) {
  const raw = String(value || '').trim();
  return raw.replace(/^Bearer\s+/i, '').trim();
}

function timingSafeEqualsFallback(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 && a === b;
}

function createAdminTelegramBridgeRouter({
  logger,
  adminAuthMiddleware,
  ensureTelegramBridgeModule,
  telegramBridgeService,
  fetchGuildById,
  timingSafeEquals = timingSafeEqualsFallback,
}) {
  const router = express.Router();

  async function validateDiscordTarget(req, channelId) {
    const normalized = String(channelId || '').trim();
    if (!/^\d{17,20}$/.test(normalized)) {
      return { ok: false, message: 'Valid Discord target channel is required' };
    }
    const guild = req.guild || await fetchGuildById(req.guildId);
    if (!guild) {
      return { ok: false, message: 'Discord server not found or bot is not in the server' };
    }
    const channel = await guild.channels.fetch(normalized).catch(() => null);
    if (!channel || !channel.isTextBased?.()) {
      return { ok: false, message: 'Discord target channel must be a text-based channel in this server' };
    }
    const botMember = guild.members?.me || (guild.members?.fetchMe ? await guild.members.fetchMe().catch(() => null) : null);
    if (botMember && channel.permissionsFor) {
      const perms = channel.permissionsFor(botMember);
      if (perms && !perms.has?.('SendMessages')) {
        return { ok: false, message: 'The bot cannot send messages in the selected Discord channel' };
      }
    }
    return { ok: true };
  }

  function getTelegramWebhookSecret() {
    return String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  }

  router.get('/api/admin/telegram-bridge/settings', adminAuthMiddleware, (req, res) => {
    if (!ensureTelegramBridgeModule(req, res)) return;
    try {
      return res.json(toSuccessResponse({
        settings: telegramBridgeService.getSettings(req.guildId),
        webhookConfigured: !!getTelegramWebhookSecret(),
        botTokenConfigured: !!String(process.env.TELEGRAM_BOT_TOKEN || '').trim(),
      }));
    } catch (error) {
      logger.error('Error loading Telegram Bridge settings:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/telegram-bridge/settings', adminAuthMiddleware, (req, res) => {
    if (!ensureTelegramBridgeModule(req, res)) return;
    try {
      const result = telegramBridgeService.updateSettings(req.guildId, req.body || {});
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update Telegram Bridge settings', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error updating Telegram Bridge settings:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/telegram-bridge/mappings', adminAuthMiddleware, (req, res) => {
    if (!ensureTelegramBridgeModule(req, res)) return;
    try {
      return res.json(toSuccessResponse({
        mappings: telegramBridgeService.getMappings(req.guildId, { includeDisabled: true }),
      }));
    } catch (error) {
      logger.error('Error loading Telegram Bridge mappings:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/telegram-bridge/mappings', adminAuthMiddleware, async (req, res) => {
    if (!ensureTelegramBridgeModule(req, res)) return;
    try {
      const target = await validateDiscordTarget(req, req.body?.discordChannelId || req.body?.discord_channel_id);
      if (!target.ok) return res.status(400).json(toErrorResponse(target.message, 'VALIDATION_ERROR'));
      const result = telegramBridgeService.createMapping(req.guildId, req.body || {});
      if (!result.success) {
        const status = result.code === 'limit_exceeded' ? 403 : 400;
        return res.status(status).json(toErrorResponse(result.message || 'Failed to create sync mapping', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error creating Telegram Bridge mapping:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/telegram-bridge/mappings/:id', adminAuthMiddleware, async (req, res) => {
    if (!ensureTelegramBridgeModule(req, res)) return;
    try {
      if (req.body?.discordChannelId !== undefined || req.body?.discord_channel_id !== undefined) {
        const target = await validateDiscordTarget(req, req.body?.discordChannelId || req.body?.discord_channel_id);
        if (!target.ok) return res.status(400).json(toErrorResponse(target.message, 'VALIDATION_ERROR'));
      }
      const result = telegramBridgeService.updateMapping(req.guildId, req.params.id, req.body || {});
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update sync mapping', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error updating Telegram Bridge mapping:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/telegram-bridge/mappings/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureTelegramBridgeModule(req, res)) return;
    try {
      const result = telegramBridgeService.deleteMapping(req.guildId, req.params.id);
      if (!result.success) {
        return res.status(404).json(toErrorResponse(result.message || 'Sync mapping not found', 'NOT_FOUND', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error deleting Telegram Bridge mapping:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/telegram-bridge/mappings/:id/test', adminAuthMiddleware, async (req, res) => {
    if (!ensureTelegramBridgeModule(req, res)) return;
    try {
      const result = await telegramBridgeService.sendTestMessage(req.guildId, req.params.id);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to send test message', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error sending Telegram Bridge test message:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/telegram-bridge/audit', adminAuthMiddleware, (req, res) => {
    if (!ensureTelegramBridgeModule(req, res)) return;
    try {
      return res.json(toSuccessResponse({
        audit: telegramBridgeService.getAudit(req.guildId, {
          mappingId: req.query.mappingId || req.query.mapping_id || null,
          status: req.query.status || '',
          limit: req.query.limit || 100,
        }),
      }));
    } catch (error) {
      logger.error('Error loading Telegram Bridge audit:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/webhooks/telegram/:secret', async (req, res) => {
    const configured = getTelegramWebhookSecret();
    const provided = normalizeWebhookSecretHeader(req.params.secret || req.headers['x-telegram-webhook-secret'] || req.headers.authorization || '');
    if (!configured || !provided || !timingSafeEquals(provided, configured)) {
      return res.status(configured ? 401 : 503).json(toErrorResponse(configured ? 'Unauthorized' : 'Telegram webhook not configured', configured ? 'UNAUTHORIZED' : 'SERVICE_UNAVAILABLE'));
    }

    const update = req.body || {};
    setImmediate(() => {
      telegramBridgeService.ingestTelegramUpdate(update).catch((error) => {
        logger.error('[telegram-bridge] async ingest failed:', error);
      });
    });
    return res.json(toSuccessResponse({ queued: true }));
  });

  return router;
}

module.exports = createAdminTelegramBridgeRouter;
