const crypto = require('crypto');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../../database/db');
const moduleGuard = require('../../utils/moduleGuard');
const { DEFAULT_CONFIG, mergeConfig } = require('./defaults');
const DetectionPipeline = require('./pipeline');
const EventWindowStore = require('./eventWindow');
const actionService = require('./actions');
const identityRegistry = require('./identityRegistry');
const domainRegistry = require('./domainRegistry');
const presetRegistry = require('./presets');
const threatIntelRegistry = require('./threatIntelRegistry');
const { scoreSignals, riskLevel } = require('./scoring');
const {
  spamFloodDetector,
  duplicateMessageDetector,
  massMentionDetector,
  suspiciousAccountDetector,
  impersonationDetector,
  scamLanguageDetector,
  linkProtectionDetector,
  attachmentThreatDetector,
  coordinatedCampaignDetector,
  accountTrustDetector,
  raidBurstDetector
} = require('./detectors');

function jsonParse(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; }
}

function normalizeGuildId(guildId) {
  const value = String(guildId || '').trim();
  return value || null;
}

const GUILD_GUARD_RULE_DETECTORS = new Set([
  'spam_flood', 'duplicate_message', 'mass_mention', 'suspicious_account',
  'staff_impersonation', 'wallet_drainer_language', 'link_protection', 'lookalike_domain',
  'link_deception', 'dangerous_attachment', 'qr_code_link', 'coordinated_link_campaign',
  'coordinated_message_campaign', 'low_trust_destination', 'account_link_burst', 'threat_intelligence_domain', 'raid_burst'
]);

const GLOBAL_REPUTATION_CATEGORIES = new Set(['spam', 'unsafe_link', 'impersonation', 'scam', 'suspicious_account']);
const GLOBAL_REPUTATION_LABELS = Object.freeze({
  spam: 'Spam',
  unsafe_link: 'Unsafe link',
  impersonation: 'Impersonation',
  scam: 'Scam',
  suspicious_account: 'Suspicious account'
});

function normalizeGlobalCategory(value, incident = null) {
  const requested = String(value || '').trim().toLowerCase();
  if (GLOBAL_REPUTATION_CATEGORIES.has(requested)) return requested;
  let signals = [];
  try { signals = JSON.parse(incident?.signals_json || '[]'); } catch (_) { signals = []; }
  const detectors = new Set(signals.map(signal => String(signal?.detector || '').trim()));
  if (detectors.has('staff_impersonation')) return 'impersonation';
  if (detectors.has('wallet_drainer_language') || detectors.has('dangerous_attachment') || detectors.has('qr_code_link') || detectors.has('coordinated_link_campaign')) return 'scam';
  if (detectors.has('link_protection') || detectors.has('lookalike_domain') || detectors.has('link_deception') || detectors.has('threat_intelligence_domain')) return 'unsafe_link';
  if (detectors.has('spam_flood') || detectors.has('duplicate_message') || detectors.has('mass_mention') || detectors.has('coordinated_message_campaign')) return 'spam';
  if (detectors.has('suspicious_account') || detectors.has('low_trust_destination') || detectors.has('account_link_burst') || detectors.has('raid_burst')) return 'suspicious_account';
  return 'scam';
}

function getGlobalReputationConfig(guildId) {
  const config = getConfig(guildId).globalReputation || {};
  const defaults = DEFAULT_CONFIG.globalReputation;
  const halfLifeDays = Object.fromEntries(Object.entries(defaults.halfLifeDays).map(([category, fallback]) => [
    category,
    Math.max(1, Math.min(3650, Number(config.halfLifeDays?.[category] || fallback) || fallback))
  ]));
  return {
    consumeEnabled: config.consumeEnabled !== false,
    publishEnabled: config.publishEnabled === true,
    notifyOnJoin: config.notifyOnJoin !== false,
    alertThreshold: Math.max(1, Math.min(100, Number(config.alertThreshold || defaults.alertThreshold) || defaults.alertThreshold)),
    halfLifeDays
  };
}

function parseUtcTimestamp(value) {
  const timestamp = String(value || '');
  if (!timestamp) return NaN;
  const normalized = !/[zZ]|[+-]\d\d:?\d\d$/.test(timestamp)
    ? `${timestamp.replace(' ', 'T')}Z`
    : timestamp;
  return new Date(normalized).getTime();
}

function globalReportContribution(report, config, now = Date.now()) {
  const baseScore = Math.max(0, Math.min(100, Number(report.base_score) || 0));
  const halfLifeDays = config.halfLifeDays[normalizeGlobalCategory(report.category)] || 90;
  const reportedAt = parseUtcTimestamp(report.created_at);
  const ageDays = Number.isFinite(reportedAt) ? Math.max(0, (now - reportedAt) / 86400000) : 0;
  const contribution = baseScore * Math.pow(0.5, ageDays / halfLifeDays);
  return { ...report, category: normalizeGlobalCategory(report.category), ageDays, contribution };
}

function getGlobalReputation(userId, options = {}) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return { userId: null, activeScore: 0, reportCount: 0, sourceCount: 0, categories: [], reports: [] };
  const reports = db.prepare("SELECT * FROM guild_guard_global_reports WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC, id DESC")
    .all(normalizedUserId);
  const config = getGlobalReputationConfig(options.guildId || null);
  const contributions = reports
    .filter(report => !options.excludeGuildId || report.source_guild_id !== String(options.excludeGuildId))
    .map(report => globalReportContribution(report, config, options.now || Date.now()));
  const categories = [...new Set(contributions.map(report => report.category))];
  const sourceCount = new Set(contributions.map(report => report.source_guild_id)).size;
  const activeScore = Math.min(100, Math.round(contributions.reduce((total, report) => total + report.contribution, 0)));
  const lastReportedAt = contributions.map(report => report.created_at).sort().pop() || null;
  const firstReportedAt = contributions.map(report => report.created_at).sort().shift() || null;
  return {
    userId: normalizedUserId,
    activeScore,
    level: activeScore >= 80 ? 'high' : activeScore >= 50 ? 'elevated' : activeScore > 0 ? 'low' : 'none',
    reportCount: contributions.length,
    sourceCount,
    categories,
    categoryLabels: categories.map(category => GLOBAL_REPUTATION_LABELS[category] || category),
    firstReportedAt,
    lastReportedAt,
    reports: options.includeReports === false ? [] : contributions.map(report => ({
      reportId: report.report_id,
      category: report.category,
      categoryLabel: GLOBAL_REPUTATION_LABELS[report.category] || report.category,
      baseScore: Number(report.base_score) || 0,
      contribution: Math.round(report.contribution * 10) / 10,
      ageDays: Math.round(report.ageDays * 10) / 10,
      createdAt: report.created_at,
      status: report.status
    }))
  };
}

function getGlobalReportForIncident(guildId, incidentId) {
  return db.prepare('SELECT * FROM guild_guard_global_reports WHERE source_guild_id = ? AND source_incident_id = ?')
    .get(normalizeGuildId(guildId), String(incidentId || '').trim()) || null;
}

function listGlobalReports(guildId, limit = 100) {
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
  return db.prepare('SELECT * FROM guild_guard_global_reports WHERE source_guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(normalizeGuildId(guildId), bounded);
}

function publishGlobalReport(guildId, incidentId, reportedBy, category = null) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const incident = getIncident(normalizedGuildId, incidentId);
  if (!incident) throw new Error('Incident not found');
  if (incident.status !== 'confirmed') throw new Error('Only confirmed incidents can be published globally');
  if (!incident.user_id) throw new Error('Incident has no target user');
  if (!getGlobalReputationConfig(normalizedGuildId).publishEnabled) throw new Error('Global reputation publishing is disabled');
  const existing = getGlobalReportForIncident(normalizedGuildId, incident.incident_id);
  if (existing?.status === 'active') return existing;
  const reportId = existing?.report_id || crypto.randomUUID();
  const normalizedCategory = normalizeGlobalCategory(category, incident);
  db.prepare(`
    INSERT INTO guild_guard_global_reports
      (report_id, user_id, category, base_score, source_guild_id, source_incident_id, reported_by, status, revoke_reason, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL)
    ON CONFLICT(source_guild_id, source_incident_id) DO UPDATE SET
      user_id = excluded.user_id, category = excluded.category, base_score = excluded.base_score,
      reported_by = excluded.reported_by, status = 'active', revoke_reason = NULL,
      revoked_at = NULL, updated_at = CURRENT_TIMESTAMP
  `).run(reportId, incident.user_id, normalizedCategory, Math.max(1, Math.min(100, Number(incident.risk_score) || 0)), normalizedGuildId, incident.incident_id, String(reportedBy || 'unknown'));
  db.prepare(`
    INSERT INTO actions (guild_id, incident_id, action_type, status, metadata_json)
    VALUES (?, ?, 'global_publish', 'applied', ?)
  `).run(normalizedGuildId, incident.incident_id, JSON.stringify({ reportedBy: reportedBy || null, category: normalizedCategory }));
  return getGlobalReportForIncident(normalizedGuildId, incident.incident_id);
}

function revokeGlobalReport(reportId, actorId, reason = '', guildId = null) {
  const normalizedReportId = String(reportId || '').trim();
  const existing = db.prepare('SELECT * FROM guild_guard_global_reports WHERE report_id = ?').get(normalizedReportId);
  if (!existing) return null;
  if (guildId && existing.source_guild_id !== normalizeGuildId(guildId)) return null;
  db.prepare(`
    UPDATE guild_guard_global_reports
    SET status = 'revoked', revoke_reason = ?, revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE report_id = ?
  `).run(String(reason || '').slice(0, 1000) || `Revoked by ${actorId || 'admin'}`, normalizedReportId);
  return db.prepare('SELECT * FROM guild_guard_global_reports WHERE report_id = ?').get(normalizedReportId);
}

function claimGlobalMatch(guildId, eventId, userId, reportId, activeScore) {
  return db.prepare(`
    INSERT OR IGNORE INTO guild_guard_global_matches (guild_id, event_id, user_id, report_id, active_score)
    VALUES (?, ?, ?, ?, ?)
  `).run(normalizeGuildId(guildId), String(eventId || '').trim(), String(userId || '').trim(), String(reportId || '').trim(), Number(activeScore) || 0).changes > 0;
}

function normalizeRules(value) {
  const source = Array.isArray(value)
    ? value
    : (value?.staffImpersonation ? [{
      id: 'staff_impersonation_escalation',
      name: 'Staff impersonation escalation',
      detectors: ['staff_impersonation'],
      threshold: value.staffImpersonation.threshold,
      enabled: value.staffImpersonation.enabled,
      actions: value.staffImpersonation
    }] : []);
  return source.map((rule, index) => {
    const detectors = [...new Set((Array.isArray(rule?.detectors) ? rule.detectors : [rule?.detector])
      .map(detector => String(detector || '').trim()).filter(detector => GUILD_GUARD_RULE_DETECTORS.has(detector)))];
    const actions = rule?.actions && typeof rule.actions === 'object' ? rule.actions : rule;
    return {
      id: String(rule?.id || `guild_guard_rule_${index + 1}`).trim().slice(0, 80),
      name: String(rule?.name || `Guild Guard rule ${index + 1}`).trim().slice(0, 120),
      detectors: detectors.length ? detectors : ['staff_impersonation'],
      threshold: Math.max(1, Math.min(100, Number(rule?.threshold ?? 50) || 50)),
      enabled: rule?.enabled !== false,
      actions: {
        timeoutUsers: actions.timeoutUsers === true,
        timeoutSeconds: Math.max(1, Math.min(2419200, Number(actions.timeoutSeconds || 3600))),
        deleteMessages: actions.deleteMessages !== false,
        notifyStaff: actions.notifyStaff !== false,
        pingStaff: actions.pingStaff === true
      }
    };
  });
}

function defaultRow(guildId) {
  return { guild_id: guildId, enabled: 0, mode: DEFAULT_CONFIG.mode, config_json: JSON.stringify(DEFAULT_CONFIG) };
}

function getConfig(guildId) {
  const normalized = normalizeGuildId(guildId);
  if (!normalized) return mergeConfig(DEFAULT_CONFIG, {});
  let row = db.prepare('SELECT * FROM guild_guard_configs WHERE guild_id = ?').get(normalized);
  if (!row) {
    const seed = defaultRow(normalized);
    db.prepare('INSERT OR IGNORE INTO guild_guard_configs (guild_id, enabled, mode, config_json) VALUES (?, ?, ?, ?)')
      .run(seed.guild_id, seed.enabled, seed.mode, seed.config_json);
    row = db.prepare('SELECT * FROM guild_guard_configs WHERE guild_id = ?').get(normalized) || seed;
  }
  const config = mergeConfig(DEFAULT_CONFIG, jsonParse(row.config_json, {}));
  config.rules = normalizeRules(config.rules);
  config.enabled = Boolean(row.enabled);
  config.mode = row.mode || config.mode;
  return config;
}

function updateConfig(guildId, patch) {
  const normalized = normalizeGuildId(guildId);
  if (!normalized) throw new Error('guildId is required');
  const current = getConfig(normalized);
  const next = mergeConfig(current, patch);
  next.rules = normalizeRules(next.rules);
  db.prepare(`
    INSERT INTO guild_guard_configs (guild_id, enabled, mode, config_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET enabled = excluded.enabled, mode = excluded.mode,
      config_json = excluded.config_json, updated_at = CURRENT_TIMESTAMP
  `).run(normalized, next.enabled ? 1 : 0, next.mode, JSON.stringify(next));
  return next;
}

function applyPreset(guildId, presetKey) {
  const preset = presetRegistry.getPreset(presetKey);
  if (!preset) throw new Error('Unknown Guild Guard protection preset');
  return updateConfig(guildId, preset.patch);
}

function listRules(guildId) {
  return getConfig(guildId).rules;
}

function createRule(guildId, input, actorId = null) {
  const normalizedGuildId = normalizeGuildId(guildId);
  if (!normalizedGuildId) throw new Error('guildId is required');
  const rule = normalizeRules([{ ...input, id: crypto.randomUUID(), createdBy: actorId }])[0];
  if (!String(input?.name || '').trim()) throw new Error('Rule name is required');
  const rules = listRules(normalizedGuildId);
  rules.push(rule);
  return updateConfig(normalizedGuildId, { rules });
}

function updateRule(guildId, ruleId, patch) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const normalizedRuleId = String(ruleId || '').trim();
  const rules = listRules(normalizedGuildId);
  const index = rules.findIndex(rule => rule.id === normalizedRuleId);
  if (index < 0) return null;
  rules[index] = normalizeRules([{ ...rules[index], ...patch, id: normalizedRuleId }])[0];
  return updateConfig(normalizedGuildId, { rules }).rules.find(rule => rule.id === normalizedRuleId) || null;
}

function deleteRule(guildId, ruleId) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const normalizedRuleId = String(ruleId || '').trim();
  const rules = listRules(normalizedGuildId);
  const next = rules.filter(rule => rule.id !== normalizedRuleId);
  if (next.length === rules.length) return false;
  updateConfig(normalizedGuildId, { rules: next });
  return true;
}

function isExempt(event, config) {
  const exemptions = config?.exemptions || {};
  if (event.isWebhook) return exemptions.webhookUsers === true;
  if (exemptions.botUsers && event.isBot) return true;
  if (exemptions.owner && event.isOwner) return true;
  if ((exemptions.userIds || []).includes(event.userId)) return true;
  if ((exemptions.channelIds || []).includes(event.channelId)) return true;
  return (event.roleIds || []).some(roleId => (exemptions.roleIds || []).includes(roleId));
}

function decayRiskScore(score, updatedAt, config, now = Date.now()) {
  if (config?.risk?.decayEnabled === false) return Math.max(0, Number(score) || 0);
  const halfLifeHours = Math.max(1, Number(config?.risk?.decayHalfLifeHours) || 24);
  // SQLite CURRENT_TIMESTAMP is UTC but has no timezone suffix. Parsing it as
  // local time makes a fresh profile look hours old on non-UTC hosts.
  const timestamp = String(updatedAt || '');
  const normalizedTimestamp = timestamp && !/[zZ]|[+-]\d\d:?\d\d$/.test(timestamp)
    ? `${timestamp.replace(' ', 'T')}Z`
    : timestamp;
  const updatedMs = normalizedTimestamp ? new Date(normalizedTimestamp).getTime() : now;
  if (!Number.isFinite(updatedMs) || updatedMs >= now) return Math.max(0, Number(score) || 0);
  const factor = Math.pow(0.5, Math.max(0, now - updatedMs) / (halfLifeHours * 3600000));
  return Math.max(0, Math.round((Number(score) || 0) * factor));
}

function getRiskProfile(guildId, userId, applyDecay = true) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedGuildId || !normalizedUserId) return null;
  const row = db.prepare('SELECT * FROM risk_profiles WHERE guild_id = ? AND user_id = ?').get(normalizedGuildId, normalizedUserId);
  if (!row) return null;
  const config = getConfig(normalizedGuildId);
  const score = applyDecay ? decayRiskScore(row.risk_score, row.updated_at, config) : Number(row.risk_score) || 0;
  const level = riskLevel(score, config);
  if (score !== Number(row.risk_score) || level !== row.risk_level) {
    db.prepare('UPDATE risk_profiles SET risk_score = ?, risk_level = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND user_id = ?')
      .run(score, level, normalizedGuildId, normalizedUserId);
  }
  const current = db.prepare('SELECT * FROM risk_profiles WHERE guild_id = ? AND user_id = ?').get(normalizedGuildId, normalizedUserId) || row;
  return { ...current, risk_score: score, risk_level: level };
}

function listRiskSignals(guildId, userId, limit = 100) {
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
  return db.prepare('SELECT * FROM risk_signals WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(normalizeGuildId(guildId), String(userId || '').trim(), bounded)
    .map(row => ({ ...row, metadata: jsonParse(row.metadata_json, {}) }));
}

function listUserIncidents(guildId, userId, limit = 50) {
  const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
  return db.prepare('SELECT * FROM incidents WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(normalizeGuildId(guildId), String(userId || '').trim(), bounded);
}

function getUserIncidentSummary(guildId, userId) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedGuildId || !normalizedUserId) return { total: 0, open: 0, confirmed: 0, falsePositive: 0, averageRiskScore: 0 };
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN status = 'false_positive' THEN 1 ELSE 0 END) AS falsePositive,
      ROUND(COALESCE(AVG(risk_score), 0), 1) AS averageRiskScore
    FROM incidents WHERE guild_id = ? AND user_id = ?
  `).get(normalizedGuildId, normalizedUserId);
  return {
    total: Number(row?.total || 0),
    open: Number(row?.open || 0),
    confirmed: Number(row?.confirmed || 0),
    falsePositive: Number(row?.falsePositive || 0),
    averageRiskScore: Number(row?.averageRiskScore || 0)
  };
}

function clearUserHistory(guildId, userId) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedGuildId || !normalizedUserId) throw new Error('guildId and userId are required');
  const tx = db.transaction(() => {
    const incidentIds = db.prepare('SELECT incident_id FROM incidents WHERE guild_id = ? AND user_id = ?')
      .all(normalizedGuildId, normalizedUserId).map(row => row.incident_id);
    const counts = { incidents: incidentIds.length, actions: 0, signals: 0, falsePositives: 0, riskProfiles: 0, globalReportsRevoked: 0, memberReports: 0 };
    if (incidentIds.length) {
      const placeholders = incidentIds.map(() => '?').join(',');
      counts.actions = db.prepare(`DELETE FROM actions WHERE guild_id = ? AND incident_id IN (${placeholders})`).run(normalizedGuildId, ...incidentIds).changes;
      counts.falsePositives = db.prepare(`DELETE FROM false_positives WHERE guild_id = ? AND incident_id IN (${placeholders})`).run(normalizedGuildId, ...incidentIds).changes;
      counts.globalReportsRevoked = db.prepare(`
        UPDATE guild_guard_global_reports
        SET status = 'revoked', revoke_reason = 'Local user history cleared', revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE source_guild_id = ? AND source_incident_id IN (${placeholders}) AND status = 'active'
      `).run(normalizedGuildId, ...incidentIds).changes;
    }
    counts.signals = db.prepare('DELETE FROM risk_signals WHERE guild_id = ? AND user_id = ?').run(normalizedGuildId, normalizedUserId).changes;
    db.prepare('DELETE FROM incidents WHERE guild_id = ? AND user_id = ?').run(normalizedGuildId, normalizedUserId);
    counts.riskProfiles = db.prepare('DELETE FROM risk_profiles WHERE guild_id = ? AND user_id = ?').run(normalizedGuildId, normalizedUserId).changes;
    counts.memberReports = db.prepare('DELETE FROM guild_guard_member_reports WHERE guild_id = ? AND (reporter_user_id = ? OR reported_user_id = ?)')
      .run(normalizedGuildId, normalizedUserId, normalizedUserId).changes;
    return counts;
  });
  return tx();
}

function resetRiskProfile(guildId, userId) {
  return db.prepare('DELETE FROM risk_profiles WHERE guild_id = ? AND user_id = ?').run(normalizeGuildId(guildId), String(userId || '').trim()).changes > 0;
}

function decayRiskProfiles(guildId = null) {
  const rows = guildId
    ? db.prepare('SELECT * FROM risk_profiles WHERE guild_id = ?').all(normalizeGuildId(guildId))
    : db.prepare('SELECT * FROM risk_profiles').all();
  let changed = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const config = getConfig(row.guild_id);
      const score = decayRiskScore(row.risk_score, row.updated_at, config);
      const level = riskLevel(score, config);
      if (score === Number(row.risk_score) && level === row.risk_level) continue;
      changed += db.prepare('UPDATE risk_profiles SET risk_score = ?, risk_level = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND user_id = ?')
        .run(score, level, row.guild_id, row.user_id).changes;
    }
  });
  tx();
  return changed;
}

async function recordSignals(event, signals, config = getConfig(event.guildId)) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO risk_signals
      (guild_id, event_id, user_id, detector, severity, score, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const signal of signals) {
      insert.run(event.guildId, event.eventId, event.userId, String(signal.detector || 'unknown'), String(signal.severity || 'info'), Number(signal.score) || 0, JSON.stringify(signal.metadata || {}));
    }
    if (event.userId) {
      const existing = db.prepare('SELECT * FROM risk_profiles WHERE guild_id = ? AND user_id = ?').get(event.guildId, event.userId);
      const previousScore = existing ? decayRiskScore(existing.risk_score, existing.updated_at, config) : 0;
      const signalScore = scoreSignals(signals, config);
      const nextScore = Math.min(100, previousScore + signalScore);
      const nextLevel = riskLevel(nextScore, config);
      db.prepare(`
        INSERT INTO risk_profiles
          (guild_id, user_id, risk_score, risk_level, signal_count, first_signal_at, last_signal_at, violation_count, last_violation_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
          risk_score = excluded.risk_score,
          risk_level = excluded.risk_level,
          signal_count = risk_profiles.signal_count + excluded.signal_count,
          last_signal_at = CURRENT_TIMESTAMP,
          violation_count = risk_profiles.violation_count + 1,
          last_violation_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      `).run(event.guildId, event.userId, nextScore, nextLevel, signals.length);
    }
  });
  tx();
}

async function recordIncident(event, signals, score, evidence, status = 'open') {
  const incidentId = crypto.randomUUID();
  db.prepare(`
    INSERT OR IGNORE INTO incidents
      (incident_id, guild_id, event_id, event_type, user_id, status, risk_score, signals_json, evidence_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(incidentId, event.guildId, event.eventId, event.eventType, event.userId, status || 'open', score, JSON.stringify(signals || []), JSON.stringify(evidence || {}));
  const raidSignal = (signals || []).find(signal => signal.detector === 'raid_burst');
  if (raidSignal) {
    const metadata = raidSignal.metadata || {};
    db.prepare(`
      INSERT OR IGNORE INTO raid_events
        (guild_id, event_id, join_count, window_seconds, action, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(event.guildId, event.eventId, Number(metadata.joinCount) || 0, Number(metadata.windowSeconds) || 60, 'lockdown', 'observed');
  }
  return db.prepare('SELECT * FROM incidents WHERE guild_id = ? AND event_id = ?').get(event.guildId, event.eventId);
}

const eventWindow = new EventWindowStore();
const pipeline = new DetectionPipeline({
  detectors: [spamFloodDetector, duplicateMessageDetector, massMentionDetector, suspiciousAccountDetector, impersonationDetector, scamLanguageDetector, linkProtectionDetector, attachmentThreatDetector, coordinatedCampaignDetector, accountTrustDetector, raidBurstDetector],
  isExempt,
  recordIncident,
  recordSignals,
  getConfig,
  eventWindow,
  applyAction: actionService.execute,
  detectorContext: { identityRegistry, domainRegistry, threatIntelRegistry }
});

function globallyAvailable() {
  return moduleGuard.isModuleEnabled('guildguard');
}

async function process(input, eventType, options) {
  if (!globallyAvailable() && !options?.force) return { skipped: true, reason: 'module_disabled' };
  return pipeline.process(input, eventType, options);
}

async function handleMessageCreate(message) {
  return process(message, 'message_create');
}

async function handleMemberJoin(member) {
  const result = await process(member, 'member_join');
  const config = getConfig(member?.guild?.id);
  const networkConfig = config.globalReputation || {};
  if (config.enabled && networkConfig.consumeEnabled !== false && networkConfig.notifyOnJoin !== false) {
    const reputation = getGlobalReputation(member?.id, { guildId: member?.guild?.id, excludeGuildId: member?.guild?.id });
    if (reputation.activeScore >= Number(networkConfig.alertThreshold || 50) && reputation.reports.length) {
      const joinEventId = `global_join:${member.guild.id}:${member.id}:${member.joinedTimestamp || Date.now()}`;
      const reportMatches = reputation.reports.filter(report => claimGlobalMatch(member.guild.id, joinEventId, member.id, report.reportId, reputation.activeScore));
      if (reportMatches.length) await actionService.alertGlobalReputation({ source: member, event: result.event, reputation, config });
    }
    result.globalReputation = reputation;
  }
  return result;
}

async function handleMemberUpdate(oldMember, newMember) {
  return process({ ...newMember, oldMember }, 'member_update');
}

async function executeQuickAction(args) {
  return actionService.executeQuickAction(args);
}

async function createTestIncident(guildId, input = {}) {
  return process({ ...input, guildId, id: input.id || `test:${Date.now()}` }, 'test', { force: true, recordEmpty: true, incidentStatus: 'test' });
}

function listIncidents(guildId, limit = 50) {
  const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
  return db.prepare(`
    SELECT incidents.*,
      (SELECT COUNT(*) FROM incidents AS related
       WHERE related.guild_id = incidents.guild_id AND related.user_id = incidents.user_id) AS user_incident_count
    FROM incidents
    WHERE guild_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(normalizeGuildId(guildId), bounded);
}

function getDashboardSummary(guildId, windowDays = 7) {
  const normalizedGuildId = normalizeGuildId(guildId);
  if (!normalizedGuildId) return { guildId: null, windowDays: 0, total: 0, statuses: {}, byEventType: [], averageRiskScore: 0, lastIncidentAt: null };
  const days = Math.max(1, Math.min(365, Number(windowDays) || 7));
  const since = `-${days} days`;
  const totals = db.prepare(`
    SELECT COUNT(*) AS total,
      ROUND(COALESCE(AVG(risk_score), 0), 1) AS averageRiskScore,
      MAX(created_at) AS lastIncidentAt
    FROM incidents
    WHERE guild_id = ? AND created_at >= datetime('now', ?)
  `).get(normalizedGuildId, since);
  const statuses = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM incidents
    WHERE guild_id = ? AND created_at >= datetime('now', ?)
    GROUP BY status
  `).all(normalizedGuildId, since).reduce((result, row) => {
    result[row.status] = row.count;
    return result;
  }, {});
  const byEventType = db.prepare(`
    SELECT event_type AS eventType, COUNT(*) AS count, ROUND(COALESCE(AVG(risk_score), 0), 1) AS averageRiskScore
    FROM incidents
    WHERE guild_id = ? AND created_at >= datetime('now', ?)
    GROUP BY event_type
    ORDER BY count DESC, event_type ASC
  `).all(normalizedGuildId, since);
  const byDetector = db.prepare(`
    SELECT detector, COUNT(*) AS count, ROUND(COALESCE(AVG(score), 0), 1) AS averageScore
    FROM risk_signals
    WHERE guild_id = ? AND created_at >= datetime('now', ?)
    GROUP BY detector
    ORDER BY count DESC, averageScore DESC, detector ASC
    LIMIT 10
  `).all(normalizedGuildId, since);
  const actionStatuses = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM actions
    WHERE guild_id = ? AND created_at >= datetime('now', ?)
    GROUP BY status
  `).all(normalizedGuildId, since).reduce((result, row) => {
    result[row.status] = Number(row.count) || 0;
    return result;
  }, {});
  const recentEvidence = db.prepare(`
    SELECT evidence_json FROM incidents
    WHERE guild_id = ? AND created_at >= datetime('now', ?)
    ORDER BY created_at DESC
    LIMIT 500
  `).all(normalizedGuildId, since);
  const channelCounts = new Map();
  for (const row of recentEvidence) {
    const channelId = String(jsonParse(row.evidence_json, {})?.channelId || '').trim();
    if (channelId) channelCounts.set(channelId, (channelCounts.get(channelId) || 0) + 1);
  }
  const topChannels = [...channelCounts.entries()].map(([channelId, count]) => ({ channelId, count }))
    .sort((left, right) => right.count - left.count).slice(0, 5);
  const openMemberReports = db.prepare("SELECT COUNT(*) AS count FROM guild_guard_member_reports WHERE guild_id = ? AND status = 'open'")
    .get(normalizedGuildId)?.count || 0;
  const total = Number(totals?.total || 0);
  const falsePositiveCount = Number(statuses.false_positive || 0);
  const falsePositiveRate = total ? Math.round((falsePositiveCount / total) * 1000) / 10 : 0;
  const config = getConfig(normalizedGuildId);
  const recommendations = [];
  if (falsePositiveRate >= 15) recommendations.push('Review trusted domains and detector thresholds; the false-positive rate is above 15%.');
  if (Number(actionStatuses.failed || 0) > 0) recommendations.push('Check GuildPilot Discord permissions because one or more protection actions failed.');
  if (Number(openMemberReports) > 0) recommendations.push(`Review ${openMemberReports} open member scam report${Number(openMemberReports) === 1 ? '' : 's'}.`);
  if (config.enabled && config.mode !== 'enforce' && total > 0) recommendations.push('Protection is monitoring only; review recent incidents before enabling automatic response.');
  if (byDetector[0]?.detector && ['link_protection', 'lookalike_domain', 'threat_intelligence_domain'].includes(byDetector[0].detector)) recommendations.push('Links are the leading signal; keep official community domains in the trusted list.');
  if (!recommendations.length) recommendations.push('No urgent tuning changes are recommended from the selected period.');
  return {
    guildId: normalizedGuildId,
    windowDays: days,
    total,
    statuses,
    byEventType,
    averageRiskScore: totals?.averageRiskScore || 0,
    lastIncidentAt: totals?.lastIncidentAt || null,
    falsePositiveRate,
    byDetector,
    actionStatuses,
    topChannels,
    openMemberReports: Number(openMemberReports),
    recommendations
  };
}

function getIncident(guildId, incidentId) {
  return db.prepare('SELECT * FROM incidents WHERE guild_id = ? AND incident_id = ?')
    .get(normalizeGuildId(guildId), String(incidentId || '').trim()) || null;
}

const SYSTEM_SAFE_DOMAINS = Object.freeze(['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'guildpilot.app']);

function isSystemSafeDomain(domain) {
  return SYSTEM_SAFE_DOMAINS.some(safeDomain => domain === safeDomain || domain.endsWith(`.${safeDomain}`));
}

function incidentDomains(incident) {
  const evidence = jsonParse(incident?.evidence_json, {});
  const signals = jsonParse(incident?.signals_json, []);
  const candidates = [...(Array.isArray(evidence.urls) ? evidence.urls : [])];
  for (const signal of Array.isArray(signals) ? signals : []) {
    const metadata = signal?.metadata || {};
    for (const key of ['domain', 'destinationDomain', 'finalUrl', 'url']) {
      if (metadata[key]) candidates.push(metadata[key]);
    }
    if (Array.isArray(metadata.decodedUrls)) candidates.push(...metadata.decodedUrls);
  }
  return [...new Set(candidates.map(domainRegistry.normalizeDomain).filter(Boolean))];
}

function normalizeIncidentIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))].slice(0, 100);
}

function listIncidentCampaigns(guildId, windowDays = 7) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const days = Math.max(1, Math.min(30, Number(windowDays) || 7));
  const incidents = db.prepare(`
    SELECT * FROM incidents
    WHERE guild_id = ? AND status NOT IN ('false_positive', 'closed') AND created_at >= datetime('now', ?)
    ORDER BY created_at DESC, id DESC
    LIMIT 500
  `).all(normalizedGuildId, `-${days} days`);
  const groups = new Map();
  for (const incident of incidents) {
    const signals = jsonParse(incident.signals_json, []);
    const keys = incidentDomains(incident).filter(domain => !isSystemSafeDomain(domain)).map(domain => ({ key: `domain:${domain}`, domain }));
    for (const signal of Array.isArray(signals) ? signals : []) {
      const contentHash = String(signal?.metadata?.contentHash || '').trim();
      if (contentHash.length >= 20) keys.push({ key: `message:${contentHash}`, contentHash });
    }
    for (const item of keys) {
      if (!groups.has(item.key)) groups.set(item.key, { ...item, incidents: [] });
      groups.get(item.key).incidents.push(incident);
    }
  }
  return [...groups.values()].map(group => {
    const uniqueIncidents = [...new Map(group.incidents.map(incident => [incident.incident_id, incident])).values()];
    return {
      key: group.key,
      label: group.domain || 'Repeated scam message',
      domain: group.domain || null,
      incidentIds: uniqueIncidents.slice(0, 100).map(incident => incident.incident_id),
      incidentCount: uniqueIncidents.length,
      userCount: new Set(uniqueIncidents.map(incident => incident.user_id).filter(Boolean)).size,
      maximumRiskScore: Math.max(...uniqueIncidents.map(incident => Number(incident.risk_score) || 0)),
      openCount: uniqueIncidents.filter(incident => ['open', 'reviewed', 'test'].includes(incident.status)).length,
      lastSeenAt: uniqueIncidents[0]?.created_at || null
    };
  }).filter(group => group.incidentCount >= 2)
    .sort((left, right) => right.maximumRiskScore - left.maximumRiskScore || right.incidentCount - left.incidentCount)
    .slice(0, 25);
}

function blockIncidentDomains(guildId, incidentId, actorId = null) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const incident = getIncident(normalizedGuildId, incidentId);
  if (!incident) return null;
  if (incident.status !== 'confirmed') throw new Error('Confirm the incident before blocking its domains');
  const allowlist = new Set(domainRegistry.list(normalizedGuildId, 'allow'));
  const existingBlocklist = new Set(domainRegistry.list(normalizedGuildId, 'block'));
  const blocked = [];
  const skipped = [];
  for (const domain of incidentDomains(incident)) {
    if (allowlist.has(domain)) {
      skipped.push({ domain, reason: 'trusted_domain' });
      continue;
    }
    if (isSystemSafeDomain(domain)) {
      skipped.push({ domain, reason: 'protected_platform_domain' });
      continue;
    }
    if (existingBlocklist.has(domain)) {
      skipped.push({ domain, reason: 'already_blocked' });
      continue;
    }
    blocked.push(domainRegistry.add(normalizedGuildId, domain, 'block', {
      reason: `Confirmed Guild Guard incident ${incident.incident_id}`,
      createdBy: actorId || null
    }));
  }
  actionService.recordAction({
    event: { guildId: normalizedGuildId },
    incident,
    actionType: 'moderator:block_domains',
    status: blocked.length ? 'applied' : 'skipped',
    metadata: { actorId: actorId || null, domains: blocked, skipped }
  });
  return { incidentId: incident.incident_id, domains: blocked, skipped };
}

function submitIncidentThreatIntelligence(guildId, incidentId, actorId = null) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const incident = getIncident(normalizedGuildId, incidentId);
  if (!incident) return null;
  if (incident.status !== 'confirmed') throw new Error('Confirm the incident before submitting threat intelligence');
  const allowlist = new Set(domainRegistry.list(normalizedGuildId, 'allow'));
  const domains = incidentDomains(incident).filter(domain => !allowlist.has(domain) && !isSystemSafeDomain(domain));
  if (!domains.length) throw new Error('This incident has no eligible domains to submit');
  return {
    incidentId: incident.incident_id,
    entries: threatIntelRegistry.submit(normalizedGuildId, incident.incident_id, domains, actorId)
  };
}

async function executeBulkIncidentResponse(guildId, input = {}, actorId = null, guild = null) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const incidentIds = normalizeIncidentIds(input.incidentIds);
  const action = String(input.action || '').trim();
  const supported = new Set(['confirm_and_block', 'delete_messages', 'timeout_users', 'close']);
  if (!incidentIds.length) throw new Error('Select at least one incident');
  if (!supported.has(action)) throw new Error('Invalid bulk response action');
  const incidents = incidentIds.map(incidentId => getIncident(normalizedGuildId, incidentId)).filter(Boolean);
  if (incidents.length !== incidentIds.length) throw new Error('One or more incidents were not found for this server');
  const timeoutSeconds = Math.max(60, Math.min(2419200, Number(input.timeoutSeconds) || Number(getConfig(normalizedGuildId).actions?.timeoutSeconds) || 3600));
  const processedUsers = new Set();
  const results = [];

  for (const incident of incidents) {
    let status = 'applied';
    let metadata = { actorId: actorId || null, action };
    try {
      if (action === 'confirm_and_block') {
        if (incident.status !== 'confirmed') updateIncidentStatus(normalizedGuildId, incident.incident_id, 'confirmed', actorId);
        const domainResult = blockIncidentDomains(normalizedGuildId, incident.incident_id, actorId);
        metadata = { ...metadata, domains: domainResult?.domains || [], skippedDomains: domainResult?.skipped || [] };
      } else if (action === 'close') {
        updateIncidentStatus(normalizedGuildId, incident.incident_id, 'closed', actorId);
      } else if (action === 'delete_messages') {
        const evidence = jsonParse(incident.evidence_json, {});
        let channel = guild?.channels?.cache?.get?.(String(evidence.channelId || '')) || null;
        if (!channel && evidence.channelId && typeof guild?.channels?.fetch === 'function') channel = await guild.channels.fetch(String(evidence.channelId));
        const message = channel?.messages?.fetch ? await channel.messages.fetch(String(incident.event_id)) : null;
        if (!message || typeof message.delete !== 'function') throw new Error('message_unavailable');
        await message.delete();
        metadata = { ...metadata, channelId: evidence.channelId, messageId: incident.event_id };
      } else if (action === 'timeout_users') {
        if (!incident.user_id) throw new Error('member_unavailable');
        if (processedUsers.has(incident.user_id)) {
          status = 'skipped';
          metadata = { ...metadata, reason: 'member_already_processed', userId: incident.user_id };
        } else {
          processedUsers.add(incident.user_id);
          const member = guild?.members?.fetch ? await guild.members.fetch(String(incident.user_id)) : null;
          if (!member || typeof member.timeout !== 'function') throw new Error('member_unavailable');
          await member.timeout(timeoutSeconds * 1000, 'Guild Guard bulk incident response');
          metadata = { ...metadata, userId: incident.user_id, timeoutSeconds };
        }
      }
    } catch (error) {
      status = 'failed';
      metadata = { ...metadata, error: String(error?.message || error) };
    }
    actionService.recordAction({
      event: { guildId: normalizedGuildId }, incident,
      actionType: `moderator:bulk_${action}`, status, metadata
    });
    results.push({ incidentId: incident.incident_id, status, ...metadata });
  }
  return {
    action,
    selected: incidents.length,
    applied: results.filter(result => result.status === 'applied').length,
    failed: results.filter(result => result.status === 'failed').length,
    skipped: results.filter(result => result.status === 'skipped').length,
    results
  };
}

function normalizeReportedUserId(value) {
  const normalized = String(value || '').trim().replace(/[<@!>]/g, '');
  if (!normalized) return null;
  if (!/^\d{15,22}$/.test(normalized)) throw new Error('Reported account must be a valid Discord user ID or mention');
  return normalized;
}

function createMemberReport(guildId, reporterUserId, input = {}) {
  const normalizedGuildId = normalizeGuildId(guildId);
  const reporter = String(reporterUserId || '').trim();
  const description = String(input.description || '').trim().slice(0, 1500);
  if (!normalizedGuildId || !reporter) throw new Error('Server and reporter are required');
  if (description.length < 10) throw new Error('Please describe what happened in at least 10 characters');
  const reportId = crypto.randomUUID();
  const reportedUserId = normalizeReportedUserId(input.reportedUserId);
  const evidenceReference = String(input.evidenceReference || '').trim().slice(0, 500) || null;
  db.prepare(`
    INSERT INTO guild_guard_member_reports
      (report_id, guild_id, reporter_user_id, reported_user_id, description, evidence_reference)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(reportId, normalizedGuildId, reporter, reportedUserId, description, evidenceReference);
  return db.prepare('SELECT * FROM guild_guard_member_reports WHERE report_id = ?').get(reportId);
}

function listMemberReports(guildId, limit = 100) {
  const bounded = Math.max(1, Math.min(200, Number(limit) || 100));
  return db.prepare(`
    SELECT * FROM guild_guard_member_reports
    WHERE guild_id = ?
    ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END, created_at DESC, id DESC
    LIMIT ?
  `).all(normalizeGuildId(guildId), bounded);
}

function updateMemberReportStatus(guildId, reportId, status, actorId = null) {
  const allowed = new Set(['open', 'reviewed', 'closed', 'dismissed']);
  if (!allowed.has(status)) throw new Error('Invalid member report status');
  const result = db.prepare(`
    UPDATE guild_guard_member_reports
    SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = ? AND report_id = ?
  `).run(status, actorId || null, normalizeGuildId(guildId), String(reportId || '').trim());
  if (!result.changes) return null;
  return db.prepare('SELECT * FROM guild_guard_member_reports WHERE guild_id = ? AND report_id = ?')
    .get(normalizeGuildId(guildId), String(reportId || '').trim());
}

async function notifyMemberReport(guild, report) {
  if (!guild || !report) return { sent: false, reason: 'guild_unavailable' };
  const config = getConfig(report.guild_id);
  const channelId = String(config.alertChannelId || '').trim();
  let channel = channelId ? guild.channels?.cache?.get?.(channelId) || null : null;
  if (!channel && channelId && typeof guild.channels?.fetch === 'function') {
    try { channel = await guild.channels.fetch(channelId); } catch (_) { channel = null; }
  }
  if (!channel || typeof channel.send !== 'function') return { sent: false, reason: 'alert_channel_unavailable' };
  const embed = new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle('Member scam report')
    .setDescription(report.description)
    .addFields(
      { name: 'Reporter', value: `<@${report.reporter_user_id}>`, inline: true },
      { name: 'Reported account', value: report.reported_user_id ? `<@${report.reported_user_id}>` : 'Not supplied', inline: true },
      { name: 'Evidence reference', value: report.evidence_reference || 'Not supplied' }
    )
    .setFooter({ text: `Report ${report.report_id}` })
    .setTimestamp();
  await channel.send({ content: 'A member submitted a Guild Guard scam report.', embeds: [embed], allowedMentions: { parse: [] } });
  return { sent: true, channelId };
}

async function postMemberSafetyPanel(guild, channelId) {
  const normalizedChannelId = String(channelId || '').trim();
  let channel = guild?.channels?.cache?.get?.(normalizedChannelId) || null;
  if (!channel && normalizedChannelId && typeof guild?.channels?.fetch === 'function') channel = await guild.channels.fetch(normalizedChannelId);
  if (!channel || typeof channel.send !== 'function') throw new Error('Select a text channel where GuildPilot can send messages');
  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle('Stay safe from Discord and wallet scams')
    .setDescription('GuildPilot and your community team will never ask for your seed phrase or private key. Bots cannot inspect your private DMs, so report suspicious messages here.')
    .addFields(
      { name: 'Before connecting a wallet', value: 'Check the domain, use official links, and never approve a transaction you do not understand.' },
      { name: 'If someone contacts you privately', value: 'Do not share secrets or click urgent support links. Capture the account ID and message link, then report it.' }
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('guildguard_report_scam').setLabel('Report a scam').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('guildguard_safety_tips').setLabel('Safety checklist').setStyle(ButtonStyle.Secondary)
  );
  const message = await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
  return { channelId: channel.id || normalizedChannelId, messageId: message?.id || null };
}

function updateIncidentStatus(guildId, incidentId, status, actorId = null) {
  const allowed = new Set(['open', 'reviewed', 'confirmed', 'false_positive', 'closed']);
  if (!allowed.has(status)) throw new Error('Invalid incident status');
  const existing = getIncident(guildId, incidentId);
  if (!existing) return null;
  const normalizedGuildId = normalizeGuildId(guildId);
  const tx = db.transaction(() => {
    db.prepare('UPDATE incidents SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND incident_id = ?')
      .run(status, normalizedGuildId, incidentId);
    db.prepare(`
      INSERT INTO actions (guild_id, incident_id, action_type, status, metadata_json)
      VALUES (?, ?, 'review_status', 'applied', ?)
    `).run(normalizedGuildId, incidentId, JSON.stringify({ actorId: actorId || null, from: existing.status, to: status }));
  });
  tx();
  return getIncident(normalizedGuildId, incidentId);
}

function reportFalsePositive(guildId, incidentId, reportedBy, reason = '') {
  const existing = getIncident(guildId, incidentId);
  if (!existing) return null;
  const normalizedGuildId = normalizeGuildId(guildId);
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO false_positives (guild_id, incident_id, reported_by, reason, status)
      VALUES (?, ?, ?, ?, 'open')
    `).run(normalizedGuildId, incidentId, String(reportedBy || 'unknown'), String(reason || '').slice(0, 1000));
    db.prepare('UPDATE incidents SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND incident_id = ?')
      .run('false_positive', normalizedGuildId, incidentId);
  });
  tx();
  return getIncident(normalizedGuildId, incidentId);
}

function listFalsePositives(guildId, limit = 50) {
  const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
  return db.prepare('SELECT * FROM false_positives WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(normalizeGuildId(guildId), bounded);
}

function purgeExpired(guildId, retentionDays = null) {
  const normalizedGuildId = normalizeGuildId(guildId);
  if (!normalizedGuildId) return { guildId: null, retentionDays: 0, deleted: 0 };
  const days = Math.max(1, Math.min(3650, Number(retentionDays || getConfig(normalizedGuildId).retentionDays) || 30));
  const cutoff = `-${days} days`;
  const tx = db.transaction(() => {
    const statements = [
      ['actions', 'guild_id'],
      ['risk_signals', 'guild_id'],
      ['raid_events', 'guild_id'],
      ['false_positives', 'guild_id'],
      ['guild_guard_member_reports', 'guild_id'],
      ['incidents', 'guild_id']
    ];
    return statements.reduce((total, [table, guildColumn]) => total + db.prepare(`DELETE FROM ${table} WHERE ${guildColumn} = ? AND created_at < datetime('now', ?)`)
      .run(normalizedGuildId, cutoff).changes, 0);
  });
  return { guildId: normalizedGuildId, retentionDays: days, deleted: tx() };
}

function runRetentionSweep() {
  const guilds = db.prepare('SELECT guild_id FROM guild_guard_configs').all();
  return guilds.map(row => ({ ...purgeExpired(row.guild_id), decayed: decayRiskProfiles(row.guild_id) }));
}

module.exports = {
  DEFAULT_CONFIG,
  getConfig,
  updateConfig,
  applyPreset,
  listPresets: presetRegistry.listPresets,
  listRules,
  getGlobalReputationConfig,
  getGlobalReputation,
  getGlobalReportForIncident,
  listGlobalReports,
  publishGlobalReport,
  revokeGlobalReport,
  claimGlobalMatch,
  createRule,
  updateRule,
  deleteRule,
  isExempt,
  process,
  handleMessageCreate,
  handleMemberJoin,
  handleMemberUpdate,
  executeQuickAction,
  createTestIncident,
  listIncidents,
  getDashboardSummary,
  getRiskProfile,
  listRiskSignals,
  listUserIncidents,
  getUserIncidentSummary,
  clearUserHistory,
  resetRiskProfile,
  decayRiskProfiles,
  getIncident,
  listIncidentCampaigns,
  blockIncidentDomains,
  submitIncidentThreatIntelligence,
  executeBulkIncidentResponse,
  createMemberReport,
  listMemberReports,
  updateMemberReportStatus,
  notifyMemberReport,
  postMemberSafetyPanel,
  updateIncidentStatus,
  reportFalsePositive,
  listFalsePositives,
  purgeExpired,
  runRetentionSweep,
  restoreExpiredLockdowns: actionService.restoreExpiredLockdowns,
  identityRegistry,
  domainRegistry,
  threatIntelRegistry,
  _pipeline: pipeline,
  _eventWindow: eventWindow
};
