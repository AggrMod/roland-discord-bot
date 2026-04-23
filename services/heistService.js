const { randomUUID } = require('crypto');
const db = require('../database/db');
const logger = require('../utils/logger');
const tenantService = require('./tenantService');
const entitlementService = require('./entitlementService');
const walletService = require('./walletService');
const nftService = require('./nftService');
const tokenService = require('./tokenService');
const treasuryService = require('./treasuryService');
const trackedWalletsService = require('./trackedWalletsService');
const roleService = require('./roleService');
const { getModuleDisplayName } = require('./moduleLabelService');

const DEFAULT_CONFIG = Object.freeze({
  enabled: 1,
  module_display_name: 'Missions',
  xp_label: 'XP',
  streetcredit_label: 'Streetcredit',
  task_label: 'Jobs',
  mission_feed_channel_id: null,
  mission_log_channel_id: null,
  vault_log_channel_id: null,
  panel_channel_id: null,
  panel_message_id: null,
  mission_spawn_enabled: 1,
  spawn_interval_minutes: 180,
  max_active_missions: 5,
  default_duration_minutes: 24 * 60,
  default_max_nfts_per_user: 2,
  random_seed: null,
  metadata_json: '{}',
});

const DEFAULT_LADDER = Object.freeze([
  { rank_key: 'associate', rank_name: 'Associate', min_xp: 0, vault_tier: 0, sort_order: 1 },
  { rank_key: 'soldier', rank_name: 'Soldier', min_xp: 100, vault_tier: 1, sort_order: 2 },
  { rank_key: 'capo', rank_name: 'Capo', min_xp: 300, vault_tier: 2, sort_order: 3 },
  { rank_key: 'underboss', rank_name: 'Underboss', min_xp: 700, vault_tier: 3, sort_order: 4 },
  { rank_key: 'don', rank_name: 'Don', min_xp: 1400, vault_tier: 4, sort_order: 5 },
]);

const ALLOWED_MISSION_STATUSES = new Set(['recruiting', 'active', 'completed', 'failed', 'cancelled']);
const ACTIVE_STATUSES = Object.freeze(['recruiting', 'active']);
const RESOLVABLE_STATUSES = Object.freeze(['recruiting', 'active']);
const SUPPORTED_METRICS = new Set(['xp', 'streetcredit', 'speed']);
const SUPPORTED_MISSION_TYPES = new Set(['nft', 'engagement', 'discord', 'governance', 'event']);
const MISSION_TYPE_DEFINITIONS = Object.freeze([
  { key: 'nft', label: 'NFT Ops', description: 'NFT/trait gated missions with locked assets', requiresModule: null },
  { key: 'engagement', label: 'Engagement Ops', description: 'Social or engagement-linked objectives', requiresModule: 'engagement' },
  { key: 'discord', label: 'Discord Ops', description: 'Server-native activity missions', requiresModule: null },
  { key: 'governance', label: 'Governance Ops', description: 'Proposal and voting related missions', requiresModule: 'governance' },
  { key: 'event', label: 'Event Ops', description: 'Special event or seasonal missions', requiresModule: null },
]);
const MAX_TEMPLATE_NAME = 120;
const MAX_TEMPLATE_DESC = 2000;
const HEIST_TRAIT_CATALOG_CACHE_TTL_MS = Math.max(60, Number(process.env.HEIST_TRAIT_CATALOG_CACHE_TTL_SEC || 600)) * 1000;
const heistTraitCatalogCache = new Map();

function normalizeGuildId(guildId) {
  const normalized = String(guildId || '').trim();
  return /^\d{17,20}$/.test(normalized) ? normalized : '';
}

function normalizeUserId(userId) {
  return String(userId || '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function toIsoOffsetFromNow(minutes) {
  const ms = Math.max(1, Number(minutes || 1)) * 60 * 1000;
  return new Date(Date.now() + ms).toISOString();
}

function safeJsonParse(value, fallback) {
  try {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function safeJsonStringify(value, fallback = '{}') {
  try {
    return JSON.stringify(value ?? {});
  } catch (_error) {
    return fallback;
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function sanitizeImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('data:image/')) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  return null;
}

function normalizeGateMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'or' ? 'or' : 'and';
}

function normalizeTraitRequirements(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const requiredTraitsRaw = Array.isArray(source.requiredTraits)
    ? source.requiredTraits
    : (Array.isArray(source.required_traits) ? source.required_traits : []);
  const requiredTraits = requiredTraitsRaw
    .map((entry) => {
      const traitType = String(entry?.traitType || entry?.trait_type || '').trim().slice(0, 64);
      if (!traitType) return null;
      const values = Array.isArray(entry?.values)
        ? entry.values.map((item) => String(item || '').trim().slice(0, 128)).filter(Boolean)
        : [];
      return { traitType, values };
    })
    .filter(Boolean);
  const requiredCollectionsRaw = Array.isArray(source.requiredCollections)
    ? source.requiredCollections
    : (Array.isArray(source.required_collections) ? source.required_collections : []);
  const requiredCollections = requiredCollectionsRaw
    .map((value) => String(value || '').trim().slice(0, 128))
    .filter(Boolean);
  const gateMode = normalizeGateMode(source.gateMode || source.gate_mode);

  return {
    requiredTraits,
    requiredCollections,
    gateMode,
  };
}

function sanitizeCollectionId(value) {
  return String(value || '').trim().slice(0, 128);
}

function normalizeMissionCollections(raw) {
  if (!Array.isArray(raw)) return [];
  const unique = new Set();
  const list = [];
  for (const entry of raw) {
    const collectionId = sanitizeCollectionId(
      typeof entry === 'string'
        ? entry
        : (entry?.collectionId || entry?.collection_id || entry?.id || '')
    );
    if (!collectionId) continue;
    const key = collectionId.toLowerCase();
    if (unique.has(key)) continue;
    unique.add(key);
    list.push({
      collectionId,
      label: String(entry?.label || entry?.name || '').trim().slice(0, 120) || null,
      source: String(entry?.source || '').trim().toLowerCase() || 'manual',
    });
  }
  return list;
}

function resolveTreasurySourceWalletAddressFromMetadata(metadata) {
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  const value = String(
    source.treasury_source_wallet_address
    || source.treasurySourceWalletAddress
    || ''
  ).trim();
  return value || null;
}

function normalizeSlotRequirement(raw = {}, index = 1) {
  const slotIndexRaw = Number(raw.slotIndex ?? raw.slot_index ?? index);
  const slotIndex = Number.isFinite(slotIndexRaw) && slotIndexRaw > 0 ? Math.floor(slotIndexRaw) : index;
  const traitRequirements = normalizeTraitRequirements(raw);
  const label = String(raw.label || '').trim().slice(0, 80) || null;
  return {
    slotIndex,
    label,
    gateMode: traitRequirements.gateMode,
    requiredCollections: traitRequirements.requiredCollections,
    requiredTraits: traitRequirements.requiredTraits,
  };
}

function normalizeSlotRequirements(raw, totalSlots = 1) {
  const size = Math.max(1, Math.min(100, Number(totalSlots || 1)));
  const source = Array.isArray(raw) ? raw : [];
  const byIndex = new Map();
  for (const entry of source) {
    const normalized = normalizeSlotRequirement(entry, 1);
    if (!normalized || !normalized.slotIndex) continue;
    if (normalized.slotIndex > size) continue;
    byIndex.set(normalized.slotIndex, normalized);
  }
  const result = [];
  for (let index = 1; index <= size; index += 1) {
    result.push(byIndex.get(index) || normalizeSlotRequirement({ slotIndex: index }, index));
  }
  return result;
}

function inListPlaceholders(length) {
  return Array.from({ length }, () => '?').join(', ');
}

function hasBrandingEnabledForGuild(guildId) {
  if (!guildId) return false;
  try {
    const context = tenantService.getTenantContext(guildId);
    return !!context?.modules?.branding;
  } catch (_error) {
    return false;
  }
}

function sanitizeTemplatePayload(payload = {}) {
  const name = String(payload.name || '').trim().slice(0, MAX_TEMPLATE_NAME);
  const description = String(payload.description || '').trim().slice(0, MAX_TEMPLATE_DESC);
  const missionTypeRaw = String(payload.missionType || payload.mission_type || 'nft').trim().toLowerCase() || 'nft';
  const missionType = SUPPORTED_MISSION_TYPES.has(missionTypeRaw) ? missionTypeRaw : 'nft';
  const modeRaw = String(payload.mode || 'solo').trim().toLowerCase();
  const mode = modeRaw === 'coop' || modeRaw === 'co-op' ? 'coop' : 'solo';
  const requiredSlots = Math.max(1, parsePositiveInt(payload.requiredSlots ?? payload.required_slots, 1));
  const totalSlots = Math.max(requiredSlots, parsePositiveInt(payload.totalSlots ?? payload.total_slots, mode === 'coop' ? 4 : 1));
  const maxNftsPerUser = Math.max(1, Math.min(10, parsePositiveInt(payload.maxNftsPerUser ?? payload.max_nfts_per_user, 2)));
  const durationMinutes = Math.max(15, Math.min(7 * 24 * 60, parsePositiveInt(payload.durationMinutes ?? payload.duration_minutes, 24 * 60)));
  const baseXpReward = Math.max(1, parsePositiveInt(payload.baseXpReward ?? payload.base_xp_reward, 25));
  const baseStreetcreditReward = Math.max(1, parsePositiveInt(payload.baseStreetcreditReward ?? payload.base_streetcredit_reward, 25));
  const spawnWeight = Math.max(1, Math.min(1000, parsePositiveInt(payload.spawnWeight ?? payload.spawn_weight, 1)));
  const cooldownMinutes = Math.max(0, Math.min(7 * 24 * 60, parseNonNegativeInt(payload.cooldownMinutes ?? payload.cooldown_minutes, 0)));
  const enabled = payload.enabled === undefined ? 1 : (payload.enabled ? 1 : 0);
  const objective = Array.isArray(payload.objective) ? payload.objective : safeJsonParse(payload.objective_json, []);
  const traitRequirementsRaw = typeof payload.traitRequirements === 'object' && payload.traitRequirements !== null
    ? payload.traitRequirements
    : (
      (typeof payload.trait_requirements === 'object' && payload.trait_requirements !== null)
        ? payload.trait_requirements
        : safeJsonParse(payload.trait_requirements_json, {})
    );
  const traitRequirements = normalizeTraitRequirements(traitRequirementsRaw);
  const rewardRules = typeof payload.rewardRules === 'object' && payload.rewardRules !== null
    ? payload.rewardRules
    : safeJsonParse(payload.reward_rules_json, {});
  const activeWindow = typeof payload.activeWindow === 'object' && payload.activeWindow !== null
    ? payload.activeWindow
    : safeJsonParse(payload.active_window_json, {});
  const metadataRaw = typeof payload.metadata === 'object' && payload.metadata !== null
    ? payload.metadata
    : safeJsonParse(payload.metadata_json, {});
  const slotRequirementsRaw = Array.isArray(payload.slot_requirements)
    ? payload.slot_requirements
    : (Array.isArray(payload.slotRequirements)
      ? payload.slotRequirements
      : (Array.isArray(metadataRaw?.slot_requirements) ? metadataRaw.slot_requirements : []));
  const slotRequirements = normalizeSlotRequirements(slotRequirementsRaw, totalSlots);
  const imageUrl = sanitizeImageUrl(
    payload.image_url
      ?? payload.imageUrl
      ?? metadataRaw?.image_url
      ?? metadataRaw?.imageUrl
  );
  const metadata = {
    ...(metadataRaw && typeof metadataRaw === 'object' ? metadataRaw : {}),
    slot_requirements: slotRequirements,
  };
  if (imageUrl) {
    metadata.image_url = imageUrl;
  } else {
    delete metadata.image_url;
    delete metadata.imageUrl;
  }

  return {
    name,
    description,
    missionType,
    mode,
    requiredSlots,
    totalSlots,
    maxNftsPerUser,
    durationMinutes,
    baseXpReward,
    baseStreetcreditReward,
    objective,
    traitRequirements,
    slotRequirements,
    rewardRules,
    activeWindow,
    spawnWeight,
    cooldownMinutes,
    enabled,
    imageUrl,
    metadata,
  };
}

function sanitizeMissionStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!ALLOWED_MISSION_STATUSES.has(normalized)) return 'recruiting';
  return normalized;
}

function toDiscordTimestamp(value) {
  const ms = new Date(value || '').getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

class HeistService {
  _selectLifecycleChannelId(config, eventType) {
    const key = String(eventType || '').trim().toLowerCase();
    if (key === 'spawned' || key === 'started') {
      return String(config?.mission_feed_channel_id || config?.mission_log_channel_id || '').trim() || null;
    }
    return String(config?.mission_log_channel_id || config?.mission_feed_channel_id || '').trim() || null;
  }

  async _postLifecycleUpdate(guildId, eventType, mission, payload = {}) {
    try {
      if (!guildId || !mission) return false;
      const clientProvider = require('../utils/clientProvider');
      const { EmbedBuilder } = require('discord.js');
      const client = clientProvider.getClient();
      if (!client) return false;

      const config = this.getConfig(guildId);
      const channelId = this._selectLifecycleChannelId(config, eventType);
      if (!channelId) return false;

      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return false;

      const status = String(mission.status || '').toLowerCase();
      const title = String(mission.title || 'Mission');
      const moduleName = getModuleDisplayName('heist', guildId);

      const lifecycleMeta = {
        spawned: { color: '#f4c430', title: `${moduleName}: Mission Spawned` },
        started: { color: '#2c8f6c', title: `${moduleName}: Mission Started` },
        completed: { color: '#2c8f6c', title: `${moduleName}: Mission Completed` },
        failed: { color: '#b73a3a', title: `${moduleName}: Mission Failed` },
        cancelled: { color: '#7d8590', title: `${moduleName}: Mission Cancelled` },
      };
      const key = lifecycleMeta[eventType] ? eventType : (lifecycleMeta[status] ? status : 'spawned');
      const style = lifecycleMeta[key] || lifecycleMeta.spawned;

      const embed = new EmbedBuilder()
        .setColor(style.color)
        .setTitle(style.title)
        .setDescription(`**${title}**`)
        .addFields(
          { name: 'Mission ID', value: String(mission.mission_id || mission.missionId || '?'), inline: true },
          { name: 'Status', value: String(mission.status || 'recruiting'), inline: true },
          { name: 'Mode', value: String(mission.mode || 'solo'), inline: true },
          { name: 'Slots', value: `${Number(mission.filled_slots || mission.filledSlots || 0)}/${Number(mission.total_slots || mission.totalSlots || 0)}`, inline: true },
          { name: 'XP Reward', value: String(Number(mission.base_xp_reward || mission.baseXpReward || 0)), inline: true },
          { name: 'Streetcredit', value: String(Number(mission.base_streetcredit_reward || mission.baseStreetcreditReward || 0)), inline: true },
        )
        .setTimestamp();

      const endsAt = mission.ends_at || mission.endsAt || null;
      const endsAtText = toDiscordTimestamp(endsAt);
      if (endsAtText) {
        embed.addFields({ name: 'Ends', value: endsAtText, inline: false });
      }

      if (payload && typeof payload === 'object') {
        const summary = [];
        if (Number.isFinite(Number(payload.successSlots))) summary.push(`success slots: ${Number(payload.successSlots)}`);
        if (Number.isFinite(Number(payload.failedSlots))) summary.push(`failed slots: ${Number(payload.failedSlots)}`);
        if (summary.length > 0) {
          embed.addFields({ name: 'Outcome', value: summary.join(' | '), inline: false });
        }
      }

      const imageUrl = sanitizeImageUrl(
        mission?.image_url
        || mission?.metadata?.image_url
        || mission?.metadata?.imageUrl
      );
      if (imageUrl) {
        embed.setThumbnail(imageUrl);
      }

      await channel.send({ embeds: [embed] });
      return true;
    } catch (error) {
      logger.warn(`[heist] lifecycle post failed (${eventType}): ${error?.message || error}`);
      return false;
    }
  }

  _scheduleLifecycleUpdate(guildId, eventType, mission, payload = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId || !mission) return;
    const missionRecord = typeof mission === 'string'
      ? this.getMission(normalizedGuildId, mission, { includeSlots: false })
      : mission;
    if (!missionRecord) return;
    this._postLifecycleUpdate(normalizedGuildId, eventType, missionRecord, payload).catch(() => {});
  }

  ensureGuildScaffold(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return false;

    db.prepare(`
      INSERT OR IGNORE INTO heist_config (
        guild_id,
        enabled,
        module_display_name,
        xp_label,
        streetcredit_label,
        task_label,
        mission_spawn_enabled,
        spawn_interval_minutes,
        max_active_missions,
        default_duration_minutes,
        default_max_nfts_per_user,
        random_seed,
        metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizedGuildId,
      DEFAULT_CONFIG.enabled,
      DEFAULT_CONFIG.module_display_name,
      DEFAULT_CONFIG.xp_label,
      DEFAULT_CONFIG.streetcredit_label,
      DEFAULT_CONFIG.task_label,
      DEFAULT_CONFIG.mission_spawn_enabled,
      DEFAULT_CONFIG.spawn_interval_minutes,
      DEFAULT_CONFIG.max_active_missions,
      DEFAULT_CONFIG.default_duration_minutes,
      DEFAULT_CONFIG.default_max_nfts_per_user,
      DEFAULT_CONFIG.random_seed,
      DEFAULT_CONFIG.metadata_json
    );

    const ladderCount = Number(
      db.prepare('SELECT COUNT(*) AS count FROM heist_ladder WHERE guild_id = ?').get(normalizedGuildId)?.count || 0
    );
    if (ladderCount === 0) {
      const insert = db.prepare(`
        INSERT INTO heist_ladder (guild_id, rank_key, rank_name, min_xp, vault_tier, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const entry of DEFAULT_LADDER) {
        insert.run(
          normalizedGuildId,
          entry.rank_key,
          entry.rank_name,
          entry.min_xp,
          entry.vault_tier,
          entry.sort_order
        );
      }
    }

    return true;
  }

  getConfig(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return null;
    this.ensureGuildScaffold(normalizedGuildId);
    const row = db.prepare('SELECT * FROM heist_config WHERE guild_id = ?').get(normalizedGuildId);
    if (!row) return null;
    const metadata = safeJsonParse(row.metadata_json, {});
    const moduleDisplayName = hasBrandingEnabledForGuild(normalizedGuildId)
      ? getModuleDisplayName('heist', normalizedGuildId)
      : (String(row.module_display_name || '').trim() || 'Missions');
    const treasurySourceWalletAddress = resolveTreasurySourceWalletAddressFromMetadata(metadata);
    return {
      ...row,
      metadata,
      treasury_source_wallet_address: treasurySourceWalletAddress,
      treasurySourceWalletAddress,
      moduleDisplayName,
    };
  }

  updateConfig(guildId, patch = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    this.ensureGuildScaffold(normalizedGuildId);
    const current = this.getConfig(normalizedGuildId);

    let nextMetadata = current?.metadata && typeof current.metadata === 'object'
      ? { ...current.metadata }
      : {};

    if (patch.metadata && typeof patch.metadata === 'object') {
      nextMetadata = {
        ...nextMetadata,
        ...patch.metadata,
      };
    }

    if (patch.treasury_source_wallet_address !== undefined || patch.treasurySourceWalletAddress !== undefined) {
      const rawWalletAddress = String(
        patch.treasury_source_wallet_address ?? patch.treasurySourceWalletAddress ?? ''
      ).trim();
      if (rawWalletAddress) {
        if (!treasuryService.isValidSolanaAddress(rawWalletAddress)) {
          return { success: false, message: 'Invalid treasury source wallet address' };
        }
        const availableWallets = this.listTreasurySourceWallets(normalizedGuildId, { includeDisabled: true });
        const walletExists = availableWallets.some((wallet) => String(wallet?.address || '').trim() === rawWalletAddress);
        if (!walletExists) {
          return { success: false, message: 'Selected treasury source wallet was not found for this server' };
        }
      }
      nextMetadata.treasury_source_wallet_address = rawWalletAddress || null;
    }

    const next = {
      enabled: patch.enabled === undefined ? Number(current.enabled || 1) : (patch.enabled ? 1 : 0),
      module_display_name: String((patch.module_display_name ?? patch.moduleDisplayName ?? current.module_display_name ?? 'Missions')).trim().slice(0, 80) || 'Missions',
      xp_label: String((patch.xp_label ?? patch.xpLabel ?? current.xp_label ?? 'XP')).trim().slice(0, 30) || 'XP',
      streetcredit_label: String((patch.streetcredit_label ?? patch.streetcreditLabel ?? current.streetcredit_label ?? 'Streetcredit')).trim().slice(0, 40) || 'Streetcredit',
      task_label: String((patch.task_label ?? patch.taskLabel ?? current.task_label ?? 'Jobs')).trim().slice(0, 40) || 'Jobs',
      mission_feed_channel_id: String((patch.mission_feed_channel_id ?? patch.missionFeedChannelId ?? current.mission_feed_channel_id ?? '')).trim() || null,
      mission_log_channel_id: String((patch.mission_log_channel_id ?? patch.missionLogChannelId ?? current.mission_log_channel_id ?? '')).trim() || null,
      vault_log_channel_id: String((patch.vault_log_channel_id ?? patch.vaultLogChannelId ?? current.vault_log_channel_id ?? '')).trim() || null,
      panel_channel_id: String((patch.panel_channel_id ?? patch.panelChannelId ?? current.panel_channel_id ?? '')).trim() || null,
      panel_message_id: String((patch.panel_message_id ?? patch.panelMessageId ?? current.panel_message_id ?? '')).trim() || null,
      mission_spawn_enabled: patch.mission_spawn_enabled === undefined
        ? Number(current.mission_spawn_enabled || 1)
        : (patch.mission_spawn_enabled ? 1 : 0),
      spawn_interval_minutes: Math.max(15, Math.min(7 * 24 * 60, parsePositiveInt(
        patch.spawn_interval_minutes ?? patch.spawnIntervalMinutes,
        Number(current.spawn_interval_minutes || DEFAULT_CONFIG.spawn_interval_minutes)
      ))),
      max_active_missions: Math.max(1, Math.min(1000, parsePositiveInt(
        patch.max_active_missions ?? patch.maxActiveMissions,
        Number(current.max_active_missions || DEFAULT_CONFIG.max_active_missions)
      ))),
      default_duration_minutes: Math.max(15, Math.min(7 * 24 * 60, parsePositiveInt(
        patch.default_duration_minutes ?? patch.defaultDurationMinutes,
        Number(current.default_duration_minutes || DEFAULT_CONFIG.default_duration_minutes)
      ))),
      default_max_nfts_per_user: Math.max(1, Math.min(10, parsePositiveInt(
        patch.default_max_nfts_per_user ?? patch.defaultMaxNftsPerUser,
        Number(current.default_max_nfts_per_user || DEFAULT_CONFIG.default_max_nfts_per_user)
      ))),
      random_seed: String((patch.random_seed ?? patch.randomSeed ?? current.random_seed ?? '')).trim() || current.random_seed || randomUUID(),
      metadata_json: safeJsonStringify(nextMetadata),
    };

    db.prepare(`
      UPDATE heist_config
      SET
        enabled = ?,
        module_display_name = ?,
        xp_label = ?,
        streetcredit_label = ?,
        task_label = ?,
        mission_feed_channel_id = ?,
        mission_log_channel_id = ?,
        vault_log_channel_id = ?,
        panel_channel_id = ?,
        panel_message_id = ?,
        mission_spawn_enabled = ?,
        spawn_interval_minutes = ?,
        max_active_missions = ?,
        default_duration_minutes = ?,
        default_max_nfts_per_user = ?,
        random_seed = ?,
        metadata_json = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ?
    `).run(
      next.enabled,
      next.module_display_name,
      next.xp_label,
      next.streetcredit_label,
      next.task_label,
      next.mission_feed_channel_id,
      next.mission_log_channel_id,
      next.vault_log_channel_id,
      next.panel_channel_id,
      next.panel_message_id,
      next.mission_spawn_enabled,
      next.spawn_interval_minutes,
      next.max_active_missions,
      next.default_duration_minutes,
      next.default_max_nfts_per_user,
      next.random_seed,
      next.metadata_json,
      normalizedGuildId
    );

    return { success: true, config: this.getConfig(normalizedGuildId) };
  }

  _listTreasurySourceWalletRows(guildId, { includeDisabled = true } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return [];
    const unique = new Map();
    const add = (walletAddress, label, enabled, source, id, createdAt) => {
      const address = String(walletAddress || '').trim();
      if (!address) return;
      const key = address.toLowerCase();
      const entry = unique.get(key);
      if (!entry) {
        unique.set(key, {
          id: Number(id || 0),
          address,
          label: String(label || '').trim() || null,
          enabled: !!enabled,
          sources: [source],
          created_at: createdAt || null,
        });
        return;
      }
      entry.enabled = entry.enabled || !!enabled;
      if (!entry.label && label) entry.label = String(label || '').trim() || null;
      if (!entry.sources.includes(source)) entry.sources.push(source);
      if (!entry.id && id) entry.id = Number(id || 0);
      if (!entry.created_at && createdAt) entry.created_at = createdAt;
    };

    const trackedWallets = trackedWalletsService.getTrackedWallets(normalizedGuildId);
    for (const wallet of (Array.isArray(trackedWallets) ? trackedWallets : [])) {
      add(
        wallet?.wallet_address,
        wallet?.label,
        Number(wallet?.enabled || 0) === 1,
        'wallet_tracker',
        wallet?.id,
        wallet?.created_at
      );
    }

    const treasuryWallets = treasuryService.listWallets(normalizedGuildId);
    for (const wallet of (Array.isArray(treasuryWallets) ? treasuryWallets : [])) {
      add(
        wallet?.address,
        wallet?.label,
        Number(wallet?.enabled ?? 1) === 1,
        'treasury',
        wallet?.id,
        wallet?.created_at
      );
    }

    // Legacy/global treasury config wallet (wallet tracker main wallet).
    // Keep this as a fallback source so missions can scan treasury inventory
    // even when guild-scoped tracked wallets were not added yet.
    try {
      const treasuryConfig = treasuryService.getConfig?.();
      const legacyWallet = String(treasuryConfig?.solana_wallet || '').trim();
      if (legacyWallet) {
        add(
          legacyWallet,
          'Primary Treasury Wallet',
          Number(treasuryConfig?.enabled ?? 1) === 1,
          'treasury_config',
          0,
          treasuryConfig?.updated_at || treasuryConfig?.created_at || null
        );
      }
    } catch (error) {
      logger.warn(`[heist] failed to read treasury config wallet for source list: ${error?.message || error}`);
    }

    return Array.from(unique.values())
      .filter((wallet) => includeDisabled ? true : wallet.enabled)
      .sort((a, b) => String(a.label || a.address).localeCompare(String(b.label || b.address), undefined, { sensitivity: 'base' }));
  }

  listTreasurySourceWallets(guildId, { includeDisabled = true } = {}) {
    return this._listTreasurySourceWalletRows(guildId, { includeDisabled }).map((wallet) => ({
      id: Number(wallet?.id || 0),
      address: String(wallet?.address || '').trim(),
      label: String(wallet?.label || '').trim() || null,
      enabled: !!wallet?.enabled,
      source: Array.isArray(wallet?.sources) ? wallet.sources.join(',') : String(wallet?.sources || ''),
      created_at: wallet?.created_at || null,
    }));
  }

  _resolveVerificationCollections(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return [];
    const unique = new Map();
    const push = (collectionId, source = 'verification') => {
      const normalized = sanitizeCollectionId(collectionId);
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (unique.has(key)) return;
      unique.set(key, {
        collectionId: normalized,
        source,
      });
    };

    try {
      const tiers = roleService.getEffectiveTiers(normalizedGuildId) || [];
      for (const tier of tiers) {
        push(tier?.collectionId || tier?.collection_id);
      }
      const traitRoles = roleService.getEffectiveTraitRoles(normalizedGuildId) || [];
      for (const traitRole of traitRoles) {
        push(traitRole?.collectionId || traitRole?.collection_id);
      }
    } catch (error) {
      logger.warn(`[heist] failed to resolve verification collections for ${normalizedGuildId}: ${error?.message || error}`);
    }

    return Array.from(unique.values());
  }

  listMissionCategories(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    return MISSION_TYPE_DEFINITIONS.map((entry) => {
      const requiresModule = String(entry.requiresModule || '').trim() || null;
      const enabled = !requiresModule
        ? true
        : !normalizedGuildId
          ? false
          : tenantService.isModuleEnabled(normalizedGuildId, requiresModule);
      return {
        key: entry.key,
        label: entry.label,
        description: entry.description,
        requiresModule,
        enabled,
      };
    });
  }

  listMissionCollections(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return [];
    const config = this.getConfig(normalizedGuildId) || { metadata: {} };
    const metadata = config.metadata && typeof config.metadata === 'object' ? config.metadata : {};
    const manual = normalizeMissionCollections(metadata.mission_collections || []);
    const verification = this._resolveVerificationCollections(normalizedGuildId);
    const unique = new Map();
    for (const entry of [...verification, ...manual]) {
      const key = String(entry.collectionId || '').trim().toLowerCase();
      if (!key) continue;
      if (!unique.has(key)) unique.set(key, { ...entry });
      else if (entry.source === 'manual') unique.get(key).source = 'manual';
    }

    const collectionList = Array.from(unique.values());
    if (!collectionList.length) return [];
    const placeholders = collectionList.map(() => '?').join(', ');
    const nameRows = db.prepare(`
      SELECT LOWER(TRIM(collection_address)) AS key, MAX(collection_name) AS collection_name
      FROM nft_tracked_collections
      WHERE guild_id = ? AND LOWER(TRIM(collection_address)) IN (${placeholders})
      GROUP BY LOWER(TRIM(collection_address))
    `).all(normalizedGuildId, ...collectionList.map((entry) => String(entry.collectionId || '').trim().toLowerCase()));
    const nameByKey = new Map(nameRows.map((row) => [String(row.key || '').trim(), String(row.collection_name || '').trim() || null]));
    return collectionList.map((entry) => ({
      ...entry,
      label: entry.label || nameByKey.get(String(entry.collectionId || '').trim().toLowerCase()) || null,
    }));
  }

  setManualMissionCollections(guildId, collections = []) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    const config = this.getConfig(normalizedGuildId) || { metadata: {} };
    const metadata = config.metadata && typeof config.metadata === 'object' ? { ...config.metadata } : {};
    metadata.mission_collections = normalizeMissionCollections(collections).map((entry) => ({
      collectionId: entry.collectionId,
      label: entry.label || null,
      source: 'manual',
    }));
    return this.updateConfig(normalizedGuildId, { metadata });
  }

  async getCollectionTraitCatalog(guildId, collectionId, { limit = 250 } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedCollectionId = sanitizeCollectionId(collectionId);
    if (!normalizedGuildId || !normalizedCollectionId) {
      return { success: false, message: 'guildId and collectionId are required', traits: [] };
    }
    const cacheKey = `${normalizedGuildId}:${normalizedCollectionId.toLowerCase()}`;
    const cached = heistTraitCatalogCache.get(cacheKey);
    if (cached && (Date.now() - Number(cached.cachedAt || 0)) < HEIST_TRAIT_CATALOG_CACHE_TTL_MS) {
      return { success: true, ...cached.payload, cached: true };
    }

    try {
      const payload = await nftService.getCollectionTraitCatalog(normalizedCollectionId, {
        guildId: normalizedGuildId,
        limit,
      });
      const safePayload = payload && typeof payload === 'object' ? payload : { collectionId: normalizedCollectionId, traits: [], sampleCount: 0 };
      heistTraitCatalogCache.set(cacheKey, {
        cachedAt: Date.now(),
        payload: safePayload,
      });
      return { success: true, ...safePayload, cached: false };
    } catch (error) {
      logger.warn(`[heist] failed trait catalog fetch for ${normalizedCollectionId}: ${error?.message || error}`);
      return { success: false, message: 'Failed to fetch trait catalog', traits: [], sampleCount: 0, collectionId: normalizedCollectionId };
    }
  }

  getLadder(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return [];
    this.ensureGuildScaffold(normalizedGuildId);
    return db.prepare(`
      SELECT id, guild_id, rank_key, rank_name, min_xp, vault_tier, sort_order, created_at, updated_at
      FROM heist_ladder
      WHERE guild_id = ?
      ORDER BY min_xp ASC, sort_order ASC, id ASC
    `).all(normalizedGuildId);
  }

  setLadder(guildId, ladder = []) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    if (!Array.isArray(ladder) || ladder.length === 0) {
      return { success: false, message: 'ladder must contain at least one rank' };
    }

    const sanitized = ladder
      .map((entry, index) => ({
        rank_key: String(entry.rank_key || entry.rankKey || `rank_${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 48) || `rank_${index + 1}`,
        rank_name: String(entry.rank_name || entry.rankName || `Rank ${index + 1}`).trim().slice(0, 80) || `Rank ${index + 1}`,
        min_xp: Math.max(0, parseNonNegativeInt(entry.min_xp ?? entry.minXp, 0)),
        vault_tier: Math.max(0, Math.min(99, parseNonNegativeInt(entry.vault_tier ?? entry.vaultTier, 0))),
        sort_order: Number.isFinite(Number(entry.sort_order ?? entry.sortOrder))
          ? Number(entry.sort_order ?? entry.sortOrder)
          : (index + 1),
      }))
      .sort((a, b) => a.min_xp - b.min_xp || a.sort_order - b.sort_order);

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM heist_ladder WHERE guild_id = ?').run(normalizedGuildId);
      const insert = db.prepare(`
        INSERT INTO heist_ladder (guild_id, rank_key, rank_name, min_xp, vault_tier, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      sanitized.forEach((entry, index) => {
        insert.run(
          normalizedGuildId,
          entry.rank_key,
          entry.rank_name,
          entry.min_xp,
          entry.vault_tier,
          Number.isFinite(entry.sort_order) ? entry.sort_order : (index + 1)
        );
      });
    });

    try {
      tx();
      return { success: true, ladder: this.getLadder(normalizedGuildId) };
    } catch (error) {
      logger.error('[heist] setLadder error:', error);
      return { success: false, message: 'Failed to save ladder' };
    }
  }

  resolveRankForXp(guildId, xp) {
    const ladder = this.getLadder(guildId);
    const normalizedXp = Math.max(0, Number.parseInt(xp, 10) || 0);
    let chosen = ladder[0] || null;
    for (const entry of ladder) {
      if (normalizedXp >= Number(entry.min_xp || 0)) {
        chosen = entry;
      }
    }
    return chosen;
  }

  getProfile(guildId, userId, username = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedGuildId || !normalizedUserId) return null;
    this.ensureGuildScaffold(normalizedGuildId);

    let row = db.prepare('SELECT * FROM heist_profiles WHERE guild_id = ? AND user_id = ?').get(normalizedGuildId, normalizedUserId);
    if (!row) {
      const rank = this.resolveRankForXp(normalizedGuildId, 0);
      db.prepare(`
        INSERT INTO heist_profiles (
          guild_id, user_id, username, total_xp, total_streetcredit, rank_key, rank_name, vault_tier, missions_completed, missions_failed, metadata_json
        ) VALUES (?, ?, ?, 0, 0, ?, ?, ?, 0, 0, '{}')
      `).run(
        normalizedGuildId,
        normalizedUserId,
        String(username || '').trim() || null,
        rank?.rank_key || null,
        rank?.rank_name || null,
        Number(rank?.vault_tier || 0)
      );
      row = db.prepare('SELECT * FROM heist_profiles WHERE guild_id = ? AND user_id = ?').get(normalizedGuildId, normalizedUserId);
    }
    if (!row) return null;
    return {
      ...row,
      metadata: safeJsonParse(row.metadata_json, {}),
    };
  }

  _applyProfileRewards(_tx, guildId, userId, username, deltaXp, deltaStreetcredit, { missionSucceeded = null } = {}) {
    const profile = db.prepare('SELECT * FROM heist_profiles WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
    let current = profile;
    if (!current) {
      const rank = this.resolveRankForXp(guildId, 0);
      db.prepare(`
        INSERT INTO heist_profiles (
          guild_id, user_id, username, total_xp, total_streetcredit, rank_key, rank_name, vault_tier, missions_completed, missions_failed, metadata_json
        ) VALUES (?, ?, ?, 0, 0, ?, ?, ?, 0, 0, '{}')
      `).run(
        guildId,
        userId,
        String(username || '').trim() || null,
        rank?.rank_key || null,
        rank?.rank_name || null,
        Number(rank?.vault_tier || 0)
      );
      current = db.prepare('SELECT * FROM heist_profiles WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
    }

    const nextXp = Math.max(0, Number(current.total_xp || 0) + Math.max(0, Number(deltaXp || 0)));
    const nextStreetcredit = Math.max(0, Number(current.total_streetcredit || 0) + Number(deltaStreetcredit || 0));
    const rank = this.resolveRankForXp(guildId, nextXp);
    const completed = Number(current.missions_completed || 0) + (missionSucceeded === true ? 1 : 0);
    const failed = Number(current.missions_failed || 0) + (missionSucceeded === false ? 1 : 0);

    db.prepare(`
      UPDATE heist_profiles
      SET
        username = COALESCE(?, username),
        total_xp = ?,
        total_streetcredit = ?,
        rank_key = ?,
        rank_name = ?,
        vault_tier = ?,
        missions_completed = ?,
        missions_failed = ?,
        last_mission_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND user_id = ?
    `).run(
      String(username || '').trim() || null,
      nextXp,
      nextStreetcredit,
      rank?.rank_key || null,
      rank?.rank_name || null,
      Number(rank?.vault_tier || 0),
      completed,
      failed,
      guildId,
      userId
    );
  }

  listTraitBonusRules(guildId, { templateId = null } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return [];
    const normalizedTemplateId = Number(templateId);
    const filterByTemplate = Number.isFinite(normalizedTemplateId) && normalizedTemplateId > 0;
    if (filterByTemplate) {
      return db.prepare(`
        SELECT r.*, t.name AS template_name
        FROM heist_trait_bonus_rules r
        LEFT JOIN heist_templates t ON t.guild_id = r.guild_id AND t.id = r.template_id
        WHERE r.guild_id = ? AND r.template_id = ?
        ORDER BY r.created_at DESC, r.id DESC
      `).all(normalizedGuildId, normalizedTemplateId);
    }
    return db.prepare(`
      SELECT r.*, t.name AS template_name
      FROM heist_trait_bonus_rules r
      LEFT JOIN heist_templates t ON t.guild_id = r.guild_id AND t.id = r.template_id
      WHERE r.guild_id = ?
      ORDER BY r.created_at DESC, r.id DESC
    `).all(normalizedGuildId);
  }

  upsertTraitBonusRule(guildId, payload = {}, ruleId = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };

    const traitType = String(payload.trait_type || payload.traitType || '').trim().slice(0, 64);
    const traitValue = String(payload.trait_value || payload.traitValue || '').trim().slice(0, 128);
    const missionType = String(payload.mission_type || payload.missionType || '').trim().toLowerCase().slice(0, 48) || null;
    const templateIdRaw = Number(payload.template_id ?? payload.templateId ?? 0);
    const templateId = Number.isFinite(templateIdRaw) && templateIdRaw > 0 ? Math.floor(templateIdRaw) : null;
    const targetMetric = String(payload.target_metric || payload.targetMetric || '').trim().toLowerCase();
    const enabled = payload.enabled === undefined ? 1 : (payload.enabled ? 1 : 0);
    const multiplier = Number(payload.multiplier);
    const flatBonus = Number(payload.flat_bonus ?? payload.flatBonus ?? 0);
    const maxBonus = payload.max_bonus ?? payload.maxBonus;

    if (!traitType || !traitValue) {
      return { success: false, message: 'trait_type and trait_value are required' };
    }
    if (!SUPPORTED_METRICS.has(targetMetric)) {
      return { success: false, message: 'target_metric must be xp, streetcredit, or speed' };
    }
    if (templateId) {
      const exists = db.prepare('SELECT id FROM heist_templates WHERE guild_id = ? AND id = ?').get(normalizedGuildId, templateId);
      if (!exists) {
        return { success: false, message: 'template_id is invalid for this guild' };
      }
    }

    const normalizedMultiplier = Number.isFinite(multiplier) ? multiplier : 1;
    const normalizedFlat = Number.isFinite(flatBonus) ? Math.floor(flatBonus) : 0;
    const normalizedMax = maxBonus === null || maxBonus === undefined || maxBonus === ''
      ? null
      : (Number.isFinite(Number(maxBonus)) ? Math.floor(Number(maxBonus)) : null);

    if (ruleId) {
      const result = db.prepare(`
        UPDATE heist_trait_bonus_rules
        SET
          trait_type = ?,
          trait_value = ?,
          template_id = ?,
          mission_type = ?,
          target_metric = ?,
          multiplier = ?,
          flat_bonus = ?,
          max_bonus = ?,
          enabled = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND guild_id = ?
      `).run(
        traitType,
        traitValue,
        templateId,
        missionType,
        targetMetric,
        normalizedMultiplier,
        normalizedFlat,
        normalizedMax,
        enabled,
        Number(ruleId),
        normalizedGuildId
      );
      if (!result.changes) return { success: false, message: 'Rule not found' };
      return { success: true };
    }

    db.prepare(`
      INSERT INTO heist_trait_bonus_rules (
        guild_id, trait_type, trait_value, template_id, mission_type, target_metric, multiplier, flat_bonus, max_bonus, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizedGuildId,
      traitType,
      traitValue,
      templateId,
      missionType,
      targetMetric,
      normalizedMultiplier,
      normalizedFlat,
      normalizedMax,
      enabled
    );
    return { success: true };
  }

  deleteTraitBonusRule(guildId, ruleId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    const result = db.prepare('DELETE FROM heist_trait_bonus_rules WHERE guild_id = ? AND id = ?').run(normalizedGuildId, Number(ruleId));
    return result.changes > 0 ? { success: true } : { success: false, message: 'Rule not found' };
  }

  listTemplates(guildId, { includeDisabled = true } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return [];
    this.ensureGuildScaffold(normalizedGuildId);
    const rows = includeDisabled
      ? db.prepare('SELECT * FROM heist_templates WHERE guild_id = ? ORDER BY created_at DESC, id DESC').all(normalizedGuildId)
      : db.prepare('SELECT * FROM heist_templates WHERE guild_id = ? AND enabled = 1 ORDER BY created_at DESC, id DESC').all(normalizedGuildId);
    return rows.map(this._hydrateTemplate);
  }

  _hydrateTemplate(row) {
    const metadata = safeJsonParse(row.metadata_json, {});
    const imageUrl = sanitizeImageUrl(row.image_url || metadata?.image_url || metadata?.imageUrl || null);
    return {
      ...row,
      objective: safeJsonParse(row.objective_json, []),
      trait_requirements: normalizeTraitRequirements(safeJsonParse(row.trait_requirements_json, {})),
      reward_rules: safeJsonParse(row.reward_rules_json, {}),
      active_window: safeJsonParse(row.active_window_json, {}),
      metadata,
      image_url: imageUrl,
    };
  }

  createTemplate(guildId, payload = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    this.ensureGuildScaffold(normalizedGuildId);
    const template = sanitizeTemplatePayload(payload);
    if (!template.name) {
      return { success: false, message: 'Template name is required' };
    }

    db.prepare(`
      INSERT INTO heist_templates (
        guild_id, template_key, name, description, mission_type, mode, required_slots, total_slots, max_nfts_per_user, duration_minutes,
        base_xp_reward, base_streetcredit_reward, objective_json, trait_requirements_json, reward_rules_json, active_window_json,
        spawn_weight, cooldown_minutes, enabled, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizedGuildId,
      String(payload.template_key || payload.templateKey || '').trim() || null,
      template.name,
      template.description || null,
      template.missionType,
      template.mode,
      template.requiredSlots,
      template.totalSlots,
      template.maxNftsPerUser,
      template.durationMinutes,
      template.baseXpReward,
      template.baseStreetcreditReward,
      safeJsonStringify(template.objective, '[]'),
      safeJsonStringify(template.traitRequirements, '{}'),
      safeJsonStringify(template.rewardRules, '{}'),
      safeJsonStringify(template.activeWindow, '{}'),
      template.spawnWeight,
      template.cooldownMinutes,
      template.enabled,
      safeJsonStringify(template.metadata, '{}')
    );
    return { success: true };
  }

  updateTemplate(guildId, templateId, payload = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    const existing = db.prepare('SELECT * FROM heist_templates WHERE guild_id = ? AND id = ?').get(normalizedGuildId, Number(templateId));
    if (!existing) return { success: false, message: 'Template not found' };
    const mergedPayload = {
      ...existing,
      ...payload,
      objective_json: payload.objective_json ?? payload.objective ?? existing.objective_json,
      trait_requirements_json: payload.trait_requirements_json ?? payload.trait_requirements ?? payload.traitRequirements ?? existing.trait_requirements_json,
      reward_rules_json: payload.reward_rules_json ?? payload.rewardRules ?? existing.reward_rules_json,
      active_window_json: payload.active_window_json ?? payload.activeWindow ?? existing.active_window_json,
      metadata_json: payload.metadata_json ?? payload.metadata ?? existing.metadata_json,
    };
    const template = sanitizeTemplatePayload(mergedPayload);
    if (!template.name) return { success: false, message: 'Template name is required' };

    const result = db.prepare(`
      UPDATE heist_templates
      SET
        template_key = ?,
        name = ?,
        description = ?,
        mission_type = ?,
        mode = ?,
        required_slots = ?,
        total_slots = ?,
        max_nfts_per_user = ?,
        duration_minutes = ?,
        base_xp_reward = ?,
        base_streetcredit_reward = ?,
        objective_json = ?,
        trait_requirements_json = ?,
        reward_rules_json = ?,
        active_window_json = ?,
        spawn_weight = ?,
        cooldown_minutes = ?,
        enabled = ?,
        metadata_json = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND id = ?
    `).run(
      String((payload.template_key ?? payload.templateKey ?? existing.template_key ?? '')).trim() || null,
      template.name,
      template.description || null,
      template.missionType,
      template.mode,
      template.requiredSlots,
      template.totalSlots,
      template.maxNftsPerUser,
      template.durationMinutes,
      template.baseXpReward,
      template.baseStreetcreditReward,
      safeJsonStringify(template.objective, '[]'),
      safeJsonStringify(template.traitRequirements, '{}'),
      safeJsonStringify(template.rewardRules, '{}'),
      safeJsonStringify(template.activeWindow, '{}'),
      template.spawnWeight,
      template.cooldownMinutes,
      template.enabled,
      safeJsonStringify(template.metadata, '{}'),
      normalizedGuildId,
      Number(templateId)
    );
    if (!result.changes) return { success: false, message: 'Template not found' };
    return { success: true };
  }

  deleteTemplate(guildId, templateId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    const result = db.prepare('DELETE FROM heist_templates WHERE guild_id = ? AND id = ?').run(normalizedGuildId, Number(templateId));
    return result.changes > 0 ? { success: true } : { success: false, message: 'Template not found' };
  }

  _chooseWeightedTemplate(templates = []) {
    if (!Array.isArray(templates) || templates.length === 0) return null;
    const weighted = templates.map((entry) => ({ entry, weight: Math.max(1, Number(entry.spawn_weight || 1)) }));
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    if (total <= 0) return weighted[0].entry;
    let marker = Math.random() * total;
    for (const item of weighted) {
      marker -= item.weight;
      if (marker <= 0) return item.entry;
    }
    return weighted[weighted.length - 1].entry;
  }

  _countActiveMissions(guildId) {
    return Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM heist_missions
      WHERE guild_id = ? AND status IN (${inListPlaceholders(ACTIVE_STATUSES.length)})
    `).get(guildId, ...ACTIVE_STATUSES)?.count || 0);
  }

  _createMissionFromTemplate(guildId, templateRow, spawnSource = 'random') {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId || !templateRow) return { success: false, message: 'Template not found' };

    const missionId = `HS-${randomUUID().split('-')[0].toUpperCase()}`;
    const now = nowIso();
    const endsAt = toIsoOffsetFromNow(templateRow.duration_minutes || DEFAULT_CONFIG.default_duration_minutes);
    const title = String(templateRow.name || 'Mission').trim().slice(0, 120) || 'Mission';

    const templateMetadata = safeJsonParse(templateRow.metadata_json, {});
    db.prepare(`
      INSERT INTO heist_missions (
        mission_id, guild_id, template_id, title, description, mission_type, mode, status,
        required_slots, total_slots, filled_slots, max_nfts_per_user,
        base_xp_reward, base_streetcredit_reward, objective_json, trait_requirements_json, reward_rules_json,
        spawn_source, started_at, ends_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'recruiting', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      missionId,
      normalizedGuildId,
      Number(templateRow.id),
      title,
      String(templateRow.description || '').trim() || null,
      String(templateRow.mission_type || 'nft'),
      String(templateRow.mode || 'solo'),
      Number(templateRow.required_slots || 1),
      Number(templateRow.total_slots || 1),
      Number(templateRow.max_nfts_per_user || 2),
      Number(templateRow.base_xp_reward || 25),
      Number(templateRow.base_streetcredit_reward || 25),
      templateRow.objective_json || '[]',
      templateRow.trait_requirements_json || '{}',
      templateRow.reward_rules_json || '{}',
      String(spawnSource || 'random').slice(0, 40),
      now,
      endsAt,
      safeJsonStringify({
        templateName: templateRow.name || null,
        slot_requirements: normalizeSlotRequirements(
          templateMetadata?.slot_requirements || templateMetadata?.slotRequirements || [],
          Number(templateRow.total_slots || 1)
        ),
        image_url: sanitizeImageUrl(
          templateMetadata?.image_url
          || templateMetadata?.imageUrl
        ),
      }, '{}')
    );

    db.prepare(`
      INSERT INTO heist_events (guild_id, event_type, mission_id, payload_json)
      VALUES (?, 'mission_spawned', ?, ?)
    `).run(
      normalizedGuildId,
      missionId,
      safeJsonStringify({ templateId: templateRow.id, spawnSource }, '{}')
    );

    this._scheduleLifecycleUpdate(normalizedGuildId, 'spawned', missionId, { spawnSource });

    return { success: true, missionId };
  }

  spawnMissionNow(guildId, templateId, { spawnSource = 'admin' } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    this.ensureGuildScaffold(normalizedGuildId);

    const activeCount = this._countActiveMissions(normalizedGuildId);
    const configuredLimit = Number(this.getConfig(normalizedGuildId)?.max_active_missions || DEFAULT_CONFIG.max_active_missions);
    const effectiveLimit = entitlementService.getEffectiveLimit(normalizedGuildId, 'heist', 'max_active_missions');
    const maxAllowed = Number.isFinite(Number(effectiveLimit)) ? Number(effectiveLimit) : configuredLimit;
    if (activeCount >= Math.max(1, maxAllowed)) {
      return { success: false, code: 'limit_exceeded', message: `Maximum active missions reached (${maxAllowed}).` };
    }

    const templateRow = db.prepare(`
      SELECT *
      FROM heist_templates
      WHERE guild_id = ? AND id = ? AND enabled = 1
    `).get(normalizedGuildId, Number(templateId));
    if (!templateRow) {
      return { success: false, message: 'Template not found or disabled' };
    }

    return this._createMissionFromTemplate(normalizedGuildId, templateRow, spawnSource);
  }

  _isTemplateCoolingDown(guildId, templateRow) {
    const cooldownMinutes = Math.max(0, Number(templateRow?.cooldown_minutes || 0));
    if (cooldownMinutes <= 0) return false;
    const cutoff = new Date(Date.now() - (cooldownMinutes * 60 * 1000)).toISOString();
    const row = db.prepare(`
      SELECT id
      FROM heist_missions
      WHERE guild_id = ? AND template_id = ? AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(guildId, Number(templateRow.id), cutoff);
    return !!row;
  }

  runSpawnTickForGuild(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    if (tenantService.isMultitenantEnabled() && !tenantService.isModuleEnabled(normalizedGuildId, 'heist')) {
      return { success: true, skipped: true, reason: 'module_disabled' };
    }
    this.ensureGuildScaffold(normalizedGuildId);
    const config = this.getConfig(normalizedGuildId);
    if (!config || !config.enabled || !config.mission_spawn_enabled) {
      return { success: true, skipped: true, reason: 'spawn_disabled' };
    }

    const activeCount = this._countActiveMissions(normalizedGuildId);
    const configuredLimit = Number(config.max_active_missions || DEFAULT_CONFIG.max_active_missions);
    const effectiveLimit = entitlementService.getEffectiveLimit(normalizedGuildId, 'heist', 'max_active_missions');
    const maxAllowed = Number.isFinite(Number(effectiveLimit)) ? Number(effectiveLimit) : configuredLimit;
    if (activeCount >= Math.max(1, maxAllowed)) {
      return { success: true, skipped: true, reason: 'active_limit' };
    }

    const since = new Date(Date.now() - (Number(config.spawn_interval_minutes || DEFAULT_CONFIG.spawn_interval_minutes) * 60 * 1000)).toISOString();
    const recent = db.prepare(`
      SELECT id
      FROM heist_missions
      WHERE guild_id = ? AND spawn_source = 'random' AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(normalizedGuildId, since);
    if (recent) return { success: true, skipped: true, reason: 'interval' };

    const templates = db.prepare(`
      SELECT *
      FROM heist_templates
      WHERE guild_id = ? AND enabled = 1
      ORDER BY id DESC
    `).all(normalizedGuildId).filter((entry) => !this._isTemplateCoolingDown(normalizedGuildId, entry));
    if (templates.length === 0) {
      return { success: true, skipped: true, reason: 'no_templates' };
    }

    const picked = this._chooseWeightedTemplate(templates);
    const result = this._createMissionFromTemplate(normalizedGuildId, picked, 'random');
    return { ...result, templateId: picked?.id || null };
  }

  _hydrateMission(row, { includeSlots = false } = {}) {
    if (!row) return null;
    const metadata = safeJsonParse(row.metadata_json, {});
    const imageUrl = sanitizeImageUrl(row.image_url || metadata?.image_url || metadata?.imageUrl || null);
    const mission = {
      ...row,
      objective: safeJsonParse(row.objective_json, []),
      trait_requirements: normalizeTraitRequirements(safeJsonParse(row.trait_requirements_json, {})),
      reward_rules: safeJsonParse(row.reward_rules_json, {}),
      metadata,
      image_url: imageUrl,
    };
    if (!includeSlots) return mission;
    const slots = db.prepare(`
      SELECT *
      FROM heist_mission_slots
      WHERE mission_id = ?
      ORDER BY slot_index ASC
    `).all(row.mission_id).map((slot) => ({
      ...slot,
      trait_snapshot: safeJsonParse(slot.trait_snapshot_json, []),
    }));
    return { ...mission, slots };
  }

  listMissions(guildId, { statuses = null, limit = 50, offset = 0 } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return [];
    const safeLimit = Math.max(1, Math.min(200, Number(limit || 50)));
    const safeOffset = Math.max(0, Number(offset || 0));
    const normalizedStatuses = Array.isArray(statuses)
      ? statuses.map((status) => sanitizeMissionStatus(status)).filter(Boolean)
      : null;

    if (normalizedStatuses && normalizedStatuses.length > 0) {
      const rows = db.prepare(`
        SELECT *
        FROM heist_missions
        WHERE guild_id = ? AND status IN (${inListPlaceholders(normalizedStatuses.length)})
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(normalizedGuildId, ...normalizedStatuses, safeLimit, safeOffset);
      return rows.map((row) => this._hydrateMission(row));
    }

    const rows = db.prepare(`
      SELECT *
      FROM heist_missions
      WHERE guild_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(normalizedGuildId, safeLimit, safeOffset);
    return rows.map((row) => this._hydrateMission(row));
  }

  listUserMissions(guildId, userId, { statuses = null, limit = 50, offset = 0 } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedGuildId || !normalizedUserId) return [];
    const safeLimit = Math.max(1, Math.min(200, Number(limit || 50)));
    const safeOffset = Math.max(0, Number(offset || 0));
    const normalizedStatuses = Array.isArray(statuses)
      ? statuses.map((status) => sanitizeMissionStatus(status)).filter(Boolean)
      : null;

    if (normalizedStatuses && normalizedStatuses.length > 0) {
      const rows = db.prepare(`
        SELECT DISTINCT m.*
        FROM heist_missions m
        INNER JOIN heist_mission_slots s ON s.mission_id = m.mission_id
        WHERE m.guild_id = ? AND s.user_id = ? AND m.status IN (${inListPlaceholders(normalizedStatuses.length)})
        ORDER BY m.created_at DESC
        LIMIT ? OFFSET ?
      `).all(normalizedGuildId, normalizedUserId, ...normalizedStatuses, safeLimit, safeOffset);
      return rows.map((row) => this._hydrateMission(row));
    }

    const rows = db.prepare(`
      SELECT DISTINCT m.*
      FROM heist_missions m
      INNER JOIN heist_mission_slots s ON s.mission_id = m.mission_id
      WHERE m.guild_id = ? AND s.user_id = ?
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `).all(normalizedGuildId, normalizedUserId, safeLimit, safeOffset);
    return rows.map((row) => this._hydrateMission(row));
  }

  getMission(guildId, missionId, { includeSlots = true } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedMissionId = String(missionId || '').trim();
    if (!normalizedGuildId || !normalizedMissionId) return null;
    const row = db.prepare(`
      SELECT *
      FROM heist_missions
      WHERE guild_id = ? AND mission_id = ?
    `).get(normalizedGuildId, normalizedMissionId);
    return this._hydrateMission(row, { includeSlots });
  }

  _extractTraitMap(attributes = []) {
    const map = new Map();
    if (!Array.isArray(attributes)) return map;
    for (const entry of attributes) {
      const key = String(entry?.trait_type || entry?.traitType || '').trim();
      const value = String(entry?.value || '').trim();
      if (!key || !value) continue;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(value);
    }
    return map;
  }

  _passesTraitRequirements(nft, requirements = {}) {
    if (!requirements || typeof requirements !== 'object') return true;
    const requiredTraits = Array.isArray(requirements.requiredTraits)
      ? requirements.requiredTraits
      : (Array.isArray(requirements.required_traits) ? requirements.required_traits : []);
    if (requiredTraits.length === 0) return true;
    const traitMap = this._extractTraitMap(nft?.attributes || []);
    for (const rule of requiredTraits) {
      const type = String(rule?.traitType || rule?.trait_type || '').trim();
      if (!type) continue;
      const values = Array.isArray(rule?.values) ? rule.values.map((v) => String(v).trim()).filter(Boolean) : [];
      const actualValues = traitMap.get(type) || new Set();
      if (values.length === 0) {
        if (!actualValues.size) return false;
      } else {
        const hasOne = values.some((value) => actualValues.has(value));
        if (!hasOne) return false;
      }
    }
    return true;
  }

  _passesCollectionRequirements(nft, requirements = {}) {
    if (!requirements || typeof requirements !== 'object') return true;
    const requiredCollections = Array.isArray(requirements.requiredCollections)
      ? requirements.requiredCollections
      : (Array.isArray(requirements.required_collections) ? requirements.required_collections : []);
    if (!requiredCollections.length) return true;
    const normalizedRequired = new Set(
      requiredCollections.map((entry) => String(entry || '').trim()).filter(Boolean)
    );
    if (!normalizedRequired.size) return true;
    const collectionKeys = [
      nft?.collectionKey,
      nft?.collection_key,
      nft?.collection,
      nft?.collectionAddress,
      nft?.collection_address,
      nft?.symbol,
    ].map((entry) => String(entry || '').trim()).filter(Boolean);
    return collectionKeys.some((key) => normalizedRequired.has(key));
  }

  _passesMissionAccessRequirements(nft, requirements = {}) {
    const normalized = normalizeTraitRequirements(requirements);
    const hasTraitRules = Array.isArray(normalized.requiredTraits) && normalized.requiredTraits.length > 0;
    const hasCollectionRules = Array.isArray(normalized.requiredCollections) && normalized.requiredCollections.length > 0;
    if (!hasTraitRules && !hasCollectionRules) return true;

    const traitPass = hasTraitRules ? this._passesTraitRequirements(nft, normalized) : false;
    const collectionPass = hasCollectionRules ? this._passesCollectionRequirements(nft, normalized) : false;
    if (hasTraitRules && hasCollectionRules) {
      return normalized.gateMode === 'or' ? (traitPass || collectionPass) : (traitPass && collectionPass);
    }
    return hasTraitRules ? traitPass : collectionPass;
  }

  _getMissionSlotRequirements(mission) {
    if (!mission || typeof mission !== 'object') return [];
    const metadata = mission.metadata && typeof mission.metadata === 'object'
      ? mission.metadata
      : safeJsonParse(mission.metadata_json, {});
    const totalSlots = Number(mission.total_slots || mission.totalSlots || 1);
    return normalizeSlotRequirements(metadata?.slot_requirements || metadata?.slotRequirements || [], totalSlots);
  }

  _findEligibleOpenSlotForNft(nft, slotRequirements = [], occupiedSlotIndexes = new Set()) {
    for (const slotRequirement of (Array.isArray(slotRequirements) ? slotRequirements : [])) {
      const slotIndex = Number(slotRequirement?.slotIndex || slotRequirement?.slot_index || 0);
      if (!slotIndex || occupiedSlotIndexes.has(slotIndex)) continue;
      if (this._passesMissionAccessRequirements(nft, slotRequirement)) {
        return slotIndex;
      }
    }
    return null;
  }

  async _getUserNftsByWallet(guildId, userId) {
    const wallets = walletService.getAllUserWallets(userId);
    const result = [];
    for (const wallet of wallets) {
      try {
        const nfts = await nftService.getNFTsForWallet(wallet, { guildId });
        for (const nft of nfts) {
          result.push({ ...nft, wallet_address: wallet });
        }
      } catch (error) {
        logger.warn(`[heist] failed NFT fetch for ${wallet}: ${error?.message || error}`);
      }
    }
    return result;
  }

  async listEligibleNftsForMission(guildId, userId, missionId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedUserId = normalizeUserId(userId);
    const normalizedMissionId = String(missionId || '').trim();
    if (!normalizedGuildId || !normalizedUserId || !normalizedMissionId) return [];
    const mission = this.getMission(normalizedGuildId, normalizedMissionId, { includeSlots: true });
    if (!mission) return [];
    const isCoopMode = String(mission.mode || '').trim().toLowerCase() === 'coop';
    const existingUserSlots = Number(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM heist_mission_slots
        WHERE guild_id = ? AND mission_id = ? AND user_id = ? AND status IN ('joined', 'completed')
      `).get(normalizedGuildId, normalizedMissionId, normalizedUserId)?.count || 0
    );
    if (existingUserSlots > 0) {
      return [];
    }

    const allNfts = await this._getUserNftsByWallet(normalizedGuildId, normalizedUserId);
    const lockedRows = db.prepare(`
      SELECT nft_mint
      FROM heist_locked_nfts
      WHERE guild_id = ?
    `).all(normalizedGuildId);
    const lockedMints = new Set(lockedRows.map((row) => String(row.nft_mint || '').trim()).filter(Boolean));
    const missionRequirements = normalizeTraitRequirements(
      safeJsonParse(mission.trait_requirements_json, mission.trait_requirements || {})
    );
    const slotRequirements = this._getMissionSlotRequirements(mission);
    const occupiedSlots = isCoopMode
      ? new Set(
        (Array.isArray(mission.slots) ? mission.slots : [])
          .map((slot) => Number(slot.slot_index || slot.slotIndex || 0))
          .filter((slotIndex) => Number.isFinite(slotIndex) && slotIndex > 0)
      )
      : new Set();
    const hasOpenSlotRequirements = slotRequirements.some((slotRequirement) => {
      const slotIndex = Number(slotRequirement?.slotIndex || 0);
      return slotIndex > 0 && !occupiedSlots.has(slotIndex);
    });

    return allNfts.filter((nft) => {
      const mint = String(nft.mint || '').trim();
      if (!mint || lockedMints.has(mint)) return false;
      if (!this._passesMissionAccessRequirements(nft, missionRequirements)) return false;
      if (!hasOpenSlotRequirements) return true;
      return this._findEligibleOpenSlotForNft(nft, slotRequirements, occupiedSlots) !== null;
    });
  }

  async joinMission({ guildId, missionId, userId, username = null, selectedMints = [] } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedMissionId = String(missionId || '').trim();
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedGuildId || !normalizedMissionId || !normalizedUserId) {
      return { success: false, message: 'guildId, missionId, and userId are required' };
    }

    const mission = this.getMission(normalizedGuildId, normalizedMissionId, { includeSlots: true });
    if (!mission) return { success: false, message: 'Mission not found' };
    if (!RESOLVABLE_STATUSES.includes(String(mission.status || '').toLowerCase())) {
      return { success: false, message: 'Mission is not accepting participants' };
    }
    if (mission.ends_at && new Date(mission.ends_at).getTime() < Date.now()) {
      return { success: false, message: 'Mission has already ended' };
    }
    const mode = String(mission.mode || '').trim().toLowerCase() === 'coop' ? 'coop' : 'solo';
    const isCoopMode = mode === 'coop';
    const requiredSlots = Math.max(1, Number(mission.required_slots || 1));
    const totalSlots = Math.max(requiredSlots, Number(mission.total_slots || 1));

    const eligibleNfts = await this.listEligibleNftsForMission(normalizedGuildId, normalizedUserId, normalizedMissionId);
    if (!eligibleNfts.length) {
      if (isCoopMode) {
        return { success: false, message: 'No eligible NFTs available or you already joined this co-op mission.' };
      }
      return { success: false, message: 'No eligible NFTs available or you already joined this mission window.' };
    }

    const pickedMints = Array.isArray(selectedMints)
      ? selectedMints.map((mint) => String(mint || '').trim()).filter(Boolean)
      : String(selectedMints || '').split(',').map((mint) => mint.trim()).filter(Boolean);
    const uniquePickedMints = Array.from(new Set(pickedMints));
    const defaultPickCount = isCoopMode ? 1 : requiredSlots;
    const selected = uniquePickedMints.length > 0
      ? eligibleNfts.filter((nft) => uniquePickedMints.includes(String(nft.mint || '').trim()))
      : eligibleNfts.slice(0, defaultPickCount);

    if (selected.length === 0) {
      return { success: false, message: 'Selected NFTs are not eligible' };
    }

    const maxNftsPerUserConfigured = Math.max(1, Number(mission.max_nfts_per_user || 1));
    const maxNftsPerUser = isCoopMode
      ? 1
      : Math.max(requiredSlots, Math.min(maxNftsPerUserConfigured, totalSlots));
    if (isCoopMode && selected.length !== 1) {
      return { success: false, message: 'Co-op missions require exactly 1 NFT per participant.' };
    }
    if (!isCoopMode && selected.length < requiredSlots) {
      return { success: false, message: `This mission requires at least ${requiredSlots} NFT slot(s).` };
    }
    if (!isCoopMode && selected.length > totalSlots) {
      return { success: false, message: `This mission allows up to ${totalSlots} NFT slot(s).` };
    }
    const existingUserSlots = Number(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM heist_mission_slots
        WHERE guild_id = ? AND mission_id = ? AND user_id = ? AND status IN ('joined', 'completed')
      `).get(normalizedGuildId, normalizedMissionId, normalizedUserId)?.count || 0
    );
    if (existingUserSlots > 0) {
      return {
        success: false,
        message: isCoopMode
          ? 'You already joined this co-op mission.'
          : 'You can run this mission once per mission window.',
      };
    }
    if ((existingUserSlots + selected.length) > maxNftsPerUser) {
      return { success: false, message: `You can lock up to ${maxNftsPerUser} NFTs in this mission.` };
    }

    let activatedNow = false;
    const tx = db.transaction(() => {
      const currentMission = db.prepare(`
        SELECT *
        FROM heist_missions
        WHERE guild_id = ? AND mission_id = ?
      `).get(normalizedGuildId, normalizedMissionId);
      if (!currentMission) throw new Error('Mission not found');
      if (!RESOLVABLE_STATUSES.includes(String(currentMission.status || '').toLowerCase())) {
        throw new Error('Mission is not accepting participants');
      }
      const currentMode = String(currentMission.mode || '').trim().toLowerCase() === 'coop' ? 'coop' : 'solo';
      const currentIsCoopMode = currentMode === 'coop';
      const currentRequiredSlots = Math.max(1, Number(currentMission.required_slots || 1));
      const currentTotalSlots = Math.max(currentRequiredSlots, Number(currentMission.total_slots || 1));
      const currentMaxNftsPerUser = currentIsCoopMode
        ? 1
        : Math.max(
          currentRequiredSlots,
          Math.min(Math.max(1, Number(currentMission.max_nfts_per_user || 1)), currentTotalSlots)
        );
      if (!currentIsCoopMode && selected.length < currentRequiredSlots) {
        throw new Error(`This mission requires at least ${currentRequiredSlots} NFT slot(s).`);
      }
      if (!currentIsCoopMode && selected.length > currentTotalSlots) {
        throw new Error(`This mission allows up to ${currentTotalSlots} NFT slot(s).`);
      }

      const currentUserSlotCount = Number(
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM heist_mission_slots
          WHERE guild_id = ? AND mission_id = ? AND user_id = ? AND status IN ('joined', 'completed')
        `).get(normalizedGuildId, normalizedMissionId, normalizedUserId)?.count || 0
      );
      if (currentUserSlotCount > 0) {
        throw new Error(
          currentIsCoopMode
            ? 'You already joined this co-op mission.'
            : 'You can run this mission once per mission window.'
        );
      }
      if ((currentUserSlotCount + selected.length) > currentMaxNftsPerUser) {
        throw new Error(`You can lock up to ${currentMaxNftsPerUser} NFTs in this mission.`);
      }

      const existingSlots = db.prepare(`
        SELECT slot_index
        FROM heist_mission_slots
        WHERE guild_id = ? AND mission_id = ? AND status IN ('joined', 'completed')
      `).all(normalizedGuildId, normalizedMissionId);
      const occupiedSlotIndexes = new Set(
        existingSlots
          .map((row) => Number(row.slot_index || 0))
          .filter((value) => Number.isFinite(value) && value > 0)
      );
      const slotRequirements = this._getMissionSlotRequirements(currentMission);
      const maxSlot = occupiedSlotIndexes.size ? Math.max(...occupiedSlotIndexes) : 0;
      let nextSlot = maxSlot;
      const assignments = [];

      if (currentIsCoopMode) {
        const available = currentTotalSlots - Number(currentMission.filled_slots || 0);
        if (available <= 0) throw new Error('Mission is full');
        if (selected.length > available) throw new Error(`Only ${available} slot(s) left.`);
        for (const nft of selected) {
          const slotIndex = this._findEligibleOpenSlotForNft(nft, slotRequirements, occupiedSlotIndexes);
          if (!slotIndex) {
            throw new Error('Selected NFT does not match any open slot requirement.');
          }
          occupiedSlotIndexes.add(slotIndex);
          assignments.push({
            nft,
            slotIndex,
            ruleSlotIndex: slotIndex,
          });
        }
      } else {
        const localUsedRequirementSlots = new Set();
        for (const nft of selected) {
          const ruleSlotIndex = this._findEligibleOpenSlotForNft(nft, slotRequirements, localUsedRequirementSlots);
          if (!ruleSlotIndex && slotRequirements.length > 0) {
            throw new Error('Selected NFTs do not satisfy the required slot traits.');
          }
          if (ruleSlotIndex) localUsedRequirementSlots.add(ruleSlotIndex);
          nextSlot += 1;
          assignments.push({
            nft,
            slotIndex: nextSlot,
            ruleSlotIndex: ruleSlotIndex || null,
          });
        }
      }

      const slotInsert = db.prepare(`
        INSERT INTO heist_mission_slots (
          guild_id, mission_id, slot_index, user_id, username, wallet_address, nft_mint, nft_name, trait_snapshot_json, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'joined')
      `);
      const lockInsert = db.prepare(`
        INSERT INTO heist_locked_nfts (
          guild_id, user_id, wallet_address, nft_mint, mission_id, mission_slot_id, expires_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const assignment of assignments) {
        const nft = assignment.nft;
        const traitSnapshot = Array.isArray(nft.attributes) ? nft.attributes : [];
        const slotResult = slotInsert.run(
          normalizedGuildId,
          normalizedMissionId,
          Number(assignment.slotIndex),
          normalizedUserId,
          String(username || '').trim() || null,
          String(nft.wallet_address || '').trim(),
          String(nft.mint || '').trim(),
          String(nft.name || '').trim() || null,
          safeJsonStringify(traitSnapshot, '[]')
        );

        lockInsert.run(
          normalizedGuildId,
          normalizedUserId,
          String(nft.wallet_address || '').trim(),
          String(nft.mint || '').trim(),
          normalizedMissionId,
          Number(slotResult.lastInsertRowid || 0) || null,
          currentMission.ends_at || null,
          safeJsonStringify({
            missionTitle: currentMission.title || null,
            slotRuleIndex: assignment.ruleSlotIndex || null,
          }, '{}')
        );
      }

      const updatedFilled = Number(currentMission.filled_slots || 0) + assignments.length;
      const shouldActivate = currentIsCoopMode
        ? updatedFilled >= currentRequiredSlots
        : updatedFilled > 0;
      activatedNow = shouldActivate && String(currentMission.status || '').toLowerCase() !== 'active';
      db.prepare(`
        UPDATE heist_missions
        SET
          filled_slots = ?,
          status = ?,
          started_at = CASE WHEN ? = 1 THEN COALESCE(started_at, CURRENT_TIMESTAMP) ELSE started_at END,
          updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND mission_id = ?
      `).run(
        updatedFilled,
        shouldActivate ? 'active' : String(currentMission.status || 'recruiting'),
        shouldActivate ? 1 : 0,
        normalizedGuildId,
        normalizedMissionId
      );

      db.prepare(`
        INSERT INTO heist_events (guild_id, event_type, mission_id, user_id, payload_json)
        VALUES (?, 'mission_join', ?, ?, ?)
      `).run(
        normalizedGuildId,
        normalizedMissionId,
        normalizedUserId,
        safeJsonStringify({ slotsAdded: assignments.length, mints: assignments.map((entry) => entry.nft.mint) }, '{}')
      );
    });

    try {
      tx();
      if (activatedNow) {
        this._scheduleLifecycleUpdate(normalizedGuildId, 'started', normalizedMissionId);
      }
      return { success: true, mission: this.getMission(normalizedGuildId, normalizedMissionId, { includeSlots: true }) };
    } catch (error) {
      const message = String(error?.message || 'Failed to join mission');
      if (message.includes('UNIQUE constraint failed: heist_locked_nfts')) {
        return { success: false, message: 'One or more selected NFTs are already locked in another mission.' };
      }
      logger.error('[heist] joinMission error:', error);
      return { success: false, message };
    }
  }

  leaveMission({ guildId, missionId, userId } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedMissionId = String(missionId || '').trim();
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedGuildId || !normalizedMissionId || !normalizedUserId) {
      return { success: false, message: 'guildId, missionId, and userId are required' };
    }

    const mission = this.getMission(normalizedGuildId, normalizedMissionId, { includeSlots: false });
    if (!mission) return { success: false, message: 'Mission not found' };
    if (String(mission.status || '').toLowerCase() !== 'recruiting') {
      return { success: false, message: 'You can only leave missions during recruiting stage.' };
    }

    const tx = db.transaction(() => {
      const rows = db.prepare(`
        SELECT id, nft_mint
        FROM heist_mission_slots
        WHERE guild_id = ? AND mission_id = ? AND user_id = ? AND status = 'joined'
      `).all(normalizedGuildId, normalizedMissionId, normalizedUserId);
      if (rows.length === 0) {
        throw new Error('You are not currently joined in this mission.');
      }

      db.prepare(`
        DELETE FROM heist_mission_slots
        WHERE guild_id = ? AND mission_id = ? AND user_id = ? AND status = 'joined'
      `).run(normalizedGuildId, normalizedMissionId, normalizedUserId);

      db.prepare(`
        DELETE FROM heist_locked_nfts
        WHERE guild_id = ? AND mission_id = ? AND user_id = ?
      `).run(normalizedGuildId, normalizedMissionId, normalizedUserId);

      const countRow = db.prepare(`
        SELECT COUNT(*) AS count
        FROM heist_mission_slots
        WHERE guild_id = ? AND mission_id = ? AND status IN ('joined', 'completed')
      `).get(normalizedGuildId, normalizedMissionId);
      const filledSlots = Number(countRow?.count || 0);

      db.prepare(`
        UPDATE heist_missions
        SET filled_slots = ?, status = 'recruiting', updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND mission_id = ?
      `).run(filledSlots, normalizedGuildId, normalizedMissionId);

      db.prepare(`
        INSERT INTO heist_events (guild_id, event_type, mission_id, user_id, payload_json)
        VALUES (?, 'mission_leave', ?, ?, ?)
      `).run(
        normalizedGuildId,
        normalizedMissionId,
        normalizedUserId,
        safeJsonStringify({ slotsRemoved: rows.length }, '{}')
      );
    });

    try {
      tx();
      return { success: true };
    } catch (error) {
      return { success: false, message: String(error?.message || 'Failed to leave mission') };
    }
  }

  cancelMission(guildId, missionId, cancelledBy = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedMissionId = String(missionId || '').trim();
    if (!normalizedGuildId || !normalizedMissionId) {
      return { success: false, message: 'guildId and missionId are required' };
    }

    const mission = this.getMission(normalizedGuildId, normalizedMissionId, { includeSlots: false });
    if (!mission) return { success: false, message: 'Mission not found' };
    if (!RESOLVABLE_STATUSES.includes(String(mission.status || '').toLowerCase())) {
      return { success: false, message: 'Only recruiting or active missions can be cancelled' };
    }

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE heist_missions
        SET status = 'cancelled', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND mission_id = ?
      `).run(normalizedGuildId, normalizedMissionId);

      db.prepare(`
        UPDATE heist_mission_slots
        SET status = 'failed', failure_reason = 'cancelled_by_admin', resolved_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND mission_id = ? AND status = 'joined'
      `).run(normalizedGuildId, normalizedMissionId);

      db.prepare(`
        DELETE FROM heist_locked_nfts
        WHERE guild_id = ? AND mission_id = ?
      `).run(normalizedGuildId, normalizedMissionId);

      db.prepare(`
        INSERT INTO heist_events (guild_id, event_type, mission_id, user_id, payload_json)
        VALUES (?, 'mission_cancelled', ?, ?, ?)
      `).run(
        normalizedGuildId,
        normalizedMissionId,
        String(cancelledBy || '').trim() || null,
        safeJsonStringify({ cancelledBy: String(cancelledBy || '').trim() || null }, '{}')
      );
    });

    try {
      tx();
      this._scheduleLifecycleUpdate(normalizedGuildId, 'cancelled', normalizedMissionId);
      return { success: true, missionId: normalizedMissionId };
    } catch (error) {
      logger.error('[heist] cancelMission error:', error);
      return { success: false, message: 'Failed to cancel mission' };
    }
  }

  _collectTraitBonusRules(guildId, missionType, templateId = null) {
    const normalizedMissionType = String(missionType || '').trim().toLowerCase();
    const normalizedTemplateId = Number(templateId);
    const hasTemplateId = Number.isFinite(normalizedTemplateId) && normalizedTemplateId > 0;
    if (hasTemplateId) {
      return db.prepare(`
        SELECT *
        FROM heist_trait_bonus_rules
        WHERE guild_id = ?
          AND enabled = 1
          AND (mission_type IS NULL OR mission_type = '' OR mission_type = ?)
          AND (template_id IS NULL OR template_id = ?)
        ORDER BY CASE WHEN template_id = ? THEN 0 ELSE 1 END ASC, id ASC
      `).all(guildId, normalizedMissionType, normalizedTemplateId, normalizedTemplateId);
    }
    return db.prepare(`
      SELECT *
      FROM heist_trait_bonus_rules
      WHERE guild_id = ? AND enabled = 1 AND (mission_type IS NULL OR mission_type = '' OR mission_type = ?)
      ORDER BY id ASC
    `).all(guildId, normalizedMissionType);
  }

  _applyMetricBonuses({ metric, baseValue, slotTraits = [], rules = [] }) {
    let value = Number(baseValue || 0);
    if (!Number.isFinite(value) || value < 0) value = 0;
    const traitMap = this._extractTraitMap(slotTraits);

    for (const rule of rules) {
      if (String(rule.target_metric || '').toLowerCase() !== metric) continue;
      const traitType = String(rule.trait_type || '').trim();
      const traitValue = String(rule.trait_value || '').trim();
      if (!traitType || !traitValue) continue;
      const values = traitMap.get(traitType);
      if (!values || !values.has(traitValue)) continue;

      const multiplier = Number(rule.multiplier);
      if (Number.isFinite(multiplier) && multiplier > 0 && multiplier !== 1) {
        value *= multiplier;
      }
      const flat = Number(rule.flat_bonus || 0);
      if (Number.isFinite(flat) && flat !== 0) {
        value += flat;
      }
      const maxBonus = Number(rule.max_bonus);
      if (Number.isFinite(maxBonus)) {
        const base = Number(baseValue || 0);
        value = Math.min(value, base + Math.max(0, maxBonus));
      }
    }

    return Math.max(0, Math.floor(value));
  }

  _isEngagementObjectiveSatisfied(guildId, userId, objective = {}, mission) {
    try {
      if (!tenantService.isModuleEnabled(guildId, 'engagement')) {
        return { ok: false, reason: 'engagement_module_disabled' };
      }
      const engagementService = require('./engagementService');
      const requiredTaskId = Number(objective.taskId || objective.task_id || 0);
      const requiredAction = String(objective.actionType || objective.action_type || '').trim();
      const requiredCount = Math.max(1, Number(objective.requiredCount || objective.required_count || 1));
      const completions = engagementService.listTaskCompletions(guildId, {
        taskId: requiredTaskId || null,
        userId,
        limit: 500,
      });
      let scoped = completions;
      if (requiredAction) {
        scoped = scoped.filter((entry) => String(entry.action_type || '').trim() === requiredAction);
      }
      if (mission?.started_at) {
        const startedAtMs = new Date(mission.started_at).getTime();
        if (Number.isFinite(startedAtMs)) {
          scoped = scoped.filter((entry) => {
            const createdMs = new Date(entry.created_at || 0).getTime();
            return Number.isFinite(createdMs) && createdMs >= startedAtMs;
          });
        }
      }
      return { ok: scoped.length >= requiredCount, reason: scoped.length >= requiredCount ? null : 'engagement_objective_not_met' };
    } catch (error) {
      logger.warn(`[heist] engagement objective check failed: ${error?.message || error}`);
      return { ok: false, reason: 'engagement_check_failed' };
    }
  }

  _evaluateSlotObjectives(guildId, userId, mission, objectives = []) {
    if (!Array.isArray(objectives) || objectives.length === 0) return { ok: true, reason: null };
    for (const objective of objectives) {
      const type = String(objective?.type || '').trim().toLowerCase();
      if (type === 'engagement_task' || type.startsWith('engagement:')) {
        const check = this._isEngagementObjectiveSatisfied(guildId, userId, objective, mission);
        if (!check.ok) return check;
      }
    }
    return { ok: true, reason: null };
  }

  async _verifyUserOwnsMint(guildId, userId, mint, nftCacheByUser) {
    const normalizedMint = String(mint || '').trim();
    if (!normalizedMint) return false;
    if (!nftCacheByUser.has(userId)) {
      const nfts = await this._getUserNftsByWallet(guildId, userId);
      nftCacheByUser.set(userId, nfts);
    }
    const nfts = nftCacheByUser.get(userId) || [];
    return nfts.some((nft) => String(nft.mint || '').trim() === normalizedMint);
  }

  async resolveMission(guildId, missionId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedMissionId = String(missionId || '').trim();
    if (!normalizedGuildId || !normalizedMissionId) {
      return { success: false, message: 'guildId and missionId are required' };
    }

    const mission = this.getMission(normalizedGuildId, normalizedMissionId, { includeSlots: true });
    if (!mission) return { success: false, message: 'Mission not found' };
    if (!RESOLVABLE_STATUSES.includes(String(mission.status || '').toLowerCase())) {
      return { success: false, message: 'Mission is already resolved' };
    }

    const objectives = Array.isArray(mission.objective) ? mission.objective : [];
    const slots = Array.isArray(mission.slots) ? mission.slots : [];
    const totalSlotsForSplit = Math.max(1, Number(mission.total_slots || slots.length || 1));
    const baseXpPerSlot = Math.max(1, Math.floor(Number(mission.base_xp_reward || 0) / totalSlotsForSplit));
    const baseStreetPerSlot = Math.max(1, Math.floor(Number(mission.base_streetcredit_reward || 0) / totalSlotsForSplit));
    const bonusRules = this._collectTraitBonusRules(normalizedGuildId, mission.mission_type, mission.template_id);
    const nftCacheByUser = new Map();

    const slotOutcomes = [];
    for (const slot of slots) {
      const ownsMint = await this._verifyUserOwnsMint(normalizedGuildId, slot.user_id, slot.nft_mint, nftCacheByUser);
      if (!ownsMint) {
        slotOutcomes.push({
          slotId: slot.id,
          userId: slot.user_id,
          username: slot.username || null,
          success: false,
          payoutXp: 0,
          payoutStreetcredit: 0,
          failureReason: 'nft_no_longer_owned',
          traits: safeJsonParse(slot.trait_snapshot_json, []),
        });
        continue;
      }

      const objectiveCheck = this._evaluateSlotObjectives(normalizedGuildId, slot.user_id, mission, objectives);
      if (!objectiveCheck.ok) {
        slotOutcomes.push({
          slotId: slot.id,
          userId: slot.user_id,
          username: slot.username || null,
          success: false,
          payoutXp: 0,
          payoutStreetcredit: 0,
          failureReason: objectiveCheck.reason || 'objective_not_met',
          traits: safeJsonParse(slot.trait_snapshot_json, []),
        });
        continue;
      }

      const traits = safeJsonParse(slot.trait_snapshot_json, []);
      const payoutXp = this._applyMetricBonuses({
        metric: 'xp',
        baseValue: baseXpPerSlot,
        slotTraits: traits,
        rules: bonusRules,
      });
      const payoutStreetcredit = this._applyMetricBonuses({
        metric: 'streetcredit',
        baseValue: baseStreetPerSlot,
        slotTraits: traits,
        rules: bonusRules,
      });
      slotOutcomes.push({
        slotId: slot.id,
        userId: slot.user_id,
        username: slot.username || null,
        success: true,
        payoutXp,
        payoutStreetcredit,
        failureReason: null,
        traits,
      });
    }

    const missionSucceeded = slotOutcomes.some((entry) => entry.success);

    const tx = db.transaction(() => {
      const slotUpdate = db.prepare(`
        UPDATE heist_mission_slots
        SET status = ?, payout_xp = ?, payout_streetcredit = ?, failure_reason = ?, resolved_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      const profileLedger = new Map();

      for (const outcome of slotOutcomes) {
        slotUpdate.run(
          outcome.success ? 'completed' : 'failed',
          outcome.payoutXp,
          outcome.payoutStreetcredit,
          outcome.failureReason,
          Number(outcome.slotId)
        );
        if (!profileLedger.has(outcome.userId)) {
          profileLedger.set(outcome.userId, {
            username: outcome.username || null,
            xp: 0,
            streetcredit: 0,
            anySuccess: false,
            anyFailure: false,
          });
        }
        const aggregate = profileLedger.get(outcome.userId);
        aggregate.xp += Number(outcome.payoutXp || 0);
        aggregate.streetcredit += Number(outcome.payoutStreetcredit || 0);
        aggregate.anySuccess = aggregate.anySuccess || outcome.success;
        aggregate.anyFailure = aggregate.anyFailure || !outcome.success;
      }

      for (const [userId, aggregate] of profileLedger.entries()) {
        this._applyProfileRewards(
          tx,
          normalizedGuildId,
          userId,
          aggregate.username,
          aggregate.xp,
          aggregate.streetcredit,
          { missionSucceeded: aggregate.anySuccess ? true : (aggregate.anyFailure ? false : null) }
        );
      }

      db.prepare(`
        DELETE FROM heist_locked_nfts
        WHERE guild_id = ? AND mission_id = ?
      `).run(normalizedGuildId, normalizedMissionId);

      db.prepare(`
        UPDATE heist_missions
        SET
          status = ?,
          resolved_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND mission_id = ?
      `).run(missionSucceeded ? 'completed' : 'failed', normalizedGuildId, normalizedMissionId);

      db.prepare(`
        INSERT INTO heist_events (guild_id, event_type, mission_id, payload_json)
        VALUES (?, 'mission_resolved', ?, ?)
      `).run(
        normalizedGuildId,
        normalizedMissionId,
        safeJsonStringify({
          missionSucceeded,
          successSlots: slotOutcomes.filter((entry) => entry.success).length,
          failedSlots: slotOutcomes.filter((entry) => !entry.success).length,
        }, '{}')
      );
    });

    try {
      tx();
      const resolvedMission = this.getMission(normalizedGuildId, normalizedMissionId, { includeSlots: false });
      this._scheduleLifecycleUpdate(normalizedGuildId, missionSucceeded ? 'completed' : 'failed', resolvedMission, {
        successSlots: slotOutcomes.filter((entry) => entry.success).length,
        failedSlots: slotOutcomes.filter((entry) => !entry.success).length,
      });
      return {
        success: true,
        missionId: normalizedMissionId,
        status: missionSucceeded ? 'completed' : 'failed',
        outcomes: slotOutcomes,
      };
    } catch (error) {
      logger.error('[heist] resolveMission error:', error);
      return { success: false, message: 'Failed to resolve mission' };
    }
  }

  async resolveDueMissions(guildId = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const now = nowIso();
    const rows = normalizedGuildId
      ? db.prepare(`
        SELECT mission_id, guild_id
        FROM heist_missions
        WHERE guild_id = ?
          AND status IN (${inListPlaceholders(RESOLVABLE_STATUSES.length)})
          AND ends_at IS NOT NULL
          AND ends_at <= ?
        ORDER BY ends_at ASC
        LIMIT 100
      `).all(normalizedGuildId, ...RESOLVABLE_STATUSES, now)
      : db.prepare(`
        SELECT mission_id, guild_id
        FROM heist_missions
        WHERE status IN (${inListPlaceholders(RESOLVABLE_STATUSES.length)})
          AND ends_at IS NOT NULL
          AND ends_at <= ?
        ORDER BY ends_at ASC
        LIMIT 200
      `).all(...RESOLVABLE_STATUSES, now);

    const results = [];
    for (const row of rows) {
      const result = await this.resolveMission(row.guild_id, row.mission_id);
      results.push(result);
    }
    return results;
  }

  async runSchedulerTick() {
    const guildRows = db.prepare(`
      SELECT DISTINCT guild_id
      FROM heist_config
      WHERE guild_id IS NOT NULL AND guild_id <> ''
    `).all();
    const guildIds = guildRows.map((row) => normalizeGuildId(row.guild_id)).filter(Boolean);

    let spawned = 0;
    let resolved = 0;
    for (const guildId of guildIds) {
      try {
        const spawnResult = this.runSpawnTickForGuild(guildId);
        if (spawnResult?.success && !spawnResult?.skipped) {
          spawned += 1;
        }
      } catch (error) {
        logger.warn(`[heist] spawn tick failed for ${guildId}: ${error?.message || error}`);
      }
    }

    const resolvedResults = await this.resolveDueMissions();
    resolved = resolvedResults.filter((entry) => entry?.success).length;
    return { success: true, guilds: guildIds.length, spawned, resolved };
  }

  _resolveTreasuryScanWallets(guildId, { includeDisabledFallback = false } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return [];
    const config = this.getConfig(normalizedGuildId);
    const sourceWalletAddress = String(config?.treasury_source_wallet_address || '').trim();
    const allWallets = this._listTreasurySourceWalletRows(normalizedGuildId, { includeDisabled: true });
    if (!allWallets.length) return [];

    if (sourceWalletAddress) {
      const selected = allWallets.find((wallet) => String(wallet?.address || '').trim() === sourceWalletAddress);
      if (!selected) {
        logger.warn(`[heist] configured treasury source wallet not found for guild ${normalizedGuildId}: ${sourceWalletAddress}`);
        return [];
      }
      return [selected];
    }

    const enabledWallets = allWallets.filter((wallet) => !!wallet.enabled);
    if (enabledWallets.length) return enabledWallets;
    return includeDisabledFallback ? allWallets : [];
  }

  async listTreasuryNfts(guildId, { limit = 500 } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return [];
    const safeLimit = Math.max(1, Math.min(5000, Number(limit || 500)));
    const wallets = this._resolveTreasuryScanWallets(normalizedGuildId, { includeDisabledFallback: true });
    if (!wallets.length) return [];

    const byMint = new Map();
    for (const wallet of wallets) {
      const walletAddress = String(wallet?.address || '').trim();
      if (!walletAddress) continue;
      let nfts = [];
      try {
        nfts = await nftService.getNFTsForWallet(walletAddress, { guildId: normalizedGuildId });
      } catch (error) {
        logger.warn(`[heist] treasury NFT fetch failed (${walletAddress}): ${error?.message || error}`);
      }
      for (const nft of (Array.isArray(nfts) ? nfts : [])) {
        const mint = String(nft?.mint || '').trim();
        if (!mint || byMint.has(mint)) continue;
        byMint.set(mint, {
          mint,
          name: String(nft?.name || '').trim() || mint.slice(0, 8),
          image: sanitizeImageUrl(nft?.image || '') || null,
          collectionKey: String(nft?.collectionKey || nft?.collection_key || '').trim() || null,
          attributes: Array.isArray(nft?.attributes) ? nft.attributes : [],
          walletAddress,
          walletLabel: String(wallet?.label || '').trim() || null,
        });
        if (byMint.size >= safeLimit) break;
      }
      if (byMint.size >= safeLimit) break;
    }

    return Array.from(byMint.values()).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
  }

  async listTreasuryTokens(guildId, { limit = 250 } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return [];
    const safeLimit = Math.max(1, Math.min(2000, Number(limit || 250)));
    const wallets = this._resolveTreasuryScanWallets(normalizedGuildId, { includeDisabledFallback: true });
    if (!wallets.length) return [];

    const byMint = new Map();
    for (const wallet of wallets) {
      const walletAddress = String(wallet?.address || '').trim();
      if (!walletAddress) continue;
      let balances = [];
      try {
        balances = await tokenService.getWalletTokenBalances(walletAddress, { guildId: normalizedGuildId });
      } catch (error) {
        logger.warn(`[heist] treasury token fetch failed (${walletAddress}): ${error?.message || error}`);
      }
      for (const token of (Array.isArray(balances) ? balances : [])) {
        const mint = String(token?.mint || '').trim();
        if (!mint) continue;
        const amount = Number(token?.amount || 0);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        const current = byMint.get(mint) || {
          mint,
          amount: 0,
          decimals: Number(token?.decimals || 0) || 0,
          walletCount: 0,
        };
        current.amount += amount;
        current.walletCount += 1;
        byMint.set(mint, current);
      }
    }

    return Array.from(byMint.values())
      .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))
      .slice(0, safeLimit);
  }

  listVaultItems(guildId, { includeDisabled = false } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return [];
    const rows = includeDisabled
      ? db.prepare('SELECT * FROM heist_vault_items WHERE guild_id = ? ORDER BY enabled DESC, cost_streetcredit ASC, id ASC').all(normalizedGuildId)
      : db.prepare('SELECT * FROM heist_vault_items WHERE guild_id = ? AND enabled = 1 ORDER BY cost_streetcredit ASC, id ASC').all(normalizedGuildId);
    return rows.map((row) => ({
      ...row,
      code_pool: safeJsonParse(row.code_pool_json, []),
      metadata: safeJsonParse(row.metadata_json, {}),
    }));
  }

  createVaultItem(guildId, payload = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    const name = String(payload.name || '').trim().slice(0, 120);
    if (!name) return { success: false, message: 'Item name is required' };
    const description = String(payload.description || '').trim().slice(0, 2000) || null;
    const cost = Math.max(0, parseNonNegativeInt(payload.cost_streetcredit ?? payload.costStreetcredit, 0));
    const requiredVaultTier = Math.max(0, parseNonNegativeInt(payload.required_vault_tier ?? payload.requiredVaultTier, 0));
    const rewardType = String(payload.reward_type || payload.rewardType || 'manual').trim().toLowerCase().slice(0, 40) || 'manual';
    const fulfillmentMode = String(payload.fulfillment_mode || payload.fulfillmentMode || 'manual').trim().toLowerCase().slice(0, 40) || 'manual';
    const roleId = String(payload.role_id || payload.roleId || '').trim() || null;
    const quantityRemaining = Number(payload.quantity_remaining ?? payload.quantityRemaining);
    const stock = Number.isFinite(quantityRemaining) ? Math.floor(quantityRemaining) : -1;
    const enabled = payload.enabled === undefined ? 1 : (payload.enabled ? 1 : 0);
    const codePool = Array.isArray(payload.code_pool || payload.codePool)
      ? (payload.code_pool || payload.codePool)
      : safeJsonParse(payload.code_pool_json, []);
    const metadata = typeof payload.metadata === 'object' && payload.metadata !== null
      ? payload.metadata
      : safeJsonParse(payload.metadata_json, {});

    db.prepare(`
      INSERT INTO heist_vault_items (
        guild_id, name, description, cost_streetcredit, required_vault_tier, reward_type, fulfillment_mode, role_id,
        code_pool_json, quantity_remaining, enabled, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizedGuildId,
      name,
      description,
      cost,
      requiredVaultTier,
      rewardType,
      fulfillmentMode,
      roleId,
      safeJsonStringify(codePool, '[]'),
      stock,
      enabled,
      safeJsonStringify(metadata, '{}')
    );
    return { success: true };
  }

  async importVaultCollectionItems(guildId, payload = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    const collectionKey = String(payload.collectionKey || payload.collection_key || '').trim();
    if (!collectionKey) return { success: false, message: 'collectionKey is required' };

    const cost = Math.max(0, parseNonNegativeInt(payload.cost_streetcredit ?? payload.costStreetcredit, 0));
    const requiredVaultTier = Math.max(0, parseNonNegativeInt(payload.required_vault_tier ?? payload.requiredVaultTier, 0));
    const quantityRemaining = Number(payload.quantity_remaining ?? payload.quantityRemaining);
    const stock = Number.isFinite(quantityRemaining) ? Math.floor(quantityRemaining) : -1;
    const enabled = payload.enabled === undefined ? 1 : (payload.enabled ? 1 : 0);
    const safeLimit = Math.max(1, Math.min(5000, parseNonNegativeInt(payload.limit, 1000) || 1000));

    const treasuryNfts = await this.listTreasuryNfts(normalizedGuildId, { limit: safeLimit });
    const normalizedCollectionKey = collectionKey.toLowerCase();
    const collectionNfts = treasuryNfts.filter((nft) => String(nft?.collectionKey || '').trim().toLowerCase() === normalizedCollectionKey);
    if (!collectionNfts.length) {
      return { success: false, message: `No treasury NFTs found for collection ${collectionKey}` };
    }

    const existingItems = this.listVaultItems(normalizedGuildId, { includeDisabled: true });
    const existingMints = new Set();
    for (const item of (Array.isArray(existingItems) ? existingItems : [])) {
      const mint = String(item?.metadata?.mint || '').trim();
      if (!mint) continue;
      existingMints.add(mint.toLowerCase());
    }

    let createdCount = 0;
    let skippedCount = 0;
    const now = nowIso();
    const tx = db.transaction(() => {
      for (const nft of collectionNfts) {
        const mint = String(nft?.mint || '').trim();
        if (!mint || existingMints.has(mint.toLowerCase())) {
          skippedCount += 1;
          continue;
        }

        const name = String(nft?.name || mint).trim().slice(0, 120) || mint.slice(0, 12);
        const description = `Treasury NFT reward (${mint})`;
        const metadata = {
          item_category: 'nft',
          source: 'treasury_nft',
          imported_at: now,
          mint,
          image: sanitizeImageUrl(nft?.image || '') || null,
          collectionKey: String(nft?.collectionKey || '').trim() || null,
          walletAddress: String(nft?.walletAddress || '').trim() || null,
          walletLabel: String(nft?.walletLabel || '').trim() || null,
        };

        db.prepare(`
          INSERT INTO heist_vault_items (
            guild_id, name, description, cost_streetcredit, required_vault_tier, reward_type, fulfillment_mode, role_id,
            code_pool_json, quantity_remaining, enabled, metadata_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          normalizedGuildId,
          name,
          description,
          cost,
          requiredVaultTier,
          'manual',
          'manual',
          null,
          '[]',
          stock,
          enabled,
          safeJsonStringify(metadata, '{}')
        );

        existingMints.add(mint.toLowerCase());
        createdCount += 1;
      }
    });

    tx();
    return {
      success: true,
      collectionKey,
      totalCount: collectionNfts.length,
      createdCount,
      skippedCount,
    };
  }

  updateVaultItem(guildId, itemId, payload = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    const existing = db.prepare('SELECT * FROM heist_vault_items WHERE guild_id = ? AND id = ?').get(normalizedGuildId, Number(itemId));
    if (!existing) return { success: false, message: 'Item not found' };

    const merged = {
      ...existing,
      ...payload,
      cost_streetcredit: payload.cost_streetcredit ?? payload.costStreetcredit ?? existing.cost_streetcredit,
      required_vault_tier: payload.required_vault_tier ?? payload.requiredVaultTier ?? existing.required_vault_tier,
      reward_type: payload.reward_type ?? payload.rewardType ?? existing.reward_type,
      fulfillment_mode: payload.fulfillment_mode ?? payload.fulfillmentMode ?? existing.fulfillment_mode,
      role_id: payload.role_id ?? payload.roleId ?? existing.role_id,
      quantity_remaining: payload.quantity_remaining ?? payload.quantityRemaining ?? existing.quantity_remaining,
      enabled: payload.enabled === undefined ? existing.enabled : (payload.enabled ? 1 : 0),
      code_pool_json: payload.code_pool_json ?? payload.codePool ?? existing.code_pool_json,
      metadata_json: payload.metadata_json ?? payload.metadata ?? existing.metadata_json,
    };

    const name = String(merged.name || '').trim().slice(0, 120);
    if (!name) return { success: false, message: 'Item name is required' };
    const description = String(merged.description || '').trim().slice(0, 2000) || null;
    const codePool = Array.isArray(merged.code_pool_json) ? merged.code_pool_json : safeJsonParse(merged.code_pool_json, []);
    const metadata = typeof merged.metadata_json === 'object' && merged.metadata_json !== null
      ? merged.metadata_json
      : safeJsonParse(merged.metadata_json, {});

    const result = db.prepare(`
      UPDATE heist_vault_items
      SET
        name = ?,
        description = ?,
        cost_streetcredit = ?,
        required_vault_tier = ?,
        reward_type = ?,
        fulfillment_mode = ?,
        role_id = ?,
        code_pool_json = ?,
        quantity_remaining = ?,
        enabled = ?,
        metadata_json = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND id = ?
    `).run(
      name,
      description,
      Math.max(0, parseNonNegativeInt(merged.cost_streetcredit, 0)),
      Math.max(0, parseNonNegativeInt(merged.required_vault_tier, 0)),
      String(merged.reward_type || 'manual').trim().toLowerCase().slice(0, 40) || 'manual',
      String(merged.fulfillment_mode || 'manual').trim().toLowerCase().slice(0, 40) || 'manual',
      String(merged.role_id || '').trim() || null,
      safeJsonStringify(codePool, '[]'),
      Number.isFinite(Number(merged.quantity_remaining)) ? Math.floor(Number(merged.quantity_remaining)) : -1,
      merged.enabled ? 1 : 0,
      safeJsonStringify(metadata, '{}'),
      normalizedGuildId,
      Number(itemId)
    );
    if (!result.changes) return { success: false, message: 'Item not found' };
    return { success: true };
  }

  deleteVaultItem(guildId, itemId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    const result = db.prepare('DELETE FROM heist_vault_items WHERE guild_id = ? AND id = ?').run(normalizedGuildId, Number(itemId));
    return result.changes > 0 ? { success: true } : { success: false, message: 'Item not found' };
  }

  listVaultRedemptions(guildId, { userId = null, limit = 100 } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return [];
    const safeLimit = Math.max(1, Math.min(500, Number(limit || 100)));
    if (userId) {
      const normalizedUserId = normalizeUserId(userId);
      return db.prepare(`
        SELECT r.*, i.name AS item_name, i.reward_type, i.fulfillment_mode
        FROM heist_vault_redemptions r
        LEFT JOIN heist_vault_items i ON i.id = r.item_id
        WHERE r.guild_id = ? AND r.user_id = ?
        ORDER BY r.created_at DESC
        LIMIT ?
      `).all(normalizedGuildId, normalizedUserId, safeLimit).map((row) => ({
        ...row,
        metadata: safeJsonParse(row.metadata_json, {}),
      }));
    }
    return db.prepare(`
      SELECT r.*, i.name AS item_name, i.reward_type, i.fulfillment_mode
      FROM heist_vault_redemptions r
      LEFT JOIN heist_vault_items i ON i.id = r.item_id
      WHERE r.guild_id = ?
      ORDER BY r.created_at DESC
      LIMIT ?
    `).all(normalizedGuildId, safeLimit).map((row) => ({
      ...row,
      metadata: safeJsonParse(row.metadata_json, {}),
    }));
  }

  updateVaultRedemptionStatus(guildId, redemptionId, payload = {}, actorUserId = null) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedRedemptionId = Number(redemptionId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    if (!Number.isFinite(normalizedRedemptionId) || normalizedRedemptionId <= 0) {
      return { success: false, message: 'Valid redemptionId is required' };
    }

    const nextStatus = String(payload.fulfillment_status || payload.fulfillmentStatus || '')
      .trim()
      .toLowerCase();
    const allowedStatuses = new Set(['pending', 'completed', 'cancelled', 'failed']);
    if (!allowedStatuses.has(nextStatus)) {
      return { success: false, message: 'fulfillment_status must be pending, completed, cancelled, or failed' };
    }

    const existing = db.prepare(`
      SELECT *
      FROM heist_vault_redemptions
      WHERE guild_id = ? AND id = ?
    `).get(normalizedGuildId, normalizedRedemptionId);
    if (!existing) return { success: false, message: 'Redemption not found' };

    const note = String(payload.note || payload.fulfillment_note || '').trim().slice(0, 1000);
    const metadata = safeJsonParse(existing.metadata_json, {});
    const nextMetadata = {
      ...metadata,
      lastStatusUpdateBy: actorUserId || null,
      lastStatusUpdateAt: nowIso(),
      ...(note ? { fulfillmentNote: note } : {}),
    };

    const result = db.prepare(`
      UPDATE heist_vault_redemptions
      SET
        fulfillment_status = ?,
        fulfilled_at = CASE
          WHEN ? = 'completed' THEN COALESCE(fulfilled_at, CURRENT_TIMESTAMP)
          ELSE fulfilled_at
        END,
        metadata_json = ?
      WHERE guild_id = ? AND id = ?
    `).run(
      nextStatus,
      nextStatus,
      safeJsonStringify(nextMetadata, '{}'),
      normalizedGuildId,
      normalizedRedemptionId
    );
    if (!result.changes) return { success: false, message: 'Redemption not found' };
    return { success: true };
  }

  async redeemVaultItem(guildId, userId, username, itemId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedGuildId || !normalizedUserId) {
      return { success: false, message: 'guildId and userId are required' };
    }

    const profile = this.getProfile(normalizedGuildId, normalizedUserId, username);
    if (!profile) return { success: false, message: 'Profile not found' };

    const item = db.prepare(`
      SELECT *
      FROM heist_vault_items
      WHERE guild_id = ? AND id = ? AND enabled = 1
    `).get(normalizedGuildId, Number(itemId));
    if (!item) return { success: false, message: 'Vault item not found' };
    const itemMetadata = safeJsonParse(item.metadata_json, {}) || {};
    const itemImageUrl = sanitizeImageUrl(
      itemMetadata.image_url
      || itemMetadata.imageUrl
      || itemMetadata.image
      || itemMetadata.item_image_url
      || itemMetadata.itemImageUrl
      || null
    );

    const cost = Math.max(0, Number(item.cost_streetcredit || 0));
    if (Number(profile.total_streetcredit || 0) < cost) {
      return { success: false, message: 'Insufficient Streetcredit balance' };
    }
    if (Number(profile.vault_tier || 0) < Number(item.required_vault_tier || 0)) {
      return { success: false, message: `Vault tier ${item.required_vault_tier} required` };
    }
    if (Number(item.quantity_remaining || -1) === 0) {
      return { success: false, message: 'Item is out of stock' };
    }

    let redemptionRecord = null;
    const tx = db.transaction(() => {
      const currentItem = db.prepare('SELECT * FROM heist_vault_items WHERE guild_id = ? AND id = ?').get(normalizedGuildId, Number(itemId));
      const currentProfile = db.prepare('SELECT * FROM heist_profiles WHERE guild_id = ? AND user_id = ?').get(normalizedGuildId, normalizedUserId);
      if (!currentItem || !currentProfile) throw new Error('Profile or item not found');
      if (Number(currentItem.quantity_remaining || -1) === 0) throw new Error('Item is out of stock');
      if (Number(currentProfile.total_streetcredit || 0) < cost) throw new Error('Insufficient Streetcredit balance');

      const nextStreetcredit = Math.max(0, Number(currentProfile.total_streetcredit || 0) - cost);
      db.prepare(`
        UPDATE heist_profiles
        SET total_streetcredit = ?, updated_at = CURRENT_TIMESTAMP
        WHERE guild_id = ? AND user_id = ?
      `).run(nextStreetcredit, normalizedGuildId, normalizedUserId);

      if (Number(currentItem.quantity_remaining || -1) > -1) {
        db.prepare(`
          UPDATE heist_vault_items
          SET quantity_remaining = quantity_remaining - 1, updated_at = CURRENT_TIMESTAMP
          WHERE guild_id = ? AND id = ?
        `).run(normalizedGuildId, Number(itemId));
      }

      const insertRedemption = db.prepare(`
        INSERT INTO heist_vault_redemptions (
          guild_id, user_id, username, item_id, cost_streetcredit, fulfillment_status, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const fulfillmentStatus = String(currentItem.fulfillment_mode || 'manual').toLowerCase() === 'auto' ? 'completed' : 'pending';
      const currentItemMetadata = safeJsonParse(currentItem.metadata_json, {}) || {};
      const currentItemImageUrl = sanitizeImageUrl(
        currentItemMetadata.image_url
        || currentItemMetadata.imageUrl
        || currentItemMetadata.image
        || currentItemMetadata.item_image_url
        || currentItemMetadata.itemImageUrl
        || null
      );
      const meta = {
        reward_type: currentItem.reward_type,
        fulfillment_mode: currentItem.fulfillment_mode,
        item_category: currentItemMetadata.item_category || currentItemMetadata.source || null,
        item_mint: currentItemMetadata.mint || null,
        item_collection: currentItemMetadata.collectionKey || null,
        item_image_url: currentItemImageUrl || null,
      };
      const redemptionInsert = insertRedemption.run(
        normalizedGuildId,
        normalizedUserId,
        String(username || '').trim() || null,
        Number(itemId),
        cost,
        fulfillmentStatus,
        safeJsonStringify(meta, '{}')
      );
      const redemptionId = Number(redemptionInsert.lastInsertRowid);
      redemptionRecord = db.prepare('SELECT * FROM heist_vault_redemptions WHERE id = ?').get(redemptionId);
      db.prepare(`
        INSERT INTO heist_events (guild_id, event_type, user_id, payload_json)
        VALUES (?, 'vault_redeem', ?, ?)
      `).run(
        normalizedGuildId,
        normalizedUserId,
        safeJsonStringify({ itemId: Number(itemId), redemptionId, cost }, '{}')
      );
    });

    try {
      tx();
    } catch (error) {
      return { success: false, message: String(error?.message || 'Failed to redeem item') };
    }

    // Manual fulfillment path: ticket if ticketing module is enabled, else log channel entry.
    try {
      const fulfillmentMode = String(item.fulfillment_mode || 'manual').trim().toLowerCase();
      if (fulfillmentMode === 'manual') {
        const { EmbedBuilder } = require('discord.js');
        const clientProvider = require('../utils/clientProvider');
        const settings = this.getConfig(normalizedGuildId);
        const context = tenantService.getTenantContext(normalizedGuildId);
        const ticketingEnabled = !!context?.modules?.ticketing;
        const moduleName = getModuleDisplayName('heist', normalizedGuildId);
        const redemptionEmbed = new EmbedBuilder()
          .setColor('#f4c430')
          .setTitle(`${moduleName} Vault Redemption`)
          .setDescription(`Manual fulfillment requested for **${item.name}**.`)
          .addFields(
            { name: 'Member', value: `<@${normalizedUserId}>`, inline: true },
            { name: 'Cost', value: `${cost} Streetcredit`, inline: true },
            { name: 'Redemption', value: `#${Number(redemptionRecord?.id || 0)}`, inline: true },
          )
          .setTimestamp();
        if (itemImageUrl) {
          redemptionEmbed.setImage(itemImageUrl);
        }
        const sendRedemptionPanel = async (channelId, mentionMember = false) => {
          const client = clientProvider.getClient();
          if (!client || !channelId) return null;
          const channel = await client.channels.fetch(String(channelId)).catch(() => null);
          if (!channel || !channel.isTextBased()) return null;
          return channel.send({
            content: mentionMember ? `<@${normalizedUserId}>` : undefined,
            embeds: [redemptionEmbed],
          }).catch(() => null);
        };

        if (ticketingEnabled) {
          const ticketService = require('./ticketService');
          const engagementConfig = settings?.metadata?.fulfillment_ticket_category_id
            || settings?.fulfillment_ticket_category_id
            || null;
          const categoryId = Number(engagementConfig || 0) || null;
          if (categoryId) {
            const ticketResult = await ticketService.createSystemTicketFromCategory(categoryId, {
              guildId: normalizedGuildId,
              openerId: normalizedUserId,
              openerName: username,
              title: `Vault Redemption #${redemptionRecord.id}`,
              intro: `Manual fulfillment requested for **${item.name}** (${cost} Streetcredit).`,
              templateResponses: {
                Item: item.name,
                Cost: `${cost}`,
                Redemption: `#${redemptionRecord.id}`,
                User: `<@${normalizedUserId}>`,
              },
            });
            if (ticketResult?.success) {
              const panelMessage = await sendRedemptionPanel(ticketResult.channelId, false);
              db.prepare(`
                UPDATE heist_vault_redemptions
                SET ticket_channel_id = ?, metadata_json = ?
                WHERE id = ?
              `).run(
                ticketResult.channelId || null,
                safeJsonStringify({
                  ...(safeJsonParse(redemptionRecord.metadata_json, {}) || {}),
                  ticketChannelId: ticketResult.channelId || null,
                  ticketNumber: ticketResult.ticketNumber || null,
                  ticketDetailsMessageId: panelMessage?.id || null,
                }, '{}'),
                Number(redemptionRecord.id)
              );
            }
          }
        } else if (settings?.vault_log_channel_id) {
          const message = await sendRedemptionPanel(settings.vault_log_channel_id, true);
          if (message?.id) {
            db.prepare(`
              UPDATE heist_vault_redemptions
              SET log_message_id = ?, metadata_json = ?
              WHERE id = ?
            `).run(
              message.id,
              safeJsonStringify({
                ...(safeJsonParse(redemptionRecord.metadata_json, {}) || {}),
                logMessageId: message.id,
              }, '{}'),
              Number(redemptionRecord.id)
            );
          }
        }
      }
    } catch (error) {
      logger.warn(`[heist] post-redemption side effect failed: ${error?.message || error}`);
    }

    return { success: true, redemption: redemptionRecord };
  }

  getPublicMissionPayload(guildId, missionRow, { includeSlots = false } = {}) {
    const mission = this._hydrateMission(missionRow, { includeSlots });
    if (!mission) return null;
    const payload = {
      missionId: mission.mission_id,
      guildId: mission.guild_id,
      templateId: mission.template_id,
      title: mission.title,
      description: mission.description,
      missionType: mission.mission_type,
      mode: mission.mode,
      status: mission.status,
      requiredSlots: mission.required_slots,
      totalSlots: mission.total_slots,
      filledSlots: mission.filled_slots,
      maxNftsPerUser: mission.max_nfts_per_user,
      baseXpReward: mission.base_xp_reward,
      baseStreetcreditReward: mission.base_streetcredit_reward,
      startedAt: mission.started_at,
      endsAt: mission.ends_at,
      resolvedAt: mission.resolved_at,
      spawnSource: mission.spawn_source,
      objective: mission.objective || [],
      traitRequirements: mission.trait_requirements || {},
      metadata: mission.metadata || {},
      imageUrl: mission.image_url || null,
      image_url: mission.image_url || null,
      createdAt: mission.created_at,
      updatedAt: mission.updated_at,
    };
    if (includeSlots) {
      payload.slots = (mission.slots || []).map((slot) => ({
        slotIndex: slot.slot_index,
        userId: slot.user_id,
        username: slot.username,
        nftMint: slot.nft_mint,
        nftName: slot.nft_name,
        status: slot.status,
        payoutXp: slot.payout_xp,
        payoutStreetcredit: slot.payout_streetcredit,
        failureReason: slot.failure_reason,
        joinedAt: slot.joined_at,
        resolvedAt: slot.resolved_at,
      }));
    }
    payload.moduleDisplayName = getModuleDisplayName('heist', guildId);
    return payload;
  }
}

module.exports = new HeistService();
