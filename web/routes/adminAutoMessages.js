const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminAutoMessagesRouter({
  logger,
  adminAuthMiddleware,
  ensureAutoMessagesModule,
  autoMessageService,
  fetchGuildById,
}) {
  const router = express.Router();

  async function validateDiscordTarget(req, channelId) {
    const normalized = String(channelId || '').trim();
    if (!/^\d{17,20}$/.test(normalized)) {
      return { ok: false, message: 'Valid Discord channel is required' };
    }
    const guild = req.guild || await fetchGuildById(req.guildId);
    if (!guild) {
      return { ok: false, message: 'Discord server not found or bot is not in the server' };
    }
    const channel = await guild.channels.fetch(normalized).catch(() => null);
    if (!channel || !channel.isTextBased?.()) {
      return { ok: false, message: 'Discord channel must be a text-based channel in this server' };
    }
    const botMember = guild.members?.me || (guild.members?.fetchMe ? await guild.members.fetchMe().catch(() => null) : null);
    if (botMember && channel.permissionsFor) {
      const perms = channel.permissionsFor(botMember);
      if (perms && !perms.has?.(PermissionFlagsBits.SendMessages)) {
        return { ok: false, message: 'The bot cannot send messages in the selected Discord channel' };
      }
      if (perms && !perms.has?.(PermissionFlagsBits.EmbedLinks)) {
        return { ok: false, message: 'The bot cannot send embeds in the selected Discord channel' };
      }
    }
    return { ok: true };
  }

  router.get('/api/admin/auto-messages/settings', adminAuthMiddleware, (req, res) => {
    if (!ensureAutoMessagesModule(req, res)) return;
    try {
      return res.json(toSuccessResponse({ settings: autoMessageService.getSettings(req.guildId) }));
    } catch (error) {
      logger.error('Error loading Auto Messages settings:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/auto-messages/settings', adminAuthMiddleware, (req, res) => {
    if (!ensureAutoMessagesModule(req, res)) return;
    try {
      const result = autoMessageService.updateSettings(req.guildId, req.body || {});
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update Auto Messages settings', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error updating Auto Messages settings:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/auto-messages/messages', adminAuthMiddleware, (req, res) => {
    if (!ensureAutoMessagesModule(req, res)) return;
    try {
      return res.json(toSuccessResponse({
        messages: autoMessageService.getMessages(req.guildId, { includeDisabled: true }),
      }));
    } catch (error) {
      logger.error('Error loading Auto Messages:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/auto-messages/messages', adminAuthMiddleware, async (req, res) => {
    if (!ensureAutoMessagesModule(req, res)) return;
    try {
      const target = await validateDiscordTarget(req, req.body?.channelId || req.body?.channel_id);
      if (!target.ok) return res.status(400).json(toErrorResponse(target.message, 'VALIDATION_ERROR'));
      const result = autoMessageService.createMessage(req.guildId, req.body || {});
      if (!result.success) {
        const status = result.code === 'limit_exceeded' ? 403 : 400;
        return res.status(status).json(toErrorResponse(result.message || 'Failed to create auto message', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error creating Auto Message:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/auto-messages/messages/:id', adminAuthMiddleware, async (req, res) => {
    if (!ensureAutoMessagesModule(req, res)) return;
    try {
      if (req.body?.channelId !== undefined || req.body?.channel_id !== undefined) {
        const target = await validateDiscordTarget(req, req.body?.channelId || req.body?.channel_id);
        if (!target.ok) return res.status(400).json(toErrorResponse(target.message, 'VALIDATION_ERROR'));
      }
      const result = autoMessageService.updateMessage(req.guildId, req.params.id, req.body || {});
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update auto message', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error updating Auto Message:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/auto-messages/messages/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureAutoMessagesModule(req, res)) return;
    try {
      const result = autoMessageService.deleteMessage(req.guildId, req.params.id);
      if (!result.success) {
        return res.status(404).json(toErrorResponse(result.message || 'Auto message not found', 'NOT_FOUND', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error deleting Auto Message:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/auto-messages/messages/:id/test', adminAuthMiddleware, async (req, res) => {
    if (!ensureAutoMessagesModule(req, res)) return;
    try {
      const result = await autoMessageService.sendTestMessage(req.guildId, req.params.id);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to send test message', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error sending Auto Message test:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/auto-messages/audit', adminAuthMiddleware, (req, res) => {
    if (!ensureAutoMessagesModule(req, res)) return;
    try {
      return res.json(toSuccessResponse({
        audit: autoMessageService.getAudit(req.guildId, {
          messageId: req.query.messageId || req.query.message_id || null,
          status: req.query.status || '',
          limit: req.query.limit || 100,
        }),
      }));
    } catch (error) {
      logger.error('Error loading Auto Messages audit:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createAdminAutoMessagesRouter;
