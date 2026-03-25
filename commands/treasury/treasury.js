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
                .setMaxValue(168)))),

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

    const config = treasuryService.getConfig();
    const balances = await treasuryService.getBalances();

    if (!config.treasuryWalletAddress) {
      return interaction.editReply({ 
        content: '❌ Treasury wallet not configured yet. Contact an admin.',
        ephemeral: true 
      });
    }

    const totalUSD = balances.reduce((sum, b) => sum + (b.usdValue || 0), 0);

    const balanceList = balances.length > 0
      ? balances.slice(0, 10).map(b => 
          `💎 **${b.symbol}**: ${b.amount.toFixed(4)} ($${(b.usdValue || 0).toFixed(2)})`
        ).join('\n')
      : '_No balances found_';

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('💰 Family Treasury')
      .setDescription(`Current holdings for the Family treasury`)
      .addFields(
        { name: '💼 Wallet', value: `\`${config.treasuryWalletAddress.slice(0, 8)}...${config.treasuryWalletAddress.slice(-8)}\``, inline: false },
        { name: '💵 Total Value', value: `$${totalUSD.toFixed(2)} USD`, inline: true },
        { name: '📦 Assets', value: `${balances.length}`, inline: true },
        { name: '🪙 Holdings', value: balanceList, inline: false }
      )
      .setFooter({ text: 'Updated every few hours • The Commission watches the Family funds' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${interaction.user.username} viewed treasury`);
  },

  // ==================== ADMIN COMMANDS ====================

  async handleAdminStatus(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const config = treasuryService.getConfig();
    const balances = await treasuryService.getBalances();

    const totalUSD = balances.reduce((sum, b) => sum + (b.usdValue || 0), 0);

    const statusText = config.enabled ? '✅ Enabled' : '❌ Disabled';
    const walletText = config.treasuryWalletAddress || '_Not set_';
    const intervalText = `${config.refreshIntervalHours} hours`;

    const balanceList = balances.length > 0
      ? balances.slice(0, 15).map(b => 
          `💎 **${b.symbol}**: ${b.amount.toFixed(4)} ($${(b.usdValue || 0).toFixed(2)})`
        ).join('\n')
      : '_No balances found_';

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('💰 Treasury Status (Admin)')
      .setDescription('Full treasury configuration and balances')
      .addFields(
        { name: 'Status', value: statusText, inline: true },
        { name: 'Refresh Interval', value: intervalText, inline: true },
        { name: 'Wallet Address', value: walletText, inline: false },
        { name: '💵 Total Value', value: `$${totalUSD.toFixed(2)} USD`, inline: true },
        { name: '📦 Assets', value: `${balances.length}`, inline: true },
        { name: '🪙 Holdings', value: balanceList, inline: false }
      )
      .setFooter({ text: 'Use /treasury admin commands to configure' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed treasury status`);
  },

  async handleAdminRefresh(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      await treasuryService.refreshBalances();
      
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

    treasuryService.setEnabled(true);
    
    await interaction.editReply({ 
      content: '✅ Treasury monitoring enabled. Automatic refreshes will run.',
      ephemeral: true 
    });
    logger.log(`Admin ${interaction.user.tag} enabled treasury monitoring`);
  },

  async handleAdminDisable(interaction) {
    await interaction.deferReply({ ephemeral: true });

    treasuryService.setEnabled(false);
    
    await interaction.editReply({ 
      content: '❌ Treasury monitoring disabled. Automatic refreshes paused.',
      ephemeral: true 
    });
    logger.log(`Admin ${interaction.user.tag} disabled treasury monitoring`);
  },

  async handleAdminSetWallet(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const address = interaction.options.getString('address');

    // Basic Solana address validation (base58, ~32-44 chars)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      return interaction.editReply({ 
        content: '❌ Invalid Solana wallet address format.',
        ephemeral: true 
      });
    }

    treasuryService.setTreasuryWallet(address);
    
    await interaction.editReply({ 
      content: `✅ Treasury wallet set to: \`${address}\`\n\nRun \`/treasury admin refresh\` to fetch balances.`,
      ephemeral: true 
    });
    logger.log(`Admin ${interaction.user.tag} set treasury wallet to ${address}`);
  },

  async handleAdminSetInterval(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const hours = interaction.options.getInteger('hours');

    treasuryService.setRefreshInterval(hours);
    
    await interaction.editReply({ 
      content: `✅ Refresh interval set to ${hours} hour(s).`,
      ephemeral: true 
    });
    logger.log(`Admin ${interaction.user.tag} set treasury interval to ${hours} hours`);
  }
};
