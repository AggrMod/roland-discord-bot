const tenantService = require('./tenantService');
const entitlementService = require('./entitlementService');

const TEMPLATE_CATALOG = Object.freeze([
  {
    key: 'starter-core',
    label: 'Starter Core',
    description: 'Free baseline with core verification and lightweight tracking.',
    planKey: 'starter',
    modules: {
      verification: true,
      governance: true,
      treasury: true,
      wallettracker: true,
      ticketing: true,
      nfttracker: true,
      tokentracker: true,
      selfserveroles: true,
      branding: true,
      minigames: false,
      heist: false,
      engagement: false
    },
    limitOverrides: {}
  },
  {
    key: 'growth-support',
    label: 'Growth Support',
    description: 'Community support setup with stronger ticketing + verification limits.',
    planKey: 'growth',
    modules: {
      verification: true,
      governance: true,
      treasury: true,
      wallettracker: true,
      ticketing: true,
      nfttracker: true,
      tokentracker: true,
      selfserveroles: true,
      branding: true,
      minigames: true,
      heist: false,
      engagement: true
    },
    limitOverrides: {
      ticketing: { max_categories: 15 },
      verification: { max_rules_total: 15, max_tiers: 10, max_trait_rules: 10, max_token_rules: 10 }
    }
  },
  {
    key: 'pro-full',
    label: 'Pro Full Stack',
    description: 'All modules enabled with high Pro limits and growth-ready defaults.',
    planKey: 'pro',
    modules: {
      verification: true,
      governance: true,
      treasury: true,
      wallettracker: true,
      minigames: true,
      heist: true,
      ticketing: true,
      nfttracker: true,
      tokentracker: true,
      selfserveroles: true,
      branding: true,
      analytics: true,
      engagement: true
    },
    limitOverrides: {}
  },
  {
    key: 'gaming-focus',
    label: 'Gaming Focus',
    description: 'Battle/games-heavy setup with engagement + heist prioritized.',
    planKey: 'pro',
    modules: {
      verification: true,
      governance: false,
      treasury: true,
      wallettracker: true,
      minigames: true,
      heist: true,
      ticketing: true,
      nfttracker: true,
      tokentracker: true,
      selfserveroles: true,
      branding: true,
      analytics: true,
      engagement: true
    },
    limitOverrides: {
      minigames: { max_bounties_per_battle: 3 },
      heist: { max_active_missions: 75 },
      engagement: { max_shop_items: 150 }
    }
  }
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeLimitValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.floor(numeric);
}

function normalizeLimitOverrides(overrides) {
  const definitions = entitlementService.getLimitDefinitions();
  const normalized = {};
  for (const [rawModuleKey, rawLimitMap] of Object.entries(overrides || {})) {
    const moduleKey = String(rawModuleKey || '').trim().toLowerCase();
    if (!moduleKey || !definitions[moduleKey]) continue;
    if (!rawLimitMap || typeof rawLimitMap !== 'object') continue;
    for (const [rawLimitKey, rawValue] of Object.entries(rawLimitMap)) {
      const limitKey = String(rawLimitKey || '').trim().toLowerCase();
      if (!limitKey || !definitions[moduleKey][limitKey]) continue;
      const normalizedValue = normalizeLimitValue(rawValue);
      if (!normalized[moduleKey]) normalized[moduleKey] = {};
      normalized[moduleKey][limitKey] = normalizedValue;
    }
  }
  return normalized;
}

function mergeModuleLimits(planLimits, overrides) {
  const merged = clone(planLimits || {});
  for (const [moduleKey, limitMap] of Object.entries(overrides || {})) {
    if (!merged[moduleKey]) merged[moduleKey] = {};
    for (const [limitKey, limitValue] of Object.entries(limitMap || {})) {
      merged[moduleKey][limitKey] = limitValue;
    }
  }
  return merged;
}

function getModuleChanges(beforeModules, afterModules) {
  const changes = [];
  const moduleKeys = new Set([
    ...Object.keys(beforeModules || {}),
    ...Object.keys(afterModules || {}),
  ]);
  for (const moduleKey of moduleKeys) {
    const before = !!beforeModules?.[moduleKey];
    const after = !!afterModules?.[moduleKey];
    if (before === after) continue;
    changes.push({ moduleKey, before, after });
  }
  return changes.sort((a, b) => a.moduleKey.localeCompare(b.moduleKey));
}

function flattenLimits(limitMap) {
  const flattened = {};
  for (const [moduleKey, limits] of Object.entries(limitMap || {})) {
    for (const [limitKey, value] of Object.entries(limits || {})) {
      flattened[`${moduleKey}.${limitKey}`] = value === undefined ? null : value;
    }
  }
  return flattened;
}

function getLimitChanges(beforeLimits, afterLimits) {
  const beforeFlat = flattenLimits(beforeLimits);
  const afterFlat = flattenLimits(afterLimits);
  const keys = new Set([
    ...Object.keys(beforeFlat),
    ...Object.keys(afterFlat),
  ]);

  const changes = [];
  for (const key of keys) {
    const [moduleKey, limitKey] = key.split('.');
    const before = beforeFlat[key] === undefined ? null : beforeFlat[key];
    const after = afterFlat[key] === undefined ? null : afterFlat[key];
    if (before === after) continue;
    changes.push({ moduleKey, limitKey, before, after });
  }
  return changes.sort((a, b) => {
    const moduleCmp = a.moduleKey.localeCompare(b.moduleKey);
    if (moduleCmp !== 0) return moduleCmp;
    return a.limitKey.localeCompare(b.limitKey);
  });
}

function safeParseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

class MonetizationTemplateService {
  listTemplates() {
    return TEMPLATE_CATALOG.map(template => ({
      key: template.key,
      label: template.label,
      description: template.description,
      planKey: template.planKey,
      modules: clone(template.modules || {}),
      limitOverrides: clone(template.limitOverrides || {}),
    }));
  }

  getTemplate(templateKey) {
    const normalized = String(templateKey || '').trim().toLowerCase();
    return TEMPLATE_CATALOG.find(template => template.key === normalized) || null;
  }

  syncTenantOverrides(guildId, desiredOverridesRaw) {
    const desiredOverrides = normalizeLimitOverrides(desiredOverridesRaw || {});
    const currentOverrides = entitlementService.getTenantModuleOverrides(guildId);

    for (const [moduleKey, entries] of Object.entries(currentOverrides || {})) {
      for (const limitKey of Object.keys(entries || {})) {
        const keep = Object.prototype.hasOwnProperty.call(desiredOverrides?.[moduleKey] || {}, limitKey);
        if (keep) continue;
        const clearResult = entitlementService.setTenantModuleOverride(guildId, moduleKey, limitKey, null);
        if (!clearResult.success) {
          return { success: false, message: clearResult.message || `Failed to clear limit ${moduleKey}.${limitKey}` };
        }
      }
    }

    for (const [moduleKey, entries] of Object.entries(desiredOverrides || {})) {
      for (const [limitKey, limitValue] of Object.entries(entries || {})) {
        const limitResult = entitlementService.setTenantModuleOverride(guildId, moduleKey, limitKey, limitValue);
        if (!limitResult.success) {
          return { success: false, message: limitResult.message || `Failed to set limit ${moduleKey}.${limitKey}` };
        }
      }
    }

    return { success: true };
  }

  previewTemplate(guildId, templateKey) {
    const template = this.getTemplate(templateKey);
    if (!template) {
      return { success: false, message: 'Unknown template' };
    }

    const beforeContext = tenantService.getTenantContext(guildId);
    if (!beforeContext?.tenant) {
      return { success: false, message: 'Tenant not found' };
    }

    const beforeSnapshot = entitlementService.getTenantLimitSnapshot(guildId);
    const beforePlanKey = beforeContext.planKey;
    const beforeModules = clone(beforeContext.modules || {});
    const beforeOverrides = clone(beforeSnapshot?.overrides || {});
    const beforeEffective = clone(beforeSnapshot?.effective || {});

    const afterPlanKey = template.planKey;
    const afterModules = clone(beforeModules);
    for (const [moduleKey, enabled] of Object.entries(template.modules || {})) {
      afterModules[moduleKey] = !!enabled;
    }

    const afterOverrides = normalizeLimitOverrides(template.limitOverrides || {});
    const afterEffective = mergeModuleLimits(
      entitlementService.getPlanModuleLimits(afterPlanKey),
      afterOverrides
    );

    return {
      success: true,
      template: {
        key: template.key,
        label: template.label,
        description: template.description,
        planKey: template.planKey,
      },
      preview: {
        before: {
          planKey: beforePlanKey,
          modules: beforeModules,
          overrides: beforeOverrides,
          effective: beforeEffective,
        },
        after: {
          planKey: afterPlanKey,
          modules: afterModules,
          overrides: afterOverrides,
          effective: afterEffective,
        },
        diff: {
          planChanged: beforePlanKey !== afterPlanKey,
          plan: { before: beforePlanKey, after: afterPlanKey },
          modules: getModuleChanges(beforeModules, afterModules),
          overrides: getLimitChanges(beforeOverrides, afterOverrides),
          effective: getLimitChanges(beforeEffective, afterEffective),
        },
      },
    };
  }

  applyTemplate(guildId, templateKey, actorId = 'system') {
    const template = this.getTemplate(templateKey);
    if (!template) {
      return { success: false, message: 'Unknown template' };
    }

    const before = tenantService.getTenantContext(guildId);
    if (!before?.tenant) {
      return { success: false, message: 'Tenant not found' };
    }
    const beforeLimitSnapshot = entitlementService.getTenantLimitSnapshot(guildId);

    const planResult = tenantService.setTenantPlan(guildId, template.planKey, actorId);
    if (!planResult.success) {
      return { success: false, message: planResult.message || 'Failed to apply template plan' };
    }

    for (const [moduleKey, enabled] of Object.entries(template.modules || {})) {
      const moduleResult = tenantService.setTenantModule(guildId, moduleKey, !!enabled, actorId);
      if (!moduleResult.success) {
        return { success: false, message: moduleResult.message || `Failed to set module ${moduleKey}` };
      }
    }

    const overrideSyncResult = this.syncTenantOverrides(guildId, template.limitOverrides || {});
    if (!overrideSyncResult.success) {
      return overrideSyncResult;
    }

    const after = tenantService.getTenantContext(guildId);
    const afterLimitSnapshot = entitlementService.getTenantLimitSnapshot(guildId);
    tenantService.logAudit(guildId, actorId, 'apply_template', {
      tenant: before,
      limitSnapshot: beforeLimitSnapshot,
    }, {
      templateKey: template.key,
      templateLabel: template.label,
      tenant: after,
      limitSnapshot: afterLimitSnapshot,
    });

    return {
      success: true,
      template: {
        key: template.key,
        label: template.label,
        description: template.description
      },
      tenant: after
    };
  }

  rollbackLastTemplate(guildId, actorId = 'system') {
    const logs = tenantService.getTenantAuditLogs(guildId, 100);
    const templateLog = logs.find(log => String(log.action || '').trim().toLowerCase() === 'apply_template');
    if (!templateLog) {
      return { success: false, message: 'No template apply audit entry found for rollback' };
    }

    const beforePayload = safeParseJson(templateLog.before_json, {});
    const beforeTenant = beforePayload?.tenant && typeof beforePayload.tenant === 'object'
      ? beforePayload.tenant
      : (beforePayload && typeof beforePayload === 'object' ? beforePayload : null);
    if (!beforeTenant?.tenant || !beforeTenant?.planKey) {
      return { success: false, message: 'Rollback snapshot is incomplete for this tenant' };
    }

    const beforeOverrides = beforePayload?.limitSnapshot?.overrides || {};
    const currentBefore = tenantService.getTenantContext(guildId);

    const planResult = tenantService.setTenantPlan(guildId, beforeTenant.planKey, actorId);
    if (!planResult.success) {
      return { success: false, message: planResult.message || 'Failed restoring previous plan' };
    }

    for (const [moduleKey, enabled] of Object.entries(beforeTenant.modules || {})) {
      const moduleResult = tenantService.setTenantModule(guildId, moduleKey, !!enabled, actorId);
      if (!moduleResult.success) {
        return { success: false, message: moduleResult.message || `Failed restoring module ${moduleKey}` };
      }
    }

    const overrideSyncResult = this.syncTenantOverrides(guildId, beforeOverrides);
    if (!overrideSyncResult.success) {
      return overrideSyncResult;
    }

    const after = tenantService.getTenantContext(guildId);
    const afterLimitSnapshot = entitlementService.getTenantLimitSnapshot(guildId);
    tenantService.logAudit(guildId, actorId, 'rollback_template', {
      sourceAuditId: templateLog.id,
      tenant: currentBefore,
    }, {
      sourceAuditId: templateLog.id,
      tenant: after,
      limitSnapshot: afterLimitSnapshot,
    });

    return {
      success: true,
      rolledBackFromAuditId: templateLog.id,
      tenant: after,
    };
  }
}

module.exports = new MonetizationTemplateService();
