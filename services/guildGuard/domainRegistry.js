const db = require('../../database/db');

function normalizeDomain(value) {
  let candidate = String(value || '').trim().toLowerCase();
  if (!candidate) return null;
  try {
    if (!candidate.includes('://')) candidate = `https://${candidate}`;
    candidate = new URL(candidate).hostname.toLowerCase();
  } catch (_) {
    candidate = candidate.replace(/^[^/]+:\/\//, '').split('/')[0];
  }
  candidate = candidate.replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9.-]+$/.test(candidate) && candidate.includes('.') ? candidate : null;
}

function list(guildId, type) {
  const table = type === 'allow' ? 'domain_allowlist' : 'domain_blocklist';
  return db.prepare(`SELECT domain FROM ${table} WHERE guild_id = ? ORDER BY domain ASC`)
    .all(String(guildId || '').trim()).map(row => row.domain);
}

function add(guildId, domain, type, metadata = {}) {
  const normalizedGuildId = String(guildId || '').trim();
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedGuildId || !normalizedDomain) throw new Error('guildId and a valid domain are required');
  const table = type === 'allow' ? 'domain_allowlist' : 'domain_blocklist';
  if (table === 'domain_allowlist') {
    db.prepare('INSERT OR IGNORE INTO domain_allowlist (guild_id, domain, created_by) VALUES (?, ?, ?)')
      .run(normalizedGuildId, normalizedDomain, metadata.createdBy || null);
  } else {
    db.prepare('INSERT OR IGNORE INTO domain_blocklist (guild_id, domain, reason, created_by) VALUES (?, ?, ?, ?)')
      .run(normalizedGuildId, normalizedDomain, metadata.reason || null, metadata.createdBy || null);
  }
  return normalizedDomain;
}

function remove(guildId, domain, type) {
  const normalizedDomain = normalizeDomain(domain);
  const table = type === 'allow' ? 'domain_allowlist' : 'domain_blocklist';
  return normalizedDomain
    ? db.prepare(`DELETE FROM ${table} WHERE guild_id = ? AND domain = ?`).run(String(guildId || '').trim(), normalizedDomain).changes > 0
    : false;
}

function getLists(guildId) {
  return { allow: list(guildId, 'allow'), block: list(guildId, 'block') };
}

module.exports = { normalizeDomain, list, add, remove, getLists };
