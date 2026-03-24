const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const proposalService = require('../../services/proposalService');
const roleService = require('../../services/roleService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('vote')
    .setDescription('Cast your vote on an active proposal')
    .addStringOption(option =>
      option.setName('proposal-id')
        .setDescription('The proposal ID (e.g., P-001)')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('choice')
        .setDescription('Your vote')
        .setRequired(true)
        .addChoices(
          { name: '✅ Yes', value: 'yes' },
          { name: '❌ No', value: 'no' },
          { name: '⚖️ Abstain', value: 'abstain' }
        )
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    const proposalId = interaction.options.getString('proposal-id').toUpperCase();
    const choice = interaction.options.getString('choice');

    const userInfo = await roleService.getUserInfo(discordId);
    
    if (!userInfo || !userInfo.voting_power || userInfo.voting_power === 0) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Not Eligible')
        .setDescription('You must verify your wallet and own at least 1 SOLPRANOS NFT to vote.')
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

    const result = proposalService.castVote(proposalId, discordId, choice, userInfo.voting_power);

    if (!result.success) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Failed to Cast Vote')
        .setDescription(result.message || 'An error occurred.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const updatedProposal = proposalService.getProposal(proposalId);
    const totalVoted = updatedProposal.yes_vp + updatedProposal.no_vp + updatedProposal.abstain_vp;

    const choiceEmoji = {
      'yes': '✅',
      'no': '❌',
      'abstain': '⚖️'
    };

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🗳️ Vote Recorded')
      .setDescription(`**${proposal.title}**`)
      .addFields(
        { name: '🆔 Proposal ID', value: proposalId, inline: true },
        { name: '📊 Your Vote', value: `${choiceEmoji[choice]} ${choice.toUpperCase()}`, inline: true },
        { name: '💪 Your VP', value: userInfo.voting_power.toString(), inline: true },
        { name: '✅ Yes', value: `${updatedProposal.yes_vp} VP`, inline: true },
        { name: '❌ No', value: `${updatedProposal.no_vp} VP`, inline: true },
        { name: '⚖️ Abstain', value: `${updatedProposal.abstain_vp} VP`, inline: true },
        { name: '📈 Total Voted', value: `${totalVoted}/${updatedProposal.total_vp} VP (${Math.round(totalVoted / updatedProposal.total_vp * 100)}%)`, inline: false }
      )
      .setFooter({ text: 'You can change your vote any time before voting closes' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
