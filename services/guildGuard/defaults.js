const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  mode: 'monitor',
  exemptions: {
    botUsers: true,
    webhookUsers: true,
    owner: true,
    userIds: [],
    roleIds: [],
    channelIds: [],
    reducedScoringRoleIds: []
  },
  detectors: {
    spam: { enabled: false },
    duplicateMessages: { enabled: false },
    massMention: { enabled: false },
    suspiciousAccount: { enabled: false },
    impersonation: { enabled: false, score: 70 },
    links: {
      enabled: false,
      requireAllowlist: false,
      protectedDomains: [],
      score: 65,
      lookalikeScore: 45,
      unsafeDestinationScore: 100,
      inspectShortenedUrls: true,
      redirectMaxHops: 3,
      urlTimeoutMs: 1500
    },
    raids: { enabled: false, windowSeconds: 60, joinThreshold: 8, score: 80 }
  },
  risk: {
    warning: 35,
    timeout: 60,
    quarantine: 80,
    alert: 25,
    decayEnabled: true,
    decayHalfLifeHours: 24,
    combinationBonuses: [
      { detectors: ['spam_flood', 'duplicate_message'], score: 10, reason: 'repeated spam pattern' },
      { detectors: ['staff_impersonation', 'link_protection'], score: 20, reason: 'possible staff scam pattern' },
      { detectors: ['suspicious_account', 'link_protection'], score: 15, reason: 'new account link risk' }
    ]
  },
  retentionDays: 30,
  alertChannelId: null,
  rules: [
    {
      id: 'staff_impersonation_escalation',
      name: 'Staff impersonation escalation',
      detectors: ['staff_impersonation'],
      threshold: 50,
      enabled: true,
      actions: { timeoutUsers: true, timeoutSeconds: 3600, deleteMessages: true, notifyStaff: true, pingStaff: true }
    }
  ],
  actions: {
    enabled: false,
    deleteMessages: false,
    warnUsers: false,
    timeoutUsers: false,
    timeoutSeconds: 60,
    lockdownEnabled: false,
    lockdownVerificationLevel: 'high'
  }
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeConfig(base, override) {
  if (!override || typeof override !== 'object') return clone(base);
  const result = clone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object') {
      result[key] = mergeConfig(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

module.exports = { DEFAULT_CONFIG, clone, mergeConfig };
