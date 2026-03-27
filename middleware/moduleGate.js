const tenantService = require('../services/tenantService');
const { getCommandModuleKey } = require('../config/commandModules');

const DISPLAY_NAMES = {
  verification: 'Verification',
  governance: 'Governance',
  treasury: 'Treasury',
  battle: 'Battle',
  heist: 'Heist'
};

async function moduleGate(interaction, moduleKey, options = {}) {
  const resolvedModuleKey = moduleKey || getCommandModuleKey(interaction?.commandName);

  if (!resolvedModuleKey || !tenantService.isMultitenantEnabled()) {
    return true;
  }

  if (!interaction?.guildId) {
    return true;
  }

  if (tenantService.isModuleEnabled(interaction.guildId, resolvedModuleKey)) {
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
