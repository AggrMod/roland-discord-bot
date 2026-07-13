const crypto = require('crypto');
const db = require('../../database/db');
const moduleGuard = require('../../utils/moduleGuard');
const { DEFAULT_CONFIG, mergeConfig } = require('./defaults');
const DetectionPipeline = require('./pipeline');
const EventWindowStore = require('./eventWindow');
const actionService = require('./actions');
const identityRegistry = require('./identityRegistry');
const domainRegistry = require('./domainRegistry');
const { scoreSignals, riskLevel } = require('./scoring');
const {
  spamFloodDetector,
  duplicateMessageDetector,
  massMentionDetector,
  suspiciousAccountDetector,
  impersonationDetector,
  linkProtectionDetector,
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
  'staff_impersonation', 'link_protection', 'lookalike_domain', 'raid_burst'
]);

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
  if (exemptions.botUsers && event.isBot) return true;
  if (exemptions.webhookUsers && event.isWebhook) return true;
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
    const counts = { incidents: incidentIds.length, actions: 0, signals: 0, falsePositives: 0, riskProfiles: 0 };
    if (incidentIds.length) {
      const placeholders = incidentIds.map(() => '?').join(',');
      counts.actions = db.prepare(`DELETE FROM actions WHERE guild_id = ? AND incident_id IN (${placeholders})`).run(normalizedGuildId, ...incidentIds).changes;
      counts.falsePositives = db.prepare(`DELETE FROM false_positives WHERE guild_id = ? AND incident_id IN (${placeholders})`).run(normalizedGuildId, ...incidentIds).changes;
    }
    counts.signals = db.prepare('DELETE FROM risk_signals WHERE guild_id = ? AND user_id = ?').run(normalizedGuildId, normalizedUserId).changes;
    db.prepare('DELETE FROM incidents WHERE guild_id = ? AND user_id = ?').run(normalizedGuildId, normalizedUserId);
    counts.riskProfiles = db.prepare('DELETE FROM risk_profiles WHERE guild_id = ? AND user_id = ?').run(normalizedGuildId, normalizedUserId).changes;
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
  detectors: [spamFloodDetector, duplicateMessageDetector, massMentionDetector, suspiciousAccountDetector, impersonationDetector, linkProtectionDetector, raidBurstDetector],
  isExempt,
  recordIncident,
  recordSignals,
  getConfig,
  eventWindow,
  applyAction: actionService.execute,
  detectorContext: { identityRegistry, domainRegistry }
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
  return process(member, 'member_join');
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
  return {
    guildId: normalizedGuildId,
    windowDays: days,
    total: totals?.total || 0,
    statuses,
    byEventType,
    averageRiskScore: totals?.averageRiskScore || 0,
    lastIncidentAt: totals?.lastIncidentAt || null
  };
}

function getIncident(guildId, incidentId) {
  return db.prepare('SELECT * FROM incidents WHERE guild_id = ? AND incident_id = ?')
    .get(normalizeGuildId(guildId), String(incidentId || '').trim()) || null;
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
  listRules,
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
  updateIncidentStatus,
  reportFalsePositive,
  listFalsePositives,
  purgeExpired,
  runRetentionSweep,
  identityRegistry,
  domainRegistry,
  _pipeline: pipeline,
  _eventWindow: eventWindow
};
