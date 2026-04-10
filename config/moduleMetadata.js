const MODULE_DISPLAY_NAMES = Object.freeze({
  verification: 'Verification',
  governance: 'Governance',
  treasury: 'Treasury',
  wallettracker: 'Wallet Tracker',
  invites: 'Invite Tracker',
  nfttracker: 'NFT Tracker',
  tokentracker: 'Token Tracker',
  ticketing: 'Ticketing',
  selfserveroles: 'Self-Serve Roles',
  branding: 'Branding',
  engagement: 'Engagement',
  minigames: 'Minigames',
  battle: 'Battle',
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
  return [normalized];
}

function getModuleDisplayName(moduleKey) {
  const normalized = normalizeModuleKey(moduleKey);
  if (normalized === 'selfserve' || normalized === 'self-serve-roles' || normalized === 'selfserve-roles') {
    return MODULE_DISPLAY_NAMES.selfserveroles;
  }
  return MODULE_DISPLAY_NAMES[normalized] || moduleKey;
}

module.exports = {
  MODULE_DISPLAY_NAMES,
  normalizeModuleKey,
  getCompatibleModuleKeys,
  getModuleDisplayName,
};
