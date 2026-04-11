const express = require('express');
const db = require('../../database/db');
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
        mentionEnabled: body.mentionEnabled,
        responseVisibility: body.responseVisibility,
        systemPrompt: body.systemPrompt,
        allowedChannelIds: body.allowedChannelIds,
        allowedRoleIds: body.allowedRoleIds,
        cooldownSeconds: body.cooldownSeconds,
        maxResponseChars: body.maxResponseChars,
        perUserDailyLimit: body.perUserDailyLimit,
        safetyFilterEnabled: body.safetyFilterEnabled,
        moderationEnabled: body.moderationEnabled,
        summaryEnabled: body.summaryEnabled,
        summaryChannelId: body.summaryChannelId,
        summaryActivityChannels: body.summaryActivityChannels,
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
      const rows = db.prepare(`
        SELECT user_id, provider, model, status, error_code, latency_ms, prompt_chars, response_chars, trigger_source, created_at
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

  router.get('/api/admin/aiassistant/usage-summary', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const guildId = String(req.guildId || '').trim();
      const today = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
          SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END) AS error_count,
          AVG(CASE WHEN latency_ms > 0 THEN latency_ms ELSE NULL END) AS avg_latency_ms
        FROM ai_assistant_usage_events
        WHERE guild_id = ?
          AND DATE(created_at) = DATE('now')
      `).get(guildId);

      const providerRows = db.prepare(`
        SELECT provider, COUNT(*) AS total
        FROM ai_assistant_usage_events
        WHERE guild_id = ?
          AND DATE(created_at) = DATE('now')
        GROUP BY provider
        ORDER BY total DESC, provider ASC
      `).all(guildId);

      const sourceRows = db.prepare(`
        SELECT trigger_source, COUNT(*) AS total
        FROM ai_assistant_usage_events
        WHERE guild_id = ?
          AND DATE(created_at) = DATE('now')
        GROUP BY trigger_source
        ORDER BY total DESC, trigger_source ASC
      `).all(guildId);

      return res.json(toSuccessResponse({
        today: {
          total: Number(today?.total || 0),
          ok: Number(today?.ok_count || 0),
          errors: Number(today?.error_count || 0),
          avgLatencyMs: today?.avg_latency_ms ? Math.round(Number(today.avg_latency_ms)) : 0,
        },
        byProvider: providerRows.map(row => ({ provider: row.provider || 'unknown', total: Number(row.total || 0) })),
        bySource: sourceRows.map(row => ({ source: row.trigger_source || 'unknown', total: Number(row.total || 0) })),
      }));
    } catch (error) {
      logger.error('Error loading AI assistant usage summary:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/aiassistant/channel-policies', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const result = aiAssistantService.listChannelPolicies(req.guildId || null);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to load channel policies', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error loading AI assistant channel policies:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/aiassistant/channel-policies', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const body = req.body || {};
      const result = aiAssistantService.saveChannelPolicies(req.guildId || null, body.policies || []);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to save channel policies', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error saving AI assistant channel policies:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/aiassistant/knowledge', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const result = aiAssistantService.listKnowledgeDocs(req.guildId || null);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to load knowledge sources', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error loading AI assistant knowledge docs:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/aiassistant/knowledge', adminAuthMiddleware, async (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const result = await aiAssistantService.saveKnowledgeDoc(req.guildId || null, req.body || {});
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to save knowledge source', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error creating AI assistant knowledge doc:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/aiassistant/knowledge/:id', adminAuthMiddleware, async (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const result = await aiAssistantService.saveKnowledgeDoc(req.guildId || null, req.body || {}, req.params.id);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update knowledge source', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error updating AI assistant knowledge doc:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/aiassistant/knowledge/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const result = aiAssistantService.deleteKnowledgeDoc(req.guildId || null, req.params.id);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to delete knowledge source', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error deleting AI assistant knowledge doc:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createAdminAiAssistantRouter;
