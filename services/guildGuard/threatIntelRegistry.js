const db = require('../../database/db');
const domainRegistry = require('./domainRegistry');

function normalizeDomain(value) {
  return domainRegistry.normalizeDomain(value);
}

function recalculate(domain) {
  const counts = db.prepare(`
    SELECT COUNT(*) AS reportCount, COUNT(DISTINCT source_guild_id) AS sourceGuildCount
    FROM guild_guard_threat_domain_reports
    WHERE domain = ?
  `).get(domain);
  const reportCount = Number(counts?.reportCount || 0);
  const sourceGuildCount = Number(counts?.sourceGuildCount || 0);
  const confidence = Math.min(95, 30 + (sourceGuildCount * 15) + (reportCount * 5));
  db.prepare(`
    INSERT INTO guild_guard_threat_domains
      (domain, status, confidence, report_count, source_guild_count)
    VALUES (?, 'pending', ?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET
      confidence = excluded.confidence,
      report_count = excluded.report_count,
      source_guild_count = excluded.source_guild_count,
      updated_at = CURRENT_TIMESTAMP
  `).run(domain, confidence, reportCount, sourceGuildCount);
  return get(domain);
}

function submit(guildId, incidentId, domains, submittedBy = null) {
  const normalizedGuildId = String(guildId || '').trim();
  const normalizedIncidentId = String(incidentId || '').trim();
  const normalizedDomains = [...new Set((domains || []).map(normalizeDomain).filter(Boolean))].slice(0, 25);
  if (!normalizedGuildId || !normalizedIncidentId || !normalizedDomains.length) throw new Error('A confirmed incident with at least one valid domain is required');
  const results = [];
  const transaction = db.transaction(() => {
    for (const domain of normalizedDomains) {
      db.prepare(`
        INSERT OR IGNORE INTO guild_guard_threat_domain_reports
          (domain, source_guild_id, source_incident_id, submitted_by)
        VALUES (?, ?, ?, ?)
      `).run(domain, normalizedGuildId, normalizedIncidentId, submittedBy || null);
      results.push(recalculate(domain));
    }
  });
  transaction();
  return results;
}

function get(domain) {
  const normalized = normalizeDomain(domain);
  return normalized ? db.prepare('SELECT * FROM guild_guard_threat_domains WHERE domain = ?').get(normalized) || null : null;
}

function isActiveDomain(domain) {
  const entry = get(domain);
  return entry?.status === 'active' ? entry : null;
}

function list(status = 'active', limit = 100) {
  const normalizedStatus = ['pending', 'active', 'revoked'].includes(status) ? status : 'active';
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
  return db.prepare(`
    SELECT * FROM guild_guard_threat_domains
    WHERE status = ?
    ORDER BY confidence DESC, updated_at DESC, domain ASC
    LIMIT ?
  `).all(normalizedStatus, bounded);
}

function review(domain, status, reviewedBy = null) {
  const normalized = normalizeDomain(domain);
  if (!normalized) throw new Error('A valid domain is required');
  if (!['active', 'revoked'].includes(status)) throw new Error('Threat intelligence must be approved or revoked');
  const result = db.prepare(`
    UPDATE guild_guard_threat_domains
    SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE domain = ?
  `).run(status, reviewedBy || null, normalized);
  return result.changes ? get(normalized) : null;
}

function listSubmissions(guildId, limit = 100) {
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
  return db.prepare(`
    SELECT reports.*, domains.status, domains.confidence, domains.report_count, domains.source_guild_count
    FROM guild_guard_threat_domain_reports AS reports
    JOIN guild_guard_threat_domains AS domains ON domains.domain = reports.domain
    WHERE reports.source_guild_id = ?
    ORDER BY reports.created_at DESC, reports.id DESC
    LIMIT ?
  `).all(String(guildId || '').trim(), bounded);
}

module.exports = { normalizeDomain, submit, get, isActiveDomain, list, review, listSubmissions };
