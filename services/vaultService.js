const db = require('../database/db');
const logger = require('../utils/logger');

function nowIso() {
  return new Date().toISOString();
}

function clampInt(value, min = 0, fallback = 0) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function safeJsonParse(value, fallback = null) {
  try {
    if (value === undefined || value === null || value === '') return fallback;
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function normalizeGuildId(guildId) {
  return String(guildId || '').trim();
}

function normalizeSeasonId(seasonId) {
  return String(seasonId || '').trim() || 'default';
}

function normalizeRewardQuantity(value) {
  if (value === null || value === undefined || value === '') return null;
  const qty = Number.parseInt(value, 10);
  if (!Number.isFinite(qty)) return null;
  return Math.max(0, qty);
}

class VaultService {
  getDefaultConfig() {
    return {
      general: {
        enabled: false,
        projectName: 'Guild Pilot Project',
        gameName: 'Reward Vault',
        seasonName: 'Default Season',
      },
      theme: {
        keyName: 'Reward Key',
      },
      mintRules: {
        keysPerPaidMint: 1,
        keysPerFreeMint: 0,
        pressurePerPaidMint: 1,
        pressurePerFreeMint: 0,
      },
      mintSource: {
        mode: 'custom_webhook',
      },
      announcements: {
        channelId: '',
        announceRewardTiers: ['rare', 'epic', 'legendary'],
        announceCommonRewards: false,
      },
      security: {
        openCooldownSeconds: 3,
      },
      rewardTable: {
        version: 'default',
        failChancePercent: 75,
        noRewardWeight: 0,
        rewards: [
          {
            code: 'sticker_pack',
            name: 'Sticker Pack',
            tier: 'common',
            weight: 70,
            enabled: true,
            quantity: 250,
            type: 'claimable_reward',
            payload: { reward: 'sticker_pack' },
          },
          {
            code: 'merch_coupon',
            name: 'Merch Coupon',
            tier: 'rare',
            weight: 20,
            enabled: true,
            quantity: 80,
            type: 'claimable_reward',
            payload: { reward: 'merch_coupon' },
          },
          {
            code: 'mystery_box',
            name: 'Mystery Box Claim',
            tier: 'rare',
            weight: 10,
            enabled: true,
            quantity: 35,
            type: 'claimable_reward',
            payload: { reward: 'mystery_box' },
          },
        ],
      },
      milestones: [],
      messages: {
        noKeys: 'You do not have any available keys.',
        vaultInactive: 'The vault is currently inactive.',
        openSuccess: 'Vault opened! You received **{{rewardName}}**.',
        noRewardOpen: 'Vault opened, but this key did not reveal a reward.',
        openSuspenseLines: [
          'You slide the key into the lock. The vault hums and the room goes quiet.',
          'The mechanism clicks once, then twice. Everyone waits for the final turn.',
          'You pull the handle. Steel groans and the vault decides your fate.',
        ],
        noRewardOpenVariants: [
          'The vault coughed, laughed, and swallowed your key.',
          'A note slides out: "Nice try. Come back with better luck."',
          'The lock opens an inch, then slams shut. Not today.',
          'The vault guard nods, shrugs, and says: "That key was training mode."',
        ],
      },
    };
  }

  mergeConfig(base, patch) {
    if (!patch || typeof patch !== 'object') return base;
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
        out[key] = this.mergeConfig(out[key], value);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  ensureConfig(guildId) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return null;
    let row = db.prepare('SELECT * FROM vault_config WHERE guild_id = ?').get(gid);
    if (!row) {
      db.prepare(`
        INSERT INTO vault_config (guild_id, config_json, created_at, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(gid, JSON.stringify(this.getDefaultConfig()));
      row = db.prepare('SELECT * FROM vault_config WHERE guild_id = ?').get(gid);
    }
    const cfg = safeJsonParse(row?.config_json, {}) || {};
    return this.mergeConfig(this.getDefaultConfig(), cfg);
  }

  getConfig(guildId) {
    return this.ensureConfig(guildId);
  }

  saveConfig(guildId, fullConfig) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return { success: false, message: 'Invalid guildId' };
    const merged = this.mergeConfig(this.getDefaultConfig(), fullConfig || {});
    db.prepare(`
      INSERT INTO vault_config (guild_id, config_json, created_at, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id) DO UPDATE SET
        config_json = excluded.config_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(gid, JSON.stringify(merged));
    return { success: true, config: merged };
  }

  setConfigValue(guildId, key, value) {
    const cfg = this.getConfig(guildId);
    if (!cfg) return { success: false, message: 'Config unavailable' };
    const parts = String(key || '').split('.').map(p => p.trim()).filter(Boolean);
    if (!parts.length) return { success: false, message: 'Invalid key' };

    let cursor = cfg;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {};
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
    return this.saveConfig(guildId, cfg);
  }

  ensureDefaultSeason(guildId) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return null;
    db.prepare(`
      INSERT OR IGNORE INTO vault_seasons (
        guild_id, season_id, season_name, active, metadata_json, created_at, updated_at
      )
      VALUES (?, 'default', 'Default Season', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(gid, JSON.stringify({ createdBy: 'system' }));
    return this.getActiveSeason(gid);
  }

  listSeasons(guildId) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return [];
    this.ensureDefaultSeason(gid);
    return db.prepare(`
      SELECT *
      FROM vault_seasons
      WHERE guild_id = ?
      ORDER BY active DESC, datetime(created_at) DESC
    `).all(gid).map(row => ({
      ...row,
      metadata: safeJsonParse(row.metadata_json, null),
    }));
  }

  getActiveSeason(guildId) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return null;
    let row = db.prepare(`
      SELECT *
      FROM vault_seasons
      WHERE guild_id = ? AND active = 1
      ORDER BY datetime(updated_at) DESC, id DESC
      LIMIT 1
    `).get(gid);
    if (!row) {
      this.ensureDefaultSeason(gid);
      row = db.prepare(`
        SELECT *
        FROM vault_seasons
        WHERE guild_id = ? AND active = 1
        ORDER BY datetime(updated_at) DESC, id DESC
        LIMIT 1
      `).get(gid);
    }
    return row
      ? { ...row, metadata: safeJsonParse(row.metadata_json, null) }
      : null;
  }

  upsertSeason(guildId, payload = {}) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return { success: false, message: 'Invalid guildId' };
    const sid = normalizeSeasonId(payload.seasonId || payload.season_id);
    const name = String(payload.seasonName || payload.season_name || sid).trim();
    const startsAt = payload.startsAt || payload.starts_at || null;
    const endsAt = payload.endsAt || payload.ends_at || null;
    const active = payload.active === true ? 1 : 0;
    const metadata = payload.metadata || null;

    db.prepare(`
      INSERT INTO vault_seasons (
        guild_id, season_id, season_name, active, starts_at, ends_at, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id, season_id) DO UPDATE SET
        season_name = excluded.season_name,
        active = excluded.active,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        metadata_json = excluded.metadata_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(gid, sid, name || sid, active, startsAt, endsAt, metadata ? JSON.stringify(metadata) : null);

    if (active === 1) {
      db.prepare(`
        UPDATE vault_seasons
        SET active = 0, updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND season_id <> ?
      `).run(gid, sid);
      db.prepare(`
        UPDATE vault_seasons
        SET active = 1, updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND season_id = ?
      `).run(gid, sid);
    }

    return { success: true, season: this.getSeason(gid, sid) };
  }

  activateSeason(guildId, seasonId) {
    const gid = normalizeGuildId(guildId);
    const sid = normalizeSeasonId(seasonId);
    const existing = this.getSeason(gid, sid);
    if (!existing) return { success: false, message: 'Season not found' };
    db.transaction(() => {
      db.prepare('UPDATE vault_seasons SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?').run(gid);
      db.prepare('UPDATE vault_seasons SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND season_id = ?').run(gid, sid);
    })();
    return { success: true, season: this.getSeason(gid, sid) };
  }

  getSeason(guildId, seasonId) {
    const gid = normalizeGuildId(guildId);
    const sid = normalizeSeasonId(seasonId);
    const row = db.prepare(`
      SELECT *
      FROM vault_seasons
      WHERE guild_id = ? AND season_id = ?
      LIMIT 1
    `).get(gid, sid);
    return row ? { ...row, metadata: safeJsonParse(row.metadata_json, null) } : null;
  }

  getRewards(guildId) {
    const cfg = this.getConfig(guildId);
    return Array.isArray(cfg?.rewardTable?.rewards)
      ? cfg.rewardTable.rewards.map(reward => ({
          ...reward,
          quantity: normalizeRewardQuantity(reward?.quantity),
        }))
      : [];
  }

  addReward(guildId, reward) {
    const cfg = this.getConfig(guildId);
    if (!cfg) return { success: false, message: 'Config unavailable' };
    const rewards = Array.isArray(cfg.rewardTable?.rewards) ? [...cfg.rewardTable.rewards] : [];
    const code = String(reward?.code || '').trim();
    if (!code) return { success: false, message: 'Reward code is required' };
    if (rewards.some(r => String(r.code || '').toLowerCase() === code.toLowerCase())) {
      return { success: false, message: 'Reward code already exists' };
    }
    rewards.push({
      code,
      name: String(reward?.name || code).trim(),
      tier: String(reward?.tier || 'common').trim().toLowerCase(),
      weight: clampInt(reward?.weight, 0, 0),
      enabled: reward?.enabled !== false,
      quantity: normalizeRewardQuantity(reward?.quantity),
      type: String(reward?.type || 'claimable_reward').trim(),
      payload: reward?.payload || null,
    });
    cfg.rewardTable = cfg.rewardTable || {};
    cfg.rewardTable.rewards = rewards;
    return this.saveConfig(guildId, cfg);
  }

  updateReward(guildId, code, patch) {
    const cfg = this.getConfig(guildId);
    if (!cfg) return { success: false, message: 'Config unavailable' };
    const rewards = Array.isArray(cfg.rewardTable?.rewards) ? [...cfg.rewardTable.rewards] : [];
    const idx = rewards.findIndex(r => String(r.code || '').toLowerCase() === String(code || '').trim().toLowerCase());
    if (idx < 0) return { success: false, message: 'Reward not found' };
    const nextPatch = { ...patch };
    if (Object.prototype.hasOwnProperty.call(nextPatch, 'quantity')) {
      nextPatch.quantity = normalizeRewardQuantity(nextPatch.quantity);
    }
    rewards[idx] = { ...rewards[idx], ...nextPatch };
    cfg.rewardTable = cfg.rewardTable || {};
    cfg.rewardTable.rewards = rewards;
    return this.saveConfig(guildId, cfg);
  }

  removeReward(guildId, code) {
    const cfg = this.getConfig(guildId);
    if (!cfg) return { success: false, message: 'Config unavailable' };
    const rewards = Array.isArray(cfg.rewardTable?.rewards) ? [...cfg.rewardTable.rewards] : [];
    const next = rewards.filter(r => String(r.code || '').toLowerCase() !== String(code || '').trim().toLowerCase());
    cfg.rewardTable = cfg.rewardTable || {};
    cfg.rewardTable.rewards = next;
    return this.saveConfig(guildId, cfg);
  }

  rollReward(guildId) {
    const cfg = this.getConfig(guildId) || {};
    const failChancePercent = Math.max(0, Math.min(100, Number(cfg?.rewardTable?.failChancePercent ?? 75) || 0));
    if (failChancePercent > 0 && (Math.random() * 100) < failChancePercent) return null;
    const noRewardWeight = clampInt(cfg?.rewardTable?.noRewardWeight, 0, 0);
    const rewards = this.getRewards(guildId)
      .filter((reward) => {
        if (!reward || reward.enabled === false || Number(reward.weight || 0) <= 0) return false;
        const quantity = normalizeRewardQuantity(reward.quantity);
        if (quantity === null) return true;
        return quantity > 0;
      });
    const weightedRewardTotal = rewards.reduce((sum, reward) => sum + Number(reward.weight || 0), 0);
    const total = weightedRewardTotal + noRewardWeight;
    if (total <= 0) return null;
    let roll = Math.random() * total;
    if (noRewardWeight > 0) {
      roll -= noRewardWeight;
      if (roll < 0) return null;
    }
    for (const reward of rewards) {
      roll -= Number(reward.weight || 0);
      if (roll <= 0) return reward;
    }
    return rewards.length ? rewards[rewards.length - 1] : null;
  }

  ensureUserStats(guildId, seasonId, discordUserId, walletAddress = null) {
    const gid = normalizeGuildId(guildId);
    const sid = normalizeSeasonId(seasonId);
    const uid = String(discordUserId || '').trim();
    if (!gid || !sid || !uid) return null;
    db.prepare(`
      INSERT OR IGNORE INTO vault_user_stats (
        guild_id, season_id, discord_user_id, wallet_address,
        paid_mints, free_mints, keys_earned, keys_used, bonus_entries, pressure, points, rewards_won,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(gid, sid, uid, walletAddress || null);
    if (walletAddress) {
      db.prepare(`
        UPDATE vault_user_stats
        SET wallet_address = COALESCE(wallet_address, ?), updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND season_id = ? AND discord_user_id = ?
      `).run(walletAddress, gid, sid, uid);
    }
    return db.prepare(`
      SELECT *
      FROM vault_user_stats
      WHERE guild_id = ? AND season_id = ? AND discord_user_id = ?
      LIMIT 1
    `).get(gid, sid, uid);
  }

  getBalance(guildId, discordUserId, seasonId = null) {
    const season = seasonId ? this.getSeason(guildId, seasonId) : this.getActiveSeason(guildId);
    if (!season) return { success: false, message: 'No active season' };
    const stats = this.ensureUserStats(guildId, season.season_id, discordUserId);
    if (!stats) return { success: false, message: 'Could not load stats' };
    return {
      success: true,
      season,
      stats: {
        ...stats,
        available_keys: Number(stats.keys_earned || 0) - Number(stats.keys_used || 0),
      },
    };
  }

  listHistory(guildId, discordUserId, limit = 20) {
    const gid = normalizeGuildId(guildId);
    const uid = String(discordUserId || '').trim();
    const rows = db.prepare(`
      SELECT *
      FROM vault_openings
      WHERE guild_id = ? AND discord_user_id = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `).all(gid, uid, Math.max(1, Math.min(100, Number(limit) || 20)));
    return rows.map(row => ({
      ...row,
      reward_payload: safeJsonParse(row.reward_payload, null),
    }));
  }

  getLeaderboard(guildId, seasonId = null, sortBy = 'keys_used', limit = 10) {
    const gid = normalizeGuildId(guildId);
    const season = seasonId ? this.getSeason(guildId, seasonId) : this.getActiveSeason(guildId);
    if (!season) return { success: false, message: 'No active season' };
    const allowed = new Set(['keys_used', 'keys_earned', 'paid_mints', 'free_mints', 'rewards_won', 'pressure']);
    const sortCol = allowed.has(String(sortBy || '').trim()) ? String(sortBy).trim() : 'keys_used';
    const rows = db.prepare(`
      SELECT discord_user_id, keys_earned, keys_used, paid_mints, free_mints, pressure, rewards_won
      FROM vault_user_stats
      WHERE guild_id = ? AND season_id = ?
      ORDER BY ${sortCol} DESC, keys_used DESC, rewards_won DESC
      LIMIT ?
    `).all(gid, season.season_id, Math.max(1, Math.min(100, Number(limit) || 10)));
    return { success: true, season, rows };
  }

  openVault(guildId, discordUserId) {
    const gid = normalizeGuildId(guildId);
    const uid = String(discordUserId || '').trim();
    if (!gid || !uid) return { success: false, message: 'Missing guild or user id' };
    const cfg = this.getConfig(gid);
    if (!cfg?.general?.enabled) {
      return { success: false, code: 'vault_inactive', message: cfg?.messages?.vaultInactive || 'Vault inactive' };
    }
    const season = this.getActiveSeason(gid);
    if (!season) return { success: false, message: 'No active season' };

    const rolledReward = this.rollReward(gid);
    const reward = rolledReward || {
      code: 'no_reward',
      name: 'No Reward',
      tier: 'none',
      type: 'none',
      payload: null,
    };
    const openingStatus = reward.code === 'no_reward' ? 'empty' : 'completed';
    const rewardWonIncrement = reward.code === 'no_reward' ? 0 : 1;
    let openingResult = null;

    const tx = db.transaction(() => {
      const stats = this.ensureUserStats(gid, season.season_id, uid);
      if (!stats) return { success: false, message: 'Could not load user stats' };

      const availableKeys = Number(stats.keys_earned || 0) - Number(stats.keys_used || 0);
      if (availableKeys <= 0) {
        return { success: false, code: 'no_keys', message: cfg?.messages?.noKeys || 'No keys available' };
      }

      db.prepare(`
        UPDATE vault_user_stats
        SET keys_used = keys_used + 1, rewards_won = rewards_won + ?, updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND season_id = ? AND discord_user_id = ?
      `).run(rewardWonIncrement, gid, season.season_id, uid);

      const updatedStats = db.prepare(`
        SELECT *
        FROM vault_user_stats
        WHERE guild_id = ? AND season_id = ? AND discord_user_id = ?
      `).get(gid, season.season_id, uid);

      const keyNumber = Number(updatedStats.keys_used || 0);
      const ins = db.prepare(`
        INSERT INTO vault_openings (
          guild_id, season_id, discord_user_id,
          reward_tier, reward_code, reward_name, reward_payload, key_number, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        gid,
        season.season_id,
        uid,
        String(reward.tier || 'common'),
        String(reward.code || 'unknown'),
        String(reward.name || 'Unknown Reward'),
        reward.payload !== undefined ? JSON.stringify(reward.payload) : null,
        keyNumber,
        openingStatus
      );

      this.applyRewardEffects({
        guildId: gid,
        seasonId: season.season_id,
        discordUserId: uid,
        reward,
      });

      const freshStats = db.prepare(`
        SELECT *
        FROM vault_user_stats
        WHERE guild_id = ? AND season_id = ? AND discord_user_id = ?
      `).get(gid, season.season_id, uid);

      openingResult = {
        success: true,
        openingId: ins.lastInsertRowid,
        reward,
        season,
        stats: {
          ...freshStats,
          available_keys: Number(freshStats.keys_earned || 0) - Number(freshStats.keys_used || 0),
        },
      };
      return openingResult;
    });

    const result = tx();
    if (!result?.success) return result || { success: false, message: 'Vault opening failed' };
    return result;
  }

  applyRewardEffects({ guildId, seasonId, discordUserId, reward }) {
    const type = String(reward?.type || 'none').trim().toLowerCase();
    if (type === 'claimable_reward') {
      db.prepare(`
        INSERT INTO vault_rewards (
          guild_id, season_id, discord_user_id, reward_code, reward_name, reward_tier, reward_payload, claim_status, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'vault_open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        guildId,
        seasonId,
        discordUserId,
        String(reward.code || 'unknown'),
        String(reward.name || 'Unknown Reward'),
        String(reward.tier || 'common'),
        reward.payload !== undefined ? JSON.stringify(reward.payload) : null
      );
    }
  }

  decrementRewardInventoryOnClaim(guildId, rewardCode, decrementBy = 1) {
    const gid = normalizeGuildId(guildId);
    const code = String(rewardCode || '').trim().toLowerCase();
    const qtyToSubtract = Math.max(1, Number.parseInt(decrementBy, 10) || 1);
    if (!gid || !code) return { success: false, message: 'Invalid inventory decrement input' };

    const cfg = this.getConfig(gid);
    if (!cfg) return { success: false, message: 'Config unavailable' };
    const rewards = Array.isArray(cfg.rewardTable?.rewards) ? [...cfg.rewardTable.rewards] : [];
    const idx = rewards.findIndex(reward => String(reward?.code || '').trim().toLowerCase() === code);
    if (idx < 0) return { success: true, changed: false, removed: false, remainingQuantity: null };

    const reward = { ...rewards[idx] };
    const currentQty = normalizeRewardQuantity(reward.quantity);
    if (currentQty === null) {
      return { success: true, changed: false, removed: false, remainingQuantity: null };
    }

    const nextQty = Math.max(0, currentQty - qtyToSubtract);
    if (nextQty <= 0) {
      rewards.splice(idx, 1);
      cfg.rewardTable = cfg.rewardTable || {};
      cfg.rewardTable.rewards = rewards;
      const saveResult = this.saveConfig(gid, cfg);
      if (!saveResult.success) return saveResult;
      return { success: true, changed: true, removed: true, remainingQuantity: 0 };
    }

    reward.quantity = nextQty;
    rewards[idx] = reward;
    cfg.rewardTable = cfg.rewardTable || {};
    cfg.rewardTable.rewards = rewards;
    const saveResult = this.saveConfig(gid, cfg);
    if (!saveResult.success) return saveResult;
    return { success: true, changed: true, removed: false, remainingQuantity: nextQty };
  }

  assignManualReward(guildId, seasonId, discordUserId, reward = {}, source = 'manual_admin') {
    const gid = normalizeGuildId(guildId);
    const sid = normalizeSeasonId(seasonId);
    const uid = String(discordUserId || '').trim();
    if (!gid || !sid || !uid) return { success: false, message: 'Invalid input' };

    const rewardCode = String(reward.code || reward.reward_code || 'manual_reward').trim();
    const rewardName = String(reward.name || reward.reward_name || rewardCode).trim();
    const rewardTier = String(reward.tier || reward.reward_tier || 'common').trim().toLowerCase();
    const claimStatus = String(reward.claimStatus || reward.claim_status || 'pending').trim().toLowerCase() || 'pending';
    const payload = reward.payload !== undefined ? reward.payload : (reward.reward_payload || null);

    this.ensureUserStats(gid, sid, uid);
    const insert = db.prepare(`
      INSERT INTO vault_rewards (
        guild_id, season_id, discord_user_id, reward_code, reward_name, reward_tier, reward_payload, claim_status, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      gid,
      sid,
      uid,
      rewardCode,
      rewardName,
      rewardTier,
      payload !== undefined && payload !== null ? JSON.stringify(payload) : null,
      claimStatus,
      String(source || 'manual_admin').trim() || 'manual_admin'
    );

    return { success: true, rewardId: insert.lastInsertRowid };
  }

  updateRewardClaimStatus(guildId, rewardId, claimStatus, claimNote = null) {
    const gid = normalizeGuildId(guildId);
    const id = Number(rewardId);
    const status = String(claimStatus || '').trim().toLowerCase();
    if (!gid || !Number.isFinite(id) || id <= 0) return { success: false, message: 'Invalid reward id' };
    if (!status) return { success: false, message: 'claimStatus is required' };

    const row = db.prepare('SELECT * FROM vault_rewards WHERE id = ? AND guild_id = ? LIMIT 1').get(id, gid);
    if (!row) return { success: false, message: 'Reward not found' };

    db.prepare(`
      UPDATE vault_rewards
      SET claim_status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?
    `).run(status, id, gid);

    let inventoryUpdate = null;
    const claimedStatuses = new Set(['claimed', 'fulfilled']);
    const previousStatus = String(row.claim_status || '').trim().toLowerCase();
    if (claimedStatuses.has(status) && !claimedStatuses.has(previousStatus)) {
      inventoryUpdate = this.decrementRewardInventoryOnClaim(gid, row.reward_code, 1);
    }

    return {
      success: true,
      reward: {
        ...row,
        claim_status: status,
        claim_note: claimNote ? String(claimNote) : null,
      },
      inventoryUpdate,
    };
  }

  addKeys(guildId, seasonId, discordUserId, amount, reason = 'manual_add', adminId = null) {
    const gid = normalizeGuildId(guildId);
    const sid = normalizeSeasonId(seasonId);
    const uid = String(discordUserId || '').trim();
    const amt = clampInt(amount, 1, 0);
    if (!gid || !uid || amt <= 0) return { success: false, message: 'Invalid input' };
    this.ensureUserStats(gid, sid, uid);
    db.prepare(`
      UPDATE vault_user_stats
      SET keys_earned = keys_earned + ?, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND season_id = ? AND discord_user_id = ?
    `).run(amt, gid, sid, uid);
    this.logAdminAction(gid, adminId, 'add_keys', uid, { seasonId: sid, amount: amt, reason });
    return { success: true };
  }

  removeKeys(guildId, seasonId, discordUserId, amount, reason = 'manual_remove', adminId = null) {
    const gid = normalizeGuildId(guildId);
    const sid = normalizeSeasonId(seasonId);
    const uid = String(discordUserId || '').trim();
    const amt = clampInt(amount, 1, 0);
    if (!gid || !uid || amt <= 0) return { success: false, message: 'Invalid input' };
    const stats = this.ensureUserStats(gid, sid, uid);
    const available = Number(stats.keys_earned || 0) - Number(stats.keys_used || 0);
    if (available < amt) return { success: false, message: 'Insufficient available keys' };
    db.prepare(`
      UPDATE vault_user_stats
      SET keys_earned = keys_earned - ?, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND season_id = ? AND discord_user_id = ?
    `).run(amt, gid, sid, uid);
    this.logAdminAction(gid, adminId, 'remove_keys', uid, { seasonId: sid, amount: amt, reason });
    return { success: true };
  }

  listOpenings(guildId, seasonId = null, limit = 50) {
    const gid = normalizeGuildId(guildId);
    const sid = seasonId ? normalizeSeasonId(seasonId) : null;
    const rows = sid
      ? db.prepare(`
          SELECT *
          FROM vault_openings
          WHERE guild_id = ? AND season_id = ?
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT ?
        `).all(gid, sid, Math.max(1, Math.min(200, Number(limit) || 50)))
      : db.prepare(`
          SELECT *
          FROM vault_openings
          WHERE guild_id = ?
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT ?
        `).all(gid, Math.max(1, Math.min(200, Number(limit) || 50)));
    return rows.map(row => ({ ...row, reward_payload: safeJsonParse(row.reward_payload, null) }));
  }

  listRewards(guildId, seasonId = null, claimStatus = null, limit = 100) {
    const gid = normalizeGuildId(guildId);
    const sid = seasonId ? normalizeSeasonId(seasonId) : null;
    const status = String(claimStatus || '').trim();
    let sql = 'SELECT * FROM vault_rewards WHERE guild_id = ?';
    const params = [gid];
    if (sid) {
      sql += ' AND season_id = ?';
      params.push(sid);
    }
    if (status) {
      sql += ' AND claim_status = ?';
      params.push(status);
    }
    sql += ' ORDER BY datetime(created_at) DESC, id DESC LIMIT ?';
    params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
    return db.prepare(sql).all(...params).map(row => ({ ...row, reward_payload: safeJsonParse(row.reward_payload, null) }));
  }

  listAdminLogs(guildId, limit = 100) {
    const gid = normalizeGuildId(guildId);
    return db.prepare(`
      SELECT *
      FROM vault_admin_logs
      WHERE guild_id = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `).all(gid, Math.max(1, Math.min(500, Number(limit) || 100))).map(row => ({
      ...row,
      details: safeJsonParse(row.details_json, null),
    }));
  }

  logAdminAction(guildId, adminUserId, action, targetUserId = null, details = null, seasonId = null) {
    try {
      db.prepare(`
        INSERT INTO vault_admin_logs (
          guild_id, season_id, admin_discord_user_id, action, target_discord_user_id, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        normalizeGuildId(guildId),
        seasonId ? normalizeSeasonId(seasonId) : null,
        adminUserId ? String(adminUserId).trim() : null,
        String(action || '').trim() || 'unknown',
        targetUserId ? String(targetUserId).trim() : null,
        details !== null && details !== undefined ? JSON.stringify(details) : null
      );
    } catch (error) {
      logger.warn('[vault] failed to write admin log:', error?.message || error);
    }
  }

  getMilestones(guildId) {
    const cfg = this.getConfig(guildId);
    return Array.isArray(cfg?.milestones) ? cfg.milestones : [];
  }

  saveMilestones(guildId, milestones = []) {
    const cfg = this.getConfig(guildId);
    if (!cfg) return { success: false, message: 'Config unavailable' };
    cfg.milestones = Array.isArray(milestones) ? milestones : [];
    return this.saveConfig(guildId, cfg);
  }

  findLinkedDiscordUserByWallet(walletAddress) {
    const wallet = String(walletAddress || '').trim();
    if (!wallet) return null;
    const row = db.prepare(`
      SELECT discord_id
      FROM wallets
      WHERE lower(wallet_address) = lower(?)
      LIMIT 1
    `).get(wallet);
    return row?.discord_id ? String(row.discord_id).trim() : null;
  }

  computeMintGrants(config, mintType) {
    const normalizedType = String(mintType || 'unknown').trim().toLowerCase();
    const paid = normalizedType === 'paid';
    const free = normalizedType === 'free';
    const rules = config?.mintRules || {};
    return {
      paid_mints: paid ? 1 : 0,
      free_mints: free ? 1 : 0,
      keys_granted: paid ? clampInt(rules.keysPerPaidMint, 0, 0) : (free ? clampInt(rules.keysPerFreeMint, 0, 0) : 0),
      pressure_granted: paid ? clampInt(rules.pressurePerPaidMint, 0, 0) : (free ? clampInt(rules.pressurePerFreeMint, 0, 0) : 0),
    };
  }

  applyMintGrantsToUser(guildId, seasonId, discordUserId, walletAddress, grants) {
    this.ensureUserStats(guildId, seasonId, discordUserId, walletAddress || null);
    db.prepare(`
      UPDATE vault_user_stats
      SET
        paid_mints = paid_mints + ?,
        free_mints = free_mints + ?,
        keys_earned = keys_earned + ?,
        pressure = pressure + ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND season_id = ? AND discord_user_id = ?
    `).run(
      clampInt(grants.paid_mints, 0, 0),
      clampInt(grants.free_mints, 0, 0),
      clampInt(grants.keys_granted, 0, 0),
      clampInt(grants.pressure_granted, 0, 0),
      normalizeGuildId(guildId),
      normalizeSeasonId(seasonId),
      String(discordUserId || '').trim()
    );
  }

  ingestMintEvent(event) {
    const guildId = normalizeGuildId(event?.guildId || event?.guild_id);
    if (!guildId) return { success: false, message: 'guildId is required' };

    const txSignature = String(event?.txSignature || event?.tx_signature || '').trim();
    if (!txSignature) return { success: false, message: 'txSignature is required' };

    const config = this.getConfig(guildId);
    const season = event?.seasonId
      ? (this.getSeason(guildId, event.seasonId) || this.getActiveSeason(guildId))
      : this.getActiveSeason(guildId);
    if (!season) return { success: false, message: 'No active season' };

    const walletAddress = String(event?.walletAddress || event?.wallet_address || '').trim() || null;
    const mintType = String(event?.mintType || event?.mint_type || 'unknown').trim().toLowerCase();
    const mintAddress = String(event?.mintAddress || event?.mint_address || '').trim() || null;

    const exists = db.prepare(`
      SELECT id
      FROM vault_mint_events
      WHERE guild_id = ? AND tx_signature = ?
      LIMIT 1
    `).get(guildId, txSignature);
    if (exists) return { success: true, duplicate: true, message: 'Duplicate tx signature ignored' };

    const grants = this.computeMintGrants(config, mintType);
    const linkedUserId = walletAddress ? this.findLinkedDiscordUserByWallet(walletAddress) : null;

    try {
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO vault_mint_events (
          guild_id, season_id, tx_signature, mint_address, wallet_address, discord_user_id, mint_type,
          keys_granted, bonus_entries_granted, pressure_granted, points_granted, metadata_json, created_at, processed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(
          guildId,
          season.season_id,
          txSignature,
          mintAddress,
          walletAddress,
          linkedUserId || null,
          mintType,
          grants.keys_granted,
          0,
          grants.pressure_granted,
          0,
          JSON.stringify({
            source: event?.source || 'vault_webhook',
            raw: event || null,
            receivedAt: nowIso(),
          })
        );

        if (linkedUserId) {
          this.applyMintGrantsToUser(guildId, season.season_id, linkedUserId, walletAddress, grants);
        }
      });
      tx();
    } catch (error) {
      const msg = String(error?.message || '').toLowerCase();
      if (msg.includes('unique') || msg.includes('constraint')) {
        return { success: true, duplicate: true, message: 'Duplicate tx signature ignored' };
      }
      throw error;
    }

    return {
      success: true,
      duplicate: false,
      linkedUserId: linkedUserId || null,
      seasonId: season.season_id,
      grants,
    };
  }

  backfillWalletForActiveSeason(guildId, walletAddress, discordUserId) {
    const gid = normalizeGuildId(guildId);
    const wallet = String(walletAddress || '').trim();
    const uid = String(discordUserId || '').trim();
    if (!gid || !wallet || !uid) return { success: false, message: 'Invalid inputs' };
    const season = this.getActiveSeason(gid);
    if (!season) return { success: false, message: 'No active season' };

    const pendingRows = db.prepare(`
      SELECT *
      FROM vault_mint_events
      WHERE guild_id = ?
        AND season_id = ?
        AND lower(wallet_address) = lower(?)
        AND (discord_user_id IS NULL OR discord_user_id = '')
    `).all(gid, season.season_id, wallet);

    if (!pendingRows.length) {
      return { success: true, seasonId: season.season_id, processed: 0 };
    }

    const tx = db.transaction(() => {
      for (const row of pendingRows) {
        const grants = {
          paid_mints: String(row.mint_type || '').toLowerCase() === 'paid' ? 1 : 0,
          free_mints: String(row.mint_type || '').toLowerCase() === 'free' ? 1 : 0,
          keys_granted: clampInt(row.keys_granted, 0, 0),
          pressure_granted: clampInt(row.pressure_granted, 0, 0),
        };
        this.applyMintGrantsToUser(gid, season.season_id, uid, wallet, grants);
        db.prepare(`
          UPDATE vault_mint_events
          SET discord_user_id = ?, processed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(uid, row.id);
      }
    });
    tx();

    return { success: true, seasonId: season.season_id, processed: pendingRows.length };
  }

  onWalletLinked(guildId, discordUserId, walletAddress) {
    try {
      const gid = normalizeGuildId(guildId);
      const uid = String(discordUserId || '').trim();
      const wallet = String(walletAddress || '').trim();
      if (!gid || !uid || !wallet) return;
      setImmediate(() => {
        try {
          const result = this.backfillWalletForActiveSeason(gid, wallet, uid);
          if (result?.success && Number(result.processed || 0) > 0) {
            logger.log(`[vault] wallet-link backfill guild=${gid} user=${uid} wallet=${wallet} processed=${result.processed}`);
          }
        } catch (error) {
          logger.error('[vault] wallet-link backfill failed:', error);
        }
      });
    } catch (error) {
      logger.error('[vault] onWalletLinked failure:', error);
    }
  }
}

module.exports = new VaultService();
