const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const walletService = require('../../services/walletService');
const roleService = require('../../services/roleService');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Link your Solana wallet to your Discord account'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';
    
    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🔗 Wallet Verification')
      .setDescription('To verify your wallet, please visit our secure web verification page.')
      .addFields(
        { name: '🌐 Verification URL', value: `${webUrl}/verify`, inline: false },
        { name: '🆔 Your Discord ID', value: `\`${discordId}\``, inline: false },
        { name: '📝 Instructions', value: '1. Click the link above\n2. Enter your Discord ID (shown above)\n3. Connect your Phantom or Solflare wallet\n4. Sign the verification message\n5. Come back here and use `/refresh-roles` to update your roles', inline: false }
      )
      .setFooter({ text: 'Your wallet will be securely verified via cryptographic signature' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${interaction.user.username} (${discordId}) requested verification link`);
  },
};
