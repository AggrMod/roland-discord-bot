const { SlashCommandBuilder } = require('discord.js');
const logger = require('../../utils/logger');

// LEGACY ALIAS: Redirects to /governance support
module.exports = {
  data: new SlashCommandBuilder()
    .setName('support')
    .setDescription('[DEPRECATED] Use /governance support instead')
    .addStringOption(option =>
      option.setName('proposal-id')
        .setDescription('The proposal ID (e.g., P-001)')
        .setRequired(true)),

  async execute(interaction) {
    await interaction.reply({ 
      content: '⚠️ **This command has been renamed to `/governance support`**\n\nPlease use the new command. This alias will be removed in Sprint B.',
      ephemeral: true 
    });
    logger.log(`User ${interaction.user.username} used legacy /support command`);
  },
};
