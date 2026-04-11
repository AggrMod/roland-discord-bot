const express = require('express');
const db = require('../../database/db');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function resolveActorUserId(req) {
  const value = req?.session?.discordUser?.id;
  return String(value || '').trim() || null;
}

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
        memoryEnabled: body.memoryEnabled,
        memoryWindowMessages: body.memoryWindowMessages,
        publicPersonaKey: body.publicPersonaKey,
        adminPersonaKey: body.adminPersonaKey,
        dailyTokenBudget: body.dailyTokenBudget,
        burstPerMinute: body.burstPerMinute,
        allowActionSuggestions: body.allowActionSuggestions,
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
        SELECT user_id, provider, model, status, error_code, latency_ms, prompt_chars, response_chars, trigger_source, channel_id, estimated_tokens, created_at
        FROM ai_assistant_usage_events
        WHERE guild_id = ?
        ORDER BY id DESC
        LIMIT 80
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
          AVG(CASE WHEN latency_ms > 0 THEN latency_ms ELSE NULL END) AS avg_latency_ms,
          SUM(COALESCE(estimated_tokens, 0)) AS estimated_tokens_total
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

      const settings = aiAssistantService.getTenantSettings(guildId);
      const configuredTokenBudget = settings.success ? Number(settings.settings.dailyTokenBudget || 0) : 0;
      const usedTokens = Number(today?.estimated_tokens_total || 0);

      return res.json(toSuccessResponse({
        today: {
          total: Number(today?.total || 0),
          ok: Number(today?.ok_count || 0),
          errors: Number(today?.error_count || 0),
          avgLatencyMs: today?.avg_latency_ms ? Math.round(Number(today.avg_latency_ms)) : 0,
          estimatedTokens: usedTokens,
        },
        byProvider: providerRows.map(row => ({ provider: row.provider || 'unknown', total: Number(row.total || 0) })),
        bySource: sourceRows.map(row => ({ source: row.trigger_source || 'unknown', total: Number(row.total || 0) })),
        tokenBudget: {
          configured: configuredTokenBudget > 0 ? configuredTokenBudget : null,
          used: usedTokens,
          remaining: configuredTokenBudget > 0 ? Math.max(0, configuredTokenBudget - usedTokens) : null,
        },
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

  router.get('/api/admin/aiassistant/personas', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const result = aiAssistantService.listPersonas(req.guildId || null);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to load personas', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error loading AI assistant personas:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/aiassistant/personas', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const result = aiAssistantService.savePersona(req.guildId || null, req.body || {});
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to save persona', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error saving AI assistant persona:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/aiassistant/personas/:personaKey', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const result = aiAssistantService.deletePersona(req.guildId || null, req.params.personaKey);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to delete persona', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error deleting AI assistant persona:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/aiassistant/role-limits', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const result = aiAssistantService.listRoleLimits(req.guildId || null);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to load role limits', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error loading AI assistant role limits:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/aiassistant/role-limits', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const result = aiAssistantService.saveRoleLimits(req.guildId || null, req.body?.limits || []);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to save role limits', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error saving AI assistant role limits:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/aiassistant/ingestion/jobs', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const result = aiAssistantService.listIngestionJobs(req.guildId || null, Number(req.query?.limit || 50));
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to load ingestion jobs', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error loading AI assistant ingestion jobs:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/aiassistant/ingestion/import', adminAuthMiddleware, async (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const sourceType = String(req.body?.sourceType || req.body?.source_type || '').trim().toLowerCase();
      const actorUserId = resolveActorUserId(req);
      let result = null;
      if (sourceType === 'url') {
        result = await aiAssistantService.importKnowledgeFromUrl(req.guildId || null, req.body || {}, actorUserId);
      } else if (sourceType === 'discord_channel') {
        result = await aiAssistantService.importKnowledgeFromDiscordChannel(req.guildId || null, req.body || {}, actorUserId);
      } else if (sourceType === 'markdown') {
        result = await aiAssistantService.importKnowledgeFromMarkdown(req.guildId || null, req.body || {}, actorUserId);
      } else if (sourceType === 'pdf_url') {
        result = await aiAssistantService.importKnowledgeFromPdfUrl(req.guildId || null, req.body || {}, actorUserId);
      } else {
        return res.status(400).json(toErrorResponse('Unsupported sourceType. Use url, markdown, pdf_url, or discord_channel.', 'VALIDATION_ERROR'));
      }

      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Knowledge import failed', 'VALIDATION_ERROR', null, result || null));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error importing AI assistant knowledge source:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/aiassistant/action-suggestions', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const result = aiAssistantService.listActionSuggestions(req.guildId || null, req.query?.status || '');
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to load action suggestions', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error loading AI assistant action suggestions:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/aiassistant/action-suggestions/generate', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const actorUserId = resolveActorUserId(req);
      if (!actorUserId) {
        return res.status(401).json(toErrorResponse('Unauthorized', 'UNAUTHORIZED'));
      }
      const result = aiAssistantService.suggestActions(
        req.guildId || null,
        actorUserId,
        req.body?.channelId || null,
        req.body?.prompt || ''
      );
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to generate action suggestions', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error generating AI assistant action suggestions:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/aiassistant/action-suggestions/:id/apply', adminAuthMiddleware, async (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const actorUserId = resolveActorUserId(req);
      if (!actorUserId) {
        return res.status(401).json(toErrorResponse('Unauthorized', 'UNAUTHORIZED'));
      }
      const result = await aiAssistantService.applyActionSuggestion(req.guildId || null, req.params.id, actorUserId);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to apply action suggestion', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error applying AI assistant action suggestion:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/aiassistant/action-suggestions/:id/reject', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const actorUserId = resolveActorUserId(req);
      if (!actorUserId) {
        return res.status(401).json(toErrorResponse('Unauthorized', 'UNAUTHORIZED'));
      }
      const result = aiAssistantService.rejectActionSuggestion(req.guildId || null, req.params.id, actorUserId);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to reject action suggestion', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error rejecting AI assistant action suggestion:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/aiassistant/analytics', adminAuthMiddleware, (req, res) => {
    if (!ensureAiAssistantModule(req, res)) return;
    try {
      const days = Number(req.query?.days || 7);
      const result = aiAssistantService.getAnalytics(req.guildId || null, days);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to load analytics', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error loading AI assistant analytics:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createAdminAiAssistantRouter;
