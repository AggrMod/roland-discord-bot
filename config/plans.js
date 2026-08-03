const MODULE_KEYS = Object.freeze([
  'verification',
  'governance',
  'treasury',
  'wallettracker',
  'invites',
  'minigames',
  'heist',
  'vault',
  'welcome',
  'ticketing',
  'nfttracker',
  'tokentracker',
  'selfserveroles',
  'branding',
  'analytics',
  'engagement',
  'guildguard',
  'aiassistant',
  'telegrambridge',
  'automessages'
]);

const PLAN_MARKETING = Object.freeze({
  starter: {
    displayLabel: 'Free',
    tagline: 'All core modules enabled. AI Assistant unlocks on Pro.',
    color: '#64748b',
    cta: 'Get Started Free',
    ctaAction: 'signup_free',
    features: [
      { label: 'All modules enabled except AI Assistant', included: true },
      { label: '3 verification rules', included: true },
      { label: '3 active governance proposals', included: true },
      { label: '3 ticket categories', included: true },
      { label: 'Invite tracking (30 days)', included: true },
      { label: 'Welcome flow (basic)', included: true },
      { label: 'Vault module (25 rewards)', included: true },
      { label: 'Engagement module (Discord)', included: true },
      { label: 'Engagement X provider', included: false },
      { label: 'AI assistant module', included: false },
      { label: 'Telegram Bridge module', included: false },
      { label: 'Auto Messages module', included: true },
      { label: 'Welcome image uploads', included: false },
      { label: 'Branding customization', included: false },
    ],
  },
  growth: {
    displayLabel: 'Growth',
    tagline: 'All core modules enabled with higher limits and X engagement.',
    color: '#6366f1',
    popular: true,
    cta: 'Start Growth',
    ctaAction: 'upgrade_growth',
    features: [
      { label: 'All modules enabled except AI Assistant', included: true },
      { label: '12 verification rules', included: true },
      { label: '25 active governance proposals', included: true },
      { label: '12 ticket categories', included: true },
      { label: 'Invite tracking (180 days + export)', included: true },
      { label: 'Welcome image uploads', included: true },
      { label: 'Vault module (100 rewards)', included: true },
      { label: 'Engagement module (Discord + X)', included: true },
      { label: 'AI assistant module', included: false },
      { label: 'Telegram Bridge module', included: true },
      { label: 'Auto Messages module', included: true },
      { label: 'Advanced branding customization', included: false },
    ],
  },
  pro: {
    displayLabel: 'Pro',
    tagline: 'All modules enabled, including AI Assistant and highest limits.',
    color: '#f59e0b',
    cta: 'Start Pro',
    ctaAction: 'upgrade_pro',
    features: [
      { label: 'All modules enabled', included: true },
      { label: '50 verification rules', included: true },
      { label: '100 active governance proposals', included: true },
      { label: '40 ticket categories', included: true },
      { label: 'Unlimited invite history + export', included: true },
      { label: 'Vault module (500 rewards)', included: true },
      { label: 'Engagement module (Discord + X)', included: true },
      { label: 'AI assistant (1000 req/day)', included: true },
      { label: 'Telegram Bridge module', included: true },
      { label: 'Auto Messages module', included: true },
      { label: 'Advanced branding customization', included: true },
      { label: 'Priority operational support', included: true },
    ],
  },
  custom: {
    displayLabel: 'Custom',
    tagline: 'Choose only the modules and capacity your community needs.',
    color: '#a78bfa',
    cta: 'Build Your Plan',
    ctaAction: 'build_custom',
    features: [
      { label: 'Choose individual GuildPilot modules', included: true },
      { label: 'Set capacity per selected module', included: true },
      { label: 'Instant transparent price calculation', included: true },
      { label: 'Monthly or annual billing', included: true },
    ],
  },
  enterprise: {
    displayLabel: 'Enterprise',
    tagline: 'Custom rollout and support bundles',
    color: '#10b981',
    cta: 'Contact Team',
    ctaAction: 'contact_enterprise',
    features: [
      { label: 'Unlimited module capacity', included: true },
      { label: 'Custom module limits', included: true },
      { label: 'Custom commercial terms', included: true },
      { label: 'Dedicated onboarding support', included: true },
    ],
  },
});

const PLAN_PRESETS = Object.freeze({
  starter: {
    key: 'starter',
    label: 'Free',
    description: 'All core modules enabled with starter limits. AI Assistant is Pro-only.',
    billing: {
      monthlyUsd: 0,
      annualDiscountPct: 16.67,
      annualBilledMonths: 10,
      earlyRenewalBilledMonths: 9,
      enterprise: false
    },
    limits: {
      max_commands: 20,
      max_enabled_modules: null,
      max_branding_profiles: 1,
      max_read_only_overrides: 0
    },
    moduleLimits: {
      verification: {
        max_rules_total: 3,
        max_tiers: 3,
        max_trait_rules: 3,
        max_token_rules: 3
      },
      governance: {
        max_active_proposals: 3
      },
      treasury: {
        max_wallets: 1
      },
      wallettracker: {
        max_tracked_wallets: 1
      },
      invites: {
        max_history_days: 30,
        max_leaderboard_rows: 10,
        allow_export: 0,
        allow_time_filters: 0
      },
      minigames: {
        max_bounties_per_battle: 0,
        max_enabled_games: 3
      },
      heist: {
        max_active_missions: 2
      },
      vault: {
        max_rewards: 25
      },
      welcome: {
        max_auto_roles: 2,
        max_channel_tokens: 1,
        max_step_fields: 2,
        allow_image_assets: 0
      },
      ticketing: {
        max_categories: 3
      },
      nfttracker: {
        max_collections: 1
      },
      tokentracker: {
        max_tokens: 1
      },
      selfserveroles: {
        max_panels: 1
      },
      branding: {
        max_profiles: 1
      },
      analytics: {},
      engagement: {
        max_shop_items: 3,
        allow_discord_provider: 1,
        allow_x_provider: 0,
      },
      guildguard: { max_incidents_per_day: 100, max_retention_days: 30, allow_ai_assistance: 0 },
      aiassistant: {
        max_requests_per_day: 0
      },
      telegrambridge: {
        max_sync_mappings: 1
      },
      automessages: {
        max_auto_messages: 3
      }
    },
    modules: {
      verification: true,
      governance: true,
      treasury: true,
      wallettracker: true,
      invites: true,
      minigames: true,
      heist: true,
      vault: true,
      welcome: true,
      ticketing: true,
      nfttracker: true,
      tokentracker: true,
      selfserveroles: true,
      branding: true,
      analytics: true,
      engagement: true,
      guildguard: true,
      aiassistant: false,
      telegrambridge: true,
      automessages: true
    }
  },
  growth: {
    key: 'growth',
    label: 'Growth',
    description: 'All core modules enabled with higher limits plus X engagement support.',
    billing: {
      monthlyUsd: 19.99,
      annualDiscountPct: 16.67,
      annualBilledMonths: 10,
      earlyRenewalBilledMonths: 9,
      enterprise: false
    },
    limits: {
      max_commands: 40,
      max_enabled_modules: null,
      max_branding_profiles: 1,
      max_read_only_overrides: 1
    },
    moduleLimits: {
      verification: {
        max_rules_total: 12,
        max_tiers: 8,
        max_trait_rules: 8,
        max_token_rules: 8
      },
      governance: {
        max_active_proposals: 25
      },
      treasury: {
        max_wallets: 10
      },
      wallettracker: {
        max_tracked_wallets: 25
      },
      invites: {
        max_history_days: 180,
        max_leaderboard_rows: 50,
        allow_export: 1,
        allow_time_filters: 1
      },
      minigames: {
        max_bounties_per_battle: 3,
        max_enabled_games: 8
      },
      heist: {
        max_active_missions: 10
      },
      vault: {
        max_rewards: 100
      },
      welcome: {
        max_auto_roles: 5,
        max_channel_tokens: 5,
        max_step_fields: 5,
        allow_image_assets: 1
      },
      ticketing: {
        max_categories: 12
      },
      nfttracker: {
        max_collections: 8
      },
      tokentracker: {
        max_tokens: 8
      },
      selfserveroles: {
        max_panels: 8
      },
      branding: {
        max_profiles: 1
      },
      analytics: {},
      engagement: {
        max_shop_items: 25,
        allow_discord_provider: 1,
        allow_x_provider: 1,
      },
      guildguard: { max_incidents_per_day: 1000, max_retention_days: 90, allow_ai_assistance: 0 },
      aiassistant: {
        max_requests_per_day: 0
      },
      telegrambridge: {
        max_sync_mappings: 5
      },
      automessages: {
        max_auto_messages: 10
      }
    },
    modules: {
      verification: true,
      governance: true,
      treasury: true,
      wallettracker: true,
      invites: true,
      minigames: true,
      heist: true,
      vault: true,
      welcome: true,
      ticketing: true,
      nfttracker: true,
      tokentracker: true,
      selfserveroles: true,
      branding: true,
      analytics: true,
      engagement: true,
      guildguard: true,
      aiassistant: false,
      telegrambridge: true,
      automessages: true
    }
  },
  pro: {
    key: 'pro',
    label: 'Pro',
    description: 'All modules enabled, including AI Assistant and expanded operational limits.',
    billing: {
      monthlyUsd: 49.99,
      annualDiscountPct: 16.67,
      annualBilledMonths: 10,
      earlyRenewalBilledMonths: 9,
      enterprise: false
    },
    limits: {
      max_commands: 80,
      max_enabled_modules: null,
      max_branding_profiles: 2,
      max_read_only_overrides: 2
    },
    moduleLimits: {
      verification: {
        max_rules_total: 50,
        max_tiers: 25,
        max_trait_rules: 25,
        max_token_rules: 25
      },
      governance: {
        max_active_proposals: 100
      },
      treasury: {
        max_wallets: 50
      },
      wallettracker: {
        max_tracked_wallets: 200
      },
      invites: {
        max_history_days: null,
        max_leaderboard_rows: 200,
        allow_export: 1,
        allow_time_filters: 1
      },
      minigames: {
        max_bounties_per_battle: 3,
        max_enabled_games: null
      },
      heist: {
        max_active_missions: 50
      },
      vault: {
        max_rewards: 500
      },
      welcome: {
        max_auto_roles: 20,
        max_channel_tokens: null,
        max_step_fields: 8,
        allow_image_assets: 1
      },
      ticketing: {
        max_categories: 40
      },
      nfttracker: {
        max_collections: 40
      },
      tokentracker: {
        max_tokens: 40
      },
      selfserveroles: {
        max_panels: 25
      },
      branding: {
        max_profiles: 2
      },
      analytics: {},
      engagement: {
        max_shop_items: 100,
        allow_discord_provider: 1,
        allow_x_provider: 1,
      },
      guildguard: { max_incidents_per_day: 10000, max_retention_days: 365, allow_ai_assistance: 1 },
      aiassistant: {
        max_requests_per_day: 1000
      },
      telegrambridge: {
        max_sync_mappings: 25
      },
      automessages: {
        max_auto_messages: 50
      }
    },
    modules: {
      verification: true,
      governance: true,
      treasury: true,
      wallettracker: true,
      invites: true,
      minigames: true,
      heist: true,
      vault: true,
      welcome: true,
      ticketing: true,
      nfttracker: true,
      tokentracker: true,
      selfserveroles: true,
      branding: true,
      analytics: true,
      engagement: true,
      guildguard: true,
      aiassistant: true,
      telegrambridge: true,
      automessages: true
    }
  },
  custom: {
    key: 'custom',
    label: 'Custom',
    description: 'A tenant-specific selection of modules and capacity limits.',
    billing: {
      monthlyUsd: null,
      annualDiscountPct: 16.67,
      annualBilledMonths: 10,
      earlyRenewalBilledMonths: 9,
      enterprise: false,
      custom: true
    },
    limits: {
      max_commands: 20,
      max_enabled_modules: 0,
      max_branding_profiles: 0,
      max_read_only_overrides: 0
    },
    moduleLimits: {},
    modules: Object.fromEntries(MODULE_KEYS.map(moduleKey => [moduleKey, false]))
  },
  enterprise: {
    key: 'enterprise',
    label: 'Enterprise',
    description: 'Maximum flexibility for custom tenant operations and support bundles.',
    billing: {
      monthlyUsd: null,
      annualDiscountPct: 16.67,
      annualBilledMonths: 10,
      earlyRenewalBilledMonths: 9,
      enterprise: true
    },
    limits: {
      max_commands: null,
      max_enabled_modules: null,
      max_branding_profiles: null,
      max_read_only_overrides: null
    },
    moduleLimits: {
      verification: {
        max_rules_total: null,
        max_tiers: null,
        max_trait_rules: null,
        max_token_rules: null
      },
      governance: {
        max_active_proposals: null
      },
      treasury: {
        max_wallets: null
      },
      wallettracker: {
        max_tracked_wallets: null
      },
      invites: {
        max_history_days: null,
        max_leaderboard_rows: null,
        allow_export: 1,
        allow_time_filters: 1
      },
      minigames: {
        max_bounties_per_battle: null,
        max_enabled_games: null
      },
      heist: {
        max_active_missions: null
      },
      vault: {
        max_rewards: null
      },
      welcome: {
        max_auto_roles: null,
        max_channel_tokens: null,
        max_step_fields: null,
        allow_image_assets: 1
      },
      ticketing: {
        max_categories: null
      },
      nfttracker: {
        max_collections: null
      },
      tokentracker: {
        max_tokens: null
      },
      selfserveroles: {
        max_panels: null
      },
      branding: {
        max_profiles: null
      },
      analytics: {},
      engagement: {
        max_shop_items: null,
        allow_discord_provider: 1,
        allow_x_provider: 1,
      },
      guildguard: { max_incidents_per_day: null, max_retention_days: null, allow_ai_assistance: 1 },
      aiassistant: {
        max_requests_per_day: null
      },
      telegrambridge: {
        max_sync_mappings: null
      },
      automessages: {
        max_auto_messages: null
      }
    },
    modules: {
      verification: true,
      governance: true,
      treasury: true,
      wallettracker: true,
      invites: true,
      minigames: true,
      heist: true,
      vault: true,
      welcome: true,
      ticketing: true,
      nfttracker: true,
      tokentracker: true,
      selfserveroles: true,
      branding: true,
      analytics: true,
      engagement: true,
      guildguard: true,
      aiassistant: true,
      telegrambridge: true,
      automessages: true
    }
  }
});

const CUSTOM_PLAN_BASE_MONTHLY_USD = 4.99;
const CUSTOM_PLAN_MIN_MONTHLY_USD = 9.99;
const CUSTOM_PLAN_CAPACITY_MULTIPLIERS = Object.freeze({
  starter: 0.6,
  growth: 1,
  pro: 1.75,
  unlimited: 2.75,
});
const CUSTOM_PLAN_MODULE_PRICING = Object.freeze({
  verification: { label: 'Wallet & role verification', monthlyUsd: 4.5 },
  governance: { label: 'Governance', monthlyUsd: 3.5 },
  treasury: { label: 'Treasury monitoring', monthlyUsd: 2.5 },
  wallettracker: { label: 'Wallet tracker', monthlyUsd: 3.5 },
  invites: { label: 'Invite analytics', monthlyUsd: 2.5 },
  minigames: { label: 'Minigames', monthlyUsd: 3 },
  heist: { label: 'Heist missions', monthlyUsd: 3.5 },
  vault: { label: 'Vault rewards', monthlyUsd: 4 },
  welcome: { label: 'Welcome & onboarding', monthlyUsd: 2.5 },
  ticketing: { label: 'Ticketing', monthlyUsd: 3 },
  nfttracker: { label: 'NFT tracker', monthlyUsd: 3.5 },
  tokentracker: { label: 'Token tracker', monthlyUsd: 3.5 },
  selfserveroles: { label: 'Self-service roles', monthlyUsd: 2 },
  branding: { label: 'Advanced branding', monthlyUsd: 3 },
  analytics: { label: 'Analytics', monthlyUsd: 2.5 },
  engagement: { label: 'Engagement & rewards', monthlyUsd: 4 },
  guildguard: { label: 'Guild Guard', monthlyUsd: 5 },
  aiassistant: { label: 'AI Assistant', monthlyUsd: 12 },
  telegrambridge: { label: 'Telegram Bridge', monthlyUsd: 4 },
  automessages: { label: 'Auto Messages', monthlyUsd: 2.5 },
});

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeCustomPlanConfig(input = {}) {
  const rawModules = Array.isArray(input?.modules)
    ? input.modules
    : Object.entries(input?.modules && typeof input.modules === 'object' ? input.modules : {})
      .filter(([, value]) => value !== false && value !== null)
      .map(([key, value]) => ({ key, ...(value && typeof value === 'object' ? value : {}) }));

  const seen = new Set();
  const modules = [];
  for (const rawSelection of rawModules) {
    const key = String(rawSelection?.key || rawSelection?.moduleKey || '').trim().toLowerCase();
    if (!MODULE_KEYS.includes(key) || seen.has(key)) continue;
    seen.add(key);

    const requestedCapacity = String(rawSelection?.capacity || rawSelection?.tier || 'growth').trim().toLowerCase();
    const capacity = Object.prototype.hasOwnProperty.call(CUSTOM_PLAN_CAPACITY_MULTIPLIERS, requestedCapacity)
      ? requestedCapacity
      : 'growth';
    const capacityPlanKey = capacity === 'unlimited' ? 'enterprise' : capacity;
    const defaults = cloneJson(PLAN_PRESETS[capacityPlanKey]?.moduleLimits?.[key] || {});
    const requestedLimits = rawSelection?.limits && typeof rawSelection.limits === 'object'
      ? rawSelection.limits
      : {};
    const limits = {};

    for (const [limitKey, defaultValue] of Object.entries(defaults)) {
      const requestedValue = requestedLimits[limitKey];
      if (limitKey.startsWith('allow_')) {
        limits[limitKey] = defaultValue === 1 && Number(requestedValue ?? defaultValue) > 0 ? 1 : 0;
        continue;
      }
      if (defaultValue === null) {
        if (requestedValue === null || requestedValue === undefined || requestedValue === '') {
          limits[limitKey] = null;
        } else {
          const numeric = Number(requestedValue);
          limits[limitKey] = Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : null;
        }
        continue;
      }
      const numeric = Number(requestedValue ?? defaultValue);
      limits[limitKey] = Number.isFinite(numeric)
        ? Math.max(0, Math.min(Math.floor(numeric), Number(defaultValue)))
        : Number(defaultValue);
    }

    modules.push({
      key,
      label: CUSTOM_PLAN_MODULE_PRICING[key]?.label || key,
      capacity,
      limits,
    });
  }

  if (!modules.length) {
    return { success: false, message: 'Select at least one module for a custom plan' };
  }

  return {
    success: true,
    config: {
      version: 1,
      modules,
    },
  };
}

function computeCustomPlanMonthlyUsd(input = {}) {
  const normalized = normalizeCustomPlanConfig(input);
  if (!normalized.success) return { ...normalized, monthlyUsd: null, breakdown: [] };

  const breakdown = normalized.config.modules.map((module) => {
    const base = Number(CUSTOM_PLAN_MODULE_PRICING[module.key]?.monthlyUsd || 0);
    const multiplier = Number(CUSTOM_PLAN_CAPACITY_MULTIPLIERS[module.capacity] || 1);
    return {
      key: module.key,
      label: module.label,
      capacity: module.capacity,
      monthlyUsd: Number((base * multiplier).toFixed(2)),
    };
  });
  const rawMonthly = CUSTOM_PLAN_BASE_MONTHLY_USD
    + breakdown.reduce((total, module) => total + module.monthlyUsd, 0);
  const monthlyUsd = Number(Math.max(CUSTOM_PLAN_MIN_MONTHLY_USD, rawMonthly).toFixed(2));

  return {
    success: true,
    config: normalized.config,
    monthlyUsd,
    breakdown,
    platformBaseMonthlyUsd: CUSTOM_PLAN_BASE_MONTHLY_USD,
  };
}

function getCustomPlanCatalog() {
  return {
    platformBaseMonthlyUsd: CUSTOM_PLAN_BASE_MONTHLY_USD,
    minimumMonthlyUsd: CUSTOM_PLAN_MIN_MONTHLY_USD,
    capacities: Object.keys(CUSTOM_PLAN_CAPACITY_MULTIPLIERS).map(key => ({
      key,
      label: key === 'starter' ? 'Light' : (key === 'unlimited' ? 'Unlimited' : `${key[0].toUpperCase()}${key.slice(1)} capacity`),
      multiplier: CUSTOM_PLAN_CAPACITY_MULTIPLIERS[key],
    })),
    modules: MODULE_KEYS.map(key => ({
      key,
      label: CUSTOM_PLAN_MODULE_PRICING[key]?.label || key,
      monthlyUsd: Number(CUSTOM_PLAN_MODULE_PRICING[key]?.monthlyUsd || 0),
    })),
  };
}

function normalizePlanKey(planKey) {
  return String(planKey || '').trim().toLowerCase();
}

function getPlanPreset(planKey) {
  return PLAN_PRESETS[normalizePlanKey(planKey)] || PLAN_PRESETS.starter;
}

function getPlanKeys() {
  return Object.keys(PLAN_PRESETS);
}

function getModuleKeys() {
  return [...MODULE_KEYS];
}

function getDefaultPlanKey() {
  return 'starter';
}

function getPlanModuleLimitDefaults(planKey) {
  const preset = getPlanPreset(planKey);
  return preset?.moduleLimits ? JSON.parse(JSON.stringify(preset.moduleLimits)) : {};
}

function getPlanCatalog() {
  return getPlanKeys().map((planKey) => {
    const preset = getPlanPreset(planKey);
    const marketing = PLAN_MARKETING[planKey] || {};
    return {
      key: planKey,
      label: marketing.displayLabel || preset?.label || planKey,
      internalLabel: preset?.label || planKey,
      description: preset?.description || '',
      billing: preset?.billing || null,
      tagline: marketing.tagline || '',
      color: marketing.color || '#6366f1',
      popular: !!marketing.popular,
      cta: marketing.cta || 'Choose Plan',
      ctaAction: marketing.ctaAction || '',
      features: Array.isArray(marketing.features) ? marketing.features.map((feature) => ({
        label: String(feature?.label || ''),
        included: feature?.included !== false,
      })) : [],
      customBuilder: planKey === 'custom' ? getCustomPlanCatalog() : null,
    };
  });
}

module.exports = {
  PLAN_MARKETING,
  PLAN_PRESETS,
  MODULE_KEYS,
  getDefaultPlanKey,
  getCustomPlanCatalog,
  computeCustomPlanMonthlyUsd,
  normalizeCustomPlanConfig,
  getPlanCatalog,
  getModuleKeys,
  getPlanModuleLimitDefaults,
  getPlanKeys,
  getPlanPreset,
  normalizePlanKey
};
