const db = require('../database/db');
const logger = require('../utils/logger');
const settingsManager = require('../config/settings');
const tenantService = require('./tenantService');
const entitlementService = require('./entitlementService');
const { decryptSecret } = require('../utils/secretVault');

const DEFAULTS = Object.freeze({
  enabled: false,
  provider: 'openai',
  modelOpenai: 'gpt-5.4',
  modelGemini: 'gemini-2.0-flash',
  responseVisibility: 'public',
  systemPrompt: '',
  allowedChannelIds: [],
});

function normalizeGuildId(guildId) {
  if (typeof guildId !== 'string') return '';
  const trimmed = guildId.trim();
  return /^\d{17,20}$/.test(trimmed) ? trimmed : '';
}

function normalizeProvider(provider, fallback = 'openai') {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'gemini') return normalized;
  return fallback;
}

function normalizeVisibility(value, fallback = 'public') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'public' || normalized === 'ephemeral') return normalized;
  return fallback;
}

function normalizeAllowedChannelIds(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const id = String(raw || '').trim();
    if (!/^\d{17,20}$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

class AiAssistantService {
  getGlobalProviderSettings() {
    const global = settingsManager.getSettings ? settingsManager.getSettings() : {};
    const openaiApiKey = decryptSecret(global.openaiApiKeyEncrypted)
      || decryptSecret(global.aiAssistantApiKeyEncrypted)
      || String(global.openaiApiKey || '').trim()
      || String(process.env.OPENAI_API_KEY || '').trim();
    const geminiApiKey = decryptSecret(global.geminiApiKeyEncrypted)
      || String(global.geminiApiKey || '').trim()
      || String(process.env.GEMINI_API_KEY || '').trim();

    return {
      openaiApiKey,
      geminiApiKey,
      defaultProvider: normalizeProvider(global.aiAssistantDefaultProvider, 'openai'),
      fallbackProvider: normalizeProvider(global.aiAssistantFallbackProvider, ''),
      defaultModelOpenai: String(global.aiAssistantDefaultModelOpenai || DEFAULTS.modelOpenai).trim() || DEFAULTS.modelOpenai,
      defaultModelGemini: String(global.aiAssistantDefaultModelGemini || DEFAULTS.modelGemini).trim() || DEFAULTS.modelGemini,
    };
  }

  getTenantSettings(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) {
      return { success: false, message: 'Invalid guildId' };
    }

    const global = this.getGlobalProviderSettings();
    const row = db.prepare(`
      SELECT guild_id, enabled, provider, model_openai, model_gemini, response_visibility, system_prompt, allowed_channel_ids
      FROM ai_assistant_tenant_settings
      WHERE guild_id = ?
    `).get(normalizedGuildId);

    const settings = {
      enabled: row ? row.enabled === 1 : DEFAULTS.enabled,
      provider: normalizeProvider(row?.provider, global.defaultProvider || DEFAULTS.provider),
      modelOpenai: String(row?.model_openai || global.defaultModelOpenai || DEFAULTS.modelOpenai).trim() || DEFAULTS.modelOpenai,
      modelGemini: String(row?.model_gemini || global.defaultModelGemini || DEFAULTS.modelGemini).trim() || DEFAULTS.modelGemini,
      responseVisibility: normalizeVisibility(row?.response_visibility, DEFAULTS.responseVisibility),
      systemPrompt: String(row?.system_prompt || '').trim(),
      allowedChannelIds: normalizeAllowedChannelIds(parseJsonArray(row?.allowed_channel_ids)),
    };

    return {
      success: true,
      settings,
      global: {
        defaultProvider: global.defaultProvider,
        fallbackProvider: global.fallbackProvider,
        hasOpenaiKey: !!global.openaiApiKey,
        hasGeminiKey: !!global.geminiApiKey,
      },
    };
  }

  saveTenantSettings(guildId, payload = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guildId' };

    const current = this.getTenantSettings(normalizedGuildId);
    if (!current.success) return current;
    const next = { ...current.settings };

    if (payload.enabled !== undefined) next.enabled = !!payload.enabled;
    if (payload.provider !== undefined) next.provider = normalizeProvider(payload.provider, next.provider);
    if (payload.modelOpenai !== undefined) next.modelOpenai = String(payload.modelOpenai || '').trim() || DEFAULTS.modelOpenai;
    if (payload.modelGemini !== undefined) next.modelGemini = String(payload.modelGemini || '').trim() || DEFAULTS.modelGemini;
    if (payload.responseVisibility !== undefined) next.responseVisibility = normalizeVisibility(payload.responseVisibility, next.responseVisibility);
    if (payload.systemPrompt !== undefined) next.systemPrompt = String(payload.systemPrompt || '').trim().slice(0, 4000);
    if (payload.allowedChannelIds !== undefined) next.allowedChannelIds = normalizeAllowedChannelIds(payload.allowedChannelIds);

    db.prepare(`
      INSERT INTO ai_assistant_tenant_settings (
        guild_id, enabled, provider, model_openai, model_gemini, response_visibility, system_prompt, allowed_channel_ids, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id) DO UPDATE SET
        enabled = excluded.enabled,
        provider = excluded.provider,
        model_openai = excluded.model_openai,
        model_gemini = excluded.model_gemini,
        response_visibility = excluded.response_visibility,
        system_prompt = excluded.system_prompt,
        allowed_channel_ids = excluded.allowed_channel_ids,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      normalizedGuildId,
      next.enabled ? 1 : 0,
      next.provider,
      next.modelOpenai,
      next.modelGemini,
      next.responseVisibility,
      next.systemPrompt || null,
      JSON.stringify(next.allowedChannelIds || [])
    );

    return { success: true, settings: next };
  }

  isChannelAllowed(settings, channelId) {
    const allowed = Array.isArray(settings?.allowedChannelIds) ? settings.allowedChannelIds : [];
    if (allowed.length === 0) return true;
    const normalized = String(channelId || '').trim();
    return !!normalized && allowed.includes(normalized);
  }

  getDailyRemaining(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { allowed: false, limit: 0, used: 0, remaining: 0 };

    const limitRaw = entitlementService.getEffectiveLimit(normalizedGuildId, 'aiassistant', 'max_requests_per_day');
    const limit = (limitRaw === null || limitRaw === undefined) ? null : Number(limitRaw);
    if (limit === null) return { allowed: true, limit: null, used: 0, remaining: null };
    if (!Number.isFinite(limit) || limit <= 0) return { allowed: false, limit: 0, used: 0, remaining: 0 };

    const usedRow = db.prepare(`
      SELECT COUNT(*) AS used
      FROM ai_assistant_usage_events
      WHERE guild_id = ?
        AND status = 'ok'
        AND DATE(created_at) = DATE('now')
    `).get(normalizedGuildId);
    const used = Number(usedRow?.used || 0);
    const remaining = Math.max(0, Math.floor(limit) - used);
    return { allowed: remaining > 0, limit: Math.floor(limit), used, remaining };
  }

  logUsage({ guildId, userId, provider, model, status = 'ok', errorCode = null, latencyMs = 0, promptChars = 0, responseChars = 0 }) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedGuildId || !normalizedUserId) return;
    try {
      db.prepare(`
        INSERT INTO ai_assistant_usage_events (
          guild_id, user_id, provider, model, status, error_code, latency_ms, prompt_chars, response_chars
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalizedGuildId,
        normalizedUserId,
        String(provider || '').trim() || 'unknown',
        String(model || '').trim() || 'unknown',
        String(status || 'ok').trim() || 'ok',
        errorCode ? String(errorCode).trim() : null,
        Math.max(0, parseInt(latencyMs, 10) || 0),
        Math.max(0, parseInt(promptChars, 10) || 0),
        Math.max(0, parseInt(responseChars, 10) || 0),
      );
    } catch (error) {
      logger.warn('[ai-assistant] failed to log usage:', error?.message || error);
    }
  }

  async callOpenAi({ apiKey, model, prompt, systemPrompt }) {
    const payload = {
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 700,
    };
    const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    }, 45000);

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = json?.error?.message || `OpenAI request failed (${response.status})`;
      throw Object.assign(new Error(message), { code: `openai_${response.status}` });
    }

    const text = String(json?.choices?.[0]?.message?.content || '').trim();
    if (!text) {
      throw Object.assign(new Error('OpenAI returned an empty response'), { code: 'openai_empty' });
    }
    return text;
  }

  async callGemini({ apiKey, model, prompt, systemPrompt }) {
    const payload = {
      ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 700,
      },
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 45000);

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = json?.error?.message || `Gemini request failed (${response.status})`;
      throw Object.assign(new Error(message), { code: `gemini_${response.status}` });
    }

    const parts = json?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts) ? parts.map(part => String(part?.text || '')).join('\n').trim() : '';
    if (!text) {
      throw Object.assign(new Error('Gemini returned an empty response'), { code: 'gemini_empty' });
    }
    return text;
  }

  resolveProviderOrder(tenantProvider, fallbackProvider, globalDefault) {
    const first = normalizeProvider(tenantProvider || globalDefault, 'openai');
    const second = normalizeProvider(fallbackProvider, '');
    const out = [first];
    if (second && second !== first) out.push(second);
    return out;
  }

  async ask({ guildId, userId, channelId, prompt, providerOverride = '', requesterTag = '' }) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const cleanPrompt = String(prompt || '').trim();
    if (!normalizedGuildId) return { success: false, code: 'invalid_guild', message: 'Invalid guild context' };
    if (!cleanPrompt) return { success: false, code: 'empty_prompt', message: 'Prompt is required' };
    if (cleanPrompt.length > 3000) return { success: false, code: 'prompt_too_long', message: 'Prompt too long (max 3000 chars)' };

    if (tenantService.isMultitenantEnabled() && !tenantService.isModuleEnabled(normalizedGuildId, 'aiassistant')) {
      return { success: false, code: 'module_disabled', message: 'AI Assistant module is disabled for this server.' };
    }

    const current = this.getTenantSettings(normalizedGuildId);
    if (!current.success) return current;
    const tenantSettings = current.settings;
    if (!tenantSettings.enabled) {
      return { success: false, code: 'tenant_disabled', message: 'AI Assistant is disabled in this server settings.' };
    }
    if (!this.isChannelAllowed(tenantSettings, channelId)) {
      return { success: false, code: 'channel_blocked', message: 'AI Assistant is not enabled in this channel.' };
    }

    const allowance = this.getDailyRemaining(normalizedGuildId);
    if (!allowance.allowed) {
      return { success: false, code: 'limit_reached', message: 'Daily AI request limit reached for this plan.', allowance };
    }

    const global = this.getGlobalProviderSettings();
    const selectedProvider = providerOverride ? normalizeProvider(providerOverride, tenantSettings.provider) : tenantSettings.provider;
    const providerOrder = this.resolveProviderOrder(selectedProvider, global.fallbackProvider, global.defaultProvider);
    const systemPrompt = tenantSettings.systemPrompt || '';
    let lastError = null;

    for (const provider of providerOrder) {
      const model = provider === 'gemini'
        ? (tenantSettings.modelGemini || global.defaultModelGemini || DEFAULTS.modelGemini)
        : (tenantSettings.modelOpenai || global.defaultModelOpenai || DEFAULTS.modelOpenai);
      const apiKey = provider === 'gemini' ? global.geminiApiKey : global.openaiApiKey;
      if (!apiKey) {
        lastError = Object.assign(new Error(`${provider} API key not configured`), { code: `${provider}_key_missing` });
        continue;
      }

      const startedAt = Date.now();
      try {
        const output = provider === 'gemini'
          ? await this.callGemini({ apiKey, model, prompt: cleanPrompt, systemPrompt })
          : await this.callOpenAi({ apiKey, model, prompt: cleanPrompt, systemPrompt });
        const text = String(output || '').trim().slice(0, 3500);
        this.logUsage({
          guildId: normalizedGuildId,
          userId,
          provider,
          model,
          status: 'ok',
          latencyMs: Date.now() - startedAt,
          promptChars: cleanPrompt.length,
          responseChars: text.length,
        });
        if (requesterTag) {
          logger.log(`[ai-assistant] guild=${normalizedGuildId} provider=${provider} model=${model} by=${requesterTag}`);
        }
        return {
          success: true,
          provider,
          model,
          text,
          responseVisibility: tenantSettings.responseVisibility,
          allowance: this.getDailyRemaining(normalizedGuildId),
        };
      } catch (error) {
        lastError = error;
        this.logUsage({
          guildId: normalizedGuildId,
          userId,
          provider,
          model,
          status: 'error',
          errorCode: error?.code || 'provider_error',
          latencyMs: Date.now() - startedAt,
          promptChars: cleanPrompt.length,
          responseChars: 0,
        });
      }
    }

    return {
      success: false,
      code: lastError?.code || 'provider_error',
      message: lastError?.message || 'All configured AI providers failed.',
    };
  }
}

module.exports = new AiAssistantService();
