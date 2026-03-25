const { SlashCommandBuilder } = require('discord.js');
const logger = require('../../utils/logger');

// LEGACY ALIAS: Redirects to /governance propose
module.exports = {
  data: new SlashCommandBuilder()
    .setName('propose')
    .setDescription('[DEPRECATED] Use /governance propose instead')
    .addStringOption(option =>
      option.setName('title')
        .setDescription('Proposal title')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('description')
        .setDescription('Detailed description of the proposal')
        .setRequired(true)),

  async execute(interaction) {
    await interaction.reply({ 
      content: '⚠️ **This command has been renamed to `/governance propose`**\n\nPlease use the new command. This alias will be removed in Sprint B.',
      ephemeral: true 
    });
    logger.log(`User ${interaction.user.username} used legacy /propose command`);
  },
};
