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
      (guild_id, user_id, username, display_name, aliases_json, enabled, managed_by_roles)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      aliases_json = excluded.aliases_json,
      enabled = excluded.enabled,
      managed_by_roles = excluded.managed_by_roles,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    normalizedGuildId,
    userId,
    identity.username ? String(identity.username).trim() : null,
    identity.displayName || identity.display_name ? String(identity.displayName || identity.display_name).trim() : null,
    JSON.stringify(aliases),
    identity.enabled === false ? 0 : 1,
    identity.managedByRoles === true ? 1 : 0
  );
  return list(normalizedGuildId, false).find(row => row.user_id === userId) || null;
}

const ROLE_MANAGEMENT_PERMISSIONS = Object.freeze([
  'Administrator',
  'ManageGuild',
  'ManageMessages',
  'ModerateMembers',
  'KickMembers',
  'BanMembers'
]);

function hasRoleManagementPermission(role) {
  return ROLE_MANAGEMENT_PERMISSIONS.some(permission => role?.permissions?.has?.(permission));
}

function memberHasRoleManagementPermission(member) {
  if (member?.permissions?.has?.('Administrator')) return true;
  return [...(member?.roles?.cache?.values?.() || [])].some(hasRoleManagementPermission);
}

function upsertRoleManagedIdentity(guildId, member) {
  const userId = String(member?.id || member?.user?.id || '').trim();
  if (!userId) return false;
  const username = String(member?.user?.username || member?.username || '').trim() || null;
  const displayName = String(member?.displayName || member?.user?.globalName || member?.user?.username || '').trim() || null;
  db.prepare(`
    INSERT INTO staff_identities
      (guild_id, user_id, username, display_name, aliases_json, enabled, managed_by_roles)
    VALUES (?, ?, ?, ?, '[]', 1, 1)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      enabled = 1,
      managed_by_roles = 1,
      updated_at = CURRENT_TIMESTAMP
  `).run(String(guildId), userId, username, displayName);
  return true;
}

async function syncFromGuild(guild) {
  const guildId = String(guild?.id || '').trim();
  if (!guildId || !guild?.members) return { guildId, added: 0, disabled: 0 };
  await guild.members.fetch();
  const privilegedIds = new Set();
  for (const member of guild.members.cache.values()) {
    if (memberHasRoleManagementPermission(member)) {
      privilegedIds.add(String(member.id));
      upsertRoleManagedIdentity(guildId, member);
    }
  }
  const managed = list(guildId, false).filter(identity => Number(identity.managed_by_roles) === 1);
  let disabled = 0;
  for (const identity of managed) {
    if (privilegedIds.has(identity.user_id)) continue;
    disabled += db.prepare(`UPDATE staff_identities SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND user_id = ? AND managed_by_roles = 1`).run(guildId, identity.user_id).changes;
  }
  return { guildId, added: privilegedIds.size, disabled };
}

function syncMember(member) {
  const guildId = String(member?.guild?.id || '').trim();
  const userId = String(member?.id || '').trim();
  if (!guildId || !userId) return { guildId, userId, enabled: false };
  if (memberHasRoleManagementPermission(member)) {
    upsertRoleManagedIdentity(guildId, member);
    return { guildId, userId, enabled: true };
  }
  const result = db.prepare('UPDATE staff_identities SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND user_id = ? AND managed_by_roles = 1')
    .run(guildId, userId);
  return { guildId, userId, enabled: false, disabled: result.changes > 0 };
}

function disableRoleManagedMember(guildId, userId) {
  const result = db.prepare('UPDATE staff_identities SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND user_id = ? AND managed_by_roles = 1')
    .run(String(guildId || '').trim(), String(userId || '').trim());
  return result.changes > 0;
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

module.exports = { list, upsert, remove, findImpersonationMatch, normalizeIdentity, syncFromGuild, syncMember, disableRoleManagedMember };
