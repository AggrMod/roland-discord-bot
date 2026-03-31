/**
 * Engagement & Points System (E1–E7)
 * Discord-native points for messages, reactions, game wins.
 * Leaderboard, points shop (roles, codes, WL spots).
 * Immutable ledger + materialized totals. Dedup by reference_id.
 */

const db     = require('../database/db');
const logger = require('../utils/logger');

// ── Default config ──────────────────────────────────────────────────────────
const DEFAULTS = {
  enabled: 1,
  points_message: 5,
  points_reaction: 2,
  cooldown_message_mins: 60,
  cooldown_reaction_daily: 5,
  leaderboard_channel: null,
};

// ── Action types ────────────────────────────────────────────────────────────
const ACTION = {
  MESSAGE:       'discord_message',
  REACTION:      'discord_reaction',
  GAME_WIN:      'game_win',
  GAME_PLACE:    'game_place',
  GAME_NIGHT:    'game_night_champion',
  ADMIN_GRANT:   'admin_grant',
  ADMIN_DEDUCT:  'admin_deduct',
  SHOP_REDEEM:   'shop_redeem',
};

// ── Config ──────────────────────────────────────────────────────────────────
function getConfig(guildId) {
  const row = db.prepare('SELECT * FROM engagement_config WHERE guild_id = ?').get(guildId);
  return Object.assign({}, DEFAULTS, row || {});
}

function setConfig(guildId, patch) {
  const cfg = getConfig(guildId);
  const merged = Object.assign({}, cfg, patch);
  db.prepare(`
    INSERT INTO engagement_config (guild_id, enabled, points_message, points_reaction,
      cooldown_message_mins, cooldown_reaction_daily, leaderboard_channel, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO UPDATE SET
      enabled = excluded.enabled,
      points_message = excluded.points_message,
      points_reaction = excluded.points_reaction,
      cooldown_message_mins = excluded.cooldown_message_mins,
      cooldown_reaction_daily = excluded.cooldown_reaction_daily,
      leaderboard_channel = excluded.leaderboard_channel,
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, merged.enabled, merged.points_message, merged.points_reaction,
         merged.cooldown_message_mins, merged.cooldown_reaction_daily, merged.leaderboard_channel || null);
  return getConfig(guildId);
}

// ── Cooldown helpers ────────────────────────────────────────────────────────
function isOnCooldown(guildId, userId, actionType, cooldownMins) {
  const row = db.prepare(
    'SELECT last_at FROM action_cooldowns WHERE guild_id = ? AND user_id = ? AND action_type = ?'
  ).get(guildId, userId, actionType);
  if (!row) return false;
  const elapsed = (Date.now() - new Date(row.last_at).getTime()) / 60000;
  return elapsed < cooldownMins;
}

function stampCooldown(guildId, userId, actionType) {
  db.prepare(`
    INSERT INTO action_cooldowns (guild_id, user_id, action_type, last_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id, user_id, action_type) DO UPDATE SET last_at = CURRENT_TIMESTAMP
  `).run(guildId, userId, actionType);
}

function dailyCount(guildId, userId, actionType) {
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt FROM points_ledger
    WHERE guild_id = ? AND user_id = ? AND action_type = ?
      AND date(created_at) = date('now')
  `).get(guildId, userId, actionType);
  return row?.cnt || 0;
}

// ── Core award ──────────────────────────────────────────────────────────────
function awardPoints(guildId, userId, username, actionType, points, refId = null, note = null) {
  if (!points || points === 0) return { awarded: false, reason: 'zero' };

  // Dedup by reference_id
  if (refId) {
    const exists = db.prepare(
      'SELECT id FROM points_ledger WHERE guild_id = ? AND user_id = ? AND reference_id = ?'
    ).get(guildId, userId, refId);
    if (exists) return { awarded: false, reason: 'duplicate' };
  }

  db.prepare(`
    INSERT INTO points_ledger (guild_id, user_id, username, action_type, points, reference_id, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, userId, username, actionType, points, refId, note);

  db.prepare(`
    INSERT INTO points_totals (guild_id, user_id, username, total_points, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      total_points = total_points + ?,
      username = excluded.username,
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, userId, username, points, points);

  return { awarded: true, points };
}

// ── Public award methods ────────────────────────────────────────────────────
function tryAwardMessage(guildId, userId, username, messageId) {
  const cfg = getConfig(guildId);
  if (!cfg.enabled) return { awarded: false, reason: 'disabled' };
  if (isOnCooldown(guildId, userId, ACTION.MESSAGE, cfg.cooldown_message_mins))
    return { awarded: false, reason: 'cooldown' };
  const result = awardPoints(guildId, userId, username, ACTION.MESSAGE, cfg.points_message, `msg:${messageId}`);
  if (result.awarded) stampCooldown(guildId, userId, ACTION.MESSAGE);
  return result;
}

function tryAwardReaction(guildId, userId, username, refId) {
  const cfg = getConfig(guildId);
  if (!cfg.enabled) return { awarded: false, reason: 'disabled' };
  const dayCount = dailyCount(guildId, userId, ACTION.REACTION);
  if (dayCount >= cfg.cooldown_reaction_daily) return { awarded: false, reason: 'daily_cap' };
  return awardPoints(guildId, userId, username, ACTION.REACTION, cfg.points_reaction, `rxn:${refId}`);
}

function awardGamePoints(guildId, userId, username, points, gameKey, place) {
  const refId = `game:${gameKey}:${userId}:${Date.now()}`;
  return awardPoints(guildId, userId, username, ACTION.GAME_PLACE, points, refId, `${gameKey} place ${place}`);
}

function adminGrant(guildId, userId, username, points, adminId, reason) {
  const refId = `admin:${adminId}:${Date.now()}`;
  return awardPoints(guildId, userId, username,
    points > 0 ? ACTION.ADMIN_GRANT : ACTION.ADMIN_DEDUCT, points, refId, reason || null);
}

// ── Leaderboard ─────────────────────────────────────────────────────────────
function getLeaderboard(guildId, limit = 10) {
  return db.prepare(`
    SELECT user_id, username, total_points
    FROM points_totals
    WHERE guild_id = ?
    ORDER BY total_points DESC
    LIMIT ?
  `).all(guildId, limit);
}

function getUserPoints(guildId, userId) {
  const row = db.prepare('SELECT * FROM points_totals WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  const rank = row ? (db.prepare(
    'SELECT COUNT(*) AS r FROM points_totals WHERE guild_id = ? AND total_points > ?'
  ).get(guildId, row.total_points)?.r || 0) + 1 : null;
  return { row, rank };
}

function getUserHistory(guildId, userId, limit = 10) {
  return db.prepare(`
    SELECT action_type, points, note, created_at
    FROM points_ledger WHERE guild_id = ? AND user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(guildId, userId, limit);
}

// ── Shop ─────────────────────────────────────────────────────────────────────
function getShopItems(guildId) {
  return db.prepare('SELECT * FROM shop_items WHERE guild_id = ? AND enabled = 1 ORDER BY cost ASC').all(guildId);
}

function addShopItem(guildId, { name, description, type, cost, roleId, codes }) {
  const codePool = JSON.stringify(codes || []);
  const qty = type === 'code' ? (codes?.length || 0) : -1;
  const result = db.prepare(`
    INSERT INTO shop_items (guild_id, name, description, type, cost, role_id, code_pool, quantity_remaining)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, name, description || '', type, cost, roleId || null, codePool, qty);
  return result.lastInsertRowid;
}

function removeShopItem(guildId, itemId) {
  return db.prepare('UPDATE shop_items SET enabled = 0 WHERE guild_id = ? AND id = ?').run(guildId, itemId);
}

function redeemItem(guildId, userId, username, itemId) {
  const item = db.prepare('SELECT * FROM shop_items WHERE guild_id = ? AND id = ? AND enabled = 1').get(guildId, itemId);
  if (!item) return { success: false, reason: 'not_found' };
  if (item.quantity_remaining === 0) return { success: false, reason: 'out_of_stock' };

  const userPts = db.prepare('SELECT total_points FROM points_totals WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  if (!userPts || userPts.total_points < item.cost) return { success: false, reason: 'insufficient_points' };

  // Atomic transaction
  const redeem = db.transaction(() => {
    // Deduct points
    db.prepare('UPDATE points_totals SET total_points = total_points - ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND user_id = ?')
      .run(item.cost, guildId, userId);
    db.prepare('INSERT INTO points_ledger (guild_id, user_id, username, action_type, points, reference_id, note) VALUES (?,?,?,?,?,?,?)')
      .run(guildId, userId, username, ACTION.SHOP_REDEEM, -item.cost, `redeem:${itemId}:${Date.now()}`, `Redeemed: ${item.name}`);

    // Decrement stock
    if (item.quantity_remaining > 0) {
      db.prepare('UPDATE shop_items SET quantity_remaining = quantity_remaining - 1 WHERE id = ?').run(itemId);
    }

    // Pull code if type=code
    let code = null;
    if (item.type === 'code') {
      const pool = JSON.parse(item.code_pool || '[]');
      code = pool.shift() || null;
      db.prepare('UPDATE shop_items SET code_pool = ? WHERE id = ?').run(JSON.stringify(pool), itemId);
    }

    // Log redemption
    const row = db.prepare('INSERT INTO shop_redemptions (guild_id, user_id, item_id, cost) VALUES (?,?,?,?)').run(guildId, userId, itemId, item.cost);
    return { redemptionId: row.lastInsertRowid, code };
  });

  try {
    const { redemptionId, code } = redeem();
    return { success: true, item, code, redemptionId, newTotal: (userPts.total_points - item.cost) };
  } catch (err) {
    logger.error('[Engagement] redeem error:', err);
    return { success: false, reason: 'error' };
  }
}

module.exports = {
  ACTION, getConfig, setConfig,
  tryAwardMessage, tryAwardReaction, awardGamePoints, adminGrant,
  getLeaderboard, getUserPoints, getUserHistory,
  getShopItems, addShopItem, removeShopItem, redeemItem,
};
