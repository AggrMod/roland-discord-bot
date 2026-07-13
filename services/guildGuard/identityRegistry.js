const db = require('../../database/db');

function parseAliases(value) {
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.map(item => String(item).trim()).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function normalizeIdentity(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

function list(guildId, enabledOnly = true) {
  const rows = db.prepare(`
    SELECT * FROM staff_identities
    WHERE guild_id = ? ${enabledOnly ? 'AND enabled = 1' : ''}
    ORDER BY id ASC
  `).all(String(guildId || '').trim());
  return rows.map(row => ({ ...row, aliases: parseAliases(row.aliases_json) }));
}

function upsert(guildId, identity) {
  const normalizedGuildId = String(guildId || '').trim();
  const userId = String(identity?.userId || identity?.user_id || '').trim();
  if (!normalizedGuildId || !userId) throw new Error('guildId and userId are required');
  const aliases = Array.isArray(identity.aliases) ? identity.aliases.map(value => String(value).trim()).filter(Boolean) : [];
  db.prepare(`
    INSERT INTO staff_identities
      (guild_id, user_id, username, display_name, aliases_json, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      aliases_json = excluded.aliases_json,
      enabled = excluded.enabled,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    normalizedGuildId,
    userId,
    identity.username ? String(identity.username).trim() : null,
    identity.displayName || identity.display_name ? String(identity.displayName || identity.display_name).trim() : null,
    JSON.stringify(aliases),
    identity.enabled === false ? 0 : 1
  );
  return list(normalizedGuildId, false).find(row => row.user_id === userId) || null;
}

function remove(guildId, userId) {
  return db.prepare('DELETE FROM staff_identities WHERE guild_id = ? AND user_id = ?')
    .run(String(guildId || '').trim(), String(userId || '').trim()).changes > 0;
}

function findImpersonationMatch(guildId, event) {
  const candidates = [event?.username, event?.displayName].map(normalizeIdentity).filter(Boolean);
  if (candidates.length === 0) return null;
  for (const identity of list(guildId)) {
    if (identity.user_id === event.userId) continue;
    const known = [identity.username, identity.display_name, ...identity.aliases]
      .map(normalizeIdentity)
      .filter(Boolean);
    if (known.some(value => candidates.includes(value))) return identity;
  }
  return null;
}

module.exports = { list, upsert, remove, findImpersonationMatch, normalizeIdentity };
