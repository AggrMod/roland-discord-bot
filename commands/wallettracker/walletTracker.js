const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const trackedWalletsService = require('../../services/trackedWalletsService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('wallet-tracker')
    .setDescription('Track wallets for alerts and holdings panels')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Start tracking a wallet for TX alerts and holdings')
        .addStringOption(o =>
          o.setName('address').setDescription('Solana wallet address').setRequired(true))
        .addStringOption(o =>
          o.setName('label').setDescription('Friendly name (e.g. "Whale #1")').setRequired(false))
        .addChannelOption(o =>
          o.setName('alert_channel').setDescription('Channel to post TX alerts in').setRequired(false))
        .addChannelOption(o =>
          o.setName('panel_channel').setDescription('Channel to post holdings panel in').setRequired(false)))
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Stop tracking a wallet')
        .addIntegerOption(o =>
          o.setName('id').setDescription('Wallet ID (from /wallet-tracker list)').setRequired(true)))
    .addSubcommand(sub =>
      sub
        .setName('list')
        .setDescription('List all tracked wallets for this server'))
    .addSubcommand(sub =>
      sub
        .setName('edit')
        .setDescription('Update label or channels for a tracked wallet')
        .addIntegerOption(o =>
          o.setName('id').setDescription('Wallet ID').setRequired(true))
        .addStringOption(o =>
          o.setName('label').setDescription('New friendly name').setRequired(false))
        .addChannelOption(o =>
          o.setName('alert_channel').setDescription('New TX alert channel').setRequired(false))
        .addChannelOption(o =>
          o.setName('panel_channel').setDescription('New holdings panel channel').setRequired(false))
        .addBooleanOption(o =>
          o.setName('enabled').setDescription('Enable or disable tracking').setRequired(false)))
    .addSubcommand(sub =>
      sub
        .setName('holdings')
        .setDescription('Post (or refresh) the holdings panel for a tracked wallet')
        .addIntegerOption(o =>
          o.setName('id').setDescription('Wallet ID').setRequired(true))
        .addChannelOption(o =>
          o.setName('channel').setDescription('Override channel (defaults to configured panel_channel)').setRequired(false)))
    .addSubcommand(sub =>
      sub
        .setName('refresh-all')
        .setDescription('Refresh holdings panels for all tracked wallets that have a panel channel configured')),

  async execute(interaction) {
    if (!await moduleGuard.checkModuleEnabled(interaction, 'wallettracker')) return;
    if (!await moduleGuard.checkAdmin(interaction)) return;

    const sub = interaction.options.getSubcommand();
    try {
      switch (sub) {
        case 'add': return this.handleWalletAdd(interaction);
        case 'remove': return this.handleWalletRemove(interaction);
        case 'list': return this.handleWalletList(interaction);
        case 'edit': return this.handleWalletEdit(interaction);
        case 'holdings': return this.handleWalletHoldings(interaction);
        case 'refresh-all': return this.handleWalletRefreshAll(interaction);
        default:
          return interaction.reply({ content: 'Unknown wallet-tracker subcommand.', ephemeral: true });
      }
    } catch (err) {
      logger.error('[wallet-tracker]', err);
      const msg = 'An error occurred. Please try again.';
      if (interaction.deferred || interaction.replied) return interaction.editReply({ content: msg });
      return interaction.reply({ content: msg, ephemeral: true });
    }
  },

  async handleWalletAdd(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const address = interaction.options.getString('address');
    const label = interaction.options.getString('label');
    const alertCh = interaction.options.getChannel('alert_channel');
    const panelCh = interaction.options.getChannel('panel_channel');
    const guildId = interaction.guildId;

    const result = trackedWalletsService.addTrackedWallet({
      guildId,
      walletAddress: address,
      label,
      alertChannelId: alertCh?.id || null,
      panelChannelId: panelCh?.id || null,
    });

    if (!result.success) {
      return interaction.editReply({ content: `❌ ${result.message}` });
    }

    const embed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('✅ Wallet Tracked')
      .addFields(
        { name: 'Address', value: `\`${address}\``, inline: false },
        { name: 'Label', value: label || '—', inline: true },
        { name: 'TX Alert Channel', value: alertCh ? `<#${alertCh.id}>` : '—', inline: true },
        { name: 'Holdings Panel Channel', value: panelCh ? `<#${panelCh.id}>` : '—', inline: true },
        { name: 'ID', value: `#${result.id}`, inline: true },
      )
      .setFooter({ text: 'Use /wallet-tracker holdings to post the first holdings panel' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },

  async handleWalletRemove(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const id = interaction.options.getInteger('id');
    const result = trackedWalletsService.removeTrackedWallet(id, interaction.guildId);
    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });
    await interaction.editReply({
      content: result.removed ? `✅ Wallet #${id} removed.` : `⚠️ Wallet #${id} not found.`,
    });
  },

  async handleWalletList(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const wallets = trackedWalletsService.getTrackedWallets(interaction.guildId);

    if (!wallets.length) {
      return interaction.editReply({ content: '📭 No wallets tracked yet. Use `/wallet-tracker add` to get started.' });
    }

    const lines = wallets.map(w => {
      const addr = `\`${w.wallet_address.slice(0, 6)}...${w.wallet_address.slice(-4)}\``;
      const lbl = w.label ? ` — **${w.label}**` : '';
      const alertCh = w.alert_channel_id ? ` 🔔<#${w.alert_channel_id}>` : '';
      const panelCh = w.panel_channel_id ? ` 📋<#${w.panel_channel_id}>` : '';
      const status = w.enabled ? '' : ' *(disabled)*';
      return `**#${w.id}** ${addr}${lbl}${alertCh}${panelCh}${status}`;
    });

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🔎 Tracked Wallets')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${wallets.length} wallet(s)` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },

  async handleWalletEdit(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const id = interaction.options.getInteger('id');
    const label = interaction.options.getString('label');
    const alertCh = interaction.options.getChannel('alert_channel');
    const panelCh = interaction.options.getChannel('panel_channel');
    const enabled = interaction.options.getBoolean('enabled');

    const updates = {};
    if (label !== null) updates.label = label;
    if (alertCh !== null) updates.alertChannelId = alertCh.id;
    if (panelCh !== null) updates.panelChannelId = panelCh.id;
    if (enabled !== null) updates.enabled = enabled;

    if (!Object.keys(updates).length) {
      return interaction.editReply({ content: '⚠️ No changes specified.' });
    }

    const result = trackedWalletsService.updateTrackedWallet(id, updates, interaction.guildId);
    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });
    await interaction.editReply({ content: `✅ Wallet #${id} updated.` });
  },

  async handleWalletHoldings(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const id = interaction.options.getInteger('id');
    const overrideChannel = interaction.options.getChannel('channel');

    const wallet = trackedWalletsService.getTrackedWalletById(id, interaction.guildId);
    if (!wallet) return interaction.editReply({ content: `❌ Wallet #${id} not found.` });

    await interaction.editReply({ content: `⏳ Fetching holdings for \`${wallet.wallet_address}\`...` });

    const result = await trackedWalletsService.postHoldingsPanel(
      wallet,
      overrideChannel?.id || null,
      interaction.guildId,
    );

    if (!result.success) {
      return interaction.editReply({ content: `❌ ${result.message}` });
    }

    await interaction.editReply({
      content: `✅ Holdings panel ${result.action === 'updated' ? 'updated' : 'posted'}! (msg ID: ${result.messageId})`,
    });
  },

  async handleWalletRefreshAll(interaction) {
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply({ content: '⏳ Refreshing all holdings panels...' });

    await trackedWalletsService.refreshAllPanels(interaction.guildId);
    await interaction.editReply({ content: '✅ All holdings panels refreshed.' });
  },
};

