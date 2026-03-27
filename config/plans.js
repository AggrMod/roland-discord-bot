const MODULE_KEYS = Object.freeze([
  'verification',
  'governance',
  'treasury',
  'battle',
  'heist',
  'ticketing',
  'nfttracker',
  'selfserveroles',
  'analytics'
]);

const PLAN_PRESETS = Object.freeze({
  starter: {
    key: 'starter',
    label: 'Starter',
    description: 'Foundational tenant bundle for verification, governance, and support.',
    limits: {
      max_commands: 20,
      max_enabled_modules: 4,
      max_branding_profiles: 1,
      max_read_only_overrides: 0
    },
    modules: {
      verification: true,
      governance: true,
      treasury: false,
      battle: false,
      heist: false,
      ticketing: true,
      nfttracker: false,
      selfserveroles: false,
      analytics: true
    }
  },
  growth: {
    key: 'growth',
    label: 'Growth',
    description: 'Adds treasury, NFT tracking, and stronger self-service controls.',
    limits: {
      max_commands: 40,
      max_enabled_modules: 6,
      max_branding_profiles: 1,
      max_read_only_overrides: 1
    },
    modules: {
      verification: true,
      governance: true,
      treasury: true,
      battle: false,
      heist: false,
      ticketing: true,
      nfttracker: true,
      selfserveroles: true,
      analytics: true
    }
  },
  pro: {
    key: 'pro',
    label: 'Pro',
    description: 'Full-featured operational bundle with competitive modules enabled.',
    limits: {
      max_commands: 80,
      max_enabled_modules: 8,
      max_branding_profiles: 2,
      max_read_only_overrides: 2
    },
    modules: {
      verification: true,
      governance: true,
      treasury: true,
      battle: true,
      heist: true,
      ticketing: true,
      nfttracker: true,
      selfserveroles: true,
      analytics: true
    }
  },
  enterprise: {
    key: 'enterprise',
    label: 'Enterprise',
    description: 'Maximum flexibility for custom tenant operations and support bundles.',
    limits: {
      max_commands: null,
      max_enabled_modules: null,
      max_branding_profiles: null,
      max_read_only_overrides: null
    },
    modules: {
      verification: true,
      governance: true,
      treasury: true,
      battle: true,
      heist: true,
      ticketing: true,
      nfttracker: true,
      selfserveroles: true,
      analytics: true
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

module.exports = {
  PLAN_PRESETS,
  MODULE_KEYS,
  getDefaultPlanKey,
  getModuleKeys,
  getPlanKeys,
  getPlanPreset,
  normalizePlanKey
};
