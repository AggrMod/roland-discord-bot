const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const proposalService = require('../../services/proposalService');
const roleService = require('../../services/roleService');
const settings = require('../../config/settings.json');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('support')
    .setDescription('Support a draft proposal to help promote it to voting')
    .addStringOption(option =>
      option.setName('proposal-id')
        .setDescription('The proposal ID (e.g., P-001)')
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const discordId = interaction.user.id;
    const proposalId = interaction.options.getString('proposal-id').toUpperCase();

    const userInfo = await roleService.getUserInfo(discordId);
    
    if (!userInfo || !userInfo.voting_power || userInfo.voting_power === 0) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Not Eligible')
        .setDescription('You must verify your wallet and own at least 1 SOLPRANOS NFT to support proposals.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const proposal = proposalService.getProposal(proposalId);
    
    if (!proposal) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Proposal Not Found')
        .setDescription(`No proposal found with ID: ${proposalId}`)
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const result = proposalService.addSupporter(proposalId, discordId);

    if (!result.success) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Failed to Add Support')
        .setDescription(result.message || 'An error occurred.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const supportThreshold = settings.supportThreshold || 4;
    const supporterCount = result.supporterCount;
    const isPromoted = result.promoted;

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle(isPromoted ? '🗳️ Proposal Promoted to Voting!' : '✅ Support Added')
      .setDescription(`**${proposal.title}**`)
      .addFields(
        { name: '🆔 Proposal ID', value: proposalId, inline: true },
        { name: '👥 Supporters', value: `${supporterCount}/${supportThreshold}`, inline: true },
        { name: '📊 Status', value: isPromoted ? 'Now Voting' : 'Still in Draft', inline: true }
      )
      .setFooter({ 
        text: isPromoted 
          ? 'Voting is now open for 7 days!' 
          : `${supportThreshold - supporterCount} more supporter(s) needed`
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
