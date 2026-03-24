const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const proposalService = require('../../services/proposalService');
const roleService = require('../../services/roleService');
const walletService = require('../../services/walletService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('propose')
    .setDescription('Create a new governance proposal')
    .addStringOption(option =>
      option.setName('title')
        .setDescription('Proposal title')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('description')
        .setDescription('Detailed description of the proposal')
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const discordId = interaction.user.id;
    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');

    const userInfo = await roleService.getUserInfo(discordId);
    
    if (!userInfo || !userInfo.voting_power || userInfo.voting_power === 0) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Not Eligible')
        .setDescription('You must verify your wallet and own at least 1 SOLPRANOS NFT to create proposals.\n\nUse `/verify <wallet>` to get started.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const wallets = walletService.getLinkedWallets(discordId);
    const primaryWallet = wallets.find(w => w.primary_wallet) || wallets[0];

    const result = proposalService.createProposal(
      discordId,
      primaryWallet?.wallet_address || null,
      title,
      description
    );

    if (!result.success) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Failed to Create Proposal')
        .setDescription(result.message || 'An error occurred.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('📜 New Proposal Created')
      .setDescription(`**${title}**\n\n${description}`)
      .addFields(
        { name: '🆔 Proposal ID', value: result.proposalId, inline: true },
        { name: '👤 Creator', value: interaction.user.username, inline: true },
        { name: '📊 Status', value: 'Draft (Needs 4 supporters)', inline: true }
      )
      .setFooter({ text: 'Use /support <proposal-id> to support this proposal' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
