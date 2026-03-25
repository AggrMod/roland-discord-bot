const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const treasuryService = require('../../services/treasuryService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('treasury')
    .setDescription('💰 Treasury module - monitor Family funds')
    
    // User command
    .addSubcommand(subcommand =>
      subcommand
        .setName('view')
        .setDescription('View current treasury balances (public read-only)'))
    
    // Admin subgroup
    .addSubcommandGroup(group =>
      group
        .setName('admin')
        .setDescription('Admin treasury management')
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('status')
            .setDescription('View full treasury status (admin)'))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('refresh')
            .setDescription('Manually refresh treasury balances'))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('enable')
            .setDescription('Enable treasury monitoring'))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('disable')
            .setDescription('Disable treasury monitoring'))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('set-wallet')
            .setDescription('Set the treasury wallet address')
            .addStringOption(option =>
              option
                .setName('address')
                .setDescription('Solana wallet address to monitor')
                .setRequired(true)))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('set-interval')
            .setDescription('Set refresh interval in hours')
            .addIntegerOption(option =>
              option
                .setName('hours')
                .setDescription('Number of hours between refreshes (1-168)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(168)))

        .addSubcommand(subcommand =>
          subcommand
            .setName('tx-history')
            .setDescription('Show recent treasury transactions')
            .addIntegerOption(option =>
              option
                .setName('limit')
                .setDescription('How many recent transactions (1-20)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(20)))

        .addSubcommand(subcommand =>
          subcommand
            .setName('tx-alerts')
            .setDescription('Configure automatic treasury transaction alerts')
            .addBooleanOption(option =>
              option
                .setName('enabled')
                .setDescription('Enable or disable tx alerts')
                .setRequired(true))
            .addChannelOption(option =>
              option
                .setName('channel')
                .setDescription('Channel to post alerts in (required when enabling)')
                .setRequired(false))
            .addBooleanOption(option =>
              option
                .setName('incoming_only')
                .setDescription('Only alert incoming transfers')
                .setRequired(false))
            .addNumberOption(option =>
              option
                .setName('min_sol')
                .setDescription('Minimum absolute SOL delta to alert (e.g. 0.1)')
                .setRequired(false)
                .setMinValue(0)))),

  async execute(interaction) {
    // Check if treasury module is enabled
    if (!await moduleGuard.checkModuleEnabled(interaction, 'treasury')) {
      return;
    }

    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommandGroup === 'admin') {
        // Admin commands require admin check
        if (!await moduleGuard.checkAdmin(interaction)) {
          return;
        }

        switch (subcommand) {
          case 'status':
            await this.handleAdminStatus(interaction);
            break;
          case 'refresh':
            await this.handleAdminRefresh(interaction);
            break;
          case 'enable':
            await this.handleAdminEnable(interaction);
            break;
          case 'disable':
            await this.handleAdminDisable(interaction);
            break;
          case 'set-wallet':
            await this.handleAdminSetWallet(interaction);
            break;
          case 'set-interval':
            await this.handleAdminSetInterval(interaction);
            break;
          case 'tx-history':
            await this.handleAdminTxHistory(interaction);
            break;
          case 'tx-alerts':
            await this.handleAdminTxAlerts(interaction);
            break;
        }
      } else {
        // User commands
        switch (subcommand) {
          case 'view':
            await this.handleView(interaction);
            break;
        }
      }
    } catch (error) {
      logger.error('Error executing treasury command:', error);
      
      const reply = { 
        content: `❌ Something went wrong: ${error.message}`, 
        ephemeral: true 
      };
      
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply);
      } else {
        await interaction.reply(reply);
      }
    }
  },

  // ==================== USER COMMANDS ====================

  async handleView(interaction) {
    await interaction.deferReply();

    const summary = treasuryService.getSummary();

    if (!summary.success) {
      return interaction.editReply({ 
        content: `❌ ${summary.message || 'Treasury unavailable right now.'}`
      });
    }

    const t = summary.treasury;
    const statusEmoji = t.status === 'ok' ? '✅' : t.status === 'stale' ? '⚠️' : '❌';

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('💰 Family Treasury')
      .setDescription('Current treasury snapshot')
      .addFields(
        { name: '🪙 SOL', value: `${t.sol}`, inline: true },
        { name: '💵 USDC', value: `${t.usdc}`, inline: true },
        { name: 'Status', value: `${statusEmoji} ${t.status}`, inline: true },
        { name: 'Last Updated', value: t.lastUpdated ? `<t:${Math.floor(new Date(t.lastUpdated).getTime()/1000)}:R>` : 'Unknown', inline: false }
      )
      .setFooter({ text: 'Treasury Watch • Wallet address hidden for security' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${interaction.user.username} viewed treasury`);
  },

  // ==================== ADMIN COMMANDS ====================

  async handleAdminStatus(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const adminSummary = treasuryService.getAdminSummary();
    if (!adminSummary.success) {
      return interaction.editReply({ content: `❌ ${adminSummary.message || 'Unable to read treasury config.'}`, ephemeral: true });
    }

    const c = adminSummary.config;
    const b = adminSummary.treasury || { sol: '0.0000', usdc: '0.0000' };
    const statusText = c.enabled ? '✅ Enabled' : '❌ Disabled';

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('💰 Treasury Status (Admin)')
      .setDescription('Full treasury configuration and balances')
      .addFields(
        { name: 'Status', value: statusText, inline: true },
        { name: 'Refresh Interval', value: `${c.refreshHours} hours`, inline: true },
        { name: 'Wallet', value: c.wallet || '_Not set_', inline: true },
        { name: 'SOL', value: `${b.sol}`, inline: true },
        { name: 'USDC', value: `${b.usdc}`, inline: true },
        { name: 'Tx Alerts', value: c.txAlertsEnabled ? `✅ <#${c.txAlertChannelId}>` : '❌ Off', inline: true },
        { name: 'Alerts Filter', value: `incoming_only=${c.txAlertIncomingOnly ? 'yes' : 'no'} | min=${c.txAlertMinSol || 0} SOL`, inline: false },
        { name: 'Last Updated', value: c.lastUpdated ? `<t:${Math.floor(new Date(c.lastUpdated).getTime()/1000)}:R>` : 'Unknown', inline: true }
      )
      .setFooter({ text: 'Use /treasury admin commands to configure' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed treasury status`);
  },

  async handleAdminRefresh(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await treasuryService.fetchBalances();
      if (!result.success) {
        return interaction.editReply({ content: `❌ ${result.message || 'Refresh failed.'}`, ephemeral: true });
      }
      
      await interaction.editReply({ 
        content: '✅ Treasury balances refreshed successfully.',
        ephemeral: true 
      });
      logger.log(`Admin ${interaction.user.tag} manually refreshed treasury`);
    } catch (error) {
      logger.error('Error refreshing treasury:', error);
      await interaction.editReply({ 
        content: `❌ Failed to refresh: ${error.message}`,
        ephemeral: true 
      });
    }
  },

  async handleAdminEnable(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const result = treasuryService.updateConfig({ enabled: true });
    if (!result.success) {
      return interaction.editReply({ content: `❌ ${result.message}`, ephemeral: true });
    }
    
    await interaction.editReply({ 
      content: '✅ Treasury monitoring enabled. Automatic refreshes will run.',
      ephemeral: true 
    });
    logger.log(`Admin ${interaction.user.tag} enabled treasury monitoring`);
  },

  async handleAdminDisable(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const result = treasuryService.updateConfig({ enabled: false });
    if (!result.success) {
      return interaction.editReply({ content: `❌ ${result.message}`, ephemeral: true });
    }
    
    await interaction.editReply({ 
      content: '❌ Treasury monitoring disabled. Automatic refreshes paused.',
      ephemeral: true 
    });
    logger.log(`Admin ${interaction.user.tag} disabled treasury monitoring`);
  },

  async handleAdminSetWallet(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const address = interaction.options.getString('address');

    const result = treasuryService.updateConfig({ solanaWallet: address });
    if (!result.success) {
      return interaction.editReply({ 
        content: `❌ ${result.message}`,
        ephemeral: true 
      });
    }
    
    const masked = treasuryService.maskAddress(address);
    await interaction.editReply({ 
      content: `✅ Treasury wallet set to: \`${masked}\`\n\nRun \`/treasury admin refresh\` to fetch balances.`,
      ephemeral: true 
    });
    logger.log(`Admin ${interaction.user.tag} set treasury wallet`);
  },

  async handleAdminSetInterval(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const hours = interaction.options.getInteger('hours');

    const result = treasuryService.updateConfig({ refreshHours: hours });
    if (!result.success) {
      return interaction.editReply({ content: `❌ ${result.message}`, ephemeral: true });
    }
    
    await interaction.editReply({ 
      content: `✅ Refresh interval set to ${hours} hour(s).`,
      ephemeral: true 
    });
    logger.log(`Admin ${interaction.user.tag} set treasury interval to ${hours} hours`);
  },

  async handleAdminTxHistory(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const limit = interaction.options.getInteger('limit') || 10;
    const result = await treasuryService.getRecentTransactions(limit);

    if (!result.success) {
      return interaction.editReply({ content: `❌ ${result.message}`, ephemeral: true });
    }

    if (!result.transactions.length) {
      return interaction.editReply({ content: 'No recent transactions found.', ephemeral: true });
    }

    const lines = result.transactions.slice(0, limit).map((tx, i) => {
      const dir = tx.direction === 'incoming' ? '🟢 IN' : tx.direction === 'outgoing' ? '🔴 OUT' : '🟡 FLAT';
      const amt = `${tx.deltaSol > 0 ? '+' : ''}${tx.deltaSol} SOL`;
      const when = tx.blockTime ? `<t:${tx.blockTime}:R>` : 'unknown';
      return `${i + 1}. ${dir} ${amt} • ${when}\n   \`${tx.signature.slice(0, 10)}...${tx.signature.slice(-8)}\``;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('📜 Treasury Transaction History')
      .setDescription(lines)
      .setFooter({ text: `Showing latest ${Math.min(limit, result.transactions.length)} txs` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed], ephemeral: true });
  },

  async handleAdminTxAlerts(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const enabled = interaction.options.getBoolean('enabled');
    const channel = interaction.options.getChannel('channel');
    const incomingOnly = interaction.options.getBoolean('incoming_only');
    const minSol = interaction.options.getNumber('min_sol');

    if (enabled && !channel) {
      return interaction.editReply({ content: '❌ Please provide a channel when enabling alerts.', ephemeral: true });
    }

    const result = treasuryService.updateConfig({
      txAlertsEnabled: enabled,
      txAlertChannelId: channel ? channel.id : undefined,
      txAlertIncomingOnly: incomingOnly !== null ? incomingOnly : undefined,
      txAlertMinSol: minSol !== null ? minSol : undefined,
      txLastSignature: null
    });

    if (!result.success) {
      return interaction.editReply({ content: `❌ ${result.message}`, ephemeral: true });
    }

    const cfg = treasuryService.getAdminSummary().config;
    await interaction.editReply({
      content: enabled
        ? `✅ Tx alerts enabled in <#${cfg.txAlertChannelId}> | incoming_only=${cfg.txAlertIncomingOnly ? 'yes' : 'no'} | min_sol=${cfg.txAlertMinSol}`
        : '✅ Tx alerts disabled.',
      ephemeral: true
    });
  }
};
