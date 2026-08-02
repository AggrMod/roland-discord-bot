const MODULE_DISPLAY_NAMES = Object.freeze({
  verification: 'Verification',
  governance: 'Governance',
  treasury: 'Wallet Tracker',
  wallettracker: 'Wallet Tracker',
  invites: 'Invite Tracker',
  nfttracker: 'NFT Activity',
  tokentracker: 'Token Tracker',
  ticketing: 'Support Tickets',
  selfserveroles: 'Self-Serve Roles',
  branding: 'Branding',
  engagement: 'Engagement',
  guildguard: 'Guild Guard',
  aiassistant: 'AI Assistant',
  telegrambridge: 'Telegram Bridge',
  automessages: 'Auto Messages',
  vault: 'Vault',
  welcome: 'Welcome & Onboarding',
  minigames: 'Minigames',
  battle: 'Minigames',
  heist: 'Missions',
  missions: 'Missions',
});

function normalizeModuleKey(moduleKey) {
  return String(moduleKey || '').trim().toLowerCase();
}

function getCompatibleModuleKeys(moduleKey) {
  const normalized = normalizeModuleKey(moduleKey);
  if (!normalized) return [];
  if (normalized === 'wallettracker') return ['wallettracker', 'treasury'];
  if (normalized === 'selfserve' || normalized === 'self-serve-roles' || normalized === 'selfserve-roles') {
    return ['selfserveroles', 'selfserve'];
  }
  if (normalized === 'battle' || normalized === 'minigames') return ['minigames', 'battle'];
  if (normalized === 'guild_guard' || normalized === 'guild-guard' || normalized === 'guard') {
    return ['guildguard', 'guild_guard', 'guild-guard', 'guard'];
  }
  return [normalized];
}

function getModuleDisplayName(moduleKey) {
  const normalized = normalizeModuleKey(moduleKey);
  if (normalized === 'selfserve' || normalized === 'self-serve-roles' || normalized === 'selfserve-roles') {
    return MODULE_DISPLAY_NAMES.selfserveroles;
  }
  if (normalized === 'guild_guard' || normalized === 'guild-guard' || normalized === 'guard') {
    return MODULE_DISPLAY_NAMES.guildguard;
  }
  return MODULE_DISPLAY_NAMES[normalized] || moduleKey;
}

module.exports = {
  MODULE_DISPLAY_NAMES,
  normalizeModuleKey,
  getCompatibleModuleKeys,
  getModuleDisplayName,
};
