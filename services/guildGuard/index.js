const crypto = require('crypto');
const db = require('../../database/db');
const moduleGuard = require('../../utils/moduleGuard');
const { DEFAULT_CONFIG, mergeConfig } = require('./defaults');
const DetectionPipeline = require('./pipeline');
const EventWindowStore = require('./eventWindow');
const actionService = require('./actions');
const identityRegistry = require('./identityRegistry');
const domainRegistry = require('./domainRegistry');
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
  config.enabled = Boolean(row.enabled);
  config.mode = row.mode || config.mode;
  return config;
}

function updateConfig(guildId, patch) {
  const normalized = normalizeGuildId(guildId);
  if (!normalized) throw new Error('guildId is required');
  const current = getConfig(normalized);
  const next = mergeConfig(current, patch);
  db.prepare(`
    INSERT INTO guild_guard_configs (guild_id, enabled, mode, config_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET enabled = excluded.enabled, mode = excluded.mode,
      config_json = excluded.config_json, updated_at = CURRENT_TIMESTAMP
  `).run(normalized, next.enabled ? 1 : 0, next.mode, JSON.stringify(next));
  return next;
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

async function recordSignals(event, signals) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO risk_signals
      (guild_id, event_id, user_id, detector, severity, score, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateProfile = db.prepare(`
    INSERT INTO risk_profiles (guild_id, user_id, risk_score, signal_count, last_signal_at)
    VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET risk_score = MIN(100, risk_profiles.risk_score + excluded.risk_score),
      signal_count = risk_profiles.signal_count + 1, last_signal_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  `);
  const tx = db.transaction(() => {
    for (const signal of signals) {
      insert.run(event.guildId, event.eventId, event.userId, String(signal.detector || 'unknown'), String(signal.severity || 'info'), Number(signal.score) || 0, JSON.stringify(signal.metadata || {}));
    }
    if (event.userId) updateProfile.run(event.guildId, event.userId, Number(signals.reduce((sum, s) => sum + (Number(s.score) || 0), 0)) || 0);
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

async function createTestIncident(guildId, input = {}) {
  return process({ ...input, guildId, id: input.id || `test:${Date.now()}` }, 'test', { force: true, recordEmpty: true, incidentStatus: 'test' });
}

function listIncidents(guildId, limit = 50) {
  const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
  return db.prepare('SELECT * FROM incidents WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(normalizeGuildId(guildId), bounded);
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
  return guilds.map(row => purgeExpired(row.guild_id));
}

module.exports = {
  DEFAULT_CONFIG,
  getConfig,
  updateConfig,
  isExempt,
  process,
  handleMessageCreate,
  handleMemberJoin,
  handleMemberUpdate,
  createTestIncident,
  listIncidents,
  getDashboardSummary,
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
