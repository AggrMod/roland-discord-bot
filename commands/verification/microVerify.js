const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const microVerifyService = require('../../services/microVerifyService');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('micro-verify')
    .setDescription('Verify wallet ownership by sending a tiny SOL amount'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    const username = interaction.user.username;

    // Check if feature is enabled
    const config = microVerifyService.getConfig();
    if (!config.enabled) {
      const embed = new EmbedBuilder()
        .setColor('#FF6B6B')
        .setTitle('❌ Feature Disabled')
        .setDescription('Micro-transfer verification is currently disabled.')
        .addFields(
          { name: '💡 Alternative', value: 'Use `/verify` to connect your wallet via signature verification.', inline: false }
        );

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // Check for existing pending request
    const existingResult = microVerifyService.getPendingRequest(discordId);
    
    if (existingResult.success) {
      const request = existingResult.request;
      const expiresAt = new Date(request.expires_at);
      const timeLeft = Math.max(0, Math.floor((expiresAt - new Date()) / 1000 / 60));

      const embed = new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle('⏳ Pending Verification Request')
        .setDescription(
          `You already have a pending verification request.\n\n` +
          `**Send exactly:** \`${request.expected_amount}\` SOL\n` +
          `**To wallet:** \`${request.destination_wallet}\`\n` +
          `**Time remaining:** ${timeLeft} minute(s)\n\n` +
          `Once you send the SOL, your wallet will be automatically verified within ${config.pollIntervalSeconds} seconds.`
        )
        .setFooter({ text: 'Make sure to send the EXACT amount shown above!' })
        .setTimestamp();

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('micro_verify_check_status')
            .setLabel('Check Status')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🔄'),
          new ButtonBuilder()
            .setLabel('Get Help')
            .setStyle(ButtonStyle.Link)
            .setURL('https://the-solpranos.com/help')
        );

      await interaction.editReply({ embeds: [embed], components: [row] });
      logger.log(`User ${username} (${discordId}) checked existing micro-verify request`);
      return;
    }

    // Create new verification request
    const result = microVerifyService.createRequest(discordId, username);

    if (!result.success) {
      const embed = new EmbedBuilder()
        .setColor('#FF6B6B')
        .setTitle('❌ Verification Failed')
        .setDescription(result.message)
        .setFooter({ text: 'Please try again later or contact support' });

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const request = result.request;
    const expiresAt = new Date(request.expiresAt);
    const timeLeft = Math.floor((expiresAt - new Date()) / 1000 / 60);

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('💸 Micro-Transfer Verification')
      .setDescription(
        `Follow these steps to verify your wallet:\n\n` +
        `**1.** Send exactly **\`${request.amount}\` SOL** from your wallet\n` +
        `**2.** To this address: \`${request.destinationWallet}\`\n` +
        `**3.** Wait up to ${config.pollIntervalSeconds} seconds for automatic verification\n\n` +
        `⏰ **Time limit:** ${timeLeft} minutes\n\n` +
        `⚠️ **Important:** Send the EXACT amount shown above. Any other amount will not be recognized.`
      )
      .addFields(
        { name: '💰 Amount', value: `\`${request.amount}\` SOL`, inline: true },
        { name: '⏱️ Expires In', value: `${timeLeft} min`, inline: true },
        { name: '🎯 Destination', value: `\`${request.destinationWallet.slice(0, 8)}...${request.destinationWallet.slice(-6)}\``, inline: false }
      )
      .setFooter({ text: 'Your wallet will be automatically linked once the transaction is detected' })
      .setTimestamp();

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('micro_verify_check_status')
          .setLabel('Check Status')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🔄'),
        new ButtonBuilder()
          .setLabel('Copy Amount')
          .setStyle(ButtonStyle.Secondary)
          .setCustomId('micro_verify_copy_amount')
          .setEmoji('📋'),
        new ButtonBuilder()
          .setLabel('Get Help')
          .setStyle(ButtonStyle.Link)
          .setURL('https://the-solpranos.com/help')
      );

    await interaction.editReply({ embeds: [embed], components: [row] });
    logger.log(`Micro-verify request created for ${username} (${discordId}): ${request.amount} SOL`);
  },
};
