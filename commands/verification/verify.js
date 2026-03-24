const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const walletService = require('../../services/walletService');
const roleService = require('../../services/roleService');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Link your Solana wallet to your Discord account')
    .addStringOption(option =>
      option.setName('wallet')
        .setDescription('Your Solana wallet address')
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const walletAddress = interaction.options.getString('wallet');
    const discordId = interaction.user.id;
    const username = interaction.user.username;

    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Invalid Wallet Address')
        .setDescription('Please provide a valid Solana wallet address.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const linkResult = walletService.linkWallet(discordId, username, walletAddress);

    if (!linkResult.success) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Verification Failed')
        .setDescription(linkResult.message)
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const updateResult = await roleService.updateUserRoles(discordId, username);

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('✅ Wallet Verified Successfully')
      .setDescription(`Your wallet has been linked to your Discord account.`)
      .addFields(
        { name: '💼 Wallet', value: `\`${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}\``, inline: true },
        { name: '🎴 NFTs Owned', value: updateResult.totalNFTs?.toString() || '0', inline: true },
        { name: '🏆 Tier', value: updateResult.tier || 'None', inline: true },
        { name: '🗳️ Voting Power', value: updateResult.votingPower?.toString() || '0', inline: true }
      )
      .setFooter({ text: 'Welcome to the Solpranos!' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${username} (${discordId}) verified wallet ${walletAddress}`);
  },
};
