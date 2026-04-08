const db = require('../database/db');
const {
  getDefaultPlanKey,
  getModuleKeys,
  getPlanKeys,
  getPlanModuleLimitDefaults,
  getPlanPreset,
  normalizePlanKey,
} = require('../config/plans');

const MODULE_KEYS = new Set(getModuleKeys());
const PLAN_KEYS = new Set(getPlanKeys());

const LIMIT_DEFINITIONS = Object.freeze({
  verification: {
    max_rules_total: { label: 'Max Verification Rules (Total)' },
    max_tiers: { label: 'Max NFT Collection Rules' },
    max_trait_rules: { label: 'Max NFT Trait Rules' },
    max_token_rules: { label: 'Max Token Rules' },
  },
  governance: {
    max_active_proposals: { label: 'Max Active Proposals' },
  },
  treasury: {
    max_wallets: { label: 'Max Treasury Wallets' },
  },
  wallettracker: {
    max_tracked_wallets: { label: 'Max Wallet Tracker Wallets' },
  },
  heist: {
    max_active_missions: { label: 'Max Active Missions' },
  },
  ticketing: {
    max_categories: { label: 'Max Ticket Categories' },
  },
  nfttracker: {
    max_collections: { label: 'Max NFT Collections' },
  },
  tokentracker: {
    max_tokens: { label: 'Max Tracked Tokens' },
  },
  selfserveroles: {
    max_panels: { label: 'Max Role Panels' },
  },
  battle: {
    max_bounties_per_battle: { label: 'Max Bounties Per Battle' },
  },
  engagement: {
    max_shop_items: { label: 'Max Shop Items' },
  },
});

function normalizeGuildId(guildId) {
  if (typeof guildId !== 'string') return '';
  const trimmed = guildId.trim();
  return /^\d{17,20}$/.test(trimmed) ? trimmed : '';
}

function normalizeModuleKey(moduleKey) {
  const normalized = String(moduleKey || '').trim().toLowerCase();
  return MODULE_KEYS.has(normalized) ? normalized : '';
}

function normalizeLimitKey(limitKey) {
  return String(limitKey || '').trim().toLowerCase();
}

function normalizeLimitValue(limitValue) {
  if (limitValue === null || limitValue === undefined || limitValue === '') {
    return null;
  }

  const numeric = Number(limitValue);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return Number.NaN;
  }

  return Math.floor(numeric);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

class EntitlementService {
  constructor() {
    this.planDefaultsSeeded = false;
  }

  getLimitDefinitions() {
    return deepClone(LIMIT_DEFINITIONS);
  }

  ensurePlanLimitDefaultsSeeded() {
    if (this.planDefaultsSeeded) return;

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO plan_module_limits (plan_key, module_key, limit_key, limit_value)
      VALUES (?, ?, ?, ?)
    `);

    const seedTxn = db.transaction(() => {
      for (const planKey of getPlanKeys()) {
        const defaults = getPlanModuleLimitDefaults(planKey);
        for (const [moduleKey, moduleLimits] of Object.entries(defaults || {})) {
          if (!moduleLimits || typeof moduleLimits !== 'object') continue;
          for (const [limitKey, limitValue] of Object.entries(moduleLimits)) {
            const normalizedValue = normalizeLimitValue(limitValue);
            if (Number.isNaN(normalizedValue)) continue;
            insertStmt.run(planKey, moduleKey, limitKey, normalizedValue);
          }
        }
      }
    });

    seedTxn();
    this.planDefaultsSeeded = true;
  }

  ensureTenantRecord(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return null;

    // Lazy require prevents circular import issues at module load time.
    const tenantService = require('./tenantService');
    const tenant = tenantService.ensureTenant(normalizedGuildId);
    return tenant?.tenant || null;
  }

  getPlanModuleLimits(planKey) {
    this.ensurePlanLimitDefaultsSeeded();
    const normalizedPlanKey = normalizePlanKey(planKey);
    const effectivePlanKey = PLAN_KEYS.has(normalizedPlanKey) ? normalizedPlanKey : getDefaultPlanKey();
    const defaults = getPlanModuleLimitDefaults(effectivePlanKey);
    const result = deepClone(defaults);

    const rows = db.prepare(`
      SELECT module_key, limit_key, limit_value
      FROM plan_module_limits
      WHERE plan_key = ?
      ORDER BY module_key ASC, limit_key ASC
    `).all(effectivePlanKey);

    for (const row of rows) {
      if (!result[row.module_key]) result[row.module_key] = {};
      result[row.module_key][row.limit_key] = row.limit_value === null ? null : Number(row.limit_value);
    }

    return result;
  }

  setPlanModuleLimit(planKey, moduleKey, limitKey, limitValue) {
    this.ensurePlanLimitDefaultsSeeded();
    const normalizedPlanKey = normalizePlanKey(planKey);
    const normalizedModuleKey = normalizeModuleKey(moduleKey);
    const normalizedLimitKey = normalizeLimitKey(limitKey);
    const normalizedLimitValue = normalizeLimitValue(limitValue);

    if (!PLAN_KEYS.has(normalizedPlanKey)) return { success: false, message: 'Invalid plan key' };
    if (!normalizedModuleKey) return { success: false, message: 'Invalid module key' };
    if (!normalizedLimitKey) return { success: false, message: 'Invalid limit key' };
    if (Number.isNaN(normalizedLimitValue)) return { success: false, message: 'limitValue must be null or a non-negative number' };

    if (limitValue === null || limitValue === undefined || limitValue === '') {
      db.prepare(`
        DELETE FROM plan_module_limits
        WHERE plan_key = ? AND module_key = ? AND limit_key = ?
      `).run(normalizedPlanKey, normalizedModuleKey, normalizedLimitKey);
    } else {
      db.prepare(`
        INSERT INTO plan_module_limits (plan_key, module_key, limit_key, limit_value)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(plan_key, module_key, limit_key) DO UPDATE SET
          limit_value = excluded.limit_value,
          updated_at = CURRENT_TIMESTAMP
      `).run(normalizedPlanKey, normalizedModuleKey, normalizedLimitKey, normalizedLimitValue);
    }

    return { success: true };
  }

  getTenantModuleOverrides(guildId) {
    const tenant = this.ensureTenantRecord(guildId);
    if (!tenant?.id) return {};

    const rows = db.prepare(`
      SELECT module_key, limit_key, limit_value
      FROM tenant_module_limit_overrides
      WHERE tenant_id = ?
      ORDER BY module_key ASC, limit_key ASC
    `).all(tenant.id);

    const overrides = {};
    for (const row of rows) {
      if (!overrides[row.module_key]) overrides[row.module_key] = {};
      overrides[row.module_key][row.limit_key] = row.limit_value === null ? null : Number(row.limit_value);
    }
    return overrides;
  }

  setTenantModuleOverride(guildId, moduleKey, limitKey, limitValue) {
    const tenant = this.ensureTenantRecord(guildId);
    const normalizedModuleKey = normalizeModuleKey(moduleKey);
    const normalizedLimitKey = normalizeLimitKey(limitKey);
    const normalizedLimitValue = normalizeLimitValue(limitValue);

    if (!tenant?.id) return { success: false, message: 'Tenant not found' };
    if (!normalizedModuleKey) return { success: false, message: 'Invalid module key' };
    if (!normalizedLimitKey) return { success: false, message: 'Invalid limit key' };
    if (Number.isNaN(normalizedLimitValue)) return { success: false, message: 'limitValue must be null or a non-negative number' };

    if (limitValue === null || limitValue === undefined || limitValue === '') {
      db.prepare(`
        DELETE FROM tenant_module_limit_overrides
        WHERE tenant_id = ? AND module_key = ? AND limit_key = ?
      `).run(tenant.id, normalizedModuleKey, normalizedLimitKey);
    } else {
      db.prepare(`
        INSERT INTO tenant_module_limit_overrides (tenant_id, module_key, limit_key, limit_value)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(tenant_id, module_key, limit_key) DO UPDATE SET
          limit_value = excluded.limit_value,
          updated_at = CURRENT_TIMESTAMP
      `).run(tenant.id, normalizedModuleKey, normalizedLimitKey, normalizedLimitValue);
    }

    return { success: true };
  }

  getEffectiveModuleLimits(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return {};

    const tenantService = require('./tenantService');
    const tenantContext = tenantService.getTenantContext(normalizedGuildId);
    const planKey = tenantContext?.planKey || getDefaultPlanKey();
    const planLimits = this.getPlanModuleLimits(planKey);
    const overrides = this.getTenantModuleOverrides(normalizedGuildId);
    const merged = deepClone(planLimits);

    for (const [moduleKey, limitMap] of Object.entries(overrides)) {
      if (!merged[moduleKey]) merged[moduleKey] = {};
      for (const [limitKey, limitValue] of Object.entries(limitMap || {})) {
        merged[moduleKey][limitKey] = limitValue;
      }
    }

    return merged;
  }

  getEffectiveLimit(guildId, moduleKey, limitKey) {
    const normalizedModuleKey = normalizeModuleKey(moduleKey);
    const normalizedLimitKey = normalizeLimitKey(limitKey);
    if (!normalizedModuleKey || !normalizedLimitKey) return null;

    const limits = this.getEffectiveModuleLimits(guildId);
    if (!limits[normalizedModuleKey]) return null;
    if (!Object.prototype.hasOwnProperty.call(limits[normalizedModuleKey], normalizedLimitKey)) return null;

    const value = limits[normalizedModuleKey][normalizedLimitKey];
    if (value === null || value === undefined) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  enforceLimit({ guildId, moduleKey, limitKey, currentCount, incrementBy = 1, itemLabel = 'items' }) {
    const normalizedCurrent = Number(currentCount);
    const current = Number.isFinite(normalizedCurrent) ? normalizedCurrent : 0;
    const nextCount = current + Math.max(Number(incrementBy) || 0, 0);
    const limit = this.getEffectiveLimit(guildId, moduleKey, limitKey);

    if (limit === null || limit === undefined) {
      return {
        success: true,
        allowed: true,
        limit: null,
        used: current,
        remaining: null,
      };
    }

    if (nextCount > limit) {
      return {
        success: false,
        allowed: false,
        limit,
        used: current,
        remaining: Math.max(0, limit - current),
        message: `Limit reached: ${limit} ${itemLabel} allowed for this server plan/module.`,
      };
    }

    return {
      success: true,
      allowed: true,
      limit,
      used: current,
      remaining: Math.max(0, limit - nextCount),
    };
  }

  getTenantLimitSnapshot(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return null;

    const tenantService = require('./tenantService');
    const tenantContext = tenantService.getTenantContext(normalizedGuildId);
    if (!tenantContext?.tenant) return null;

    const planPreset = getPlanPreset(tenantContext.planKey || getDefaultPlanKey());
    const planLimits = this.getPlanModuleLimits(tenantContext.planKey);
    const overrides = this.getTenantModuleOverrides(normalizedGuildId);
    const effective = this.getEffectiveModuleLimits(normalizedGuildId);

    return {
      guildId: normalizedGuildId,
      planKey: tenantContext.planKey,
      planLabel: planPreset.label,
      definitions: this.getLimitDefinitions(),
      planLimits,
      overrides,
      effective,
    };
  }
}

module.exports = new EntitlementService();
