const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const microVerifyService = require('../../services/microVerifyService');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('micro-verify-config')
    .setDescription('Configure micro-transfer verification settings (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(subcommand =>
      subcommand
        .setName('view')
        .setDescription('View current configuration'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('enable')
        .setDescription('Enable micro-transfer verification')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Enable or disable micro-verify')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('wallet')
        .setDescription('Set verification receive wallet')
        .addStringOption(option =>
          option.setName('address')
            .setDescription('Solana wallet address to receive verification transfers')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('ttl')
        .setDescription('Set request time-to-live')
        .addIntegerOption(option =>
          option.setName('minutes')
            .setDescription('Minutes before verification request expires')
            .setRequired(true)
            .setMinValue(5)
            .setMaxValue(60)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('poll-interval')
        .setDescription('Set blockchain polling interval')
        .addIntegerOption(option =>
          option.setName('seconds')
            .setDescription('Seconds between blockchain polls')
            .setRequired(true)
            .setMinValue(15)
            .setMaxValue(300)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('stats')
        .setDescription('View verification statistics')),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const subcommand = interaction.options.getSubcommand();

    try {
      switch (subcommand) {
        case 'view': {
          const config = microVerifyService.getConfig();
          
          const embed = new EmbedBuilder()
            .setColor(config.enabled ? '#57F287' : '#99AAB5')
            .setTitle('⚙️ Micro-Verify Configuration')
            .addFields(
              { name: '🔌 Enabled', value: config.enabled ? '✅ Yes' : '❌ No', inline: true },
              { name: '👛 Receive Wallet', value: config.receiveWallet ? `\`${config.receiveWallet.slice(0, 8)}...${config.receiveWallet.slice(-6)}\`` : '❌ Not set', inline: true },
              { name: '⏰ Request TTL', value: `${config.ttlMinutes} minutes`, inline: true },
              { name: '🔄 Poll Interval', value: `${config.pollIntervalSeconds} seconds`, inline: true },
              { name: '⏱️ Rate Limit', value: `${config.rateLimitMinutes} minutes`, inline: true },
              { name: '📊 Max Pending/User', value: `${config.maxPendingPerUser}`, inline: true }
            )
            .setFooter({ text: 'Use /micro-verify-config to update settings' })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
          break;
        }

        case 'enable': {
          const enabled = interaction.options.getBoolean('enabled');
          const result = microVerifyService.updateConfig({ MICRO_VERIFY_ENABLED: enabled });

          if (result.success) {
            // Restart polling if enabled
            if (enabled) {
              microVerifyService.startPolling();
            } else {
              microVerifyService.stopPolling();
            }

            const embed = new EmbedBuilder()
              .setColor('#57F287')
              .setTitle('✅ Configuration Updated')
              .setDescription(`Micro-transfer verification has been **${enabled ? 'enabled' : 'disabled'}**.`)
              .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            logger.log(`Micro-verify ${enabled ? 'enabled' : 'disabled'} by ${interaction.user.username}`);
          } else {
            throw new Error(result.message);
          }
          break;
        }

        case 'wallet': {
          const address = interaction.options.getString('address');
          
          // Basic validation (check if valid Solana address length)
          if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
            const embed = new EmbedBuilder()
              .setColor('#FF6B6B')
              .setTitle('❌ Invalid Address')
              .setDescription('Please provide a valid Solana wallet address.')
              .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            return;
          }

          const result = microVerifyService.updateConfig({ VERIFICATION_RECEIVE_WALLET: address });

          if (result.success) {
            // Restart polling with new wallet
            microVerifyService.stopPolling();
            if (microVerifyService.isEnabled()) {
              microVerifyService.startPolling();
            }

            const embed = new EmbedBuilder()
              .setColor('#57F287')
              .setTitle('✅ Wallet Updated')
              .setDescription(`Verification receive wallet set to:\n\`${address}\``)
              .setFooter({ text: 'Polling restarted with new wallet' })
              .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            logger.log(`Micro-verify wallet updated to ${address} by ${interaction.user.username}`);
          } else {
            throw new Error(result.message);
          }
          break;
        }

        case 'ttl': {
          const minutes = interaction.options.getInteger('minutes');
          const result = microVerifyService.updateConfig({ VERIFY_REQUEST_TTL_MINUTES: minutes });

          if (result.success) {
            const embed = new EmbedBuilder()
              .setColor('#57F287')
              .setTitle('✅ TTL Updated')
              .setDescription(`Verification request TTL set to **${minutes} minutes**.`)
              .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            logger.log(`Micro-verify TTL updated to ${minutes}m by ${interaction.user.username}`);
          } else {
            throw new Error(result.message);
          }
          break;
        }

        case 'poll-interval': {
          const seconds = interaction.options.getInteger('seconds');
          const result = microVerifyService.updateConfig({ POLL_INTERVAL_SECONDS: seconds });

          if (result.success) {
            // Restart polling with new interval
            microVerifyService.stopPolling();
            if (microVerifyService.isEnabled()) {
              microVerifyService.startPolling();
            }

            const embed = new EmbedBuilder()
              .setColor('#57F287')
              .setTitle('✅ Poll Interval Updated')
              .setDescription(`Blockchain polling interval set to **${seconds} seconds**.`)
              .setFooter({ text: 'Polling restarted with new interval' })
              .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            logger.log(`Micro-verify poll interval updated to ${seconds}s by ${interaction.user.username}`);
          } else {
            throw new Error(result.message);
          }
          break;
        }

        case 'stats': {
          const statsResult = microVerifyService.getStats();
          
          if (!statsResult.success) {
            throw new Error(statsResult.message);
          }

          const stats = statsResult.stats;
          const successRate = stats.total > 0 
            ? ((stats.verified / stats.total) * 100).toFixed(1) 
            : '0.0';

          const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('📊 Micro-Verify Statistics')
            .addFields(
              { name: '📝 Total Requests', value: stats.total.toString(), inline: true },
              { name: '✅ Verified', value: stats.verified.toString(), inline: true },
              { name: '⏳ Pending', value: stats.pending.toString(), inline: true },
              { name: '⏰ Expired', value: stats.expired.toString(), inline: true },
              { name: '📈 Success Rate', value: `${successRate}%`, inline: true }
            )
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
          break;
        }

        default: {
          await interaction.editReply({ content: 'Unknown subcommand' });
        }
      }
    } catch (error) {
      logger.error('Error in micro-verify-config command:', error);
      
      const embed = new EmbedBuilder()
        .setColor('#FF6B6B')
        .setTitle('❌ Error')
        .setDescription(error.message || 'An error occurred while updating configuration.')
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    }
  },
};
