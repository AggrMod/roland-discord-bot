const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const roleService = require('../../services/roleService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('refresh-roles')
    .setDescription('Manually update your roles based on current NFT holdings'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    const username = interaction.user.username;

    const updateResult = await roleService.updateUserRoles(discordId, username);

    if (!updateResult.success) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Update Failed')
        .setDescription(updateResult.message || 'Failed to update roles. Please try again.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('✅ Roles Updated')
      .setDescription('Your roles have been refreshed based on your current NFT holdings.')
      .addFields(
        { name: '🎴 Total NFTs', value: updateResult.totalNFTs?.toString() || '0', inline: true },
        { name: '🏆 Current Tier', value: updateResult.tier || 'None', inline: true },
        { name: '🗳️ Voting Power', value: updateResult.votingPower?.toString() || '0', inline: true }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
