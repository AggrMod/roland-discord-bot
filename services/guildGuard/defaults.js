const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  mode: 'monitor',
  preset: 'custom',
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
    scamLanguage: { enabled: false, score: 55, secretRequestScore: 100 },
    attachments: {
      enabled: false,
      scanQrCodes: true,
      qrCodeScore: 35,
      maxImagesPerMessage: 2,
      maxScanBytes: 3000000,
      scanTimeoutMs: 4000
    },
    campaigns: { enabled: false, windowSeconds: 90, userThreshold: 3, messageThreshold: 3, linkScore: 75, messageScore: 45 },
    accountTrust: { enabled: false, maxAccountAgeHours: 72, maxMemberAgeHours: 24, lowTrustScore: 30, burstWindowSeconds: 120, channelThreshold: 3, burstScore: 65 },
    links: {
      enabled: false,
      requireAllowlist: false,
      protectedDomains: [],
      score: 65,
      threatIntelScore: 70,
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
      { detectors: ['suspicious_account', 'link_protection'], score: 15, reason: 'new account link risk' },
      { detectors: ['wallet_drainer_language', 'link_protection'], score: 20, reason: 'wallet-drainer link pattern' },
      { detectors: ['wallet_drainer_language', 'qr_code_link'], score: 20, reason: 'wallet-drainer QR pattern' },
      { detectors: ['dangerous_attachment', 'wallet_drainer_language'], score: 15, reason: 'dangerous wallet attachment pattern' },
      { detectors: ['coordinated_link_campaign', 'wallet_drainer_language'], score: 15, reason: 'coordinated wallet-drainer campaign' },
      { detectors: ['low_trust_destination', 'wallet_drainer_language'], score: 15, reason: 'low-trust wallet scam pattern' }
    ]
  },
  retentionDays: 30,
  alertChannelId: null,
  globalReputation: {
    consumeEnabled: true,
    publishEnabled: false,
    notifyOnJoin: true,
    alertThreshold: 50,
    halfLifeDays: {
      spam: 90,
      unsafe_link: 120,
      impersonation: 180,
      scam: 365,
      suspicious_account: 120
    }
  },
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
    lockdownVerificationLevel: 'high',
    lockdownDurationSeconds: 900
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
