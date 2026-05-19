const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminWelcomeRouter({
  logger,
  adminAuthMiddleware,
  ensureWelcomeModule,
  welcomeService,
  fetchGuildById,
}) {
  const router = express.Router();

  router.get('/api/admin/welcome/settings', adminAuthMiddleware, (req, res) => {
    if (!ensureWelcomeModule(req, res)) return;
    try {
      const result = welcomeService.getSettings(req.guildId);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to load welcome settings', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error loading welcome settings:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/welcome/settings', adminAuthMiddleware, (req, res) => {
    if (!ensureWelcomeModule(req, res)) return;
    try {
      const body = req.body || {};
      const result = welcomeService.updateSettings(req.guildId, {
        enabled: body.enabled,
        welcomeChannelId: body.welcomeChannelId,
        welcomeMessageTemplate: body.welcomeMessageTemplate,
        welcomeEmbed: body.welcomeEmbed,
        welcomeImageUrl: body.welcomeImageUrl,
        dynamicAvatarCard: body.dynamicAvatarCard,
        dmEnabled: body.dmEnabled,
        dmMessageTemplate: body.dmMessageTemplate,
        autoRoleIds: body.autoRoleIds,
        captchaEnabled: body.captchaEnabled,
        captchaRoleId: body.captchaRoleId,
      });
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to save welcome settings', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error saving welcome settings:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/welcome/test', adminAuthMiddleware, async (req, res) => {
    if (!ensureWelcomeModule(req, res)) return;
    try {
      const guild = req.guild || await fetchGuildById(req.guildId);
      if (!guild) return res.status(404).json(toErrorResponse('Guild not found', 'NOT_FOUND'));
      const actor = req.session?.discordUser || {};
      const result = await welcomeService.sendTestWelcome(guild, { id: actor.id });
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to send test welcome', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error sending test welcome:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/welcome/assets', adminAuthMiddleware, (req, res) => {
    if (!ensureWelcomeModule(req, res)) return;
    try {
      const rows = require('../../database/db').prepare(`
        SELECT id, file_name, mime_type, byte_size, created_at
        FROM tenant_welcome_assets
        WHERE guild_id = ?
        ORDER BY id DESC
        LIMIT 50
      `).all(req.guildId);
      return res.json(toSuccessResponse({ assets: rows.map(row => ({
        id: Number(row.id),
        fileName: row.file_name,
        mimeType: row.mime_type,
        byteSize: Number(row.byte_size || 0),
        createdAt: row.created_at,
      })) }));
    } catch (error) {
      logger.error('Error loading welcome assets:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/welcome/upload-image', adminAuthMiddleware, (req, res) => {
    if (!ensureWelcomeModule(req, res)) return;
    try {
      const raw = String(req.body?.dataUrl || '').trim();
      if (!raw.startsWith('data:image/')) {
        return res.status(400).json(toErrorResponse('dataUrl image is required', 'VALIDATION_ERROR'));
      }
      const match = raw.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        return res.status(400).json(toErrorResponse('Invalid dataUrl payload', 'VALIDATION_ERROR'));
      }
      const mimeType = String(match[1] || '').trim().toLowerCase();
      const base64 = String(match[2] || '').trim();
      const buffer = Buffer.from(base64, 'base64');
      const result = welcomeService.saveUploadedImage({
        guildId: req.guildId,
        fileName: req.body?.fileName || `welcome-${Date.now()}`,
        mimeType,
        buffer,
      });
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to upload image', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error uploading welcome image:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/public/v1/welcome/captcha/verify', async (req, res) => {
    try {
      const result = await welcomeService.verifyCaptcha({
        challengeToken: req.body?.challengeToken,
        captchaToken: req.body?.captchaToken,
      });
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Verification failed', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error verifying welcome captcha:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createAdminWelcomeRouter;
