const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminWelcomeRouter({
  logger,
  adminAuthMiddleware,
  ensureWelcomeModule,
  welcomeService,
  fetchGuildById,
  entitlementService,
  tenantService,
}) {
  const router = express.Router();
  const countChannelTokens = (text) => {
    const raw = String(text || '');
    const matches = raw.match(/\{channel:[^}]+\}/gi);
    return matches ? matches.length : 0;
  };

  const WELCOME_PRESETS = Object.freeze({
    minimal: {
      message: 'Welcome {user_mention} to {server_name}! You are member #{member_count}.',
      embed: {
        color: '#f8b64c',
        title: 'Welcome to {server_name}',
        description: 'Great to have you here, {username}.',
        footer: 'GuildPilot Welcome',
        fields: []
      }
    },
    family_initiation: {
      message: 'A new Associate has joined the Family... 🕵️‍♂️ {user_mention}',
      embed: {
        color: '#f8b64c',
        title: 'SOLPRANOS FAMILY FILE · MEMBER #{member_count}',
        description: 'Welcome to the underworld of {server_name}, {username}! You have been assigned as Associate #{member_count}.',
        footer: 'GuildPilot · Solpranos Onboarding',
        fields: [
          { name: '🔑 Step 1: Claim Your Identity', value: 'Head to {channel:verify-wallet} and link your Solana wallet to unlock your family roles and holder channels.', inline: false },
          { name: '📜 Step 2: Learn the Family Code', value: 'Review our rules in {channel:rules} so you do not sleep with the fishes.', inline: false },
          { name: '💰 Step 3: Active Heists & Missions', value: 'Earn points and run missions with the crew by checking {channel:missions}.', inline: false },
        ]
      }
    }
  });

  router.get('/api/admin/welcome/settings', adminAuthMiddleware, (req, res) => {
    if (!ensureWelcomeModule(req, res)) return;
    try {
      const result = welcomeService.getSettings(req.guildId);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to load welcome settings', 'VALIDATION_ERROR', null, result));
      }
      const channelTokenLimit = entitlementService?.getEffectiveLimit?.(req.guildId, 'welcome', 'max_channel_tokens');
      const stepFieldLimit = entitlementService?.getEffectiveLimit?.(req.guildId, 'welcome', 'max_step_fields');
      const imageAssetsEnabled = entitlementService?.getEffectiveLimit?.(req.guildId, 'welcome', 'allow_image_assets');
      const planKey = String(tenantService?.getTenantContext?.(req.guildId)?.planKey || 'starter').toLowerCase();
      const canEditBrandingFields = planKey !== 'starter';
      return res.json(toSuccessResponse({
        ...result,
        limits: {
          maxChannelTokens: channelTokenLimit,
          maxStepFields: stepFieldLimit,
          allowImageAssets: imageAssetsEnabled === null ? true : Number(imageAssetsEnabled) > 0,
          canEditBrandingFields,
          planKey,
        }
      }));
    } catch (error) {
      logger.error('Error loading welcome settings:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/welcome/settings', adminAuthMiddleware, (req, res) => {
    if (!ensureWelcomeModule(req, res)) return;
    try {
      const body = req.body || {};
      const planKey = String(tenantService?.getTenantContext?.(req.guildId)?.planKey || 'starter').toLowerCase();
      const canEditBrandingFields = planKey !== 'starter';
      const fields = Array.isArray(body?.welcomeEmbed?.fields) ? body.welcomeEmbed.fields : [];
      const channelTokenLimit = entitlementService?.getEffectiveLimit?.(req.guildId, 'welcome', 'max_channel_tokens');
      const stepFieldLimit = entitlementService?.getEffectiveLimit?.(req.guildId, 'welcome', 'max_step_fields');
      const autoRoleLimit = entitlementService?.getEffectiveLimit?.(req.guildId, 'welcome', 'max_auto_roles');
      const imageAssetsEnabled = entitlementService?.getEffectiveLimit?.(req.guildId, 'welcome', 'allow_image_assets');
      const totalChannelTokens =
        countChannelTokens(body.welcomeMessageTemplate)
        + countChannelTokens(body.dmMessageTemplate)
        + countChannelTokens(body?.welcomeEmbed?.title)
        + countChannelTokens(body?.welcomeEmbed?.description)
        + countChannelTokens(body?.welcomeEmbed?.footer)
        + fields.reduce((sum, field) => sum + countChannelTokens(field?.name) + countChannelTokens(field?.value), 0);
      if (channelTokenLimit !== null && Number.isFinite(channelTokenLimit) && totalChannelTokens > channelTokenLimit) {
        return res.status(400).json(toErrorResponse(`Channel link token limit reached (${channelTokenLimit}).`, 'VALIDATION_ERROR'));
      }
      if (stepFieldLimit !== null && Number.isFinite(stepFieldLimit) && fields.length > stepFieldLimit) {
        return res.status(400).json(toErrorResponse(`Step field limit reached (${stepFieldLimit}).`, 'VALIDATION_ERROR'));
      }
      const autoRoleCount = Array.isArray(body.autoRoleIds) ? body.autoRoleIds.length : 0;
      if (autoRoleLimit !== null && Number.isFinite(autoRoleLimit) && autoRoleCount > autoRoleLimit) {
        return res.status(400).json(toErrorResponse(`Auto role limit reached (${autoRoleLimit}).`, 'VALIDATION_ERROR'));
      }
      if ((Number(imageAssetsEnabled || 0) <= 0) && body.welcomeImageAssetId) {
        return res.status(403).json(toErrorResponse('Uploaded image assets are not available on your current plan.', 'FORBIDDEN'));
      }

      let normalizedEmbed = body.welcomeEmbed;
      if (!canEditBrandingFields) {
        const current = welcomeService.getSettings(req.guildId);
        const currentEmbed = current?.success ? (current.settings?.welcomeEmbed || {}) : {};
        normalizedEmbed = {
          ...(body.welcomeEmbed || {}),
          color: currentEmbed?.color || null,
          footer: currentEmbed?.footer || '',
        };
      }
      const result = welcomeService.updateSettings(req.guildId, {
        enabled: body.enabled,
        welcomeChannelId: body.welcomeChannelId,
        verificationChannelId: body.verificationChannelId,
        welcomeMessageTemplate: body.welcomeMessageTemplate,
        welcomeEmbed: normalizedEmbed,
        welcomeImageUrl: body.welcomeImageUrl,
        welcomeImageAssetId: body.welcomeImageAssetId,
        dynamicAvatarCard: body.dynamicAvatarCard,
        dmEnabled: body.dmEnabled,
        dmMessageTemplate: body.dmMessageTemplate,
        autoRoleIds: body.autoRoleIds,
        captchaEnabled: body.captchaEnabled,
        captchaRoleId: body.captchaRoleId,
        captchaRemoveRoleId: body.captchaRemoveRoleId,
        captchaPromptMode: body.captchaPromptMode,
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

  router.post('/api/admin/welcome/captcha-panel', adminAuthMiddleware, async (req, res) => {
    if (!ensureWelcomeModule(req, res)) return;
    try {
      const guild = req.guild || await fetchGuildById(req.guildId);
      if (!guild) return res.status(404).json(toErrorResponse('Guild not found', 'NOT_FOUND'));
      const settingsResult = welcomeService.getSettings(req.guildId);
      if (!settingsResult.success) {
        return res.status(400).json(toErrorResponse(settingsResult.message || 'Failed to load welcome settings', 'VALIDATION_ERROR'));
      }
      const configuredChannel = settingsResult.settings?.verificationChannelId || settingsResult.settings?.welcomeChannelId || null;
      const channelId = String(req.body?.channelId || configuredChannel || '').trim();
      const result = await welcomeService.postCaptchaPanel(guild, channelId);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to post captcha panel', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error posting welcome captcha panel:', error);
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

  router.get('/api/admin/welcome/analytics', adminAuthMiddleware, (req, res) => {
    if (!ensureWelcomeModule(req, res)) return;
    try {
      const days = Number(req.query?.days || 30);
      const result = welcomeService.getAnalyticsSummary(req.guildId, days);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to load analytics', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error loading welcome analytics:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/welcome/upload-image', adminAuthMiddleware, (req, res) => {
    if (!ensureWelcomeModule(req, res)) return;
    try {
      const imageAssetsEnabled = entitlementService?.getEffectiveLimit?.(req.guildId, 'welcome', 'allow_image_assets');
      if (Number(imageAssetsEnabled || 0) <= 0) {
        return res.status(403).json(toErrorResponse('Uploaded image assets are not available on your current plan.', 'FORBIDDEN'));
      }
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

  router.post('/api/admin/welcome/preset', adminAuthMiddleware, (req, res) => {
    if (!ensureWelcomeModule(req, res)) return;
    try {
      const key = String(req.body?.presetKey || '').trim().toLowerCase();
      const preset = WELCOME_PRESETS[key];
      if (!preset) return res.status(404).json(toErrorResponse('Preset not found', 'NOT_FOUND'));
      const result = welcomeService.updateSettings(req.guildId, {
        welcomeMessageTemplate: preset.message,
        welcomeEmbed: preset.embed,
      });
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to apply preset', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error applying welcome preset:', error);
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
