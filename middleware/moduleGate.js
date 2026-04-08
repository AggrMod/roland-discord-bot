const tenantService = require('../services/tenantService');
const { getCommandModuleKey } = require('../config/commandModules');

const DISPLAY_NAMES = {
  verification: 'Verification',
  governance: 'Governance',
  treasury: 'Treasury',
  wallettracker: 'Wallet Tracker',
  nfttracker: 'NFT Tracker',
  tokentracker: 'Token Tracker',
  ticketing: 'Ticketing',
  selfserveroles: 'Self-Serve Roles',
  branding: 'Branding',
  engagement: 'Engagement',
  minigames: 'Minigames',
  battle: 'Battle',
  heist: 'Heist'
};

function getCompatibleModuleKeys(moduleKey) {
  const normalized = String(moduleKey || '').trim().toLowerCase();
  if (!normalized) return [];
  if (normalized === 'wallettracker') return ['wallettracker', 'treasury'];
  if (normalized === 'battle' || normalized === 'minigames') return ['minigames', 'battle'];
  return [normalized];
}

async function moduleGate(interaction, moduleKey, options = {}) {
  const resolvedModuleKey = moduleKey || getCommandModuleKey(interaction?.commandName);
  const compatibleModuleKeys = getCompatibleModuleKeys(resolvedModuleKey);

  if (!resolvedModuleKey) {
    return true;
  }

  // Single-tenant mode: still respect module enable/disable flags from settings if set
  // This is intentional — single-tenant skips tenant DB lookups but honors module-toggles.json flags
  if (!tenantService.isMultitenantEnabled()) {
    try {
      const moduleGuard = require('../utils/moduleGuard');
      const enabled = compatibleModuleKeys.some(moduleKey => moduleGuard.isModuleEnabled(moduleKey));
      if (!enabled) {
        const displayName = options.displayName || DISPLAY_NAMES[resolvedModuleKey] || resolvedModuleKey;
        const reply = { content: `The **${displayName}** module is currently disabled.`, ephemeral: true };
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(reply);
        } else {
          await interaction.reply(reply);
        }
        return false;
      }
    } catch (_) {}
    return true;
  }

  if (!interaction?.guildId) {
    return true;
  }

  if (compatibleModuleKeys.some(moduleKey => tenantService.isModuleEnabled(interaction.guildId, moduleKey))) {
    return true;
  }

  const displayName = options.displayName || DISPLAY_NAMES[resolvedModuleKey] || resolvedModuleKey;
  const reply = {
    content: `🚫 The **${displayName}** business is closed right now. Talk to the Don if you need access.`,
    ephemeral: true
  };

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(reply);
  } else {
    await interaction.reply(reply);
  }

  return false;
}

module.exports = moduleGate;
