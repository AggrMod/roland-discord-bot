const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify-panel')
    .setDescription('Post a verification panel in this channel (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🔗 Verify your wallet!')
      .setDescription('To get access to roles, verify your wallet with Solpranos by clicking the button below.')
      .setThumbnail(interaction.client.user.displayAvatarURL({ size: 256 }))
      .setFooter({ text: 'Solpranos', iconURL: interaction.client.user.displayAvatarURL({ size: 32 }) });

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('panel_verify')
          .setLabel('Verify')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setLabel('Add Wallet')
          .setStyle(ButtonStyle.Link)
          .setURL(`${webUrl}/verify`),
        new ButtonBuilder()
          .setLabel('Get Help')
          .setStyle(ButtonStyle.Link)
          .setURL('https://the-solpranos.com/help')
      );

    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: '✅ Verification panel posted!', ephemeral: true });
    logger.log(`Verify panel posted in #${interaction.channel.name} by ${interaction.user.username}`);
  },
};
