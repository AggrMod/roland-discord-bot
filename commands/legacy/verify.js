const { SlashCommandBuilder } = require('discord.js');
const logger = require('../../utils/logger');

// LEGACY ALIAS: Redirects to /verification status
module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('[DEPRECATED] Use /verification status instead'),

  async execute(interaction) {
    await interaction.reply({ 
      content: '⚠️ **This command has been renamed to `/verification status`**\n\nPlease use the new command. This alias will be removed in Sprint B.',
      ephemeral: true 
    });
    logger.log(`User ${interaction.user.username} used legacy /verify command`);
  },
};
