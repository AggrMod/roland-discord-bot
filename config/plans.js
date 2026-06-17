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
  'aiassistant',
  'telegrambridge'
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
      { label: 'Advanced branding customization', included: true },
      { label: 'Priority operational support', included: true },
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
      annualDiscountPct: 15,
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
      aiassistant: {
        max_requests_per_day: 0
      },
      telegrambridge: {
        max_sync_mappings: 1
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
      aiassistant: false,
      telegrambridge: true
    }
  },
  growth: {
    key: 'growth',
    label: 'Growth',
    description: 'All core modules enabled with higher limits plus X engagement support.',
    billing: {
      monthlyUsd: 19.99,
      annualDiscountPct: 15,
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
      aiassistant: {
        max_requests_per_day: 0
      },
      telegrambridge: {
        max_sync_mappings: 5
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
      aiassistant: false,
      telegrambridge: true
    }
  },
  pro: {
    key: 'pro',
    label: 'Pro',
    description: 'All modules enabled, including AI Assistant and expanded operational limits.',
    billing: {
      monthlyUsd: 49.99,
      annualDiscountPct: 15,
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
      aiassistant: {
        max_requests_per_day: 1000
      },
      telegrambridge: {
        max_sync_mappings: 25
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
      aiassistant: true,
      telegrambridge: true
    }
  },
  enterprise: {
    key: 'enterprise',
    label: 'Enterprise',
    description: 'Maximum flexibility for custom tenant operations and support bundles.',
    billing: {
      monthlyUsd: null,
      annualDiscountPct: 15,
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
      aiassistant: {
        max_requests_per_day: null
      },
      telegrambridge: {
        max_sync_mappings: null
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
      aiassistant: true,
      telegrambridge: true
    }
  }
});

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
    };
  });
}

module.exports = {
  PLAN_MARKETING,
  PLAN_PRESETS,
  MODULE_KEYS,
  getDefaultPlanKey,
  getPlanCatalog,
  getModuleKeys,
  getPlanModuleLimitDefaults,
  getPlanKeys,
  getPlanPreset,
  normalizePlanKey
};
