const db = require('../database/db');
const logger = require('../utils/logger');
const settingsManager = require('../config/settings');
const tenantService = require('./tenantService');
const entitlementService = require('./entitlementService');
const walletService = require('./walletService');
const { decryptSecret } = require('../utils/secretVault');

const DEFAULTS = Object.freeze({
  enabled: false,
  provider: 'openai',
  modelOpenai: 'gpt-5.4',
  modelGemini: 'gemini-2.0-flash',
  mentionEnabled: true,
  responseVisibility: 'public',
  systemPrompt: '',
  allowedChannelIds: [],
  allowedRoleIds: [],
  cooldownSeconds: 12,
  maxResponseChars: 1600,
  perUserDailyLimit: 20,
  safetyFilterEnabled: true,
  moderationEnabled: false,
  defaultChannelMode: 'mention',
  defaultMinConfidence: 35,
  defaultPassiveCooldownSeconds: 120,
  defaultPassiveMaxPerHour: 6,
});

const PROMPT_DENYLIST_RULES = Object.freeze([
  {
    code: 'illegal_access',
    message: 'I cannot help with hacking, account takeover, malware, or bypassing security.',
    regex: /\b(hack|hacking|exploit|malware|keylogger|ddos|bypass(?:ing)?\s+(?:security|2fa|mfa)|phish(?:ing)?)\b/i,
  },
  {
    code: 'wallet_secret_exfil',
    message: 'I cannot assist with stealing or requesting wallet secrets.',
    regex: /\b(seed phrase|mnemonic|private key|recovery phrase)\b.*\b(share|send|give|reveal|steal|extract|dump)\b|\b(share|send|give|reveal|steal|extract|dump)\b.*\b(seed phrase|mnemonic|private key|recovery phrase)\b/i,
  },
  {
    code: 'fraud',
    message: 'I cannot help with scams, fraud, or impersonation.',
    regex: /\b(scam|fraud|impersonat(?:e|ion)|drain wallet|rug pull)\b/i,
  },
]);

const SEARCH_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'at', 'is', 'it', 'this', 'that',
  'with', 'as', 'by', 'be', 'are', 'was', 'were', 'from', 'if', 'i', 'you', 'we', 'they', 'he', 'she',
  'my', 'your', 'our', 'their', 'about', 'how', 'what', 'when', 'where', 'why', 'can', 'do', 'does',
  'did', 'should', 'would', 'could', 'please', 'help', 'need', 'want', 'me', 'us'
]);

function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let mA = 0;
  let mB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    mA += vecA[i] * vecA[i];
    mB += vecB[i] * vecB[i];
  }
  mA = Math.sqrt(mA);
  mB = Math.sqrt(mB);
  if (mA === 0 || mB === 0) return 0;
  return dotProduct / (mA * mB);
}

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

function normalizeChannelMode(mode, fallback = DEFAULTS.defaultChannelMode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'off' || normalized === 'mention' || normalized === 'passive') return normalized;
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

function normalizeAllowedRoleIds(input) {
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

function normalizeIntegerInRange(value, { min, max, fallback }) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length > 2048) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.toString();
  } catch (_error) {
    return '';
  }
}

function parseTags(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const out = [];
  const seen = new Set();
  for (const token of raw.split(/[,\n]/g)) {
    const normalized = token.trim().toLowerCase();
    if (!normalized) continue;
    if (normalized.length > 32) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= 30) break;
  }
  return out;
}

function tokenizeForSearch(value) {
  const text = String(value || '').toLowerCase();
  const tokens = text.match(/[a-z0-9]{2,}/g) || [];
  const out = [];
  const seen = new Set();
  for (const token of tokens) {
    if (SEARCH_STOP_WORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 80) break;
  }
  return out;
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSnippet(body, tokens = []) {
  const clean = String(body || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= 320) return clean;

  const firstToken = tokens.find(Boolean);
  if (!firstToken) return `${clean.slice(0, 317)}...`;

  const regex = new RegExp(`\\b${escapeRegExp(firstToken)}\\b`, 'i');
  const match = regex.exec(clean);
  if (!match) return `${clean.slice(0, 317)}...`;

  const center = match.index;
  const start = Math.max(0, center - 130);
  const end = Math.min(clean.length, center + 190);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < clean.length ? '...' : '';
  return `${prefix}${clean.slice(start, end)}${suffix}`;
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
             , mention_enabled, allowed_role_ids, cooldown_seconds, max_response_chars
             , per_user_daily_limit, safety_filter_enabled, moderation_enabled
      FROM ai_assistant_tenant_settings
      WHERE guild_id = ?
    `).get(normalizedGuildId);

    const settings = {
      enabled: row ? row.enabled === 1 : DEFAULTS.enabled,
      provider: normalizeProvider(row?.provider, global.defaultProvider || DEFAULTS.provider),
      modelOpenai: String(row?.model_openai || global.defaultModelOpenai || DEFAULTS.modelOpenai).trim() || DEFAULTS.modelOpenai,
      modelGemini: String(row?.model_gemini || global.defaultModelGemini || DEFAULTS.modelGemini).trim() || DEFAULTS.modelGemini,
      mentionEnabled: row ? row.mention_enabled !== 0 : DEFAULTS.mentionEnabled,
      responseVisibility: normalizeVisibility(row?.response_visibility, DEFAULTS.responseVisibility),
      systemPrompt: String(row?.system_prompt || '').trim(),
      allowedChannelIds: normalizeAllowedChannelIds(parseJsonArray(row?.allowed_channel_ids)),
      allowedRoleIds: normalizeAllowedRoleIds(parseJsonArray(row?.allowed_role_ids)),
      cooldownSeconds: normalizeIntegerInRange(row?.cooldown_seconds, { min: 3, max: 600, fallback: DEFAULTS.cooldownSeconds }),
      maxResponseChars: normalizeIntegerInRange(row?.max_response_chars, { min: 300, max: 1900, fallback: DEFAULTS.maxResponseChars }),
      perUserDailyLimit: normalizeIntegerInRange(row?.per_user_daily_limit, { min: 0, max: 500, fallback: DEFAULTS.perUserDailyLimit }),
      safetyFilterEnabled: row ? row.safety_filter_enabled !== 0 : DEFAULTS.safetyFilterEnabled,
      moderationEnabled: row ? row.moderation_enabled === 1 : DEFAULTS.moderationEnabled,
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
    if (payload.mentionEnabled !== undefined) next.mentionEnabled = !!payload.mentionEnabled;
    if (payload.responseVisibility !== undefined) next.responseVisibility = normalizeVisibility(payload.responseVisibility, next.responseVisibility);
    if (payload.systemPrompt !== undefined) next.systemPrompt = String(payload.systemPrompt || '').trim().slice(0, 4000);
    if (payload.allowedChannelIds !== undefined) next.allowedChannelIds = normalizeAllowedChannelIds(payload.allowedChannelIds);
    if (payload.allowedRoleIds !== undefined) next.allowedRoleIds = normalizeAllowedRoleIds(payload.allowedRoleIds);
    if (payload.cooldownSeconds !== undefined) {
      next.cooldownSeconds = normalizeIntegerInRange(payload.cooldownSeconds, { min: 3, max: 600, fallback: DEFAULTS.cooldownSeconds });
    }
    if (payload.maxResponseChars !== undefined) {
      next.maxResponseChars = normalizeIntegerInRange(payload.maxResponseChars, { min: 300, max: 1900, fallback: DEFAULTS.maxResponseChars });
    }
    if (payload.perUserDailyLimit !== undefined) {
      next.perUserDailyLimit = normalizeIntegerInRange(payload.perUserDailyLimit, { min: 0, max: 500, fallback: DEFAULTS.perUserDailyLimit });
    }
    if (payload.safetyFilterEnabled !== undefined) next.safetyFilterEnabled = !!payload.safetyFilterEnabled;
    if (payload.moderationEnabled !== undefined) next.moderationEnabled = !!payload.moderationEnabled;

    db.prepare(`
      INSERT INTO ai_assistant_tenant_settings (
        guild_id, enabled, provider, model_openai, model_gemini, mention_enabled, response_visibility, system_prompt, allowed_channel_ids, allowed_role_ids, cooldown_seconds, max_response_chars, per_user_daily_limit, safety_filter_enabled, moderation_enabled, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id) DO UPDATE SET
        enabled = excluded.enabled,
        provider = excluded.provider,
        model_openai = excluded.model_openai,
        model_gemini = excluded.model_gemini,
        mention_enabled = excluded.mention_enabled,
        response_visibility = excluded.response_visibility,
        system_prompt = excluded.system_prompt,
        allowed_channel_ids = excluded.allowed_channel_ids,
        allowed_role_ids = excluded.allowed_role_ids,
        cooldown_seconds = excluded.cooldown_seconds,
        max_response_chars = excluded.max_response_chars,
        per_user_daily_limit = excluded.per_user_daily_limit,
        safety_filter_enabled = excluded.safety_filter_enabled,
        moderation_enabled = excluded.moderation_enabled,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      normalizedGuildId,
      next.enabled ? 1 : 0,
      next.provider,
      next.modelOpenai,
      next.modelGemini,
      next.mentionEnabled ? 1 : 0,
      next.responseVisibility,
      next.systemPrompt || null,
      JSON.stringify(next.allowedChannelIds || []),
      JSON.stringify(next.allowedRoleIds || []),
      next.cooldownSeconds,
      next.maxResponseChars,
      next.perUserDailyLimit,
      next.safetyFilterEnabled ? 1 : 0,
      next.moderationEnabled ? 1 : 0
    );

    return { success: true, settings: next };
  }

  getChannelPolicy(guildId, channelId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedChannelId = String(channelId || '').trim();
    if (!normalizedGuildId || !/^\d{17,20}$/.test(normalizedChannelId)) {
      return { success: false, message: 'Invalid guild/channel id' };
    }

    const row = db.prepare(`
      SELECT guild_id, channel_id, mode, min_confidence, passive_cooldown_seconds, passive_max_per_hour, updated_at
      FROM ai_assistant_channel_policies
      WHERE guild_id = ? AND channel_id = ?
    `).get(normalizedGuildId, normalizedChannelId);

    if (!row) {
      return {
        success: true,
        policy: {
          guildId: normalizedGuildId,
          channelId: normalizedChannelId,
          mode: DEFAULTS.defaultChannelMode,
          minConfidence: DEFAULTS.defaultMinConfidence,
          passiveCooldownSeconds: DEFAULTS.defaultPassiveCooldownSeconds,
          passiveMaxPerHour: DEFAULTS.defaultPassiveMaxPerHour,
          updatedAt: null,
          isDefault: true,
        }
      };
    }

    return {
      success: true,
      policy: {
        guildId: normalizedGuildId,
        channelId: normalizedChannelId,
        mode: normalizeChannelMode(row.mode),
        minConfidence: normalizeIntegerInRange(row.min_confidence, { min: 0, max: 100, fallback: DEFAULTS.defaultMinConfidence }),
        passiveCooldownSeconds: normalizeIntegerInRange(row.passive_cooldown_seconds, { min: 5, max: 3600, fallback: DEFAULTS.defaultPassiveCooldownSeconds }),
        passiveMaxPerHour: normalizeIntegerInRange(row.passive_max_per_hour, { min: 1, max: 100, fallback: DEFAULTS.defaultPassiveMaxPerHour }),
        updatedAt: row.updated_at || null,
        isDefault: false,
      }
    };
  }

  listChannelPolicies(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guildId' };

    const rows = db.prepare(`
      SELECT guild_id, channel_id, mode, min_confidence, passive_cooldown_seconds, passive_max_per_hour, updated_at
      FROM ai_assistant_channel_policies
      WHERE guild_id = ?
      ORDER BY channel_id ASC
      LIMIT 500
    `).all(normalizedGuildId);

    return {
      success: true,
      policies: rows.map(row => ({
        guildId: String(row.guild_id || ''),
        channelId: String(row.channel_id || ''),
        mode: normalizeChannelMode(row.mode),
        minConfidence: normalizeIntegerInRange(row.min_confidence, { min: 0, max: 100, fallback: DEFAULTS.defaultMinConfidence }),
        passiveCooldownSeconds: normalizeIntegerInRange(row.passive_cooldown_seconds, { min: 5, max: 3600, fallback: DEFAULTS.defaultPassiveCooldownSeconds }),
        passiveMaxPerHour: normalizeIntegerInRange(row.passive_max_per_hour, { min: 1, max: 100, fallback: DEFAULTS.defaultPassiveMaxPerHour }),
        updatedAt: row.updated_at || null,
      })),
    };
  }

  saveChannelPolicies(guildId, policies = []) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guildId' };
    if (!Array.isArray(policies)) return { success: false, message: 'Policies must be an array' };

    const normalizedPolicies = [];
    const seen = new Set();
    for (const item of policies) {
      const channelId = String(item?.channelId || item?.channel_id || '').trim();
      if (!/^\d{17,20}$/.test(channelId)) continue;
      if (seen.has(channelId)) continue;
      seen.add(channelId);
      normalizedPolicies.push({
        channelId,
        mode: normalizeChannelMode(item?.mode),
        minConfidence: normalizeIntegerInRange(item?.minConfidence, { min: 0, max: 100, fallback: DEFAULTS.defaultMinConfidence }),
        passiveCooldownSeconds: normalizeIntegerInRange(item?.passiveCooldownSeconds, { min: 5, max: 3600, fallback: DEFAULTS.defaultPassiveCooldownSeconds }),
        passiveMaxPerHour: normalizeIntegerInRange(item?.passiveMaxPerHour, { min: 1, max: 100, fallback: DEFAULTS.defaultPassiveMaxPerHour }),
      });
      if (normalizedPolicies.length >= 500) break;
    }

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM ai_assistant_channel_policies WHERE guild_id = ?').run(normalizedGuildId);
      const insertStmt = db.prepare(`
        INSERT INTO ai_assistant_channel_policies (
          guild_id, channel_id, mode, min_confidence, passive_cooldown_seconds, passive_max_per_hour, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);
      for (const policy of normalizedPolicies) {
        insertStmt.run(
          normalizedGuildId,
          policy.channelId,
          policy.mode,
          policy.minConfidence,
          policy.passiveCooldownSeconds,
          policy.passiveMaxPerHour
        );
      }
    });

    tx();
    return { success: true, count: normalizedPolicies.length };
  }

  listKnowledgeDocs(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guildId' };
    const docs = db.prepare(`
      SELECT id, guild_id, title, body, source_url, tags, enabled, created_at, updated_at
      FROM ai_assistant_knowledge_docs
      WHERE guild_id = ?
      ORDER BY enabled DESC, updated_at DESC, id DESC
      LIMIT 200
    `).all(normalizedGuildId).map(row => ({
      id: Number(row.id),
      guildId: String(row.guild_id || ''),
      title: String(row.title || ''),
      body: String(row.body || ''),
      sourceUrl: String(row.source_url || ''),
      tags: parseTags(row.tags).join(', '),
      enabled: row.enabled !== 0,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
    }));
    return { success: true, docs };
  }

  async generateEmbedding(text, openaiKey) {
    if (!text || !openaiKey) return null;
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: text.slice(0, 8000),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        logger.error('[ai-assistant-embeddings] OpenAI error:', data?.error?.message || 'Unknown');
        return null;
      }
      return data?.data?.[0]?.embedding || null;
    } catch (error) {
      logger.error('[ai-assistant-embeddings] Network error:', error);
      return null;
    }
  }

  async saveKnowledgeDoc(guildId, payload = {}, docId = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guildId' };

    const title = String(payload.title || '').trim().slice(0, 120);
    const body = String(payload.body || '').trim().slice(0, 12000);
    const sourceUrl = normalizeUrl(payload.sourceUrl || payload.source_url || '');
    const tags = parseTags(payload.tags).join(', ');
    const enabled = payload.enabled === undefined ? true : !!payload.enabled;

    if (!title) return { success: false, message: 'Title is required' };
    if (!body || body.length < 20) return { success: false, message: 'Body content is required (min 20 chars)' };

    let embeddingJson = null;
    const settings = this.getTenantSettings(normalizedGuildId);
    if (settings.success && settings.global.hasOpenaiKey) {
      const vector = await this.generateEmbedding(`${title}\n${body}`, settings.global.openaiApiKey);
      if (vector) embeddingJson = JSON.stringify(vector);
    }

    if (docId === null || docId === undefined) {
      const result = db.prepare(`
        INSERT INTO ai_assistant_knowledge_docs (guild_id, title, body, source_url, tags, enabled, vector_embedding, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(normalizedGuildId, title, body, sourceUrl || null, tags, enabled ? 1 : 0, embeddingJson);
      return { success: true, id: Number(result.lastInsertRowid) };
    }

    const normalizedDocId = Number.parseInt(docId, 10);
    if (!Number.isFinite(normalizedDocId) || normalizedDocId <= 0) {
      return { success: false, message: 'Invalid knowledge document id' };
    }
    const existing = db.prepare('SELECT id FROM ai_assistant_knowledge_docs WHERE id = ? AND guild_id = ?').get(normalizedDocId, normalizedGuildId);
    if (!existing) return { success: false, message: 'Knowledge document not found' };

    db.prepare(`
      UPDATE ai_assistant_knowledge_docs
      SET title = ?, body = ?, source_url = ?, tags = ?, enabled = ?, vector_embedding = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?
    `).run(title, body, sourceUrl || null, tags, enabled ? 1 : 0, embeddingJson, normalizedDocId, normalizedGuildId);
    return { success: true, id: normalizedDocId };
  }

  deleteKnowledgeDoc(guildId, docId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guildId' };
    const normalizedDocId = Number.parseInt(docId, 10);
    if (!Number.isFinite(normalizedDocId) || normalizedDocId <= 0) {
      return { success: false, message: 'Invalid knowledge document id' };
    }
    const result = db.prepare('DELETE FROM ai_assistant_knowledge_docs WHERE id = ? AND guild_id = ?').run(normalizedDocId, normalizedGuildId);
    if (!result.changes) return { success: false, message: 'Knowledge document not found' };
    return { success: true };
  }

  async resolveKnowledgeContext(guildId, prompt) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) {
      return { success: false, code: 'invalid_guild', message: 'Invalid guild context' };
    }

    const docs = db.prepare(`
      SELECT id, title, body, source_url, tags, vector_embedding
      FROM ai_assistant_knowledge_docs
      WHERE guild_id = ?
        AND enabled = 1
      ORDER BY updated_at DESC, id DESC
      LIMIT 250
    `).all(normalizedGuildId);

    if (!docs.length) {
      return { success: true, hasDocs: false, matches: [], confidence: 0 };
    }

    const settings = this.getTenantSettings(normalizedGuildId);
    const promptVector = settings.success && settings.global.hasOpenaiKey
      ? await this.generateEmbedding(prompt, settings.global.openaiApiKey)
      : null;

    const matches = [];
    if (promptVector) {
      for (const row of docs) {
        if (!row.vector_embedding) continue;
        try {
          const docVector = JSON.parse(row.vector_embedding);
          const similarity = cosineSimilarity(promptVector, docVector);
          if (similarity < 0.25) continue;

          matches.push({
            id: Number(row.id),
            title: row.title,
            sourceUrl: String(row.source_url || ''),
            tags: row.tags,
            score: Math.round(similarity * 100),
            similarity,
            snippet: row.body.slice(0, 1000),
          });
        } catch (e) {
          logger.error(`[ai-assistant-semantic] Error parsing vector for doc ${row.id}:`, e.message);
        }
      }
      matches.sort((a, b) => b.similarity - a.similarity);
    } else {
      const promptTokens = tokenizeForSearch(prompt);
      if (promptTokens.length > 0) {
        for (const row of docs) {
          const title = String(row.title || '');
          const body = String(row.body || '');
          const tags = parseTags(row.tags);
          const haystack = `${title}\n${body}\n${tags.join(' ')}`.toLowerCase();
          const titleTokens = tokenizeForSearch(title);
          const titleSet = new Set(titleTokens);
          const bodySet = new Set(tokenizeForSearch(`${body} ${tags.join(' ')}`));

          let overlap = 0;
          let titleOverlap = 0;
          for (const token of promptTokens) {
            if (bodySet.has(token) || haystack.includes(token)) overlap += 1;
            if (titleSet.has(token)) titleOverlap += 1;
          }
          const overlapRatio = overlap / Math.max(promptTokens.length, 1);
          const score = (overlap * 4) + (titleOverlap * 3) + Math.round(overlapRatio * 10);
          if (score < 3) continue;

          matches.push({
            id: Number(row.id),
            title,
            sourceUrl: String(row.source_url || ''),
            tags: tags.join(', '),
            score,
            similarity: overlapRatio,
            snippet: extractSnippet(body, promptTokens),
          });
        }
        matches.sort((a, b) => b.score - a.score);
      }
    }

    const topMatches = matches.slice(0, 4);
    const top = topMatches[0] || null;
    let confidence = 0;
    if (top) {
      confidence = promptVector 
        ? Math.round(Math.min(100, top.similarity * 110))
        : Math.round(Math.min(100, (Number(top.similarity || 0) * 100)));
    }

    return { success: true, hasDocs: true, matches: topMatches, confidence };
  }

  isChannelAllowed(settings, channelId) {
    const allowed = Array.isArray(settings?.allowedChannelIds) ? settings.allowedChannelIds : [];
    if (allowed.length === 0) return true;
    const normalized = String(channelId || '').trim();
    return !!normalized && allowed.includes(normalized);
  }

  isMemberRoleAllowed(settings, member) {
    const requiredRoles = Array.isArray(settings?.allowedRoleIds) ? settings.allowedRoleIds : [];
    if (requiredRoles.length === 0) return true;
    if (!member || !member.roles || !member.roles.cache) return false;
    return requiredRoles.some(roleId => member.roles.cache.has(roleId));
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

  getUserDailyRemaining(guildId, userId, perUserDailyLimit = DEFAULTS.perUserDailyLimit) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedGuildId || !normalizedUserId) {
      return { allowed: false, limit: 0, used: 0, remaining: 0 };
    }

    const limit = normalizeIntegerInRange(perUserDailyLimit, { min: 0, max: 500, fallback: DEFAULTS.perUserDailyLimit });
    if (limit <= 0) return { allowed: true, limit: null, used: 0, remaining: null };

    const usedRow = db.prepare(`
      SELECT COUNT(*) AS used
      FROM ai_assistant_usage_events
      WHERE guild_id = ?
        AND user_id = ?
        AND status = 'ok'
        AND DATE(created_at) = DATE('now')
    `).get(normalizedGuildId, normalizedUserId);
    const used = Number(usedRow?.used || 0);
    const remaining = Math.max(0, limit - used);
    return { allowed: remaining > 0, limit, used, remaining };
  }

  matchPromptDenylist(prompt) {
    const text = String(prompt || '').trim();
    if (!text) return null;
    for (const rule of PROMPT_DENYLIST_RULES) {
      if (rule.regex.test(text)) {
        return { code: rule.code, message: rule.message };
      }
    }
    return null;
  }

  async callOpenAiModeration({ apiKey, input }) {
    const response = await fetchWithTimeout('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'omni-moderation-latest',
        input: String(input || '').slice(0, 8000),
      }),
    }, 30000);

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = json?.error?.message || `Moderation request failed (${response.status})`;
      throw Object.assign(new Error(message), { code: `moderation_${response.status}` });
    }

    const result = json?.results?.[0] || {};
    return {
      flagged: !!result.flagged,
      categories: result.categories || {},
    };
  }

  logUsage({ guildId, userId, provider, model, status = 'ok', errorCode = null, latencyMs = 0, promptChars = 0, responseChars = 0, triggerSource = 'slash' }) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedGuildId || !normalizedUserId) return;
    try {
      db.prepare(`
        INSERT INTO ai_assistant_usage_events (
          guild_id, user_id, provider, model, status, error_code, latency_ms, prompt_chars, response_chars, trigger_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        String(triggerSource || 'slash').trim() || 'slash',
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

  async ask({ guildId, userId, channelId, prompt, providerOverride = '', requesterTag = '', triggerSource = 'slash', requiredConfidence = null, memberRoleNames = [] }) {
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
    const userAllowance = this.getUserDailyRemaining(normalizedGuildId, userId, tenantSettings.perUserDailyLimit);
    if (!userAllowance.allowed) {
      return { success: false, code: 'user_limit_reached', message: 'You reached your daily AI request limit for this server.', allowance, userAllowance };
    }

    const knowledge = await this.resolveKnowledgeContext(normalizedGuildId, cleanPrompt);
    if (!knowledge.success) return knowledge;
    const confidenceThreshold = requiredConfidence === null || requiredConfidence === undefined
      ? DEFAULTS.defaultMinConfidence
      : normalizeIntegerInRange(requiredConfidence, { min: 0, max: 100, fallback: DEFAULTS.defaultMinConfidence });
    const confidence = Number(knowledge.confidence || 0);

    if (!knowledge.hasDocs) {
      this.logUsage({
        guildId: normalizedGuildId,
        userId,
        provider: 'knowledge',
        model: 'local_index',
        status: 'error',
        errorCode: 'knowledge_not_configured',
        latencyMs: 0,
        promptChars: cleanPrompt.length,
        responseChars: 0,
        triggerSource,
      });
      // We log the missing knowledge but DO NOT block the request. 
      // This allows general conversational capability.
    } else if (!knowledge.matches.length) {
      this.logUsage({
        guildId: normalizedGuildId,
        userId,
        provider: 'knowledge',
        model: 'local_index',
        status: 'error',
        errorCode: 'knowledge_no_match',
        latencyMs: 0,
        promptChars: cleanPrompt.length,
        responseChars: 0,
        triggerSource,
      });
    } else {
      // We log low confidence matches, but we no longer block the request.
      // This allows the bot to fall back to general AI knowledge.
      if (confidence < confidenceThreshold) {
        this.logUsage({
          guildId: normalizedGuildId,
          userId,
          provider: 'knowledge',
          model: 'local_index',
          status: 'error',
          errorCode: 'knowledge_low_confidence',
          latencyMs: 0,
          promptChars: cleanPrompt.length,
          responseChars: 0,
          triggerSource,
        });
      }
    }

    if (tenantSettings.safetyFilterEnabled) {
      const blocked = this.matchPromptDenylist(cleanPrompt);
      if (blocked) {
        this.logUsage({
          guildId: normalizedGuildId,
          userId,
          provider: 'safety',
          model: 'denylist',
          status: 'error',
          errorCode: blocked.code,
          latencyMs: 0,
          promptChars: cleanPrompt.length,
          responseChars: 0,
          triggerSource,
        });
        return { success: false, code: 'content_blocked', message: blocked.message, allowance, userAllowance };
      }
    }

    const global = this.getGlobalProviderSettings();
    if (tenantSettings.moderationEnabled) {
      const moderationKey = global.openaiApiKey;
      if (!moderationKey) {
        return { success: false, code: 'moderation_unavailable', message: 'Moderation is enabled but no OpenAI API key is configured.' };
      }
      try {
        const moderation = await this.callOpenAiModeration({ apiKey: moderationKey, input: cleanPrompt });
        if (moderation.flagged) {
          this.logUsage({
            guildId: normalizedGuildId,
            userId,
            provider: 'moderation',
            model: 'omni-moderation-latest',
            status: 'error',
            errorCode: 'moderation_flagged_prompt',
            latencyMs: 0,
            promptChars: cleanPrompt.length,
            responseChars: 0,
            triggerSource,
          });
          return { success: false, code: 'content_blocked', message: 'That request is blocked by safety policy.', allowance, userAllowance };
        }
      } catch (error) {
        return { success: false, code: error?.code || 'moderation_error', message: error?.message || 'Moderation check failed.' };
      }
    }

    const selectedProvider = providerOverride ? normalizeProvider(providerOverride, tenantSettings.provider) : tenantSettings.provider;
    const providerOrder = this.resolveProviderOrder(selectedProvider, global.fallbackProvider, global.defaultProvider);
    const knowledgeBlock = knowledge.matches.map((entry, index) => {
      const sourceLabel = entry.sourceUrl ? ` | source: ${entry.sourceUrl}` : '';
      return `[K${index + 1}] ${entry.title}${sourceLabel}\n${entry.snippet}`;
    }).join('\n\n');
    
    const walletAddress = walletService.getFavoriteWallet(userId) || walletService.getAllUserWallets(userId)[0] || null;
    const contextBlock = [
      'User Context:',
      `- Discord Tag: ${requesterTag || 'Unknown'}`,
      `- Roles: ${Array.isArray(memberRoleNames) && memberRoleNames.length > 0 ? memberRoleNames.join(', ') : 'None'}`,
      `- Verified Wallet: ${walletAddress ? walletAddress : 'None'}`,
      `- Verification Status: ${walletAddress ? 'Verified Member' : 'Unverified Guest'}`,
    ].join('\n');

    const groundingInstruction = [
      'Grounding policy:',
      '- Use only the provided knowledge snippets for factual claims.',
      '- If snippets are insufficient, state that clearly and ask for an admin/source update.',
      '- Do not invent policies, links, dates, or procedures.',
      '- Treat K1..K4 snippets as the highest priority truth for this tenant.',
      '',
      'Knowledge snippets:',
      knowledgeBlock,
    ].join('\n');
    const systemPrompt = [tenantSettings.systemPrompt || '', contextBlock, groundingInstruction].filter(Boolean).join('\n\n');
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
        const maxChars = normalizeIntegerInRange(tenantSettings.maxResponseChars, { min: 300, max: 1900, fallback: DEFAULTS.maxResponseChars });
        const text = String(output || '').trim().slice(0, maxChars);
        this.logUsage({
          guildId: normalizedGuildId,
          userId,
          provider,
          model,
          status: 'ok',
          latencyMs: Date.now() - startedAt,
          promptChars: cleanPrompt.length,
          responseChars: text.length,
          triggerSource,
        });
        if (requesterTag) {
          logger.log(`[ai-assistant] guild=${normalizedGuildId} provider=${provider} model=${model} by=${requesterTag}`);
        }
        return {
          success: true,
          provider,
          model,
          text,
          knowledgeMatches: knowledge.matches.map(match => ({
            id: match.id,
            title: match.title,
            sourceUrl: match.sourceUrl || '',
          })),
          confidence,
          confidenceThreshold,
          responseVisibility: tenantSettings.responseVisibility,
          allowance: this.getDailyRemaining(normalizedGuildId),
          userAllowance: this.getUserDailyRemaining(normalizedGuildId, userId, tenantSettings.perUserDailyLimit),
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
          triggerSource,
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
