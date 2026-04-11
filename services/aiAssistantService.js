const db = require('../database/db');
const logger = require('../utils/logger');
const settingsManager = require('../config/settings');
const tenantService = require('./tenantService');
const entitlementService = require('./entitlementService');
const clientProvider = require('../utils/clientProvider');
const walletService = require('./walletService');
const roleService = require('./roleService');
const battleService = require('./battleService');
const { decryptSecret } = require('../utils/secretVault');
const crypto = require('crypto');
let pdfParse = null;
try {
  // Optional dependency for PDF ingestion.
  pdfParse = require('pdf-parse');
} catch (_error) {
  pdfParse = null;
}

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
  memoryEnabled: true,
  memoryWindowMessages: 6,
  publicPersonaKey: 'default_public',
  adminPersonaKey: 'default_admin',
  dailyTokenBudget: 0,
  burstPerMinute: 0,
  allowActionSuggestions: true,
  defaultChannelMode: 'mention',
  defaultMinConfidence: 35,
  defaultPassiveCooldownSeconds: 120,
  defaultPassiveMaxPerHour: 6,
  summaryEnabled: false,
  summaryChannelId: null,
  summaryActivityChannels: [],
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

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeScope(value, fallback = 'both') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'public' || normalized === 'admin' || normalized === 'both') return normalized;
  return fallback;
}

function normalizeAudience(value, fallback = 'public') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'public' || normalized === 'admin') return normalized;
  return fallback;
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
             , summary_enabled, summary_channel_id, summary_activity_channels
             , memory_enabled, memory_window_messages, public_persona_key, admin_persona_key
             , daily_token_budget, burst_per_minute, allow_action_suggestions
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
      perUserDailyLimit: normalizeIntegerInRange(row?.per_user_daily_limit, { min: 0, max: 1000, fallback: DEFAULTS.perUserDailyLimit }),
      safetyFilterEnabled: row ? row.safety_filter_enabled !== 0 : DEFAULTS.safetyFilterEnabled,
      moderationEnabled: row ? row.moderation_enabled === 1 : DEFAULTS.moderationEnabled,
      summaryEnabled: row ? row.summary_enabled === 1 : DEFAULTS.summaryEnabled,
      summaryChannelId: row?.summary_channel_id || null,
      summaryActivityChannels: normalizeAllowedChannelIds(parseJsonArray(row?.summary_activity_channels)),
      memoryEnabled: row ? row.memory_enabled !== 0 : DEFAULTS.memoryEnabled,
      memoryWindowMessages: normalizeIntegerInRange(row?.memory_window_messages, { min: 0, max: 30, fallback: DEFAULTS.memoryWindowMessages }),
      publicPersonaKey: String(row?.public_persona_key || DEFAULTS.publicPersonaKey).trim() || DEFAULTS.publicPersonaKey,
      adminPersonaKey: String(row?.admin_persona_key || DEFAULTS.adminPersonaKey).trim() || DEFAULTS.adminPersonaKey,
      dailyTokenBudget: normalizeIntegerInRange(row?.daily_token_budget, { min: 0, max: 2000000, fallback: DEFAULTS.dailyTokenBudget }),
      burstPerMinute: normalizeIntegerInRange(row?.burst_per_minute, { min: 0, max: 200, fallback: DEFAULTS.burstPerMinute }),
      allowActionSuggestions: row ? row.allow_action_suggestions !== 0 : DEFAULTS.allowActionSuggestions,
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
      next.perUserDailyLimit = normalizeIntegerInRange(payload.perUserDailyLimit, { min: 0, max: 1000, fallback: DEFAULTS.perUserDailyLimit });
    }
    if (payload.safetyFilterEnabled !== undefined) next.safetyFilterEnabled = !!payload.safetyFilterEnabled;
    if (payload.moderationEnabled !== undefined) next.moderationEnabled = !!payload.moderationEnabled;
    if (payload.summaryEnabled !== undefined) next.summaryEnabled = !!payload.summaryEnabled;
    if (payload.summaryChannelId !== undefined) next.summaryChannelId = String(payload.summaryChannelId || '').trim() || null;
    if (payload.summaryActivityChannels !== undefined) next.summaryActivityChannels = normalizeAllowedChannelIds(payload.summaryActivityChannels);
    if (payload.memoryEnabled !== undefined) next.memoryEnabled = !!payload.memoryEnabled;
    if (payload.memoryWindowMessages !== undefined) {
      next.memoryWindowMessages = normalizeIntegerInRange(payload.memoryWindowMessages, { min: 0, max: 30, fallback: DEFAULTS.memoryWindowMessages });
    }
    if (payload.publicPersonaKey !== undefined) next.publicPersonaKey = String(payload.publicPersonaKey || '').trim().slice(0, 64) || DEFAULTS.publicPersonaKey;
    if (payload.adminPersonaKey !== undefined) next.adminPersonaKey = String(payload.adminPersonaKey || '').trim().slice(0, 64) || DEFAULTS.adminPersonaKey;
    if (payload.dailyTokenBudget !== undefined) {
      next.dailyTokenBudget = normalizeIntegerInRange(payload.dailyTokenBudget, { min: 0, max: 2000000, fallback: DEFAULTS.dailyTokenBudget });
    }
    if (payload.burstPerMinute !== undefined) {
      next.burstPerMinute = normalizeIntegerInRange(payload.burstPerMinute, { min: 0, max: 200, fallback: DEFAULTS.burstPerMinute });
    }
    if (payload.allowActionSuggestions !== undefined) next.allowActionSuggestions = !!payload.allowActionSuggestions;

    db.prepare(`
      INSERT INTO ai_assistant_tenant_settings (
        guild_id, enabled, provider, model_openai, model_gemini, mention_enabled, response_visibility, system_prompt, allowed_channel_ids, allowed_role_ids, cooldown_seconds, max_response_chars, per_user_daily_limit, safety_filter_enabled, moderation_enabled, summary_enabled, summary_channel_id, summary_activity_channels, memory_enabled, memory_window_messages, public_persona_key, admin_persona_key, daily_token_budget, burst_per_minute, allow_action_suggestions, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
        summary_enabled = excluded.summary_enabled,
        summary_channel_id = excluded.summary_channel_id,
        summary_activity_channels = excluded.summary_activity_channels,
        memory_enabled = excluded.memory_enabled,
        memory_window_messages = excluded.memory_window_messages,
        public_persona_key = excluded.public_persona_key,
        admin_persona_key = excluded.admin_persona_key,
        daily_token_budget = excluded.daily_token_budget,
        burst_per_minute = excluded.burst_per_minute,
        allow_action_suggestions = excluded.allow_action_suggestions,
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
      next.moderationEnabled ? 1 : 0,
      next.summaryEnabled ? 1 : 0,
      next.summaryChannelId,
      JSON.stringify(next.summaryActivityChannels || []),
      next.memoryEnabled ? 1 : 0,
      next.memoryWindowMessages,
      next.publicPersonaKey,
      next.adminPersonaKey,
      next.dailyTokenBudget,
      next.burstPerMinute,
      next.allowActionSuggestions ? 1 : 0,
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
      SELECT id, guild_id, title, body, source_url, tags, enabled, is_lore, priority, source_type, source_ref, body_hash, stale, source_checked_at, created_at, updated_at
      FROM ai_assistant_knowledge_docs
      WHERE guild_id = ?
      ORDER BY enabled DESC, priority DESC, updated_at DESC, id DESC
      LIMIT 200
    `).all(normalizedGuildId).map(row => ({
      id: Number(row.id),
      guildId: String(row.guild_id || ''),
      title: String(row.title || ''),
      body: String(row.body || ''),
      sourceUrl: String(row.source_url || ''),
      tags: parseTags(row.tags).join(', '),
      enabled: row.enabled !== 0,
      isLore: row.is_lore !== 0,
      priority: Number(row.priority || 0),
      sourceType: String(row.source_type || 'manual'),
      sourceRef: String(row.source_ref || ''),
      bodyHash: String(row.body_hash || ''),
      stale: row.stale === 1,
      sourceCheckedAt: row.source_checked_at || null,
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
    const isLore = !!(payload.isLore ?? payload.is_lore);
    const priority = Number.parseInt(payload.priority, 10) || 0;
    const sourceType = String(payload.sourceType || payload.source_type || 'manual').trim().toLowerCase() || 'manual';
    const sourceRef = String(payload.sourceRef || payload.source_ref || '').trim().slice(0, 500) || null;
    const bodyHash = sha256Text(body);
    const sourceCheckedAt = payload.sourceCheckedAt || payload.source_checked_at || new Date().toISOString();

    if (!title) return { success: false, message: 'Title is required' };
    if (!body || body.length < 20) return { success: false, message: 'Body content is required (min 20 chars)' };

    let embeddingJson = null;
    const global = this.getGlobalProviderSettings();
    if (global.openaiApiKey) {
      const vector = await this.generateEmbedding(`${title}\n${body}`, global.openaiApiKey);
      if (vector) embeddingJson = JSON.stringify(vector);
    }

    if (docId === null || docId === undefined) {
      const result = db.prepare(`
        INSERT INTO ai_assistant_knowledge_docs (guild_id, title, body, source_url, tags, enabled, is_lore, priority, source_type, source_ref, body_hash, stale, source_checked_at, vector_embedding, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(normalizedGuildId, title, body, sourceUrl || null, tags, enabled ? 1 : 0, isLore ? 1 : 0, priority, sourceType, sourceRef, bodyHash, 0, sourceCheckedAt, embeddingJson);
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
      SET title = ?, body = ?, source_url = ?, tags = ?, enabled = ?, is_lore = ?, priority = ?, source_type = ?, source_ref = ?, body_hash = ?, stale = 0, source_checked_at = ?, vector_embedding = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?
    `).run(title, body, sourceUrl || null, tags, enabled ? 1 : 0, isLore ? 1 : 0, priority, sourceType, sourceRef, bodyHash, sourceCheckedAt, embeddingJson, normalizedDocId, normalizedGuildId);
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

  ensureDefaultPersonas(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return;
    const defaults = [
      {
        personaKey: 'default_public',
        displayName: 'Community Assistant',
        scope: 'public',
        promptText: 'You are GuildPilot assistant. Be concise, accurate, and helpful for community members.',
      },
      {
        personaKey: 'default_admin',
        displayName: 'Ops Analyst',
        scope: 'admin',
        promptText: 'You are GuildPilot operations analyst. Prioritize actionable recommendations, risks, and exact next steps.',
      },
    ];
    const stmt = db.prepare(`
      INSERT INTO ai_assistant_personas (guild_id, persona_key, display_name, scope, prompt_text, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id, persona_key) DO NOTHING
    `);
    for (const item of defaults) {
      stmt.run(normalizedGuildId, item.personaKey, item.displayName, item.scope, item.promptText);
    }
  }

  listPersonas(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guildId' };
    this.ensureDefaultPersonas(normalizedGuildId);
    const rows = db.prepare(`
      SELECT persona_key, display_name, scope, prompt_text, enabled, updated_at
      FROM ai_assistant_personas
      WHERE guild_id = ?
      ORDER BY display_name ASC, persona_key ASC
    `).all(normalizedGuildId);
    return {
      success: true,
      personas: rows.map(row => ({
        personaKey: String(row.persona_key || ''),
        displayName: String(row.display_name || ''),
        scope: normalizeScope(row.scope, 'both'),
        promptText: String(row.prompt_text || ''),
        enabled: row.enabled !== 0,
        updatedAt: row.updated_at || null,
      })),
    };
  }

  savePersona(guildId, payload = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guildId' };
    const personaKey = String(payload.personaKey || payload.persona_key || '').trim().toLowerCase().replace(/[^a-z0-9_\-]/g, '').slice(0, 64);
    const displayName = String(payload.displayName || payload.display_name || '').trim().slice(0, 80);
    const promptText = String(payload.promptText || payload.prompt_text || '').trim().slice(0, 4000);
    const scope = normalizeScope(payload.scope, 'both');
    const enabled = payload.enabled === undefined ? true : !!payload.enabled;
    if (!personaKey) return { success: false, message: 'personaKey is required' };
    if (!displayName) return { success: false, message: 'displayName is required' };
    if (!promptText) return { success: false, message: 'promptText is required' };

    db.prepare(`
      INSERT INTO ai_assistant_personas (guild_id, persona_key, display_name, scope, prompt_text, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id, persona_key) DO UPDATE SET
        display_name = excluded.display_name,
        scope = excluded.scope,
        prompt_text = excluded.prompt_text,
        enabled = excluded.enabled,
        updated_at = CURRENT_TIMESTAMP
    `).run(normalizedGuildId, personaKey, displayName, scope, promptText, enabled ? 1 : 0);
    return { success: true, personaKey };
  }

  deletePersona(guildId, personaKey) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedPersonaKey = String(personaKey || '').trim().toLowerCase();
    if (!normalizedGuildId || !normalizedPersonaKey) return { success: false, message: 'Invalid guild/persona' };
    if (normalizedPersonaKey === 'default_public' || normalizedPersonaKey === 'default_admin') {
      return { success: false, message: 'Default personas cannot be deleted' };
    }
    const result = db.prepare('DELETE FROM ai_assistant_personas WHERE guild_id = ? AND persona_key = ?').run(normalizedGuildId, normalizedPersonaKey);
    if (!result.changes) return { success: false, message: 'Persona not found' };
    return { success: true };
  }

  resolvePersonaPrompt(guildId, personaKey, audience = 'public') {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedPersonaKey = String(personaKey || '').trim().toLowerCase();
    if (!normalizedGuildId) return '';
    this.ensureDefaultPersonas(normalizedGuildId);
    const row = db.prepare(`
      SELECT prompt_text, scope, enabled
      FROM ai_assistant_personas
      WHERE guild_id = ? AND persona_key = ?
      LIMIT 1
    `).get(normalizedGuildId, normalizedPersonaKey);
    if (!row || row.enabled === 0) return '';
    const scope = normalizeScope(row.scope, 'both');
    if (scope !== 'both' && scope !== audience) return '';
    return String(row.prompt_text || '').trim();
  }

  listRoleLimits(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guildId' };
    const rows = db.prepare(`
      SELECT role_id, daily_requests_per_user, daily_tokens_per_user, updated_at
      FROM ai_assistant_role_limits
      WHERE guild_id = ?
      ORDER BY role_id ASC
    `).all(normalizedGuildId);
    return {
      success: true,
      limits: rows.map(row => ({
        roleId: String(row.role_id || ''),
        dailyRequestsPerUser: Number(row.daily_requests_per_user || 0),
        dailyTokensPerUser: Number(row.daily_tokens_per_user || 0),
        updatedAt: row.updated_at || null,
      })),
    };
  }

  saveRoleLimits(guildId, limits = []) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guildId' };
    if (!Array.isArray(limits)) return { success: false, message: 'limits must be an array' };
    const normalized = [];
    const seen = new Set();
    for (const row of limits) {
      const roleId = String(row?.roleId || row?.role_id || '').trim();
      if (!/^\d{17,20}$/.test(roleId) || seen.has(roleId)) continue;
      seen.add(roleId);
      normalized.push({
        roleId,
        dailyRequestsPerUser: normalizeIntegerInRange(row?.dailyRequestsPerUser, { min: 0, max: 1000, fallback: 0 }),
        dailyTokensPerUser: normalizeIntegerInRange(row?.dailyTokensPerUser, { min: 0, max: 2000000, fallback: 0 }),
      });
      if (normalized.length >= 500) break;
    }

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM ai_assistant_role_limits WHERE guild_id = ?').run(normalizedGuildId);
      const stmt = db.prepare(`
        INSERT INTO ai_assistant_role_limits (guild_id, role_id, daily_requests_per_user, daily_tokens_per_user, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);
      for (const row of normalized) {
        stmt.run(normalizedGuildId, row.roleId, row.dailyRequestsPerUser, row.dailyTokensPerUser);
      }
    });
    tx();
    return { success: true, count: normalized.length };
  }

  getEstimatedTokens(textLength) {
    const chars = Math.max(0, Number.parseInt(textLength, 10) || 0);
    return Math.max(1, Math.ceil(chars / 4));
  }

  getDailyTokenUsage(guildId, userId = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return 0;
    if (userId) {
      const row = db.prepare(`
        SELECT COALESCE(SUM(estimated_tokens), 0) AS total
        FROM ai_assistant_usage_events
        WHERE guild_id = ?
          AND user_id = ?
          AND status = 'ok'
          AND DATE(created_at) = DATE('now')
      `).get(normalizedGuildId, String(userId || '').trim());
      return Number(row?.total || 0);
    }
    const row = db.prepare(`
      SELECT COALESCE(SUM(estimated_tokens), 0) AS total
      FROM ai_assistant_usage_events
      WHERE guild_id = ?
        AND status = 'ok'
        AND DATE(created_at) = DATE('now')
    `).get(normalizedGuildId);
    return Number(row?.total || 0);
  }

  getBurstUsage(guildId, channelId = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return 0;
    if (channelId && /^\d{17,20}$/.test(String(channelId || '').trim())) {
      const row = db.prepare(`
        SELECT COUNT(*) AS total
        FROM ai_assistant_usage_events
        WHERE guild_id = ?
          AND channel_id = ?
          AND status = 'ok'
          AND created_at >= datetime('now', '-1 minute')
      `).get(normalizedGuildId, String(channelId || '').trim());
      return Number(row?.total || 0);
    }
    const row = db.prepare(`
      SELECT COUNT(*) AS total
      FROM ai_assistant_usage_events
      WHERE guild_id = ?
        AND status = 'ok'
        AND created_at >= datetime('now', '-1 minute')
    `).get(normalizedGuildId);
    return Number(row?.total || 0);
  }

  getEffectiveRoleLimit(guildId, memberRoleIds = []) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedRoleIds = Array.isArray(memberRoleIds)
      ? memberRoleIds.map(roleId => String(roleId || '').trim()).filter(roleId => /^\d{17,20}$/.test(roleId))
      : [];
    if (!normalizedGuildId || !normalizedRoleIds.length) {
      return { dailyRequestsPerUser: 0, dailyTokensPerUser: 0 };
    }
    const rows = db.prepare(`
      SELECT role_id, daily_requests_per_user, daily_tokens_per_user
      FROM ai_assistant_role_limits
      WHERE guild_id = ?
    `).all(normalizedGuildId);
    const matched = rows.filter(row => normalizedRoleIds.includes(String(row.role_id || '')));
    if (!matched.length) return { dailyRequestsPerUser: 0, dailyTokensPerUser: 0 };
    const strictestReq = matched
      .map(row => Number(row.daily_requests_per_user || 0))
      .filter(v => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b)[0] || 0;
    const strictestTokens = matched
      .map(row => Number(row.daily_tokens_per_user || 0))
      .filter(v => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b)[0] || 0;
    return { dailyRequestsPerUser: strictestReq, dailyTokensPerUser: strictestTokens };
  }

  getMemoryContext(guildId, userId, channelId, windowMessages = DEFAULTS.memoryWindowMessages) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedUserId = String(userId || '').trim();
    const normalizedChannelId = String(channelId || '').trim() || null;
    if (!normalizedGuildId || !normalizedUserId) {
      return { summary: '', turns: [] };
    }
    const row = db.prepare(`
      SELECT summary_text
      FROM ai_assistant_memory_state
      WHERE guild_id = ? AND user_id = ? AND channel_id IS ?
      LIMIT 1
    `).get(normalizedGuildId, normalizedUserId, normalizedChannelId);
    const turnLimit = normalizeIntegerInRange(windowMessages, { min: 0, max: 30, fallback: DEFAULTS.memoryWindowMessages });
    const turns = turnLimit > 0
      ? db.prepare(`
          SELECT prompt_text, response_text, created_at
          FROM ai_assistant_memory_entries
          WHERE guild_id = ? AND user_id = ? AND channel_id IS ?
          ORDER BY id DESC
          LIMIT ?
        `).all(normalizedGuildId, normalizedUserId, normalizedChannelId, turnLimit).reverse()
      : [];
    return {
      summary: String(row?.summary_text || '').trim(),
      turns: turns.map(turn => ({
        prompt: String(turn.prompt_text || ''),
        response: String(turn.response_text || ''),
        createdAt: turn.created_at || null,
      })),
    };
  }

  storeMemoryExchange(guildId, userId, channelId, promptText, responseText, triggerSource = 'slash', windowMessages = DEFAULTS.memoryWindowMessages) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedUserId = String(userId || '').trim();
    const normalizedChannelId = String(channelId || '').trim() || null;
    if (!normalizedGuildId || !normalizedUserId) return;
    const cleanPrompt = String(promptText || '').trim().slice(0, 1200);
    const cleanResponse = String(responseText || '').trim().slice(0, 1800);
    if (!cleanPrompt || !cleanResponse) return;

    db.prepare(`
      INSERT INTO ai_assistant_memory_entries (guild_id, user_id, channel_id, prompt_text, response_text, trigger_source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(normalizedGuildId, normalizedUserId, normalizedChannelId, cleanPrompt, cleanResponse, String(triggerSource || 'slash').trim() || 'slash');

    this.compactMemoryContext(normalizedGuildId, normalizedUserId, normalizedChannelId, windowMessages);
  }

  compactMemoryContext(guildId, userId, channelId, windowMessages = DEFAULTS.memoryWindowMessages) {
    const keep = normalizeIntegerInRange(windowMessages, { min: 0, max: 30, fallback: DEFAULTS.memoryWindowMessages });
    const rows = db.prepare(`
      SELECT id, prompt_text, response_text
      FROM ai_assistant_memory_entries
      WHERE guild_id = ? AND user_id = ? AND channel_id IS ?
      ORDER BY id ASC
    `).all(guildId, userId, channelId);
    if (rows.length <= (keep * 2)) return;

    const compactCount = Math.max(0, rows.length - keep);
    const toCompact = rows.slice(0, compactCount);
    if (!toCompact.length) return;
    const compactIds = toCompact.map(row => Number(row.id));
    const compactSummary = toCompact.map((row, index) => {
      const q = String(row.prompt_text || '').slice(0, 140);
      const a = String(row.response_text || '').slice(0, 180);
      return `${index + 1}. Q: ${q} | A: ${a}`;
    }).join('\n');

    const existingState = db.prepare(`
      SELECT summary_text FROM ai_assistant_memory_state
      WHERE guild_id = ? AND user_id = ? AND channel_id IS ?
      LIMIT 1
    `).get(guildId, userId, channelId);
    const mergedSummary = [String(existingState?.summary_text || '').trim(), compactSummary]
      .filter(Boolean)
      .join('\n')
      .slice(-4000);

    db.prepare(`
      INSERT INTO ai_assistant_memory_state (guild_id, user_id, channel_id, summary_text, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id, user_id, channel_id) DO UPDATE SET
        summary_text = excluded.summary_text,
        updated_at = CURRENT_TIMESTAMP
    `).run(guildId, userId, channelId, mergedSummary);

    const placeholders = compactIds.map(() => '?').join(', ');
    db.prepare(`DELETE FROM ai_assistant_memory_entries WHERE id IN (${placeholders})`).run(...compactIds);
  }

  async importKnowledgeFromUrl(guildId, payload = {}, requestedByUserId = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guildId' };
    const sourceUrl = normalizeUrl(payload.sourceUrl || payload.source_url || '');
    if (!sourceUrl) return { success: false, message: 'Valid source URL is required' };
    const title = String(payload.title || '').trim().slice(0, 120) || `Imported: ${sourceUrl}`;
    const tags = String(payload.tags || '').trim();

    const jobId = db.prepare(`
      INSERT INTO ai_assistant_ingestion_jobs (guild_id, status, source_type, source_ref, requested_by_user_id, payload_json, created_at, updated_at)
      VALUES (?, 'running', 'url', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(normalizedGuildId, sourceUrl, requestedByUserId ? String(requestedByUserId).trim() : null, JSON.stringify(payload || {})).lastInsertRowid;

    try {
      const response = await fetchWithTimeout(sourceUrl, { method: 'GET', headers: { 'User-Agent': 'GuildPilot-KnowledgeBot/1.0' } }, 45000);
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      const rawBody = await response.text();
      const body = contentType.includes('html') ? stripHtmlToText(rawBody) : String(rawBody || '').trim();
      if (!response.ok || !body || body.length < 20) {
        throw new Error(`Could not import from URL (${response.status})`);
      }
      const saveResult = await this.saveKnowledgeDoc(normalizedGuildId, {
        title,
        body: body.slice(0, 12000),
        tags,
        sourceUrl,
        sourceType: 'url',
        sourceRef: sourceUrl,
        enabled: true,
      });
      if (!saveResult.success) throw new Error(saveResult.message || 'Failed to save imported document');
      db.prepare(`
        UPDATE ai_assistant_ingestion_jobs
        SET status = 'completed', result_doc_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND guild_id = ?
      `).run(Number(saveResult.id), Number(jobId), normalizedGuildId);
      return { success: true, jobId: Number(jobId), docId: Number(saveResult.id) };
    } catch (error) {
      db.prepare(`
        UPDATE ai_assistant_ingestion_jobs
        SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND guild_id = ?
      `).run(String(error?.message || 'Import failed').slice(0, 500), Number(jobId), normalizedGuildId);
      return { success: false, message: error?.message || 'Import failed', jobId: Number(jobId) };
    }
  }

  async importKnowledgeFromMarkdown(guildId, payload = {}, requestedByUserId = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guildId' };
    const title = String(payload.title || '').trim().slice(0, 120) || 'Imported Markdown';
    const body = String(payload.body || '').trim().slice(0, 12000);
    if (body.length < 20) return { success: false, message: 'Markdown body must be at least 20 characters' };
    const tags = String(payload.tags || '').trim();

    const jobId = db.prepare(`
      INSERT INTO ai_assistant_ingestion_jobs (guild_id, status, source_type, source_ref, requested_by_user_id, payload_json, created_at, updated_at)
      VALUES (?, 'running', 'markdown', 'inline_markdown', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      normalizedGuildId,
      requestedByUserId ? String(requestedByUserId).trim() : null,
      JSON.stringify({ title, tags })
    ).lastInsertRowid;

    try {
      const saveResult = await this.saveKnowledgeDoc(normalizedGuildId, {
        title,
        body,
        tags,
        sourceType: 'markdown',
        sourceRef: 'inline_markdown',
        enabled: payload.enabled !== false,
      });
      if (!saveResult.success) throw new Error(saveResult.message || 'Failed to save markdown document');
      db.prepare(`
        UPDATE ai_assistant_ingestion_jobs
        SET status = 'completed', result_doc_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND guild_id = ?
      `).run(Number(saveResult.id), Number(jobId), normalizedGuildId);
      return { success: true, jobId: Number(jobId), docId: Number(saveResult.id) };
    } catch (error) {
      db.prepare(`
        UPDATE ai_assistant_ingestion_jobs
        SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND guild_id = ?
      `).run(String(error?.message || 'Markdown import failed').slice(0, 500), Number(jobId), normalizedGuildId);
      return { success: false, message: error?.message || 'Markdown import failed', jobId: Number(jobId) };
    }
  }

  async importKnowledgeFromPdfUrl(guildId, payload = {}, requestedByUserId = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guildId' };
    if (!pdfParse) {
      return { success: false, message: 'PDF parser is unavailable in this deployment.' };
    }
    const sourceUrl = normalizeUrl(payload.sourceUrl || payload.source_url || '');
    if (!sourceUrl) return { success: false, message: 'Valid PDF source URL is required' };
    const title = String(payload.title || '').trim().slice(0, 120) || `Imported PDF: ${sourceUrl}`;
    const tags = String(payload.tags || '').trim();

    const jobId = db.prepare(`
      INSERT INTO ai_assistant_ingestion_jobs (guild_id, status, source_type, source_ref, requested_by_user_id, payload_json, created_at, updated_at)
      VALUES (?, 'running', 'pdf_url', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      normalizedGuildId,
      sourceUrl,
      requestedByUserId ? String(requestedByUserId).trim() : null,
      JSON.stringify(payload || {})
    ).lastInsertRowid;

    try {
      const response = await fetchWithTimeout(sourceUrl, { method: 'GET', headers: { 'User-Agent': 'GuildPilot-KnowledgeBot/1.0' } }, 45000);
      if (!response.ok) {
        throw new Error(`Could not download PDF (${response.status})`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const parsed = await pdfParse(Buffer.from(arrayBuffer));
      const body = String(parsed?.text || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12000);
      if (body.length < 20) throw new Error('PDF text extraction returned too little content');

      const saveResult = await this.saveKnowledgeDoc(normalizedGuildId, {
        title,
        body,
        tags,
        sourceUrl,
        sourceType: 'pdf_url',
        sourceRef: sourceUrl,
        enabled: true,
      });
      if (!saveResult.success) throw new Error(saveResult.message || 'Failed to save imported PDF');
      db.prepare(`
        UPDATE ai_assistant_ingestion_jobs
        SET status = 'completed', result_doc_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND guild_id = ?
      `).run(Number(saveResult.id), Number(jobId), normalizedGuildId);
      return { success: true, jobId: Number(jobId), docId: Number(saveResult.id) };
    } catch (error) {
      db.prepare(`
        UPDATE ai_assistant_ingestion_jobs
        SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND guild_id = ?
      `).run(String(error?.message || 'PDF import failed').slice(0, 500), Number(jobId), normalizedGuildId);
      return { success: false, message: error?.message || 'PDF import failed', jobId: Number(jobId) };
    }
  }

  async importKnowledgeFromDiscordChannel(guildId, payload = {}, requestedByUserId = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guildId' };
    const channelId = String(payload.channelId || payload.channel_id || '').trim();
    if (!/^\d{17,20}$/.test(channelId)) return { success: false, message: 'Valid channelId is required' };
    const messageLimit = normalizeIntegerInRange(payload.messageLimit, { min: 20, max: 500, fallback: 120 });
    const title = String(payload.title || '').trim().slice(0, 120) || `Imported channel ${channelId}`;
    const tags = String(payload.tags || '').trim();

    const jobId = db.prepare(`
      INSERT INTO ai_assistant_ingestion_jobs (guild_id, status, source_type, source_ref, requested_by_user_id, payload_json, created_at, updated_at)
      VALUES (?, 'running', 'discord_channel', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(normalizedGuildId, channelId, requestedByUserId ? String(requestedByUserId).trim() : null, JSON.stringify(payload || {})).lastInsertRowid;

    try {
      const client = clientProvider.getClient();
      if (!client) throw new Error('Discord client is not ready');
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) throw new Error('Channel not found or not text-based');

      let before = undefined;
      const collected = [];
      while (collected.length < messageLimit) {
        const batchSize = Math.min(100, messageLimit - collected.length);
        const batch = await channel.messages.fetch({ limit: batchSize, before }).catch(() => null);
        if (!batch || batch.size === 0) break;
        const rows = Array.from(batch.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        for (const message of rows) {
          if (!message || !message.content) continue;
          collected.push(`[${new Date(message.createdTimestamp).toISOString()}] ${message.author?.username || 'unknown'}: ${message.content}`);
        }
        before = rows[0]?.id;
      }
      if (!collected.length) throw new Error('No messages found to import');
      const body = collected.join('\n').slice(0, 12000);
      const saveResult = await this.saveKnowledgeDoc(normalizedGuildId, {
        title,
        body,
        tags,
        sourceType: 'discord_channel',
        sourceRef: channelId,
        enabled: true,
      });
      if (!saveResult.success) throw new Error(saveResult.message || 'Failed to save imported channel document');
      db.prepare(`
        UPDATE ai_assistant_ingestion_jobs
        SET status = 'completed', result_doc_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND guild_id = ?
      `).run(Number(saveResult.id), Number(jobId), normalizedGuildId);
      return { success: true, jobId: Number(jobId), docId: Number(saveResult.id) };
    } catch (error) {
      db.prepare(`
        UPDATE ai_assistant_ingestion_jobs
        SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND guild_id = ?
      `).run(String(error?.message || 'Import failed').slice(0, 500), Number(jobId), normalizedGuildId);
      return { success: false, message: error?.message || 'Import failed', jobId: Number(jobId) };
    }
  }

  listIngestionJobs(guildId, limit = 50) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guildId' };
    const normalizedLimit = normalizeIntegerInRange(limit, { min: 1, max: 200, fallback: 50 });
    const rows = db.prepare(`
      SELECT id, status, source_type, source_ref, requested_by_user_id, result_doc_id, error_message, created_at, updated_at
      FROM ai_assistant_ingestion_jobs
      WHERE guild_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(normalizedGuildId, normalizedLimit);
    return {
      success: true,
      jobs: rows.map(row => ({
        id: Number(row.id),
        status: String(row.status || 'queued'),
        sourceType: String(row.source_type || ''),
        sourceRef: String(row.source_ref || ''),
        requestedByUserId: String(row.requested_by_user_id || ''),
        resultDocId: row.result_doc_id ? Number(row.result_doc_id) : null,
        errorMessage: String(row.error_message || ''),
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
      })),
    };
  }

  suggestActions(guildId, userId, channelId, prompt) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedUserId = String(userId || '').trim();
    const normalizedChannelId = String(channelId || '').trim() || null;
    const cleanPrompt = String(prompt || '').trim();
    if (!normalizedGuildId || !normalizedUserId) return { success: false, message: 'Invalid guild/user context' };
    if (!cleanPrompt) return { success: false, message: 'Prompt is required' };

    const suggestions = [];
    const lower = cleanPrompt.toLowerCase();
    if (lower.includes('faq') || lower.includes('document') || lower.includes('knowledge')) {
      suggestions.push({
        actionType: 'knowledge_doc_upsert',
        title: 'Create Knowledge Document Draft',
        reason: 'Prompt indicates missing or new documentation.',
        payload: {
          title: 'AI Draft Knowledge',
          body: cleanPrompt,
          tags: 'ai-draft,documentation',
          enabled: false,
        },
      });
    }
    if (lower.includes('verification rule') || lower.includes('verification')) {
      suggestions.push({
        actionType: 'system_prompt_append',
        title: 'Append Verification Policy Hint',
        reason: 'Prompt asks for verification logic clarification.',
        payload: {
          appendText: `\nVerification policy note: ${cleanPrompt.slice(0, 300)}`,
        },
      });
    }
    if (lower.includes('proposal') || lower.includes('governance')) {
      suggestions.push({
        actionType: 'proposal_brief_draft',
        title: 'Generate Governance Brief Draft',
        reason: 'Prompt references governance/proposal workflow.',
        payload: { briefPrompt: cleanPrompt },
      });
    }

    if (!suggestions.length) {
      suggestions.push({
        actionType: 'knowledge_doc_upsert',
        title: 'Create Generic Knowledge Draft',
        reason: 'Fallback action to capture this request for admins.',
        payload: {
          title: 'AI Captured Request',
          body: cleanPrompt,
          tags: 'ai-captured',
          enabled: false,
        },
      });
    }

    const insertStmt = db.prepare(`
      INSERT INTO ai_assistant_action_suggestions (
        guild_id, requested_by_user_id, context_channel_id, action_type, title, reason, payload_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    const createdIds = [];
    for (const suggestion of suggestions.slice(0, 5)) {
      const result = insertStmt.run(
        normalizedGuildId,
        normalizedUserId,
        normalizedChannelId,
        suggestion.actionType,
        suggestion.title,
        suggestion.reason,
        JSON.stringify(suggestion.payload || {}),
      );
      createdIds.push(Number(result.lastInsertRowid));
    }
    return { success: true, createdIds };
  }

  listActionSuggestions(guildId, status = '') {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guildId' };
    const normalizedStatus = String(status || '').trim().toLowerCase();
    const rows = normalizedStatus
      ? db.prepare(`
          SELECT id, requested_by_user_id, context_channel_id, action_type, title, reason, payload_json, status, applied_by_user_id, created_at, updated_at
          FROM ai_assistant_action_suggestions
          WHERE guild_id = ? AND status = ?
          ORDER BY id DESC
          LIMIT 200
        `).all(normalizedGuildId, normalizedStatus)
      : db.prepare(`
          SELECT id, requested_by_user_id, context_channel_id, action_type, title, reason, payload_json, status, applied_by_user_id, created_at, updated_at
          FROM ai_assistant_action_suggestions
          WHERE guild_id = ?
          ORDER BY id DESC
          LIMIT 200
        `).all(normalizedGuildId);
    return {
      success: true,
      suggestions: rows.map(row => ({
        id: Number(row.id),
        requestedByUserId: String(row.requested_by_user_id || ''),
        contextChannelId: String(row.context_channel_id || ''),
        actionType: String(row.action_type || ''),
        title: String(row.title || ''),
        reason: String(row.reason || ''),
        payload: (() => {
          try { return JSON.parse(row.payload_json || '{}'); } catch (_error) { return {}; }
        })(),
        status: String(row.status || 'pending'),
        appliedByUserId: String(row.applied_by_user_id || ''),
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
      })),
    };
  }

  async applyActionSuggestion(guildId, suggestionId, adminUserId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedAdminUserId = String(adminUserId || '').trim();
    const normalizedSuggestionId = Number.parseInt(suggestionId, 10);
    if (!normalizedGuildId || !normalizedAdminUserId || !Number.isFinite(normalizedSuggestionId) || normalizedSuggestionId <= 0) {
      return { success: false, message: 'Invalid input' };
    }
    const row = db.prepare(`
      SELECT id, action_type, payload_json, status
      FROM ai_assistant_action_suggestions
      WHERE id = ? AND guild_id = ?
      LIMIT 1
    `).get(normalizedSuggestionId, normalizedGuildId);
    if (!row) return { success: false, message: 'Suggestion not found' };
    if (String(row.status || '').toLowerCase() !== 'pending') return { success: false, message: 'Suggestion is not pending' };
    const payload = (() => {
      try { return JSON.parse(row.payload_json || '{}'); } catch (_error) { return {}; }
    })();

    if (row.action_type === 'knowledge_doc_upsert') {
      const saveResult = await this.saveKnowledgeDoc(normalizedGuildId, payload);
      if (!saveResult.success) return saveResult;
    } else if (row.action_type === 'system_prompt_append') {
      const current = this.getTenantSettings(normalizedGuildId);
      if (!current.success) return current;
      const appendText = String(payload.appendText || '').trim().slice(0, 500);
      const saveResult = this.saveTenantSettings(normalizedGuildId, {
        systemPrompt: [current.settings.systemPrompt, appendText].filter(Boolean).join('\n'),
      });
      if (!saveResult.success) return saveResult;
    } else if (row.action_type === 'proposal_brief_draft') {
      const brief = await this.generateProposalBrief(normalizedGuildId, {
        title: 'AI Draft',
        category: 'general',
        description: String(payload.briefPrompt || '').trim().slice(0, 2000),
      });
      if (!brief) return { success: false, message: 'Could not generate proposal draft' };
      await this.saveKnowledgeDoc(normalizedGuildId, {
        title: 'AI Draft Proposal Brief',
        body: brief,
        tags: 'proposal,ai-draft',
        enabled: false,
      });
    } else {
      return { success: false, message: `Unsupported action type: ${row.action_type}` };
    }

    db.prepare(`
      UPDATE ai_assistant_action_suggestions
      SET status = 'applied', applied_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?
    `).run(normalizedAdminUserId, normalizedSuggestionId, normalizedGuildId);
    return { success: true };
  }

  rejectActionSuggestion(guildId, suggestionId, adminUserId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedAdminUserId = String(adminUserId || '').trim();
    const normalizedSuggestionId = Number.parseInt(suggestionId, 10);
    if (!normalizedGuildId || !normalizedAdminUserId || !Number.isFinite(normalizedSuggestionId) || normalizedSuggestionId <= 0) {
      return { success: false, message: 'Invalid input' };
    }
    const result = db.prepare(`
      UPDATE ai_assistant_action_suggestions
      SET status = 'rejected', applied_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ? AND status = 'pending'
    `).run(normalizedAdminUserId, normalizedSuggestionId, normalizedGuildId);
    if (!result.changes) return { success: false, message: 'Pending suggestion not found' };
    return { success: true };
  }

  getAnalytics(guildId, windowDays = 7) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'Invalid guildId' };
    const days = normalizeIntegerInRange(windowDays, { min: 1, max: 30, fallback: 7 });
    const rows = db.prepare(`
      SELECT prompt_text, error_code, status, trigger_source, provider, model, estimated_tokens, created_at
      FROM ai_assistant_usage_events
      WHERE guild_id = ?
        AND DATE(created_at) >= DATE('now', ?)
      ORDER BY id DESC
      LIMIT 2000
    `).all(normalizedGuildId, `-${days} day`);

    const missingRows = rows.filter(row => String(row.error_code || '').startsWith('knowledge_') || String(row.status || '').toLowerCase() !== 'ok');
    const topicCounter = new Map();
    for (const row of missingRows) {
      const tokens = tokenizeForSearch(String(row.prompt_text || '')).slice(0, 8);
      const key = tokens.slice(0, 3).join(' ');
      if (!key) continue;
      topicCounter.set(key, Number(topicCounter.get(key) || 0) + 1);
    }
    const topMissingTopics = Array.from(topicCounter.entries())
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);

    const estimatedTokenUsage = rows.reduce((sum, row) => sum + Number(row.estimated_tokens || 0), 0);
    const providerCounter = new Map();
    for (const row of rows) {
      const key = String(row.provider || 'unknown');
      providerCounter.set(key, Number(providerCounter.get(key) || 0) + 1);
    }
    const byProvider = Array.from(providerCounter.entries()).map(([provider, total]) => ({ provider, total }));

    return {
      success: true,
      days,
      totals: {
        events: rows.length,
        missingKnowledgeEvents: missingRows.length,
        estimatedTokenUsage,
      },
      byProvider,
      topMissingTopics,
      recommendations: topMissingTopics.slice(0, 6).map(item => ({
        title: `Add KB entry: ${item.topic}`,
        reason: `Detected ${item.count} unresolved requests on this topic`,
      })),
    };
  }

  isAdminAudience(triggerSource, memberRoleNames = []) {
    const source = String(triggerSource || '').trim().toLowerCase();
    if (source.includes('admin') || source.includes('superadmin')) return true;
    const adminHints = ['admin', 'owner', 'moderator', 'mod', 'staff', 'team', 'support'];
    return (Array.isArray(memberRoleNames) ? memberRoleNames : [])
      .map(name => String(name || '').toLowerCase())
      .some(name => adminHints.some(hint => name.includes(hint)));
  }

  cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    return Number.isFinite(similarity) ? similarity : 0;
  }

  /**
   * Generates a concise "Family Brief" summary for a governance proposal.
   */
  async generateProposalBrief(guildId, proposal) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!proposal) return null;

    const persona = "You are the Consigliere of the Cartoon Maffia. Your job is to provide a sharp, concise 'Family Brief' (2-3 sentences) for a new proposal. " +
                    "Focus on the 'why' and the potential impact on the Family's treasury or territory. Keep the tone professional but gritty Mafioso.";

    const prompt = `Proposal Title: ${proposal.title}\nCategory: ${proposal.category}\nDescription: ${proposal.description}\n\nProvide the brief:`;

    try {
      const response = await this.ask({
        guildId: normalizedGuildId,
        userId: 'system-agent',
        channelId: null,
        prompt,
        triggerSource: 'proposal_brief',
        overrideSystemPrompt: persona,
        skipKnowledge: true,
        skipChannelCheck: true,
        skipRoleCheck: true,
      });
      return response.success ? response.text : null;
    } catch (e) {
      logger.error(`[ai-assistant-proposal] Error generating brief for ${proposal.proposal_id}:`, e);
      return null;
    }
  }

  /**
   * Generates a "Gritty Recap" for a completed heist mission.
   */
  async generateMissionRecap(guildId, mission, participants) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!mission) return null;

    const eraContext = `Current Era: ${await battleService.getCurrentEraConfiguration(normalizedGuildId).then(e => e?.name || 'Unknown')}`;
    const participantNames = (participants || []).map(p => p.username).join(', ');
    
    const persona = "You are a underworld journalist/chronicler for the Cartoon Maffia. " +
                    "Write a short, flavorful 'Heat Recap' (3-4 sentences) of a recently completed heist/mission. " +
                    "Mention a few of the participants and the outcome. Keep it immersive and era-appropriate.";

    const prompt = `${eraContext}\nMission: ${mission.title}\nDescription: ${mission.description}\n` +
                   `Participants: ${participantNames}\nOutcome: Successfully completed, rewards distributed.\n\nWrite the recap:`;

    try {
      const response = await this.ask({
        guildId: normalizedGuildId,
        userId: 'system-agent',
        channelId: null,
        prompt,
        triggerSource: 'mission_recap',
        overrideSystemPrompt: persona,
        skipKnowledge: true,
        skipChannelCheck: true,
        skipRoleCheck: true,
      });
      return response.success ? response.text : null;
    } catch (e) {
      logger.error(`[ai-assistant-mission] Error generating recap for ${mission.mission_id}:`, e);
      return null;
    }
  }

  /**
   * Generates a narrative summary of all family activity from the last 24h.
   */
  async generateDailyFamilyRecap(guildId, activityData) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!activityData) return null;

    const persona = "You are the primary chronicler for the Cartoon Maffia. " +
                    "Your job is to write the 'Daily Family Report'—a gritty, immersive narrative summary of the last 24 hours of moves. " +
                    "Focus on the power plays, successful heists, arena combat outcomes, and new plans hatching. Tone: Gritty, professional Mafioso. " +
                    "Highlight 'Family Honors' (the most active members) with distinctive flair. " +
                    "Avoid generic corporate language. Use Family terminology (e.g., 'territory', 'business', 'made men', 'the arena').";

    const prompt = `Family Activity from the last 24 hours:\n\n${JSON.stringify(activityData, null, 2)}\n\n` +
                   `Write the Daily Family Report (3 paragraphs). Include a section for 'Family Honors' acknowledging the most active members listed in the data.`;

    try {
      const response = await this.ask({
        guildId: normalizedGuildId,
        userId: 'system-agent',
        channelId: null,
        prompt,
        triggerSource: 'daily_family_recap',
        overrideSystemPrompt: persona,
        skipKnowledge: true,
        skipChannelCheck: true,
        skipRoleCheck: true,
      });
      return response.success ? response.text : null;
    } catch (e) {
      logger.error(`[ai-assistant-daily] Error generating daily recap for ${normalizedGuildId}:`, e);
      return null;
    }
  }

  /**
   * Generates an instant, personalized briefing for a member or the family.
   */
  async generateInstantBriefing(guildId, options = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);

    // Gather current state (bounded to keep prompt size safe).
    const currentProposals = db.prepare("SELECT title, status FROM proposals WHERE guild_id = ? AND status IN ('supporting', 'voting')").all(normalizedGuildId);
    const activeMissions = db.prepare("SELECT title FROM missions WHERE guild_id = ? AND status = 'active'").all(normalizedGuildId);
    const recentBattles = db.prepare("SELECT lobby_id, status FROM battle_lobbies WHERE guild_id = ? AND status IN ('open', 'in_progress')").all(normalizedGuildId);

    const proposals = (currentProposals || []).slice(0, 12).map(item => ({
      title: String(item?.title || '').slice(0, 100),
      status: String(item?.status || '').slice(0, 32),
    }));
    const missions = (activeMissions || []).slice(0, 12).map(item => String(item?.title || '').slice(0, 100));
    const arenas = (recentBattles || []).slice(0, 12).map(item => ({
      lobby: String(item?.lobby_id || '').slice(0, 32),
      status: String(item?.status || '').slice(0, 32),
    }));

    const persona = "You are the Family Consigliere. A member is asking for an update on current affairs. " +
                    "Give them a sharp, concise briefing on current 'business' (proposals), 'heists' (missions), and 'the arena' (battles). " +
                    "Tone: Efficient, loyal, slightly dangerous. If things are quiet, encourage them to stir up some trouble.";

    const proposalLine = proposals.length
      ? proposals.map(item => `${item.title} [${item.status}]`).join(' | ')
      : 'No active proposals.';
    const missionLine = missions.length
      ? missions.join(' | ')
      : 'No active missions.';
    const arenaLine = arenas.length
      ? arenas.map(item => `${item.lobby} [${item.status}]`).join(' | ')
      : 'No active arena battles.';

    let prompt = [
      'Current Family State:',
      `Business (proposals): ${proposalLine}`,
      `Heists (missions): ${missionLine}`,
      `Arena: ${arenaLine}`,
      '',
      'Provide a concise status briefing for the member (1-2 paragraphs).',
    ].join('\n');

    if (prompt.length > 2800) {
      prompt = `${prompt.slice(0, 2750)}\n\n(Truncated state snapshot for brevity.)`;
    }

    try {
      const callerUserId = String(options.userId || '').trim() || 'system-agent';
      const callerChannelId = String(options.channelId || '').trim() || null;
      const response = await this.ask({
        guildId: normalizedGuildId,
        userId: callerUserId,
        channelId: callerChannelId,
        prompt,
        requesterTag: String(options.requesterTag || '').trim(),
        triggerSource: 'instant_briefing',
        memberRoleNames: Array.isArray(options.memberRoleNames) ? options.memberRoleNames : [],
        memberRoleIds: Array.isArray(options.memberRoleIds) ? options.memberRoleIds : [],
        overrideSystemPrompt: persona,
        skipKnowledge: true,
        skipChannelCheck: !callerChannelId,
        skipRoleCheck: !callerChannelId,
      });
      if (!response.success) {
        return {
          success: false,
          code: response.code || 'briefing_failed',
          message: response.message || 'Briefing request failed.',
        };
      }
      return {
        success: true,
        text: response.text,
      };
    } catch (e) {
      logger.error(`[ai-assistant-briefing] Error generating briefing for ${normalizedGuildId}:`, e);
      return {
        success: false,
        code: 'briefing_exception',
        message: e?.message || 'Briefing request failed unexpectedly.',
      };
    }
  }

  async resolveKnowledgeContext(guildId, prompt) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) {
      return { success: false, code: 'invalid_guild', message: 'Invalid guild context' };
    }

    const global = this.getGlobalProviderSettings();
    let promptVector = null;
    if (global.openaiApiKey) {
      promptVector = await this.generateEmbedding(prompt, global.openaiApiKey);
    }

    const docs = db.prepare(`
      SELECT id, title, body, source_url, tags, is_lore, priority, vector_embedding
      FROM ai_assistant_knowledge_docs
      WHERE guild_id = ?
        AND enabled = 1
    `).all(normalizedGuildId);

    if (!docs.length) {
      return { success: true, hasDocs: false, matches: [], confidence: 0 };
    }

    const matches = [];

    if (promptVector) {
      // 1. Semantic Search Branch
      for (const row of docs) {
        if (!row.vector_embedding) continue;
        try {
          const docVector = JSON.parse(row.vector_embedding);
          const similarity = this.cosineSimilarity(promptVector, docVector);
          
          // Hybrid Score: weight similarity + priority + lore boost
          const loreBoost = (row.is_lore && similarity > 0.3) ? 0.15 : 0;
          const priorityBoost = (Number(row.priority) || 0) * 0.01;
          const totalScore = similarity + loreBoost + priorityBoost;

          // Threshold for inclusion
          if (totalScore < 0.35) continue;

          matches.push({
            id: Number(row.id),
            title: row.title,
            sourceUrl: String(row.source_url || ''),
            tags: row.tags,
            score: Math.round(totalScore * 100),
            similarity: similarity, 
            snippet: String(row.body || '').slice(0, 1500),
          });
        } catch (e) {
          logger.error(`[ai-assistant-semantic] Error parsing vector for doc ${row.id}:`, e.message);
        }
      }
      matches.sort((a, b) => b.score - a.score);
    } else {
      // 2. Fallback Keyword Search Branch (if no OpenAI key or embedding fails)
      const promptTokens = tokenizeForSearch(prompt);
      if (promptTokens.length > 0) {
        for (const row of docs) {
          const title = String(row.title || '');
          const body = String(row.body || '');
          const tags = parseTags(row.tags);
          const haystack = `${title}\n${body}\n${tags.join(' ')}`.toLowerCase();
          
          let overlap = 0;
          for (const token of promptTokens) {
            if (haystack.includes(token)) overlap += 1;
          }
          const overlapRatio = overlap / Math.max(promptTokens.length, 1);
          
          const loreBoost = (row.is_lore && overlapRatio > 0.2) ? 5 : 0;
          const priorityBoost = (Number(row.priority) || 0);
          const score = (overlap * 4) + loreBoost + priorityBoost;

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

    const finalMatches = matches.slice(0, 15);
    const highestSimilarity = finalMatches.length > 0 ? Math.max(...finalMatches.map(m => m.similarity)) : 0;

    return {
      success: true,
      hasDocs: true,
      matches: finalMatches,
      confidence: Math.round(highestSimilarity * 100),
    };
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

  logUsage({
    guildId,
    userId,
    provider,
    model,
    status = 'ok',
    errorCode = null,
    latencyMs = 0,
    promptChars = 0,
    responseChars = 0,
    triggerSource = 'slash',
    promptText = null,
    channelId = null,
    estimatedTokens = 0,
  }) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedGuildId || !normalizedUserId) return;
    try {
      db.prepare(`
        INSERT INTO ai_assistant_usage_events (
          guild_id, user_id, provider, model, status, error_code, latency_ms, prompt_chars, response_chars, trigger_source, prompt_text, channel_id, estimated_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        promptText ? String(promptText).trim().slice(0, 3000) : null,
        (channelId && /^\d{17,20}$/.test(String(channelId).trim())) ? String(channelId).trim() : null,
        Math.max(0, parseInt(estimatedTokens, 10) || 0),
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

  async injectRpgContext(guildId, userId) {
    const ctx = {
      tier: 'Guest',
      era: 'Modern',
      recentWinner: null,
      recentMission: null,
    };

    try {
      // 1. User Tier
      const user = await roleService.getUserInfo(userId);
      if (user && user.tier) {
        ctx.tier = user.tier;
      }

      // 2. Current Era
      const settings = this.getTenantSettings(guildId);
      const eraKey = settings.settings?.era || 'mafia';
      const eraConfig = battleService.getEraConfig(eraKey);
      ctx.era = eraConfig?.name || 'Mafia';

      // 3. Recent Battle Winner
      const battleDb = require('../database/battleDb');
      const lastLobby = battleDb.prepare(`
        SELECT lobby_id FROM battle_lobbies 
        WHERE status = 'completed' AND guild_id = ? 
        ORDER BY completed_at DESC LIMIT 1
      `).get(guildId);

      if (lastLobby) {
        const winner = battleDb.prepare(`
          SELECT username FROM battle_participants 
          WHERE lobby_id = ? AND is_alive = 1 LIMIT 1
        `).get(lastLobby.lobby_id);
        if (winner) {
          ctx.recentWinner = winner.username;
        }
      }

      // 4. Recent Mission
      const lastMission = db.prepare(`
        SELECT title, status FROM missions 
        WHERE guild_id = ? 
        ORDER BY created_at DESC LIMIT 1
      `).get(guildId);
      if (lastMission) {
        ctx.recentMission = `${lastMission.title} (${lastMission.status})`;
      }
    } catch (error) {
      logger.warn('[ai-assistant] failed to inject RPG context:', error);
    }

    return ctx;
  }

  async ask({
    guildId,
    userId,
    channelId,
    prompt,
    providerOverride = '',
    requesterTag = '',
    triggerSource = 'slash',
    requiredConfidence = null,
    memberRoleNames = [],
    memberRoleIds = [],
    overrideSystemPrompt = '',
    audienceOverride = '',
    skipKnowledge = false,
    skipChannelCheck = false,
    skipRoleCheck = false,
  }) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedUserId = String(userId || '').trim() || 'system-agent';
    const normalizedChannelId = /^\d{17,20}$/.test(String(channelId || '').trim()) ? String(channelId || '').trim() : null;
    const isSystemRequest = normalizedUserId === 'system-agent';
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
    if (!skipChannelCheck && !this.isChannelAllowed(tenantSettings, normalizedChannelId)) {
      return { success: false, code: 'channel_blocked', message: 'AI Assistant is not enabled in this channel.' };
    }
    if (!skipRoleCheck && Array.isArray(tenantSettings.allowedRoleIds) && tenantSettings.allowedRoleIds.length > 0) {
      const normalizedMemberRoleIds = Array.isArray(memberRoleIds)
        ? memberRoleIds.map(roleId => String(roleId || '').trim()).filter(Boolean)
        : [];
      const hasAllowedRole = normalizedMemberRoleIds.some(roleId => tenantSettings.allowedRoleIds.includes(roleId));
      if (!hasAllowedRole) {
        return { success: false, code: 'role_blocked', message: 'You do not have an allowed role for AI Assistant in this server.' };
      }
    }

    const allowance = this.getDailyRemaining(normalizedGuildId);
    if (!isSystemRequest && !allowance.allowed) {
      return { success: false, code: 'limit_reached', message: 'Daily AI request limit reached for this plan.', allowance };
    }

    const effectiveRoleLimit = this.getEffectiveRoleLimit(normalizedGuildId, memberRoleIds);
    const userLimitCandidates = [];
    const tenantUserLimit = Number(tenantSettings.perUserDailyLimit || 0);
    if (tenantUserLimit > 0) userLimitCandidates.push(tenantUserLimit);
    if (Number(effectiveRoleLimit.dailyRequestsPerUser || 0) > 0) userLimitCandidates.push(Number(effectiveRoleLimit.dailyRequestsPerUser));
    const effectivePerUserLimit = userLimitCandidates.length ? Math.min(...userLimitCandidates) : 0;

    const userAllowance = isSystemRequest
      ? { allowed: true, limit: null, used: 0, remaining: null }
      : this.getUserDailyRemaining(normalizedGuildId, normalizedUserId, effectivePerUserLimit);
    if (!userAllowance.allowed) {
      return { success: false, code: 'user_limit_reached', message: 'You reached your daily AI request limit for this server.', allowance, userAllowance };
    }

    const maxChars = normalizeIntegerInRange(tenantSettings.maxResponseChars, { min: 300, max: 1900, fallback: DEFAULTS.maxResponseChars });
    const estimatedRequestTokens = this.getEstimatedTokens(cleanPrompt.length + Math.min(maxChars, 1600));
    const tenantDailyTokenBudget = Number(tenantSettings.dailyTokenBudget || 0);
    const burstPerMinute = Number(tenantSettings.burstPerMinute || 0);
    const roleTokenLimit = Number(effectiveRoleLimit.dailyTokensPerUser || 0);

    if (!isSystemRequest && burstPerMinute > 0) {
      const burstUsed = this.getBurstUsage(normalizedGuildId, normalizedChannelId);
      if (burstUsed >= burstPerMinute) {
        return {
          success: false,
          code: 'burst_limited',
          message: 'AI Assistant is temporarily rate-limited in this server. Please retry in a minute.',
          burst: { limit: burstPerMinute, used: burstUsed, remaining: Math.max(0, burstPerMinute - burstUsed) },
        };
      }
    }

    const guildTokensUsed = this.getDailyTokenUsage(normalizedGuildId);
    if (!isSystemRequest && tenantDailyTokenBudget > 0 && (guildTokensUsed + estimatedRequestTokens) > tenantDailyTokenBudget) {
      return {
        success: false,
        code: 'token_budget_reached',
        message: 'Daily AI token budget has been reached for this server.',
        tokenBudget: {
          limit: tenantDailyTokenBudget,
          used: guildTokensUsed,
          remaining: Math.max(0, tenantDailyTokenBudget - guildTokensUsed),
        },
      };
    }

    const userTokensUsed = isSystemRequest ? 0 : this.getDailyTokenUsage(normalizedGuildId, normalizedUserId);
    if (!isSystemRequest && roleTokenLimit > 0 && (userTokensUsed + estimatedRequestTokens) > roleTokenLimit) {
      return {
        success: false,
        code: 'role_token_limit_reached',
        message: 'Your AI usage token allowance has been reached for today.',
        roleTokenBudget: {
          limit: roleTokenLimit,
          used: userTokensUsed,
          remaining: Math.max(0, roleTokenLimit - userTokensUsed),
        },
      };
    }

    const knowledge = skipKnowledge
      ? { success: true, hasDocs: false, matches: [], confidence: 0 }
      : await this.resolveKnowledgeContext(normalizedGuildId, cleanPrompt);
    if (!knowledge.success) return knowledge;
    const confidenceThreshold = requiredConfidence === null || requiredConfidence === undefined
      ? DEFAULTS.defaultMinConfidence
      : normalizeIntegerInRange(requiredConfidence, { min: 0, max: 100, fallback: DEFAULTS.defaultMinConfidence });
    const confidence = Number(knowledge.confidence || 0);
    const allowSuggestions = !isSystemRequest
      && tenantSettings.allowActionSuggestions
      && !skipKnowledge
      && !!normalizedChannelId;
    const createSuggestions = () => {
      if (!allowSuggestions) return;
      try {
        this.suggestActions(normalizedGuildId, normalizedUserId, normalizedChannelId, cleanPrompt);
      } catch (error) {
        logger.warn('[ai-assistant] failed to create action suggestion:', error?.message || error);
      }
    };

    if (!skipKnowledge) {
      if (!knowledge.hasDocs) {
        this.logUsage({
          guildId: normalizedGuildId,
          userId: normalizedUserId,
          provider: 'knowledge',
          model: 'local_index',
          status: 'error',
          errorCode: 'knowledge_not_configured',
          latencyMs: 0,
          promptChars: cleanPrompt.length,
          responseChars: 0,
          triggerSource,
          promptText: cleanPrompt,
          channelId: normalizedChannelId,
          estimatedTokens: estimatedRequestTokens,
        });
        createSuggestions();
        // We log the missing knowledge but DO NOT block the request.
        // This allows general conversational capability.
      } else if (!knowledge.matches.length) {
        this.logUsage({
          guildId: normalizedGuildId,
          userId: normalizedUserId,
          provider: 'knowledge',
          model: 'local_index',
          status: 'error',
          errorCode: 'knowledge_no_match',
          latencyMs: 0,
          promptChars: cleanPrompt.length,
          responseChars: 0,
          triggerSource,
          promptText: cleanPrompt,
          channelId: normalizedChannelId,
          estimatedTokens: estimatedRequestTokens,
        });
        createSuggestions();
      } else {
        // We log low confidence matches, but we no longer block the request.
        // This allows the bot to fall back to general AI knowledge.
        if (confidence < confidenceThreshold) {
          this.logUsage({
            guildId: normalizedGuildId,
            userId: normalizedUserId,
            provider: 'knowledge',
            model: 'local_index',
            status: 'error',
            errorCode: 'knowledge_low_confidence',
            latencyMs: 0,
            promptChars: cleanPrompt.length,
            responseChars: 0,
            triggerSource,
            promptText: cleanPrompt,
            channelId: normalizedChannelId,
            estimatedTokens: estimatedRequestTokens,
          });
          createSuggestions();
        }
      }
    }

    if (tenantSettings.safetyFilterEnabled) {
      const blocked = this.matchPromptDenylist(cleanPrompt);
      if (blocked) {
        this.logUsage({
          guildId: normalizedGuildId,
          userId: normalizedUserId,
          provider: 'safety',
          model: 'denylist',
          status: 'error',
          errorCode: blocked.code,
          latencyMs: 0,
          promptChars: cleanPrompt.length,
          responseChars: 0,
          triggerSource,
          promptText: cleanPrompt,
          channelId: normalizedChannelId,
          estimatedTokens: estimatedRequestTokens,
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
            userId: normalizedUserId,
            provider: 'moderation',
            model: 'omni-moderation-latest',
            status: 'error',
            errorCode: 'moderation_flagged_prompt',
            latencyMs: 0,
            promptChars: cleanPrompt.length,
            responseChars: 0,
            triggerSource,
            promptText: cleanPrompt,
            channelId: normalizedChannelId,
            estimatedTokens: estimatedRequestTokens,
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
    
    const walletAddress = walletService.getFavoriteWallet(normalizedUserId) || walletService.getAllUserWallets(normalizedUserId)[0] || null;
    const rpg = await this.injectRpgContext(normalizedGuildId, normalizedUserId);

    const contextBlock = [
      'Guild & User Context:',
      `- Server Era: ${rpg.era}`,
      `- User Tag: ${requesterTag || 'Unknown'}`,
      `- User RPG Rank: ${rpg.tier}`,
      `- Roles: ${Array.isArray(memberRoleNames) && memberRoleNames.length > 0 ? memberRoleNames.join(', ') : 'None'}`,
      `- Verified Wallet: ${walletAddress ? walletAddress : 'None'}`,
      `- Verification Status: ${walletAddress ? 'Verified Member' : 'Unverified Guest'}`,
      rpg.recentWinner ? `- Last Battle Winner: ${rpg.recentWinner}` : null,
      rpg.recentMission ? `- Latest Mission: ${rpg.recentMission}` : null,
    ].filter(Boolean).join('\n');

    const audience = normalizeAudience(
      audienceOverride,
      this.isAdminAudience(triggerSource, memberRoleNames) ? 'admin' : 'public'
    );
    const personaKey = audience === 'admin' ? tenantSettings.adminPersonaKey : tenantSettings.publicPersonaKey;
    const personaPrompt = this.resolvePersonaPrompt(normalizedGuildId, personaKey, audience)
      || this.resolvePersonaPrompt(normalizedGuildId, audience === 'admin' ? DEFAULTS.adminPersonaKey : DEFAULTS.publicPersonaKey, audience);
    const personaInstruction = personaPrompt
      || (rpg.era.toLowerCase().includes('mafia')
        ? 'Adopt a slightly gritty, street-wise Mafia persona. Use terms like "Associate," "Consigliere," "The Syndicate," or "Family business" naturally.'
        : 'Maintain a helpful, immersive persona consistent with the current guild era.');

    const memoryContext = (!isSystemRequest && tenantSettings.memoryEnabled)
      ? this.getMemoryContext(normalizedGuildId, normalizedUserId, normalizedChannelId, tenantSettings.memoryWindowMessages)
      : { summary: '', turns: [] };
    const memoryTurnsText = (memoryContext.turns || [])
      .map((turn, index) => `Turn ${index + 1} user: ${String(turn.prompt || '').slice(0, 280)}\nTurn ${index + 1} assistant: ${String(turn.response || '').slice(0, 380)}`)
      .join('\n');
    const memoryBlock = [
      memoryContext.summary ? `Conversation summary:\n${memoryContext.summary}` : '',
      memoryTurnsText ? `Recent turns:\n${memoryTurnsText}` : '',
    ].filter(Boolean).join('\n\n');

    const groundingInstruction = [
      personaInstruction,
      '',
      'Grounding policy:',
      '- Use only the provided knowledge snippets for factual claims.',
      '- If snippets are insufficient, state that clearly and ask for an admin/source update.',
      '- Do not invent policies, links, dates, or procedures.',
      '- Treat K1..K4 snippets as the highest priority truth for this tenant.',
      '- Prioritize Lore-related documents when answering world-building questions.',
      '',
      'Knowledge snippets:',
      knowledgeBlock || 'No tenant knowledge snippet matched for this question.',
    ].join('\n');
    const finalSystemPrompt = String(overrideSystemPrompt || tenantSettings.systemPrompt || '').trim();
    const systemPrompt = [finalSystemPrompt, contextBlock, memoryBlock, groundingInstruction].filter(Boolean).join('\n\n');
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
        const text = String(output || '').trim().slice(0, maxChars);
        const estimatedTokens = this.getEstimatedTokens(cleanPrompt.length + text.length);
        this.logUsage({
          guildId: normalizedGuildId,
          userId: normalizedUserId,
          provider,
          model,
          status: 'ok',
          latencyMs: Date.now() - startedAt,
          promptChars: cleanPrompt.length,
          responseChars: text.length,
          triggerSource,
          promptText: cleanPrompt,
          channelId: normalizedChannelId,
          estimatedTokens,
        });
        if (!isSystemRequest && tenantSettings.memoryEnabled) {
          this.storeMemoryExchange(
            normalizedGuildId,
            normalizedUserId,
            normalizedChannelId,
            cleanPrompt,
            text,
            triggerSource,
            tenantSettings.memoryWindowMessages
          );
        }
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
          allowance: isSystemRequest ? { allowed: true, limit: null, used: 0, remaining: null } : this.getDailyRemaining(normalizedGuildId),
          userAllowance: isSystemRequest
            ? { allowed: true, limit: null, used: 0, remaining: null }
            : this.getUserDailyRemaining(normalizedGuildId, normalizedUserId, effectivePerUserLimit),
          tokenBudget: {
            limit: tenantDailyTokenBudget > 0 ? tenantDailyTokenBudget : null,
            used: this.getDailyTokenUsage(normalizedGuildId),
          },
          roleTokenBudget: {
            limit: roleTokenLimit > 0 ? roleTokenLimit : null,
            used: isSystemRequest ? 0 : this.getDailyTokenUsage(normalizedGuildId, normalizedUserId),
          },
        };
      } catch (error) {
        lastError = error;
        this.logUsage({
          guildId: normalizedGuildId,
          userId: normalizedUserId,
          provider,
          model,
          status: 'error',
          errorCode: error?.code || 'provider_error',
          latencyMs: Date.now() - startedAt,
          promptChars: cleanPrompt.length,
          responseChars: 0,
          triggerSource,
          promptText: cleanPrompt,
          channelId: normalizedChannelId,
          estimatedTokens: estimatedRequestTokens,
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
