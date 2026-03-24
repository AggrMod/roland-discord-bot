const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const treasuryService = require('../../services/treasuryService');
const logger = require('../../utils/logger');
const governanceLogger = require('../../utils/governanceLogger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('treasury')
    .setDescription('Manage treasury monitoring (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('View current treasury status')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('refresh')
        .setDescription('Manually refresh treasury balances')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('enable')
        .setDescription('Enable treasury monitoring')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('disable')
        .setDescription('Disable treasury monitoring')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('set-wallet')
        .setDescription('Set the treasury wallet address')
        .addStringOption(option =>
          option
            .setName('address')
            .setDescription('Solana wallet address to monitor')
            .setRequired(true)
        )
    )
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
            .setMaxValue(168)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('panel')
        .setDescription('Post treasury monitoring panel in current channel')
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommand === 'status') {
        await handleStatus(interaction);
      } else if (subcommand === 'refresh') {
        await handleRefresh(interaction);
      } else if (subcommand === 'enable') {
        await handleEnable(interaction);
      } else if (subcommand === 'disable') {
        await handleDisable(interaction);
      } else if (subcommand === 'set-wallet') {
        await handleSetWallet(interaction);
      } else if (subcommand === 'set-interval') {
        await handleSetInterval(interaction);
      } else if (subcommand === 'panel') {
        await handlePanel(interaction);
      }
    } catch (error) {
      logger.error('Error executing treasury command:', error);
      const errorEmbed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Error')
        .setDescription('An error occurred while processing your request.')
        .setTimestamp();

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
      } else {
        await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      }
    }
  },
};

async function handleStatus(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const summary = treasuryService.getAdminSummary();

  if (!summary.success) {
    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('❌ Treasury Status')
      .setDescription(summary.message)
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  const statusEmoji = {
    ok: '✅',
    warning: '⚠️',
    stale: '🔴',
    never_updated: '⭕'
  };

  const statusText = {
    ok: 'Current',
    warning: 'Needs Refresh',
    stale: 'Stale',
    never_updated: 'Never Updated'
  };

  const config = summary.config;
  const treasury = summary.treasury;

  const embed = new EmbedBuilder()
    .setColor(config.enabled ? '#00FF00' : '#808080')
    .setTitle('💰 Treasury Watch Status')
    .addFields(
      { 
        name: '⚙️ Configuration', 
        value: `**Enabled:** ${config.enabled ? '✅ Yes' : '❌ No'}\n**Wallet:** ${config.wallet || 'Not configured'}\n**Refresh Interval:** ${config.refreshHours} hours`, 
        inline: false 
      },
      { 
        name: '💵 Balances', 
        value: `**SOL:** ${treasury.sol}\n**USDC:** ${treasury.usdc}`, 
        inline: true 
      },
      { 
        name: '📊 Status', 
        value: `${statusEmoji[treasury.status]} ${statusText[treasury.status]}${treasury.staleMinutes ? `\n(${treasury.staleMinutes} min ago)` : ''}`, 
        inline: true 
      }
    )
    .setTimestamp();

  if (treasury.lastUpdated) {
    embed.setFooter({ text: `Last updated: ${new Date(treasury.lastUpdated).toLocaleString()}` });
  }

  if (config.lastError) {
    embed.addFields({ 
      name: '❌ Last Error', 
      value: config.lastError, 
      inline: false 
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleRefresh(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const config = treasuryService.getConfig();

  if (!config || !config.enabled) {
    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('❌ Cannot Refresh')
      .setDescription('Treasury monitoring is disabled. Enable it first with `/treasury enable`.')
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  if (!config.solana_wallet) {
    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('❌ Cannot Refresh')
      .setDescription('No wallet configured. Set a wallet with `/treasury set-wallet`.')
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  const result = await treasuryService.fetchBalances();

  if (!result.success) {
    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('❌ Refresh Failed')
      .setDescription(`Error: ${result.message || result.error}`)
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  const embed = new EmbedBuilder()
    .setColor('#00FF00')
    .setTitle('✅ Treasury Refreshed')
    .addFields(
      { name: '💵 SOL Balance', value: result.balances.sol, inline: true },
      { name: '💵 USDC Balance', value: result.balances.usdc, inline: true }
    )
    .setFooter({ text: `Updated at ${new Date(result.balances.lastUpdated).toLocaleString()}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
  logger.log(`Treasury manually refreshed by ${interaction.user.tag}`);
}

async function handleEnable(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const result = treasuryService.updateConfig({ enabled: true });

  const embed = new EmbedBuilder()
    .setColor(result.success ? '#00FF00' : '#FF0000')
    .setTitle(result.success ? '✅ Treasury Enabled' : '❌ Error')
    .setDescription(result.message)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
  logger.log(`Treasury monitoring enabled by ${interaction.user.tag}`);
}

async function handleDisable(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const result = treasuryService.updateConfig({ enabled: false });

  const embed = new EmbedBuilder()
    .setColor(result.success ? '#00FF00' : '#FF0000')
    .setTitle(result.success ? '⏸️ Treasury Disabled' : '❌ Error')
    .setDescription(result.message)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
  logger.log(`Treasury monitoring disabled by ${interaction.user.tag}`);
}

async function handleSetWallet(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const address = interaction.options.getString('address');
  const result = treasuryService.updateConfig({ solanaWallet: address });

  if (!result.success) {
    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('❌ Invalid Wallet')
      .setDescription(result.message)
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  const maskedAddress = treasuryService.maskAddress(address);

  const embed = new EmbedBuilder()
    .setColor('#00FF00')
    .setTitle('✅ Wallet Configured')
    .setDescription(`Treasury wallet set to: **${maskedAddress}**`)
    .setFooter({ text: 'Use /treasury refresh to fetch initial balances' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
  logger.log(`Treasury wallet set to ${maskedAddress} by ${interaction.user.tag}`);
}

async function handleSetInterval(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const hours = interaction.options.getInteger('hours');
  const result = treasuryService.updateConfig({ refreshHours: hours });

  const embed = new EmbedBuilder()
    .setColor(result.success ? '#00FF00' : '#FF0000')
    .setTitle(result.success ? '✅ Interval Updated' : '❌ Error')
    .setDescription(result.success 
      ? `Refresh interval set to **${hours} hours**` 
      : result.message
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
  logger.log(`Treasury refresh interval set to ${hours} hours by ${interaction.user.tag}`);
}

async function handlePanel(interaction) {
  await interaction.deferReply();

  const { embed, components } = buildTreasuryPanel();

  await interaction.editReply({ embeds: [embed], components: [components] });
  
  // Log to governance if available
  try {
    governanceLogger.logAction({
      type: 'treasury_panel_posted',
      actor: interaction.user.id,
      channel: interaction.channel.id,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    // Governance logger may not be configured, ignore
  }

  logger.log(`Treasury panel posted by ${interaction.user.tag} in #${interaction.channel.name}`);
}

function buildTreasuryPanel() {
  const config = treasuryService.getConfig();
  
  let embed;
  
  if (!config || !config.enabled) {
    // Disabled state
    embed = new EmbedBuilder()
      .setColor('#808080')
      .setTitle('💰 Treasury Monitor')
      .setDescription('⚙️ **Treasury monitoring is currently disabled.**\n\nAn administrator can enable it using `/treasury enable`.')
      .setTimestamp();
  } else if (!config.solana_wallet) {
    // No wallet configured state
    embed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('💰 Treasury Monitor')
      .setDescription('⚠️ **No wallet configured.**\n\nAn administrator needs to set a wallet using `/treasury set-wallet`.')
      .setTimestamp();
  } else {
    // Normal operational state
    const statusEmoji = {
      ok: '✅',
      warning: '⚠️',
      stale: '🔴',
      never_updated: '⭕'
    };

    const statusText = {
      ok: 'Current',
      warning: 'Needs Refresh',
      stale: 'Stale Data',
      never_updated: 'Not Yet Updated'
    };

    const staleness = treasuryService.checkStaleness(config.last_updated, config.refresh_hours);
    const sol = config.sol_balance || '0.0000';
    const usdc = config.usdc_balance || '0.0000';

    let color = '#00FF00'; // Green for ok
    if (staleness.status === 'warning') color = '#FFA500'; // Orange
    if (staleness.status === 'stale' || staleness.status === 'never_updated') color = '#FF0000'; // Red

    embed = new EmbedBuilder()
      .setColor(color)
      .setTitle('💰 Treasury Monitor')
      .addFields(
        { name: '💵 SOL Balance', value: `**${sol}** SOL`, inline: true },
        { name: '💵 USDC Balance', value: `**$${usdc}**`, inline: true },
        { name: '📊 Status', value: `${statusEmoji[staleness.status]} ${statusText[staleness.status]}`, inline: true }
      )
      .setTimestamp();

    if (config.last_updated) {
      const lastUpdatedDate = new Date(config.last_updated);
      embed.setFooter({ text: `Last updated: ${lastUpdatedDate.toLocaleString()}` });
    } else {
      embed.setFooter({ text: 'Never updated - click refresh to fetch data' });
    }

    if (config.last_error) {
      embed.addFields({ 
        name: '❌ Last Error', 
        value: config.last_error.substring(0, 200), 
        inline: false 
      });
    }
  }

  // Always include refresh button
  const refreshButton = new ButtonBuilder()
    .setCustomId('treasury_refresh_panel')
    .setLabel('🔄 Refresh')
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder()
    .addComponents(refreshButton);

  return { embed, components: row };
}

// Export for use in button handler
module.exports.buildTreasuryPanel = buildTreasuryPanel;
