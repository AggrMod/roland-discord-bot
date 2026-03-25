const { SlashCommandBuilder } = require('discord.js');
const logger = require('../../utils/logger');

// LEGACY ALIAS: Redirects to /governance vote
module.exports = {
  data: new SlashCommandBuilder()
    .setName('vote')
    .setDescription('[DEPRECATED] Use /governance vote instead')
    .addStringOption(option =>
      option.setName('proposal-id')
        .setDescription('The proposal ID (e.g., P-001)')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('choice')
        .setDescription('Your vote')
        .setRequired(true)
        .addChoices(
          { name: '✅ Yes', value: 'yes' },
          { name: '❌ No', value: 'no' },
          { name: '⚖️ Abstain', value: 'abstain' }
        )),

  async execute(interaction) {
    await interaction.reply({ 
      content: '⚠️ **This command has been renamed to `/governance vote`**\n\nPlease use the new command. This alias will be removed in Sprint B.',
      ephemeral: true 
    });
    logger.log(`User ${interaction.user.username} used legacy /vote command`);
  },
};
