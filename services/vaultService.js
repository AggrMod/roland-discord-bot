const db = require('../database/db');
const logger = require('../utils/logger');
const { Connection, PublicKey } = require('@solana/web3.js');
const xProviderService = require('./xProviderService');
const { decryptSecret } = require('../utils/secretVault');

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

function normalizeKeyTierId(value) {
  const id = String(value || '').trim().toLowerCase();
  return id || 'default';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function parseDbTimestampMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return NaN;
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  return new Date(normalized).getTime();
}

function normalizeXSocialRequirements(rewardPayload) {
  const payload = rewardPayload && typeof rewardPayload === 'object' ? rewardPayload : {};
  const out = [];
  const arr = Array.isArray(payload.social_requirements)
    ? payload.social_requirements
    : (Array.isArray(payload.socialRequirements) ? payload.socialRequirements : []);

  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const provider = String(raw.provider || 'x').trim().toLowerCase();
    if (provider !== 'x') continue;
    const action = String(raw.action || raw.action_type || '').trim().toLowerCase();
    if (!action) continue;
    const targetPostId = String(raw.target_post_id || raw.targetPostId || '').trim();
    const targetAccountId = String(raw.target_account_id || raw.targetAccountId || '').trim();
    const targetAccountHandle = String(raw.target_account_handle || raw.targetAccountHandle || '').trim().replace(/^@+/, '').toLowerCase();
    out.push({
      provider,
      action,
      targetPostId: targetPostId || null,
      targetAccountId: targetAccountId || null,
      targetAccountHandle: targetAccountHandle || null,
    });
  }

  const legacy = payload.x_task_gate && typeof payload.x_task_gate === 'object' ? payload.x_task_gate : null;
  if (legacy) {
    const postId = String(legacy.postId || legacy.post_id || '').trim();
    const accountId = String(legacy.followAccountId || legacy.follow_account_id || '').trim();
    const accountHandle = String(legacy.followAccountHandle || legacy.follow_account_handle || '').trim().replace(/^@+/, '').toLowerCase();
    if (legacy.requireLike && postId) out.push({ provider: 'x', action: 'x_like', targetPostId: postId, targetAccountId: null, targetAccountHandle: null });
    if (legacy.requireRepost && postId) out.push({ provider: 'x', action: 'x_repost', targetPostId: postId, targetAccountId: null, targetAccountHandle: null });
    if (legacy.requireFollow && (accountId || accountHandle)) out.push({ provider: 'x', action: 'x_follow', targetPostId: null, targetAccountId: accountId || null, targetAccountHandle: accountHandle || null });
  }

  const dedup = new Map();
  for (const req of out) {
    const key = `${req.provider}|${req.action}|${req.targetPostId || ''}|${req.targetAccountId || ''}|${req.targetAccountHandle || ''}`;
    if (!dedup.has(key)) dedup.set(key, req);
  }
  return [...dedup.values()];
}

function buildRequirementTargetRef(req) {
  if (req.action === 'x_follow') return String(req.targetAccountId || req.targetAccountHandle || '').trim().toLowerCase();
  return String(req.targetPostId || '').trim();
}

class VaultService {
  constructor() {
    this.rpcConnection = null;
    this.rpcUrl = null;
  }

  getRpcUrl() {
    const explicit = String(process.env.SOLANA_RPC_URL || '').trim();
    if (explicit) return explicit;
    const heliusApiKey = String(process.env.HELIUS_API_KEY || '').trim();
    if (heliusApiKey) return `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
    return 'https://api.mainnet-beta.solana.com';
  }

  getRpcConnection() {
    const rpcUrl = this.getRpcUrl();
    if (!this.rpcConnection || this.rpcUrl !== rpcUrl) {
      this.rpcUrl = rpcUrl;
      this.rpcConnection = new Connection(rpcUrl, 'confirmed');
    }
    return this.rpcConnection;
  }

  normalizeSolanaAddress(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    try {
      return new PublicKey(raw).toBase58();
    } catch (_error) {
      return null;
    }
  }

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
      keyTiers: [
        {
          id: 'default',
          name: 'Default Key',
          enabled: true,
          inheritsFrom: null,
        },
      ],
      keyTierConversions: [],
      mintRules: {
        keysPerPaidMint: 1,
        keysPerFreeMint: 0,
        pressurePerPaidMint: 1,
        pressurePerFreeMint: 0,
        keyTierGrants: {
          default: {
            paid: 1,
            free: 0,
          },
        },
      },
      mintSource: {
        mode: 'custom_webhook',
        countTransfersToPaymentWallet: false,
        paymentWalletAddress: '',
        paymentWalletAddresses: [],
        paymentMinLamports: 1,
        paymentBands: [],
      },
      announcements: {
        channelId: '',
        announceRewardTiers: ['rare', 'epic', 'legendary'],
        announceCommonRewards: false,
      },
      ticketing: {
        createTicketOnWin: false,
        rewardTicketCategoryId: null,
        alertChannelId: null,
      },
      security: {
        openCooldownSeconds: 3,
        upgradeCooldownSeconds: 0,
        upgradeDailyCapPerUser: 0,
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

  validateAndNormalizeConfig(config) {
    const next = this.mergeConfig(this.getDefaultConfig(), config || {});
    const keyTiersRaw = Array.isArray(next.keyTiers) ? next.keyTiers : [];
    const normalizedTiers = [];
    const seen = new Set();
    for (const tier of keyTiersRaw) {
      const id = normalizeKeyTierId(tier?.id || tier?.keyTier || tier?.key_tier);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      normalizedTiers.push({
        id,
        name: String(tier?.name || tier?.label || id).trim() || id,
        enabled: tier?.enabled !== false,
        inheritsFrom: tier?.inheritsFrom ? normalizeKeyTierId(tier.inheritsFrom) : null,
      });
    }
    if (!normalizedTiers.length) {
      normalizedTiers.push({
        id: 'default',
        name: String(next?.theme?.keyName || 'Reward Key'),
        enabled: true,
        inheritsFrom: null,
      });
      seen.add('default');
    }

    const byId = new Map(normalizedTiers.map(t => [t.id, t]));
    for (const tier of normalizedTiers) {
      if (tier.id === 'default') {
        tier.inheritsFrom = null;
        continue;
      }
      if (tier.inheritsFrom && !byId.has(tier.inheritsFrom)) {
        throw new Error(`Key tier "${tier.id}" inherits from unknown tier "${tier.inheritsFrom}"`);
      }
    }

    const visitState = new Map(); // 0=unvisited,1=visiting,2=done
    const dfs = (tierId) => {
      const state = visitState.get(tierId) || 0;
      if (state === 1) throw new Error(`Key tier inheritance cycle detected at "${tierId}"`);
      if (state === 2) return;
      visitState.set(tierId, 1);
      const tier = byId.get(tierId);
      if (tier?.inheritsFrom) dfs(tier.inheritsFrom);
      visitState.set(tierId, 2);
    };
    for (const tier of normalizedTiers) dfs(tier.id);

    next.keyTiers = normalizedTiers;
    const keyTierConversionsRaw = Array.isArray(next.keyTierConversions) ? next.keyTierConversions : [];
    next.keyTierConversions = keyTierConversionsRaw
      .map((rule) => ({
        fromTier: normalizeKeyTierId(rule?.fromTier || rule?.from_tier),
        toTier: normalizeKeyTierId(rule?.toTier || rule?.to_tier),
        fromAmount: Math.max(1, clampInt(rule?.fromAmount ?? rule?.from_amount, 1, 1)),
        toAmount: Math.max(1, clampInt(rule?.toAmount ?? rule?.to_amount, 1, 1)),
        enabled: rule?.enabled !== false,
      }))
      .filter((rule) => byId.has(rule.fromTier) && byId.has(rule.toTier))
      .filter((rule) => rule.fromTier !== rule.toTier);
    const pairSeen = new Set();
    for (const rule of next.keyTierConversions) {
      const pair = `${rule.fromTier}->${rule.toTier}`;
      if (pairSeen.has(pair)) {
        throw new Error(`Duplicate conversion rule for ${pair}`);
      }
      pairSeen.add(pair);
    }

    const keyTierGrantsRaw = next?.mintRules?.keyTierGrants && typeof next.mintRules.keyTierGrants === 'object'
      ? next.mintRules.keyTierGrants
      : {};
    const normalizedGrants = {};
    for (const [tierIdRaw, grant] of Object.entries(keyTierGrantsRaw)) {
      const tierId = normalizeKeyTierId(tierIdRaw);
      if (!byId.has(tierId)) continue;
      normalizedGrants[tierId] = {
        paid: clampInt(grant?.paid, 0, 0),
        free: clampInt(grant?.free, 0, 0),
      };
    }
    if (!Object.keys(normalizedGrants).length && normalizedTiers.length) {
      const fallbackTierId = normalizedTiers[0].id;
      normalizedGrants[fallbackTierId] = {
        paid: clampInt(next?.mintRules?.keysPerPaidMint, 0, 0),
        free: clampInt(next?.mintRules?.keysPerFreeMint, 0, 0),
      };
    }
    next.mintRules = next.mintRules || {};
    next.mintRules.keyTierGrants = normalizedGrants;

    const paymentBandsRaw = Array.isArray(next?.mintSource?.paymentBands) ? next.mintSource.paymentBands : [];
    const normalizedBands = paymentBandsRaw
      .map((band) => ({
        keyTier: normalizeKeyTierId(band?.keyTier || band?.key_tier || 'default'),
        minLamports: Math.max(0, clampInt(band?.minLamports ?? band?.min_lamports, 0, 0)),
        maxLamports: band?.maxLamports === null || band?.maxLamports === undefined || band?.maxLamports === ''
          ? null
          : Math.max(0, clampInt(band?.maxLamports ?? band?.max_lamports, 0, 0)),
        paid: Math.max(0, clampInt(band?.paid, 0, 1)),
        free: Math.max(0, clampInt(band?.free, 0, 0)),
      }))
      .filter((band) => byId.has(band.keyTier))
      .filter((band) => band.maxLamports === null || band.maxLamports >= band.minLamports)
      .sort((a, b) => Number(a.minLamports || 0) - Number(b.minLamports || 0));
    next.mintSource = next.mintSource || {};
    next.mintSource.paymentBands = normalizedBands;

    const rewards = Array.isArray(next?.rewardTable?.rewards) ? next.rewardTable.rewards : [];
    next.rewardTable = next.rewardTable || {};
    next.rewardTable.rewards = rewards.map((reward) => {
      const keyTier = reward?.keyTier ? normalizeKeyTierId(reward.keyTier) : null;
      if (keyTier && !byId.has(keyTier)) {
        throw new Error(`Reward "${String(reward?.code || 'unknown')}" references unknown key tier "${keyTier}"`);
      }
      return {
        ...reward,
        keyTier,
      };
    });

    return next;
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
    let merged = null;
    try {
      merged = this.validateAndNormalizeConfig(fullConfig || {});
    } catch (error) {
      return { success: false, message: String(error?.message || error || 'Invalid config') };
    }
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
          keyTier: reward?.keyTier ? normalizeKeyTierId(reward.keyTier) : null,
          quantity: normalizeRewardQuantity(reward?.quantity),
        }))
      : [];
  }

  getKeyTiers(guildId) {
    const cfg = this.getConfig(guildId) || {};
    const raw = Array.isArray(cfg.keyTiers) ? cfg.keyTiers : [];
    const normalized = raw
      .map((tier) => ({
        id: normalizeKeyTierId(tier?.id || tier?.keyTier || tier?.key_tier),
        name: String(tier?.name || tier?.label || tier?.id || 'Default Key').trim() || 'Default Key',
        enabled: tier?.enabled !== false,
        inheritsFrom: tier?.inheritsFrom ? normalizeKeyTierId(tier.inheritsFrom) : null,
      }))
      .filter(tier => !!tier.id);

    if (!normalized.length) {
      return [{ id: 'default', name: String(cfg?.theme?.keyName || 'Reward Key'), enabled: true, inheritsFrom: null }];
    }
    return normalized;
  }

  resolveKeyTier(guildId, keyTierId = null) {
    const tiers = this.getKeyTiers(guildId);
    const requested = normalizeKeyTierId(keyTierId || 'default');
    const byId = new Map(tiers.map(tier => [tier.id, tier]));
    return byId.get(requested) || tiers.find(tier => tier.enabled !== false) || tiers[0] || null;
  }

  getInheritedTierChain(guildId, keyTierId = null) {
    const tiers = this.getKeyTiers(guildId);
    const byId = new Map(tiers.map(tier => [tier.id, tier]));
    const start = this.resolveKeyTier(guildId, keyTierId);
    if (!start) return [];
    const chain = [];
    const seen = new Set();
    let cursor = start;
    while (cursor && !seen.has(cursor.id)) {
      chain.push(cursor.id);
      seen.add(cursor.id);
      const parentId = cursor.inheritsFrom ? normalizeKeyTierId(cursor.inheritsFrom) : null;
      cursor = parentId ? byId.get(parentId) : null;
    }
    return chain;
  }

  getStatsKeyBalances(stats) {
    const parsed = safeJsonParse(stats?.key_balances_json, {});
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    for (const [tierKey, amountRaw] of Object.entries(parsed)) {
      const tierId = normalizeKeyTierId(tierKey);
      const amount = Number.parseInt(amountRaw, 10);
      out[tierId] = Number.isFinite(amount) ? Math.max(0, amount) : 0;
    }
    return out;
  }

  getAvailableKeysForTier(stats, keyTierId = 'default') {
    const tierId = normalizeKeyTierId(keyTierId);
    const balances = this.getStatsKeyBalances(stats);
    if (Object.prototype.hasOwnProperty.call(balances, tierId)) {
      return Math.max(0, Number(balances[tierId] || 0));
    }
    if (tierId === 'default') {
      return Math.max(0, Number(stats?.keys_earned || 0) - Number(stats?.keys_used || 0));
    }
    return 0;
  }

  getKeyTierConversions(guildId) {
    const cfg = this.getConfig(guildId) || {};
    return Array.isArray(cfg.keyTierConversions) ? cfg.keyTierConversions : [];
  }

  getKeyTierConversionRule(guildId, fromTier, toTier) {
    const fromId = normalizeKeyTierId(fromTier);
    const toId = normalizeKeyTierId(toTier);
    const rules = this.getKeyTierConversions(guildId);
    return rules.find((rule) =>
      rule && rule.enabled !== false
      && normalizeKeyTierId(rule.fromTier) === fromId
      && normalizeKeyTierId(rule.toTier) === toId
    ) || null;
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
      keyTier: reward?.keyTier ? normalizeKeyTierId(reward.keyTier) : null,
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
    if (Object.prototype.hasOwnProperty.call(nextPatch, 'keyTier')) {
      nextPatch.keyTier = nextPatch.keyTier ? normalizeKeyTierId(nextPatch.keyTier) : null;
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

  rollReward(guildId, keyTierId = 'default') {
    const cfg = this.getConfig(guildId) || {};
    const failChancePercent = Math.max(0, Math.min(100, Number(cfg?.rewardTable?.failChancePercent ?? 75) || 0));
    if (failChancePercent > 0 && (Math.random() * 100) < failChancePercent) return null;
    const noRewardWeight = clampInt(cfg?.rewardTable?.noRewardWeight, 0, 0);
    const inheritedTiers = new Set(this.getInheritedTierChain(guildId, keyTierId));
    const rewards = this.getRewards(guildId)
      .filter((reward) => {
        if (!reward || reward.enabled === false || Number(reward.weight || 0) <= 0) return false;
        const rewardKeyTier = reward?.keyTier ? normalizeKeyTierId(reward.keyTier) : null;
        if (rewardKeyTier && !inheritedTiers.has(rewardKeyTier)) return false;
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
        paid_mints, free_mints, keys_earned, keys_used, key_balances_json, bonus_entries, pressure, points, rewards_won,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, '{}', 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
        key_balances: this.getStatsKeyBalances(stats),
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

  openVault(guildId, discordUserId, options = {}) {
    const gid = normalizeGuildId(guildId);
    const uid = String(discordUserId || '').trim();
    if (!gid || !uid) return { success: false, message: 'Missing guild or user id' };
    const cfg = this.getConfig(gid);
    if (!cfg?.general?.enabled) {
      return { success: false, code: 'vault_inactive', message: cfg?.messages?.vaultInactive || 'Vault inactive' };
    }
    const season = this.getActiveSeason(gid);
    if (!season) return { success: false, message: 'No active season' };

    const selectedTier = this.resolveKeyTier(gid, options?.keyTier || options?.key_tier || 'default');
    if (!selectedTier || selectedTier.enabled === false) {
      return { success: false, message: 'Selected key tier is disabled' };
    }

    const rolledReward = this.rollReward(gid, selectedTier.id);
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
      const cooldownSec = Math.max(0, Number(cfg?.security?.openCooldownSeconds || 0) || 0);
      if (cooldownSec > 0) {
        const lastOpen = db.prepare(`
          SELECT created_at
          FROM vault_openings
          WHERE guild_id = ? AND season_id = ? AND discord_user_id = ?
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT 1
        `).get(gid, season.season_id, uid);
        if (lastOpen?.created_at) {
          const elapsedMs = Date.now() - parseDbTimestampMs(lastOpen.created_at);
          if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < (cooldownSec * 1000)) {
            const waitSec = Math.max(1, Math.ceil(((cooldownSec * 1000) - elapsedMs) / 1000));
            return { success: false, code: 'cooldown_active', message: `Vault cooldown active. Try again in ${waitSec}s.` };
          }
        }
      }

      const balances = this.getStatsKeyBalances(stats);
      const availableKeys = this.getAvailableKeysForTier(stats, selectedTier.id);
      if (availableKeys <= 0) {
        return { success: false, code: 'no_keys', message: `${cfg?.messages?.noKeys || 'No keys available'} (${selectedTier.name})` };
      }

      if (selectedTier.id === 'default') {
        db.prepare(`
          UPDATE vault_user_stats
          SET keys_used = keys_used + 1, rewards_won = rewards_won + ?, updated_at = CURRENT_TIMESTAMP
          WHERE guild_id = ? AND season_id = ? AND discord_user_id = ?
        `).run(rewardWonIncrement, gid, season.season_id, uid);
      } else {
        balances[selectedTier.id] = Math.max(0, Number(balances[selectedTier.id] || 0) - 1);
        db.prepare(`
          UPDATE vault_user_stats
          SET key_balances_json = ?, rewards_won = rewards_won + ?, updated_at = CURRENT_TIMESTAMP
          WHERE guild_id = ? AND season_id = ? AND discord_user_id = ?
        `).run(JSON.stringify(balances), rewardWonIncrement, gid, season.season_id, uid);
      }

      const updatedStats = db.prepare(`
        SELECT *
        FROM vault_user_stats
        WHERE guild_id = ? AND season_id = ? AND discord_user_id = ?
      `).get(gid, season.season_id, uid);

      const keyNumber = Number(updatedStats.keys_used || 0);
      const ins = db.prepare(`
        INSERT INTO vault_openings (
          guild_id, season_id, discord_user_id,
          reward_tier, reward_code, reward_name, reward_payload, key_number, key_tier, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        gid,
        season.season_id,
        uid,
        String(reward.tier || 'common'),
        String(reward.code || 'unknown'),
        String(reward.name || 'Unknown Reward'),
        reward.payload !== undefined ? JSON.stringify(reward.payload) : null,
        keyNumber,
        selectedTier.id,
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
          key_balances: this.getStatsKeyBalances(freshStats),
        },
        keyTier: selectedTier.id,
        keyTierName: selectedTier.name,
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

  async updateRewardClaimStatus(guildId, rewardId, claimStatus, claimNote = null) {
    const gid = normalizeGuildId(guildId);
    const id = Number(rewardId);
    const status = String(claimStatus || '').trim().toLowerCase();
    if (!gid || !Number.isFinite(id) || id <= 0) return { success: false, message: 'Invalid reward id' };
    if (!status) return { success: false, message: 'claimStatus is required' };

    const row = db.prepare('SELECT * FROM vault_rewards WHERE id = ? AND guild_id = ? LIMIT 1').get(id, gid);
    if (!row) return { success: false, message: 'Reward not found' };

    const finalizedStatuses = new Set(['claimed', 'fulfilled']);
    if (finalizedStatuses.has(status)) {
      const gate = await this.canFinalizeRewardClaim(gid, id, row.discord_user_id);
      if (!gate.success) return gate;
      if (gate.allowed === false) {
        return {
          success: false,
          code: gate.code || 'social_requirements_pending',
          message: gate.message || 'Social requirements are not verified yet.',
          pending: gate.pending || [],
          requirements: gate.requirements || [],
        };
      }
    }

    db.prepare(`
      UPDATE vault_rewards
      SET claim_status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?
    `).run(status, id, gid);

    let inventoryUpdate = null;
    const claimedStatuses = finalizedStatuses;
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

  addKeys(guildId, seasonId, discordUserId, amount, reason = 'manual_add', adminId = null, keyTier = 'default') {
    const gid = normalizeGuildId(guildId);
    const sid = normalizeSeasonId(seasonId);
    const uid = String(discordUserId || '').trim();
    const amt = clampInt(amount, 1, 0);
    if (!gid || !uid || amt <= 0) return { success: false, message: 'Invalid input' };
    const stats = this.ensureUserStats(gid, sid, uid);
    const tierId = normalizeKeyTierId(keyTier);
    const balances = this.getStatsKeyBalances(stats);
    balances[tierId] = Math.max(0, Number(balances[tierId] || 0) + amt);
    db.prepare(`
      UPDATE vault_user_stats
      SET keys_earned = keys_earned + ?, key_balances_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND season_id = ? AND discord_user_id = ?
    `).run(amt, JSON.stringify(balances), gid, sid, uid);
    this.logAdminAction(gid, adminId, 'add_keys', uid, { seasonId: sid, amount: amt, reason, keyTier: tierId });
    return { success: true };
  }

  removeKeys(guildId, seasonId, discordUserId, amount, reason = 'manual_remove', adminId = null, keyTier = 'default') {
    const gid = normalizeGuildId(guildId);
    const sid = normalizeSeasonId(seasonId);
    const uid = String(discordUserId || '').trim();
    const amt = clampInt(amount, 1, 0);
    if (!gid || !uid || amt <= 0) return { success: false, message: 'Invalid input' };
    const stats = this.ensureUserStats(gid, sid, uid);
    const tierId = normalizeKeyTierId(keyTier);
    const available = this.getAvailableKeysForTier(stats, tierId);
    if (available < amt) return { success: false, message: 'Insufficient available keys' };
    const balances = this.getStatsKeyBalances(stats);
    balances[tierId] = Math.max(0, Number(balances[tierId] || 0) - amt);
    db.prepare(`
      UPDATE vault_user_stats
      SET keys_earned = keys_earned - ?, key_balances_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND season_id = ? AND discord_user_id = ?
    `).run(amt, JSON.stringify(balances), gid, sid, uid);
    this.logAdminAction(gid, adminId, 'remove_keys', uid, { seasonId: sid, amount: amt, reason, keyTier: tierId });
    return { success: true };
  }

  upgradeKeys(guildId, discordUserId, options = {}) {
    const gid = normalizeGuildId(guildId);
    const uid = String(discordUserId || '').trim();
    const season = options?.seasonId ? this.getSeason(gid, options.seasonId) : this.getActiveSeason(gid);
    if (!gid || !uid) return { success: false, message: 'Invalid input' };
    if (!season) return { success: false, message: 'No active season' };

    const fromTier = normalizeKeyTierId(options?.fromTier || options?.from_tier || 'default');
    const toTier = normalizeKeyTierId(options?.toTier || options?.to_tier || 'default');
    const times = Math.max(1, Math.min(1000, clampInt(options?.times, 1, 1)));
    const cfg = this.getConfig(gid) || {};
    const upgradeCooldownSeconds = Math.max(0, Number(cfg?.security?.upgradeCooldownSeconds || 0) || 0);
    const upgradeDailyCapPerUser = Math.max(0, Number(cfg?.security?.upgradeDailyCapPerUser || 0) || 0);
    const rule = this.getKeyTierConversionRule(gid, fromTier, toTier);
    if (!rule) return { success: false, message: `No conversion rule configured for ${fromTier} -> ${toTier}` };

    const requiredFrom = Math.max(1, clampInt(rule.fromAmount, 1, 1)) * times;
    const gainedTo = Math.max(1, clampInt(rule.toAmount, 1, 1)) * times;

    let out = null;
    const tx = db.transaction(() => {
      const stats = this.ensureUserStats(gid, season.season_id, uid);
      if (!stats) return { success: false, message: 'Could not load user stats' };
      if (upgradeCooldownSeconds > 0) {
        const recent = db.prepare(`
          SELECT created_at
          FROM vault_admin_logs
          WHERE guild_id = ? AND action = 'key_upgrade' AND target_discord_user_id = ?
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT 1
        `).get(gid, uid);
        if (recent?.created_at) {
          const elapsedMs = Date.now() - parseDbTimestampMs(recent.created_at);
          if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < (upgradeCooldownSeconds * 1000)) {
            const waitSec = Math.max(1, Math.ceil(((upgradeCooldownSeconds * 1000) - elapsedMs) / 1000));
            return { success: false, message: `Upgrade cooldown active. Try again in ${waitSec}s.` };
          }
        }
      }
      if (upgradeDailyCapPerUser > 0) {
        const today = new Date().toISOString().slice(0, 10);
        const rows = db.prepare(`
          SELECT details_json
          FROM vault_admin_logs
          WHERE guild_id = ? AND action = 'key_upgrade' AND target_discord_user_id = ?
            AND date(created_at) = date(?)
        `).all(gid, uid, today);
        let usedToday = 0;
        for (const row of rows) {
          const details = safeJsonParse(row?.details_json, {});
          usedToday += Math.max(0, Number(details?.requiredFrom || 0));
        }
        if ((usedToday + requiredFrom) > upgradeDailyCapPerUser) {
          return { success: false, message: `Daily upgrade cap reached (${upgradeDailyCapPerUser} source keys/day)` };
        }
      }
      const balances = this.getStatsKeyBalances(stats);
      const fromAvailable = this.getAvailableKeysForTier(stats, fromTier);
      if (fromAvailable < requiredFrom) {
        return { success: false, message: `Insufficient ${fromTier} keys (${fromAvailable} available, ${requiredFrom} required)` };
      }

      balances[fromTier] = Math.max(0, fromAvailable - requiredFrom);
      const toAvailable = this.getAvailableKeysForTier(stats, toTier);
      balances[toTier] = Math.max(0, toAvailable + gainedTo);

      const rawKeysEarnedDelta = gainedTo - requiredFrom;
      const currentKeysEarned = Number(stats.keys_earned || 0);
      const keysEarnedDelta = Math.max(-currentKeysEarned, rawKeysEarnedDelta);
      db.prepare(`
        UPDATE vault_user_stats
        SET
          keys_earned = keys_earned + ?,
          key_balances_json = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND season_id = ? AND discord_user_id = ?
      `).run(keysEarnedDelta, JSON.stringify(balances), gid, season.season_id, uid);

      const fresh = db.prepare(`
        SELECT *
        FROM vault_user_stats
        WHERE guild_id = ? AND season_id = ? AND discord_user_id = ?
        LIMIT 1
      `).get(gid, season.season_id, uid);

      out = {
        success: true,
        seasonId: season.season_id,
        rule: {
          fromTier,
          toTier,
          fromAmount: rule.fromAmount,
          toAmount: rule.toAmount,
          times,
        },
        moved: {
          consumed: requiredFrom,
          added: gainedTo,
        },
        stats: {
          ...fresh,
          available_keys: Number(fresh.keys_earned || 0) - Number(fresh.keys_used || 0),
          key_balances: this.getStatsKeyBalances(fresh),
        },
      };
      return out;
    });

    const result = tx();
    if (!result?.success) return result || { success: false, message: 'Key upgrade failed' };
    this.logAdminAction(gid, null, 'key_upgrade', uid, {
      seasonId: season.season_id,
      fromTier,
      toTier,
      times,
      requiredFrom,
      gainedTo,
      source: 'user_upgrade',
    });
    return result;
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

  listUserRewards(guildId, discordUserId, { claimStatus = null, limit = 50 } = {}) {
    const gid = normalizeGuildId(guildId);
    const uid = String(discordUserId || '').trim();
    if (!gid || !uid) return [];
    let sql = 'SELECT * FROM vault_rewards WHERE guild_id = ? AND discord_user_id = ?';
    const params = [gid, uid];
    if (claimStatus) {
      sql += ' AND claim_status = ?';
      params.push(String(claimStatus || '').trim());
    }
    sql += ' ORDER BY datetime(created_at) DESC, id DESC LIMIT ?';
    params.push(Math.max(1, Math.min(200, Number(limit) || 50)));
    return db.prepare(sql).all(...params).map(row => ({ ...row, reward_payload: safeJsonParse(row.reward_payload, null) }));
  }

  getLinkedXAccount(guildId, discordUserId) {
    const gid = normalizeGuildId(guildId);
    const uid = String(discordUserId || '').trim();
    if (!gid || !uid) return null;
    const row = db.prepare(`
      SELECT *
      FROM engagement_social_accounts
      WHERE guild_id = ? AND user_id = ? AND provider = 'x'
      ORDER BY datetime(updated_at) DESC, id DESC
      LIMIT 1
    `).get(gid, uid);
    if (!row) return null;
    const rawToken = String(row.access_token || '').trim();
    const accessToken = rawToken.startsWith('v1:') ? decryptSecret(rawToken) : rawToken;
    return {
      ...row,
      accessToken: String(accessToken || '').trim(),
      providerUserId: String(row.provider_user_id || '').trim(),
      handle: String(row.handle || '').trim().replace(/^@+/, '').toLowerCase(),
      metadata: safeJsonParse(row.metadata_json, {}),
    };
  }

  async verifyRewardSocialRequirements(guildId, rewardId, discordUserId) {
    const gid = normalizeGuildId(guildId);
    const rid = Number(rewardId);
    const uid = String(discordUserId || '').trim();
    if (!gid || !Number.isFinite(rid) || rid <= 0 || !uid) {
      return { success: false, message: 'Invalid verification input' };
    }
    const rewardRow = db.prepare('SELECT * FROM vault_rewards WHERE id = ? AND guild_id = ? AND discord_user_id = ? LIMIT 1').get(rid, gid, uid);
    if (!rewardRow) return { success: false, message: 'Reward not found' };

    const requirements = normalizeXSocialRequirements(safeJsonParse(rewardRow.reward_payload, {}));
    if (!requirements.length) return { success: true, gated: false, verified: true, requirements: [], pending: [] };

    const account = this.getLinkedXAccount(gid, uid);
    if (!account?.accessToken) {
      return { success: true, gated: true, verified: false, code: 'missing_linked_x', message: 'Link your X account in Engagement before verifying.', requirements, pending: requirements };
    }

    const runtimeBearer = xProviderService.getRuntimeConfig().bearerToken;
    const results = [];
    for (const req of requirements) {
      const targetRef = buildRequirementTargetRef(req);
      let verified = false;
      let lastError = null;
      try {
        if (req.action === 'x_like' && req.targetPostId) {
          const liked = await xProviderService.getLikedPosts(account.providerUserId || account.metadata?.userId || account.handle, {
            accessToken: account.accessToken,
            maxResults: 100,
          });
          verified = (liked.posts || []).some(post => String(post.id) === String(req.targetPostId));
        } else if (req.action === 'x_repost' && req.targetPostId) {
          const reposts = await xProviderService.getRetweetingUsers(req.targetPostId, {
            bearerToken: runtimeBearer,
            accessToken: account.accessToken,
            maxResults: 100,
          });
          verified = (reposts.users || []).some(entry => String(entry.id) === String(account.providerUserId));
        } else if (req.action === 'x_follow' && (req.targetAccountId || req.targetAccountHandle)) {
          let targetId = String(req.targetAccountId || '').trim();
          if (!targetId && req.targetAccountHandle) {
            const lookup = await xProviderService.getUserByUsername(req.targetAccountHandle, {
              bearerToken: runtimeBearer,
              accessToken: account.accessToken,
            });
            targetId = String(lookup?.data?.id || '').trim();
          }
          const following = await xProviderService.getFollowing(account.providerUserId, {
            accessToken: account.accessToken,
            bearerToken: runtimeBearer,
            maxResults: 1000,
          });
          verified = !!targetId && (following.users || []).some(entry => String(entry.id) === targetId);
        } else {
          lastError = 'Unsupported requirement';
        }
      } catch (error) {
        lastError = String(error?.message || 'Verification failed');
      }

      db.prepare(`
        INSERT INTO vault_reward_social_checks (
          guild_id, reward_id, user_id, provider, action_type, target_ref, status, last_error, verified_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(reward_id, action_type, target_ref) DO UPDATE SET
          status = excluded.status,
          last_error = excluded.last_error,
          verified_at = excluded.verified_at,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        gid,
        rid,
        uid,
        req.provider,
        req.action,
        targetRef,
        verified ? 'verified' : 'pending',
        verified ? null : (lastError || 'Not yet verified'),
        verified ? nowIso() : null
      );

      results.push({
        ...req,
        targetRef,
        verified,
        lastError,
      });
    }

    const pending = results.filter(entry => !entry.verified);
    return {
      success: true,
      gated: true,
      verified: pending.length === 0,
      requirements: results,
      pending,
    };
  }

  async canFinalizeRewardClaim(guildId, rewardId, discordUserId) {
    const verifyResult = await this.verifyRewardSocialRequirements(guildId, rewardId, discordUserId);
    if (!verifyResult.success) return verifyResult;
    if (!verifyResult.gated) return { success: true, allowed: true, gated: false };
    if (verifyResult.verified) return { success: true, allowed: true, gated: true };
    return {
      success: true,
      allowed: false,
      gated: true,
      code: 'social_requirements_pending',
      message: 'Reward claim is gated until X social requirements are verified.',
      pending: verifyResult.pending || [],
      requirements: verifyResult.requirements || [],
    };
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

  listUserKeyOverview(guildId, seasonId = null, limit = 200) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return [];
    const sid = seasonId ? normalizeSeasonId(seasonId) : (this.getActiveSeason(gid)?.season_id || 'default');
    const rows = db.prepare(`
      SELECT discord_user_id, wallet_address, keys_earned, keys_used, key_balances_json, paid_mints, free_mints, rewards_won, updated_at
      FROM vault_user_stats
      WHERE guild_id = ? AND season_id = ?
      ORDER BY datetime(updated_at) DESC, discord_user_id ASC
      LIMIT ?
    `).all(gid, sid, Math.max(1, Math.min(2000, Number(limit) || 200)));
    return rows.map((row) => {
      const keyBalances = this.getStatsKeyBalances(row);
      const availableLegacy = Math.max(0, Number(row.keys_earned || 0) - Number(row.keys_used || 0));
      const availableByTier = Object.values(keyBalances).reduce((sum, n) => sum + Math.max(0, Number(n || 0)), 0);
      return {
        ...row,
        season_id: sid,
        key_balances: keyBalances,
        available_keys_legacy: availableLegacy,
        available_keys_total: availableByTier || availableLegacy,
      };
    });
  }

  getVaultHealthSummary(guildId) {
    const gid = normalizeGuildId(guildId);
    const cfg = this.getConfig(gid) || {};
    const season = this.getActiveSeason(gid);
    const paymentBands = Array.isArray(cfg?.mintSource?.paymentBands) ? cfg.mintSource.paymentBands : [];
    const conversions = Array.isArray(cfg?.keyTierConversions) ? cfg.keyTierConversions.filter(r => r && r.enabled !== false) : [];
    const ticketing = cfg?.ticketing || {};
    return {
      enabled: !!cfg?.general?.enabled,
      activeSeasonId: season?.season_id || null,
      activeSeasonName: season?.season_name || null,
      cooldownSeconds: Number(cfg?.security?.openCooldownSeconds || 0),
      upgradeCooldownSeconds: Number(cfg?.security?.upgradeCooldownSeconds || 0),
      upgradeDailyCapPerUser: Number(cfg?.security?.upgradeDailyCapPerUser || 0),
      paymentBandsConfigured: paymentBands.length,
      keyConversionRulesEnabled: conversions.length,
      ticketOnWinEnabled: !!ticketing.createTicketOnWin,
      rewardTicketCategoryId: ticketing.rewardTicketCategoryId || null,
      rewardTicketAlertChannelId: ticketing.alertChannelId || null,
      rpcUrlConfigured: !!this.getRpcUrl(),
    };
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
    const wallet = this.normalizeSolanaAddress(walletAddress);
    if (!wallet) return null;
    const row = db.prepare(`
      SELECT discord_id, wallet_address
      FROM wallets
    `).all();
    const match = row.find((entry) => this.normalizeSolanaAddress(entry?.wallet_address) === wallet);
    if (!match) return null;
    return match?.discord_id ? String(match.discord_id).trim() : null;
  }

  normalizeMintTypeValue(rawMintType) {
    const key = String(rawMintType || '').trim().toLowerCase();
    if (!key) return 'unknown';
    if (['paid', 'mint', 'nft_mint', 'token_mint', 'compressed_nft_mint', 'mint_to'].includes(key)) return 'paid';
    if (['free', 'free_mint', 'airdrop', 'gift'].includes(key)) return 'free';
    if (key === 'manual') return 'manual';
    if (key === 'unknown') return 'unknown';
    return key;
  }

  detectPositiveMintSignals(event) {
    const candidateMints = new Set();
    const candidateWallets = new Set();

    const addMint = (value) => {
      const mint = String(value || '').trim();
      if (mint) candidateMints.add(mint);
    };
    const addWallet = (value) => {
      const wallet = String(value || '').trim();
      if (wallet) candidateWallets.add(wallet);
    };

    const tokenTransfers = Array.isArray(event?.tokenTransfers) ? event.tokenTransfers : [];
    for (const transfer of tokenTransfers) {
      const amount = Number(transfer?.tokenAmount || transfer?.amount || 0);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      addMint(transfer?.mint);
      addWallet(transfer?.toUserAccount || transfer?.to_user_account || transfer?.to || null);
    }

    const accountRows = Array.isArray(event?.accountData) ? event.accountData : [];
    for (const accountRow of accountRows) {
      const balanceChanges = Array.isArray(accountRow?.tokenBalanceChanges) ? accountRow.tokenBalanceChanges : [];
      for (const change of balanceChanges) {
        const rawAmount = Number(change?.rawTokenAmount?.tokenAmount || change?.raw_token_amount?.token_amount || 0);
        if (!Number.isFinite(rawAmount) || rawAmount <= 0) continue;
        addMint(change?.mint);
        addWallet(change?.userAccount || change?.user_account || null);
      }
    }

    const nftMints = Array.isArray(event?.events?.nft?.nfts) ? event.events.nft.nfts : [];
    for (const nft of nftMints) addMint(nft?.mint);

    return {
      hasPositiveTokenSignal: candidateMints.size > 0,
      candidateMints: [...candidateMints],
      candidateWallets: [...candidateWallets],
    };
  }

  getConfiguredPaymentWalletSet(config) {
    const source = config?.mintSource || {};
    const out = new Set();
    const addWallet = (value) => {
      const wallet = String(value || '').trim();
      if (wallet) out.add(wallet);
    };

    addWallet(source.paymentWalletAddress);
    addWallet(source.mintWalletAddress);
    addWallet(source.transferTargetWallet);

    if (Array.isArray(source.paymentWalletAddresses)) {
      source.paymentWalletAddresses.forEach(addWallet);
    } else if (typeof source.paymentWalletAddresses === 'string') {
      source.paymentWalletAddresses
        .split(/[\n,\s]+/)
        .map(value => value.trim())
        .filter(Boolean)
        .forEach(addWallet);
    }

    return out;
  }

  detectPaymentWalletTransfer(event, config) {
    const source = config?.mintSource || {};
    const enabled = source.countTransfersToPaymentWallet === true || source.usePaymentTransfersAsMints === true;
    const paymentWallets = this.getConfiguredPaymentWalletSet(config);
    const minLamports = clampInt(source.paymentMinLamports, 0, 1);

    if (!enabled || paymentWallets.size === 0) {
      return {
        enabled,
        matched: false,
        minLamports,
        candidatePayers: [],
      };
    }

    const candidatePayers = new Set();
    const matches = [];
    const nativeTransfers = Array.isArray(event?.nativeTransfers)
      ? event.nativeTransfers
      : (Array.isArray(event?.native_transfers) ? event.native_transfers : []);
    for (const transfer of nativeTransfers) {
      const toWallet = String(
        transfer?.toUserAccount
        || transfer?.to_user_account
        || transfer?.to
        || transfer?.destination
        || ''
      ).trim();
      if (!toWallet || !paymentWallets.has(toWallet)) continue;

      const lamports = Number(transfer?.amount || transfer?.lamports || transfer?.nativeAmount || 0);
      if (!Number.isFinite(lamports) || lamports < minLamports) continue;

      const fromWallet = String(
        transfer?.fromUserAccount
        || transfer?.from_user_account
        || transfer?.from
        || transfer?.source
        || ''
      ).trim();
      if (fromWallet) candidatePayers.add(fromWallet);

      matches.push({
        toWallet,
        fromWallet: fromWallet || null,
        lamports,
      });
    }

    return {
      enabled,
      matched: matches.length > 0,
      minLamports,
      paymentWallets: [...paymentWallets],
      candidatePayers: [...candidatePayers],
      matches,
      reason: matches.length > 0 ? 'native_transfer_to_configured_payment_wallet' : 'no_matching_native_transfer',
    };
  }

  extractNativeTransfersFromParsedTransaction(parsedTx) {
    const transfers = [];
    const pushTransfer = (fromWallet, toWallet, lamports) => {
      const from = String(fromWallet || '').trim();
      const to = String(toWallet || '').trim();
      const amount = Number(lamports || 0);
      if (!from || !to) return;
      if (!Number.isFinite(amount) || amount <= 0) return;
      transfers.push({
        fromUserAccount: from,
        toUserAccount: to,
        amount,
      });
    };

    const readInstruction = (ix) => {
      if (!ix || typeof ix !== 'object') return;
      const parsed = ix.parsed;
      const program = String(ix.program || '').trim().toLowerCase();
      const type = String(parsed?.type || '').trim().toLowerCase();
      if (program !== 'system' || type !== 'transfer') return;
      const info = parsed?.info || {};
      pushTransfer(
        info.source || info.from || info.fromUserAccount,
        info.destination || info.to || info.toUserAccount,
        info.lamports || info.amount
      );
    };

    const outerInstructions = Array.isArray(parsedTx?.transaction?.message?.instructions)
      ? parsedTx.transaction.message.instructions
      : [];
    outerInstructions.forEach(readInstruction);

    const innerRows = Array.isArray(parsedTx?.meta?.innerInstructions) ? parsedTx.meta.innerInstructions : [];
    for (const row of innerRows) {
      const innerInstructions = Array.isArray(row?.instructions) ? row.instructions : [];
      innerInstructions.forEach(readInstruction);
    }

    return transfers;
  }

  async verifyPaymentTransaction(guildId, txSignature, options = {}) {
    const gid = normalizeGuildId(guildId);
    const signature = String(txSignature || '').trim();
    if (!gid) return { success: false, message: 'guildId is required' };
    if (!signature) return { success: false, message: 'txSignature is required' };

    const config = this.getConfig(gid);
    const season = options?.seasonId
      ? (this.getSeason(gid, options.seasonId) || this.getActiveSeason(gid))
      : this.getActiveSeason(gid);
    if (!season) return { success: false, message: 'No active season' };

    const paymentWallets = [...this.getConfiguredPaymentWalletSet(config)];
    if (!paymentWallets.length) {
      return { success: false, message: 'No mint payment wallet configured in Vault settings' };
    }

    const source = config?.mintSource || {};
    const minLamports = clampInt(source.paymentMinLamports, 0, 1);
    const connection = this.getRpcConnection();
    const parsedTx = await connection.getParsedTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!parsedTx) {
      return { success: false, message: 'Transaction not found or not confirmed yet' };
    }
    if (parsedTx?.meta?.err) {
      return { success: false, message: 'Transaction failed on-chain' };
    }

    const nativeTransfers = this.extractNativeTransfersFromParsedTransaction(parsedTx);
    const matches = nativeTransfers
      .filter((transfer) => {
        const destination = String(transfer?.toUserAccount || '').trim();
        const amount = Number(transfer?.amount || 0);
        return paymentWallets.includes(destination) && Number.isFinite(amount) && amount >= minLamports;
      })
      .sort((a, b) => Number(b?.amount || 0) - Number(a?.amount || 0));

    if (!matches.length) {
      return {
        success: false,
        message: 'No qualifying SOL transfer to a configured Vault payment wallet was found',
        paymentWallets,
        minLamports,
      };
    }

    const selectedTransfer = matches[0];
    const payerWallet = String(selectedTransfer?.fromUserAccount || '').trim();
    const linkedUserId = options?.discordUserId
      ? String(options.discordUserId || '').trim()
      : (payerWallet ? this.findLinkedDiscordUserByWallet(payerWallet) : null);
    const expectedDiscordUserId = String(options?.expectedDiscordUserId || '').trim();
    if (expectedDiscordUserId && String(linkedUserId || '') !== expectedDiscordUserId) {
      return {
        success: false,
        message: 'Payment sender wallet is not linked to your Discord account',
        payerWallet: payerWallet || null,
        linkedUserId: linkedUserId || null,
      };
    }

    const ingestResult = this.ingestMintEvent({
      guildId: gid,
      seasonId: season.season_id,
      txSignature: signature,
      walletAddress: payerWallet || null,
      discordUserId: linkedUserId || null,
      type: 'TRANSFER',
      source: String(options?.source || 'vault_onchain_payment_verify'),
      nativeTransfers: matches,
    });

    return {
      ...ingestResult,
      verifiedOnChain: !!ingestResult?.success,
      txSignature: signature,
      seasonId: season.season_id,
      payerWallet: payerWallet || null,
      linkedUserId: linkedUserId || ingestResult?.linkedUserId || null,
      matchedTransfer: {
        fromWallet: payerWallet || null,
        toWallet: String(selectedTransfer?.toUserAccount || '').trim() || null,
        lamports: Number(selectedTransfer?.amount || 0),
      },
      matchedTransferCount: matches.length,
    };
  }

  classifyMintEventType(event, config = null) {
    const explicitType = this.normalizeMintTypeValue(event?.mintType || event?.mint_type);
    if (['paid', 'free', 'manual'].includes(explicitType)) {
      return { mintType: explicitType, reason: 'explicit_mint_type' };
    }

    const eventTypeRaw = event?.type || event?.eventType || event?.transactionType || event?.txnType || '';
    const eventType = String(eventTypeRaw || '').trim().toUpperCase();
    const signals = this.detectPositiveMintSignals(event);
    const paymentTransfer = this.detectPaymentWalletTransfer(event, config);

    if (paymentTransfer.matched) {
      return {
        mintType: 'paid',
        reason: 'payment_transfer_to_configured_wallet',
        signals,
        paymentTransfer,
      };
    }

    const paidTypeSet = new Set(['NFT_MINT', 'TOKEN_MINT', 'COMPRESSED_NFT_MINT', 'MINT_TO']);
    const freeTypeSet = new Set(['FREE_MINT']);
    if (paidTypeSet.has(eventType)) return { mintType: 'paid', reason: `event_type:${eventType}`, signals };
    if (freeTypeSet.has(eventType)) return { mintType: 'free', reason: `event_type:${eventType}`, signals };

    const createAccountTypeSet = new Set(['CREATE_ACCOUNT', 'CREATE', 'INITIALIZE_ACCOUNT']);
    if (createAccountTypeSet.has(eventType) && signals.hasPositiveTokenSignal) {
      return { mintType: 'paid', reason: `create_account_with_token_signal:${eventType}`, signals };
    }

    if (signals.hasPositiveTokenSignal && (event?.events?.nft || event?.events?.compressedNft || /MINT/.test(eventType))) {
      return { mintType: 'paid', reason: 'positive_token_signal_with_mint_context', signals };
    }

    return {
      mintType: 'unknown',
      reason: eventType ? `unmapped_event_type:${eventType}` : 'unknown_event_type',
      signals,
      paymentTransfer,
    };
  }

  extractCanonicalMintEvent(event, config = null) {
    const classification = this.classifyMintEventType(event || {}, config);
    const signals = classification.signals || this.detectPositiveMintSignals(event || {});
    const paymentTransfer = classification.paymentTransfer || this.detectPaymentWalletTransfer(event || {}, config);

    const txSignature = String(
      event?.txSignature
      || event?.tx_signature
      || event?.signature
      || event?.transactionSignature
      || event?.txnSignature
      || ''
    ).trim();

    const walletAddress = String(
      event?.walletAddress
      || event?.wallet_address
      || event?.feePayer
      || event?.fee_payer
      || event?.payer
      || event?.events?.nft?.buyer
      || paymentTransfer?.candidatePayers?.[0]
      || signals.candidateWallets?.[0]
      || ''
    ).trim() || null;

    const mintAddress = String(
      event?.mintAddress
      || event?.mint_address
      || event?.events?.nft?.nfts?.[0]?.mint
      || event?.tokenTransfers?.[0]?.mint
      || signals.candidateMints?.[0]
      || ''
    ).trim() || null;

    const discordUserId = String(event?.discordUserId || event?.discord_user_id || '').trim() || null;

    return {
      txSignature,
      walletAddress,
      mintAddress,
      mintType: classification.mintType,
      classificationReason: classification.reason,
      signals,
      paymentTransfer,
      discordUserId,
    };
  }

  computeMintGrants(config, mintType, context = {}) {
    const normalizedType = this.normalizeMintTypeValue(mintType);
    const paid = normalizedType === 'paid';
    const free = normalizedType === 'free';
    const rules = config?.mintRules || {};
    const transferLamports = Number(context?.transferLamports || 0);
    const hasLamports = Number.isFinite(transferLamports) && transferLamports > 0;
    const configuredTierGrants = rules?.keyTierGrants && typeof rules.keyTierGrants === 'object'
      ? rules.keyTierGrants
      : {};
    const keyTierGrants = {};

    const paymentBands = Array.isArray(config?.mintSource?.paymentBands) ? config.mintSource.paymentBands : [];
    const matchedBand = (paid || free) && hasLamports
      ? paymentBands.find((band) => {
          const min = Math.max(0, Number(band?.minLamports || 0) || 0);
          const maxRaw = band?.maxLamports;
          const max = maxRaw === null || maxRaw === undefined || maxRaw === '' ? null : Math.max(0, Number(maxRaw) || 0);
          if (transferLamports < min) return false;
          if (max !== null && transferLamports > max) return false;
          return true;
        })
      : null;

    const tierList = Array.isArray(config?.keyTiers) ? config.keyTiers : [];
    const fallbackTierId = normalizeKeyTierId(tierList[0]?.id || 'default');
    if (matchedBand) {
      const bandTier = normalizeKeyTierId(matchedBand.keyTier || fallbackTierId);
      keyTierGrants[bandTier] = paid ? clampInt(matchedBand.paid, 0, 1) : (free ? clampInt(matchedBand.free, 0, 0) : 0);
    } else {
      for (const [tierIdRaw, tierRule] of Object.entries(configuredTierGrants)) {
        const tierId = normalizeKeyTierId(tierIdRaw);
        const paidGrant = clampInt(tierRule?.paid, 0, 0);
        const freeGrant = clampInt(tierRule?.free, 0, 0);
        keyTierGrants[tierId] = paid ? paidGrant : (free ? freeGrant : 0);
      }
    }
    if (!Object.keys(keyTierGrants).length) {
      keyTierGrants[fallbackTierId] = paid ? clampInt(rules.keysPerPaidMint, 0, 0) : (free ? clampInt(rules.keysPerFreeMint, 0, 0) : 0);
    }
    const totalKeysGranted = Object.values(keyTierGrants).reduce((sum, next) => sum + clampInt(next, 0, 0), 0);

    return {
      paid_mints: paid ? 1 : 0,
      free_mints: free ? 1 : 0,
      keys_granted: totalKeysGranted,
      key_tier_grants: keyTierGrants,
      grant_source: matchedBand ? 'payment_band' : 'default_tier_rules',
      matched_payment_band: matchedBand || null,
      pressure_granted: paid ? clampInt(rules.pressurePerPaidMint, 0, 0) : (free ? clampInt(rules.pressurePerFreeMint, 0, 0) : 0),
    };
  }

  applyMintGrantsToUser(guildId, seasonId, discordUserId, walletAddress, grants) {
    const stats = this.ensureUserStats(guildId, seasonId, discordUserId, walletAddress || null);
    const balances = this.getStatsKeyBalances(stats);
    const tierGrants = grants?.key_tier_grants && typeof grants.key_tier_grants === 'object'
      ? grants.key_tier_grants
      : { default: clampInt(grants?.keys_granted, 0, 0) };
    for (const [tierIdRaw, deltaRaw] of Object.entries(tierGrants)) {
      const tierId = normalizeKeyTierId(tierIdRaw);
      const delta = clampInt(deltaRaw, 0, 0);
      if (delta <= 0) continue;
      balances[tierId] = Math.max(0, Number(balances[tierId] || 0) + delta);
    }
    db.prepare(`
      UPDATE vault_user_stats
      SET
        paid_mints = paid_mints + ?,
        free_mints = free_mints + ?,
        keys_earned = keys_earned + ?,
        key_balances_json = ?,
        pressure = pressure + ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND season_id = ? AND discord_user_id = ?
    `).run(
      clampInt(grants.paid_mints, 0, 0),
      clampInt(grants.free_mints, 0, 0),
      clampInt(grants.keys_granted, 0, 0),
      JSON.stringify(balances),
      clampInt(grants.pressure_granted, 0, 0),
      normalizeGuildId(guildId),
      normalizeSeasonId(seasonId),
      String(discordUserId || '').trim()
    );
  }

  ingestMintEvent(event) {
    const guildId = normalizeGuildId(event?.guildId || event?.guild_id);
    if (!guildId) return { success: false, message: 'guildId is required' };

    const config = this.getConfig(guildId);
    const canonical = this.extractCanonicalMintEvent(event || {}, config);
    const txSignature = canonical.txSignature;
    if (!txSignature) return { success: false, message: 'txSignature is required' };

    const season = event?.seasonId
      ? (this.getSeason(guildId, event.seasonId) || this.getActiveSeason(guildId))
      : this.getActiveSeason(guildId);
    if (!season) return { success: false, message: 'No active season' };

    const walletAddress = canonical.walletAddress;
    const mintType = canonical.mintType;
    const mintAddress = canonical.mintAddress;
    const classificationReason = canonical.classificationReason;

    const existingAnyGuild = db.prepare(`
      SELECT *
      FROM vault_mint_events
      WHERE tx_signature = ?
      LIMIT 1
    `).get(txSignature);
    if (existingAnyGuild && String(existingAnyGuild.guild_id || '') !== guildId) {
      return { success: true, duplicate: true, message: 'Duplicate tx signature ignored' };
    }
    const existing = existingAnyGuild || null;
    const existingGrants = existing
      ? {
          paid_mints: String(existing.mint_type || '').toLowerCase() === 'paid' ? 1 : 0,
          free_mints: String(existing.mint_type || '').toLowerCase() === 'free' ? 1 : 0,
          keys_granted: clampInt(existing.keys_granted, 0, 0),
          key_tier_grants: { default: clampInt(existing.keys_granted, 0, 0) },
          pressure_granted: clampInt(existing.pressure_granted, 0, 0),
        }
      : null;
    const topLamports = Array.isArray(canonical?.paymentTransfer?.matches) && canonical.paymentTransfer.matches.length
      ? Number(canonical.paymentTransfer.matches.reduce((best, next) => {
          const lamports = Number(next?.lamports || 0);
          return lamports > best ? lamports : best;
        }, 0))
      : 0;
    const grants = this.computeMintGrants(config, mintType, { transferLamports: topLamports });
    const linkedUserId = canonical.discordUserId || (walletAddress ? this.findLinkedDiscordUserByWallet(walletAddress) : null);

    if (existing) {
      const shouldUpgradeUnknown = String(existing.mint_type || '').trim().toLowerCase() === 'unknown'
        && (mintType === 'paid' || mintType === 'free')
        && (grants.keys_granted > 0 || grants.pressure_granted > 0 || grants.paid_mints > 0 || grants.free_mints > 0);
      const shouldAttachLinkedUser = !String(existing.discord_user_id || '').trim() && !!linkedUserId;

      if (!shouldUpgradeUnknown && !shouldAttachLinkedUser) {
        return { success: true, duplicate: true, message: 'Duplicate tx signature ignored' };
      }

      const txUpgrade = db.transaction(() => {
        const nextDiscordUserId = shouldAttachLinkedUser ? linkedUserId : (String(existing.discord_user_id || '').trim() || null);
        const nextMintType = shouldUpgradeUnknown ? mintType : String(existing.mint_type || 'unknown').trim().toLowerCase();
        const nextMintAddress = existing.mint_address || mintAddress || null;
        const nextWalletAddress = existing.wallet_address || walletAddress || null;
        const nextKeysGranted = shouldUpgradeUnknown ? grants.keys_granted : clampInt(existing.keys_granted, 0, 0);
        const nextPressureGranted = shouldUpgradeUnknown ? grants.pressure_granted : clampInt(existing.pressure_granted, 0, 0);

        db.prepare(`
          UPDATE vault_mint_events
          SET
            mint_type = ?,
            mint_address = COALESCE(mint_address, ?),
            wallet_address = COALESCE(wallet_address, ?),
            discord_user_id = COALESCE(discord_user_id, ?),
            keys_granted = ?,
            pressure_granted = ?,
            metadata_json = ?,
            processed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          nextMintType,
          nextMintAddress,
          nextWalletAddress,
          nextDiscordUserId,
          nextKeysGranted,
          nextPressureGranted,
          JSON.stringify({
            source: event?.source || 'vault_webhook',
            classificationReason,
            raw: event || null,
            receivedAt: nowIso(),
          }),
          existing.id
        );

        if (nextDiscordUserId) {
          const prior = existingGrants || { paid_mints: 0, free_mints: 0, keys_granted: 0, pressure_granted: 0 };
          const delta = {
            paid_mints: Math.max(0, clampInt(grants.paid_mints, 0, 0) - clampInt(prior.paid_mints, 0, 0)),
            free_mints: Math.max(0, clampInt(grants.free_mints, 0, 0) - clampInt(prior.free_mints, 0, 0)),
            keys_granted: Math.max(0, clampInt(nextKeysGranted, 0, 0) - clampInt(prior.keys_granted, 0, 0)),
            key_tier_grants: grants.key_tier_grants || { default: Math.max(0, clampInt(nextKeysGranted, 0, 0) - clampInt(prior.keys_granted, 0, 0)) },
            pressure_granted: Math.max(0, clampInt(nextPressureGranted, 0, 0) - clampInt(prior.pressure_granted, 0, 0)),
          };

          const hasDelta = delta.paid_mints > 0 || delta.free_mints > 0 || delta.keys_granted > 0 || delta.pressure_granted > 0;
          const shouldReplayExisting = shouldAttachLinkedUser && !shouldUpgradeUnknown && (prior.keys_granted > 0 || prior.pressure_granted > 0 || prior.paid_mints > 0 || prior.free_mints > 0);

          if (hasDelta) {
            this.applyMintGrantsToUser(guildId, season.season_id, nextDiscordUserId, nextWalletAddress, delta);
          } else if (shouldReplayExisting) {
            this.applyMintGrantsToUser(guildId, season.season_id, nextDiscordUserId, nextWalletAddress, prior);
          }
        }
      });
      txUpgrade();

      return {
        success: true,
        duplicate: false,
        upgraded: shouldUpgradeUnknown,
        linkedUserId: linkedUserId || null,
        seasonId: season.season_id,
        grants: shouldUpgradeUnknown ? grants : existingGrants,
        message: shouldUpgradeUnknown ? 'Duplicate tx upgraded from unknown mint type' : 'Linked existing tx to wallet owner',
      };
    }

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
            classificationReason,
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
    const wallet = this.normalizeSolanaAddress(walletAddress);
    const uid = String(discordUserId || '').trim();
    if (!gid || !wallet || !uid) return { success: false, message: 'Invalid inputs' };
    const season = this.getActiveSeason(gid);
    if (!season) return { success: false, message: 'No active season' };

    const candidateRows = db.prepare(`
      SELECT *
      FROM vault_mint_events
      WHERE guild_id = ?
        AND season_id = ?
        AND (discord_user_id IS NULL OR discord_user_id = '')
    `).all(gid, season.season_id);
    const pendingRows = candidateRows.filter(row => this.normalizeSolanaAddress(row.wallet_address) === wallet);

    if (!pendingRows.length) {
      return { success: true, seasonId: season.season_id, processed: 0 };
    }

    const tx = db.transaction(() => {
      for (const row of pendingRows) {
        const grants = {
          paid_mints: String(row.mint_type || '').toLowerCase() === 'paid' ? 1 : 0,
          free_mints: String(row.mint_type || '').toLowerCase() === 'free' ? 1 : 0,
          keys_granted: clampInt(row.keys_granted, 0, 0),
          key_tier_grants: { default: clampInt(row.keys_granted, 0, 0) },
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

  async backfillAllMissingMintTransfersForActiveSeason(guildId, options = {}) {
    const gid = normalizeGuildId(guildId);
    if (!gid) return { success: false, message: 'Invalid guildId' };

    const season = this.getActiveSeason(gid);
    if (!season) return { success: false, message: 'No active season' };

    const config = this.getConfig(gid);
    const paymentWallets = [...this.getConfiguredPaymentWalletSet(config)];
    if (!paymentWallets.length) {
      return { success: false, message: 'No mint payment wallet configured in Vault settings' };
    }

    const mintSource = config?.mintSource || {};
    const minLamports = clampInt(mintSource.paymentMinLamports, 0, 1);
    const maxSignaturesPerWallet = Math.max(1, Math.min(50000, clampInt(options?.limitPerWallet, 1, 5000)));
    const dryRun = options?.dryRun === true || String(options?.dryRun || '').trim().toLowerCase() === 'true';
    const delayMs = Math.max(0, Math.min(5000, Number(options?.delayMs ?? 250) || 0));
    const maxRuntimeMs = Math.max(10_000, Math.min(30 * 60 * 1000, Number(options?.maxRuntimeMs ?? (10 * 60 * 1000)) || (10 * 60 * 1000)));
    const rpcRetryMax = Math.max(0, Math.min(5, Number(options?.rpcRetryMax ?? 2) || 0));
    const startTs = Date.now();
    const connection = this.getRpcConnection();

    const summary = {
      success: true,
      seasonId: season.season_id,
      paymentWallets,
      minLamports,
      maxSignaturesPerWallet,
      scannedSignatures: 0,
      matchedTransfers: 0,
      ingested: 0,
      dryRun,
      duplicates: 0,
      failed: 0,
      timedOut: false,
      errors: [],
    };

    for (const walletAddress of paymentWallets) {
      try {
        const walletPubkey = new PublicKey(walletAddress);
        let beforeSignature = null;
        let remaining = maxSignaturesPerWallet;

        while (remaining > 0) {
          if ((Date.now() - startTs) > maxRuntimeMs) {
            summary.timedOut = true;
            break;
          }
          const fetchLimit = Math.min(1000, remaining);
          let signatureRows = [];
          let fetchErr = null;
          for (let attempt = 0; attempt <= rpcRetryMax; attempt += 1) {
            try {
              signatureRows = await connection.getSignaturesForAddress(walletPubkey, {
                limit: fetchLimit,
                before: beforeSignature || undefined,
              });
              fetchErr = null;
              break;
            } catch (error) {
              fetchErr = error;
              if (attempt < rpcRetryMax) await sleep(delayMs * Math.max(1, attempt + 1));
            }
          }
          if (fetchErr) throw fetchErr;
          const signatures = (signatureRows || [])
            .map(row => String(row?.signature || '').trim())
            .filter(Boolean);
          if (!signatures.length) break;

          summary.scannedSignatures += signatures.length;
          remaining -= signatures.length;
          beforeSignature = signatures[signatures.length - 1] || null;

          let parsedTransactions = [];
          let parseErr = null;
          try {
            // Chunk signatures into batches of 100 to avoid RPC limits
            const CHUNK_SIZE = 100;
            for (let c = 0; c < signatures.length; c += CHUNK_SIZE) {
              const chunk = signatures.slice(c, c + CHUNK_SIZE);
              let chunkParsed = null;
              let chunkErr = null;
              for (let attempt = 0; attempt <= rpcRetryMax; attempt += 1) {
                try {
                  chunkParsed = await connection.getParsedTransactions(chunk, { maxSupportedTransactionVersion: 0 });
                  chunkErr = null;
                  break;
                } catch (error) {
                  chunkErr = error;
                  if (attempt < rpcRetryMax) await sleep(delayMs * Math.max(1, attempt + 1));
                }
              }
              if (chunkErr) throw chunkErr;
              parsedTransactions.push(...(chunkParsed || []));
              if (delayMs > 0 && c + CHUNK_SIZE < signatures.length) await sleep(delayMs);
            }
          } catch (error) {
            parseErr = error;
          }

          if (parseErr) throw parseErr;
          for (let i = 0; i < signatures.length; i += 1) {
            const signature = signatures[i];
            const tx = parsedTransactions?.[i] || null;
            if (!signature || !tx) continue;

            const exists = db.prepare(`
              SELECT id
              FROM vault_mint_events
              WHERE guild_id = ? AND tx_signature = ?
              LIMIT 1
            `).get(gid, signature);
            if (exists) {
              summary.duplicates += 1;
              continue;
            }

            const nativeTransfers = this.extractNativeTransfersFromParsedTransaction(tx);
            const matchingTransfers = nativeTransfers.filter((transfer) => {
              const destination = String(transfer?.toUserAccount || transfer?.to || '').trim();
              const lamports = Number(transfer?.amount || transfer?.lamports || 0);
              return destination === walletAddress && Number.isFinite(lamports) && lamports >= minLamports;
            });
            if (!matchingTransfers.length) continue;
            summary.matchedTransfers += 1;

            matchingTransfers.sort((a, b) => Number(b?.amount || 0) - Number(a?.amount || 0));
            const payerWallet = String(matchingTransfers[0]?.fromUserAccount || '').trim() || null;

            const ingestResult = dryRun
              ? { success: true, duplicate: false }
              : this.ingestMintEvent({
                  guildId: gid,
                  seasonId: season.season_id,
                  txSignature: signature,
                  walletAddress: payerWallet,
                  mintType: 'paid',
                  type: 'TRANSFER',
                  source: 'vault_backfill_transfer',
                  paymentWalletAddress: walletAddress,
                  nativeTransfers: matchingTransfers,
                });

            if (ingestResult?.success) {
              if (ingestResult?.duplicate) summary.duplicates += 1;
              else summary.ingested += 1;
            } else {
              summary.failed += 1;
            }
          }

          if (signatures.length < fetchLimit) break;
          if (delayMs > 0) await sleep(delayMs);
        }
      } catch (error) {
        summary.errors.push({
          walletAddress,
          message: String(error?.message || error),
        });
        summary.failed += 1;
      }
      if (summary.timedOut) break;
    }

    return summary;
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
