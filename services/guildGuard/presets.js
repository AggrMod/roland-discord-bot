const PRESETS = Object.freeze({
  essential: {
    key: 'essential',
    name: 'Essential',
    description: 'Monitor the main scam and raid signals and alert moderators without automatic member actions.',
    patch: {
      preset: 'essential',
      enabled: true,
      mode: 'monitor',
      exemptions: { botUsers: true, webhookUsers: false },
      detectors: {
        spam: { enabled: true, maxMessages: 6, windowMs: 10000 },
        duplicateMessages: { enabled: true, threshold: 4, windowMs: 30000 },
        massMention: { enabled: true, threshold: 6 },
        suspiciousAccount: { enabled: true, maxAccountAgeHours: 24 },
        impersonation: { enabled: true, score: 70 },
        links: { enabled: true, requireAllowlist: false },
        raids: { enabled: true, windowSeconds: 60, joinThreshold: 8, score: 80 }
      },
      risk: { warning: 35, timeout: 60, quarantine: 80, alert: 25 },
      actions: {
        enabled: false,
        deleteMessages: false,
        warnUsers: false,
        timeoutUsers: false,
        lockdownEnabled: false
      }
    }
  },
  balanced: {
    key: 'balanced',
    name: 'Balanced',
    description: 'Recommended protection with focused automatic actions for high-confidence threats.',
    patch: {
      preset: 'balanced',
      enabled: true,
      mode: 'enforce',
      exemptions: { botUsers: true, webhookUsers: false },
      detectors: {
        spam: { enabled: true, maxMessages: 5, windowMs: 10000 },
        duplicateMessages: { enabled: true, threshold: 3, windowMs: 30000 },
        massMention: { enabled: true, threshold: 5 },
        suspiciousAccount: { enabled: true, maxAccountAgeHours: 48 },
        impersonation: { enabled: true, score: 70 },
        links: { enabled: true, requireAllowlist: false },
        raids: { enabled: true, windowSeconds: 60, joinThreshold: 8, score: 80 }
      },
      risk: { warning: 35, timeout: 60, quarantine: 80, alert: 25 },
      actions: {
        enabled: true,
        deleteMessages: true,
        warnUsers: true,
        timeoutUsers: true,
        timeoutSeconds: 3600,
        lockdownEnabled: true,
        lockdownVerificationLevel: 'high',
        lockdownDurationSeconds: 900
      }
    }
  },
  strict: {
    key: 'strict',
    name: 'Strict',
    description: 'Launch-day protection with tighter thresholds and scanning for untrusted bot content.',
    patch: {
      preset: 'strict',
      enabled: true,
      mode: 'enforce',
      exemptions: { botUsers: false, webhookUsers: false },
      detectors: {
        spam: { enabled: true, maxMessages: 4, windowMs: 10000 },
        duplicateMessages: { enabled: true, threshold: 3, windowMs: 20000 },
        massMention: { enabled: true, threshold: 4 },
        suspiciousAccount: { enabled: true, maxAccountAgeHours: 72 },
        impersonation: { enabled: true, score: 75 },
        links: { enabled: true, requireAllowlist: false, lookalikeScore: 55 },
        raids: { enabled: true, windowSeconds: 60, joinThreshold: 5, score: 85 }
      },
      risk: { warning: 25, timeout: 50, quarantine: 70, alert: 20 },
      actions: {
        enabled: true,
        deleteMessages: true,
        warnUsers: true,
        timeoutUsers: true,
        timeoutSeconds: 7200,
        lockdownEnabled: true,
        lockdownVerificationLevel: 'high',
        lockdownDurationSeconds: 1200
      }
    }
  }
});

function listPresets() {
  return Object.values(PRESETS).map(preset => ({
    key: preset.key,
    name: preset.name,
    description: preset.description
  }));
}

function getPreset(key) {
  return PRESETS[String(key || '').trim().toLowerCase()] || null;
}

module.exports = { PRESETS, listPresets, getPreset };
