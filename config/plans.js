const MODULE_KEYS = Object.freeze([
  'verification',
  'governance',
  'treasury',
  'wallettracker',
  'invites',
  'minigames',
  'heist',
  'ticketing',
  'nfttracker',
  'tokentracker',
  'selfserveroles',
  'branding',
  'analytics',
  'engagement',
  'aiassistant'
]);

const PLAN_PRESETS = Object.freeze({
  starter: {
    key: 'starter',
    label: 'Starter',
    description: 'Foundational tenant bundle for verification, governance, and support.',
    billing: {
      monthlyUsd: 0,
      annualDiscountPct: 15,
      enterprise: false
    },
    limits: {
      max_commands: 20,
      max_enabled_modules: 4,
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
        max_shop_items: 3
      },
      aiassistant: {
        max_requests_per_day: 0
      }
    },
    modules: {
      verification: true,
      governance: true,
      treasury: true,
      wallettracker: true,
      invites: true,
      minigames: false,
      heist: false,
      ticketing: true,
      nfttracker: true,
      tokentracker: true,
      selfserveroles: true,
      branding: true,
      analytics: true,
      engagement: false,
      aiassistant: false
    }
  },
  growth: {
    key: 'growth',
    label: 'Growth',
    description: 'Adds treasury, NFT tracking, and stronger self-service controls.',
    billing: {
      monthlyUsd: 19.99,
      annualDiscountPct: 15,
      enterprise: false
    },
    limits: {
      max_commands: 40,
      max_enabled_modules: 6,
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
        max_shop_items: 25
      },
      aiassistant: {
        max_requests_per_day: 0
      }
    },
    modules: {
      verification: true,
      governance: true,
      treasury: true,
      wallettracker: true,
      invites: true,
      minigames: true,
      heist: false,
      ticketing: true,
      nfttracker: true,
      tokentracker: true,
      selfserveroles: true,
      branding: true,
      analytics: true,
      engagement: true,
      aiassistant: false
    }
  },
  pro: {
    key: 'pro',
    label: 'Pro',
    description: 'Full-featured operational bundle with competitive modules enabled.',
    billing: {
      monthlyUsd: 49.99,
      annualDiscountPct: 15,
      enterprise: false
    },
    limits: {
      max_commands: 80,
      max_enabled_modules: 8,
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
        max_shop_items: 100
      },
      aiassistant: {
        max_requests_per_day: 1000
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
      ticketing: true,
      nfttracker: true,
      tokentracker: true,
      selfserveroles: true,
      branding: true,
      analytics: true,
      engagement: true,
      aiassistant: true
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
        max_shop_items: null
      },
      aiassistant: {
        max_requests_per_day: null
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
      ticketing: true,
      nfttracker: true,
      tokentracker: true,
      selfserveroles: true,
      branding: true,
      analytics: true,
      engagement: true,
      aiassistant: true
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

module.exports = {
  PLAN_PRESETS,
  MODULE_KEYS,
  getDefaultPlanKey,
  getModuleKeys,
  getPlanModuleLimitDefaults,
  getPlanKeys,
  getPlanPreset,
  normalizePlanKey
};
