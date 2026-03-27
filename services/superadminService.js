const db = require('../database/db');

function normalizeDiscordId(userId) {
  return typeof userId === 'string' ? userId.trim() : '';
}

function parseEnvIds(value) {
  if (!value) return [];
  return String(value)
    .split(/[\s,]+/)
    .map(id => id.trim())
    .filter(Boolean);
}

function getRootSuperadminIds() {
  const ids = [
    ...parseEnvIds(process.env.SUPERADMIN_DISCORD_ID),
    ...parseEnvIds(process.env.SUPERADMIN_DISCORD_IDS)
  ];

  return [...new Set(ids)];
}

function isRootSuperadmin(userId) {
  const normalizedUserId = normalizeDiscordId(userId);
  if (!normalizedUserId) return false;
  return getRootSuperadminIds().includes(normalizedUserId);
}

function isSuperadmin(userId) {
  const normalizedUserId = normalizeDiscordId(userId);
  if (!normalizedUserId) return false;
  if (isRootSuperadmin(normalizedUserId)) return true;

  const row = db.prepare('SELECT 1 FROM superadmins WHERE discord_id = ?').get(normalizedUserId);
  return !!row;
}

function listSuperadmins() {
  const rootIds = getRootSuperadminIds();
  const rootEntries = rootIds.map(discordId => ({
    userId: discordId,
    source: 'env',
    addedBy: null,
    createdAt: null
  }));

  const dbEntries = db.prepare(`
    SELECT discord_id AS userId, added_by AS addedBy, created_at AS createdAt
    FROM superadmins
    ORDER BY created_at ASC, discord_id ASC
  `).all();

  const seen = new Set(rootIds);
  const merged = [...rootEntries];

  for (const entry of dbEntries) {
    if (seen.has(entry.userId)) continue;
    seen.add(entry.userId);
    merged.push({
      ...entry,
      source: 'db'
    });
  }

  return merged;
}

function addSuperadmin(userId, addedBy) {
  const normalizedUserId = normalizeDiscordId(userId);
  const normalizedAddedBy = normalizeDiscordId(addedBy) || null;

  if (!normalizedUserId) {
    return { success: false, message: 'userId is required' };
  }

  if (isRootSuperadmin(normalizedUserId)) {
    return {
      success: true,
      superadmin: {
        userId: normalizedUserId,
        source: 'env',
        addedBy: null,
        createdAt: null
      }
    };
  }

  const existing = db.prepare('SELECT discord_id, added_by, created_at FROM superadmins WHERE discord_id = ?').get(normalizedUserId);
  if (!existing) {
    db.prepare('INSERT INTO superadmins (discord_id, added_by) VALUES (?, ?)').run(normalizedUserId, normalizedAddedBy);
  } else if (normalizedAddedBy && existing.added_by !== normalizedAddedBy) {
    db.prepare('UPDATE superadmins SET added_by = ? WHERE discord_id = ?').run(normalizedAddedBy, normalizedUserId);
  }

  const record = db.prepare(`
    SELECT discord_id AS userId, added_by AS addedBy, created_at AS createdAt
    FROM superadmins
    WHERE discord_id = ?
  `).get(normalizedUserId);

  return {
    success: true,
    superadmin: {
      ...record,
      source: 'db'
    }
  };
}

function removeSuperadmin(userId, removedBy) {
  const normalizedUserId = normalizeDiscordId(userId);
  const normalizedRemovedBy = normalizeDiscordId(removedBy) || null;

  if (!normalizedUserId) {
    return { success: false, message: 'userId is required' };
  }

  if (isRootSuperadmin(normalizedUserId)) {
    return { success: false, message: 'Cannot remove root superadmins' };
  }

  const existing = db.prepare('SELECT discord_id, added_by, created_at FROM superadmins WHERE discord_id = ?').get(normalizedUserId);
  if (!existing) {
    return { success: false, message: 'Superadmin not found' };
  }

  db.prepare('DELETE FROM superadmins WHERE discord_id = ?').run(normalizedUserId);

  return {
    success: true,
    removedBy: normalizedRemovedBy,
    superadmin: {
      userId: normalizedUserId,
      source: 'db',
      addedBy: existing.added_by,
      createdAt: existing.created_at
    }
  };
}

module.exports = {
  addSuperadmin,
  isRootSuperadmin,
  isSuperadmin,
  listSuperadmins,
  removeSuperadmin
};
