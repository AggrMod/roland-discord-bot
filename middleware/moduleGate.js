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

const MINIGAME_LIMIT_ORDER = Object.freeze([
  'battle',
  'higherlower',
  'diceduel',
  'reactionrace',
  'numberguess',
  'slots',
  'trivia',
  'wordscramble',
  'rps',
  'blackjack',
]);

const MINIGAME_COMMAND_KEYS = Object.freeze({
  battle: 'battle',
  higherlower: 'higherlower',
  diceduel: 'diceduel',
  reactionrace: 'reactionrace',
  numberguess: 'numberguess',
  slots: 'slots',
  trivia: 'trivia',
  wordscramble: 'wordscramble',
  rps: 'rps',
  blackjack: 'blackjack',
});

const MINIGAME_LABELS = Object.freeze({
  battle: '/battle',
  higherlower: '/higherlower',
  diceduel: '/diceduel',
  reactionrace: '/reactionrace',
  numberguess: '/numberguess',
  slots: '/slots',
  trivia: '/trivia',
  wordscramble: '/wordscramble',
  rps: '/rps',
  blackjack: '/blackjack',
});

const MINIGAME_LIMIT_SUBCOMMANDS = Object.freeze({
  battle: new Set(['create', 'start']),
  higherlower: new Set(['start']),
  diceduel: new Set(['start']),
  reactionrace: new Set(['start']),
  numberguess: new Set(['start']),
  slots: new Set(['start']),
  trivia: new Set(['start']),
  wordscramble: new Set(['start']),
  rps: new Set(['start']),
  blackjack: new Set(['start']),
  gamenight: new Set(['start']),
});

function getCompatibleModuleKeys(moduleKey) {
  const normalized = String(moduleKey || '').trim().toLowerCase();
  if (!normalized) return [];
  if (normalized === 'wallettracker') return ['wallettracker', 'treasury'];
  if (normalized === 'battle' || normalized === 'minigames') return ['minigames', 'battle'];
  return [normalized];
}

function getMinigameGateContext(interaction) {
  if (!interaction?.isChatInputCommand?.()) return null;
  const commandName = String(interaction.commandName || '').trim().toLowerCase();
  const gameKey = MINIGAME_COMMAND_KEYS[commandName] || null;
  if (!gameKey) return null;

  const restrictedSubcommands = MINIGAME_LIMIT_SUBCOMMANDS[commandName] || null;
  if (!restrictedSubcommands || restrictedSubcommands.size === 0) {
    return { commandName, gameKey };
  }

  let subcommand = null;
  try {
    subcommand = interaction.options?.getSubcommand?.(false) || null;
  } catch (_error) {
    subcommand = null;
  }

  if (subcommand && !restrictedSubcommands.has(subcommand)) {
    return null;
  }

  return { commandName, gameKey };
}

async function enforceMinigamePlanLimit(interaction) {
  const context = getMinigameGateContext(interaction);
  if (!context) return true;

  let entitlementService;
  try {
    entitlementService = require('../services/entitlementService');
  } catch (_error) {
    return true;
  }

  const limit = entitlementService.getEffectiveLimit(interaction.guildId, 'minigames', 'max_enabled_games');
  if (limit === null || limit === undefined) return true;

  const numericLimit = Number(limit);
  if (!Number.isFinite(numericLimit) || numericLimit < 0) return true;

  const allowedCount = Math.floor(numericLimit);
  const gameIndex = MINIGAME_LIMIT_ORDER.indexOf(context.gameKey);
  if (gameIndex < 0 || gameIndex < allowedCount) return true;

  const unlockedCommands = MINIGAME_LIMIT_ORDER
    .slice(0, allowedCount)
    .map(gameKey => MINIGAME_LABELS[gameKey] || gameKey);
  const unlockedText = unlockedCommands.length > 0
    ? unlockedCommands.join(', ')
    : 'None';
  const reply = {
    content: `This minigame is locked on your current plan. Allowed minigames: ${unlockedText}.`,
    ephemeral: true,
  };

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(reply);
  } else {
    await interaction.reply(reply);
  }
  return false;
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
    if (compatibleModuleKeys.includes('minigames')) {
      return enforceMinigamePlanLimit(interaction);
    }
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
