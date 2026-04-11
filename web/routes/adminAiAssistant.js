const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminAiAssistantRouter({
  logger,
  adminAuthMiddleware,
  ensureAiAssistantModule,
  aiAssistantService,
}) {
  const router = express.Router();

  router.get('/api/admin/aiassistant/settings', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const result = aiAssistantService.getTenantSettings(req.guildId || null);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to load AI assistant settings', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error loading AI assistant settings:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/aiassistant/settings', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const body = req.body || {};
      const result = aiAssistantService.saveTenantSettings(req.guildId || null, {
        enabled: body.enabled,
        provider: body.provider,
        modelOpenai: body.modelOpenai,
        modelGemini: body.modelGemini,
        responseVisibility: body.responseVisibility,
        systemPrompt: body.systemPrompt,
        allowedChannelIds: body.allowedChannelIds,
      });
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to save AI assistant settings', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error saving AI assistant settings:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/aiassistant/usage', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const guildId = String(req.guildId || '').trim();
      const rows = require('../../database/db').prepare(`
        SELECT user_id, provider, model, status, error_code, latency_ms, prompt_chars, response_chars, created_at
        FROM ai_assistant_usage_events
        WHERE guild_id = ?
        ORDER BY id DESC
        LIMIT 50
      `).all(guildId);
      return res.json(toSuccessResponse({ events: rows }));
    } catch (error) {
      logger.error('Error loading AI assistant usage:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createAdminAiAssistantRouter;
