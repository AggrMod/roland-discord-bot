const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const proposalService = require('../../services/proposalService');
const roleService = require('../../services/roleService');
const walletService = require('../../services/walletService');
const logger = require('../../utils/logger');

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
        .setDescription('You must verify your wallet and own at least 1 SOLPRANOS NFT to create proposals.\n\nUse `/verify` to get started.')
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
      .setFooter({ text: 'Posted to proposals channel - waiting for supporters' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

    // Post to proposals channel with Support button
    const proposalsChannelId = process.env.PROPOSALS_CHANNEL_ID;
    if (proposalsChannelId) {
      try {
        const proposalsChannel = await interaction.client.channels.fetch(proposalsChannelId);
        
        if (proposalsChannel && proposalsChannel.isTextBased()) {
          const channelEmbed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle(`📜 ${title}`)
            .setDescription(description)
            .addFields(
              { name: '🆔 Proposal ID', value: result.proposalId, inline: true },
              { name: '👤 Creator', value: interaction.user.username, inline: true },
              { name: '📊 Status', value: 'Draft', inline: true },
              { name: '👥 Supporters', value: '0/4', inline: true }
            )
            .setFooter({ text: 'Click Support below to help promote this proposal (4 needed)' })
            .setTimestamp();

          const row = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(`support_${result.proposalId}`)
                .setLabel('Support')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('✅')
            );

          const message = await proposalsChannel.send({ embeds: [channelEmbed], components: [row] });
          
          // Store message ID in database
          const db = require('../../database/db');
          db.prepare('UPDATE proposals SET message_id = ?, channel_id = ? WHERE proposal_id = ?')
            .run(message.id, proposalsChannelId, result.proposalId);
          
          logger.log(`Proposal ${result.proposalId} posted to channel ${proposalsChannelId}, message ${message.id}`);
        }
      } catch (error) {
        logger.error('Error posting proposal to channel:', error);
      }
    }
  },
};
