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
      battle: false,
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
      battle: true,
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
      battle: true,
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
      battle: true,
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
      battle: { max_bounties_per_battle: 3 },
      heist: { max_active_missions: 75 },
      engagement: { max_shop_items: 150 }
    }
  }
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

  applyTemplate(guildId, templateKey, actorId = 'system') {
    const template = this.getTemplate(templateKey);
    if (!template) {
      return { success: false, message: 'Unknown template' };
    }

    const before = tenantService.getTenantContext(guildId);
    if (!before?.tenant) {
      return { success: false, message: 'Tenant not found' };
    }

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

    for (const [moduleKey, entries] of Object.entries(template.limitOverrides || {})) {
      for (const [limitKey, limitValue] of Object.entries(entries || {})) {
        const limitResult = entitlementService.setTenantModuleOverride(guildId, moduleKey, limitKey, limitValue);
        if (!limitResult.success) {
          return { success: false, message: limitResult.message || `Failed to set limit ${moduleKey}.${limitKey}` };
        }
      }
    }

    const after = tenantService.getTenantContext(guildId);
    tenantService.logAudit(guildId, actorId, 'apply_template', before, {
      templateKey: template.key,
      templateLabel: template.label,
      tenant: after
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
}

module.exports = new MonetizationTemplateService();
