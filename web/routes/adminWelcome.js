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
