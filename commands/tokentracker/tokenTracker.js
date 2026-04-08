const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const trackedWalletsService = require('../../services/trackedWalletsService');
const moduleGuard = require('../../utils/moduleGuard');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('token-tracker')
    .setDescription('Track SPL token activity and alerts')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Add a token mint to track')
        .addStringOption(o =>
          o.setName('mint').setDescription('SPL token mint address').setRequired(true))
        .addStringOption(o =>
          o.setName('symbol').setDescription('Token symbol (optional)').setRequired(false))
        .addStringOption(o =>
          o.setName('name').setDescription('Display name (optional)').setRequired(false))
        .addChannelOption(o =>
          o.setName('alert_channel').setDescription('Channel for token activity alerts (optional)').setRequired(false))
        .addNumberOption(o =>
          o.setName('min_alert_amount').setDescription('Minimum amount delta to alert on').setRequired(false))
        .addBooleanOption(o =>
          o.setName('alert_buys').setDescription('Alert on buy/swap-in events').setRequired(false))
        .addBooleanOption(o =>
          o.setName('alert_sells').setDescription('Alert on sell/swap-out events').setRequired(false))
        .addBooleanOption(o =>
          o.setName('alert_transfers').setDescription('Alert on transfer in/out events').setRequired(false))
        .addBooleanOption(o =>
          o.setName('enabled').setDescription('Enable token tracking immediately').setRequired(false)))
    .addSubcommand(sub =>
      sub
        .setName('edit')
        .setDescription('Update tracked token settings')
        .addIntegerOption(o =>
          o.setName('id').setDescription('Tracked token ID from /token-tracker list').setRequired(true))
        .addStringOption(o =>
          o.setName('mint').setDescription('Updated SPL mint address').setRequired(false))
        .addStringOption(o =>
          o.setName('symbol').setDescription('Updated token symbol').setRequired(false))
        .addStringOption(o =>
          o.setName('name').setDescription('Updated display name').setRequired(false))
        .addChannelOption(o =>
          o.setName('alert_channel').setDescription('Updated token alert channel').setRequired(false))
        .addNumberOption(o =>
          o.setName('min_alert_amount').setDescription('Minimum amount delta to alert on').setRequired(false))
        .addBooleanOption(o =>
          o.setName('alert_buys').setDescription('Alert on buy/swap-in events').setRequired(false))
        .addBooleanOption(o =>
          o.setName('alert_sells').setDescription('Alert on sell/swap-out events').setRequired(false))
        .addBooleanOption(o =>
          o.setName('alert_transfers').setDescription('Alert on transfer in/out events').setRequired(false))
        .addBooleanOption(o =>
          o.setName('enabled').setDescription('Enable or disable this tracked token').setRequired(false)))
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Remove a tracked token mint')
        .addIntegerOption(o =>
          o.setName('id').setDescription('Tracked token ID from /token-tracker list').setRequired(true)))
    .addSubcommand(sub =>
      sub
        .setName('list')
        .setDescription('List tracked token mints for this server'))
    .addSubcommand(sub =>
      sub
        .setName('feed')
        .setDescription('Show recent tracked token activity events')
        .addIntegerOption(o =>
          o.setName('limit').setDescription('Events to show (1-30)').setRequired(false).setMinValue(1).setMaxValue(30))),

  async execute(interaction) {
    if (!await moduleGuard.checkModuleEnabled(interaction, 'tokentracker')) return;
    if (!await moduleGuard.checkAdmin(interaction)) return;

    const sub = interaction.options.getSubcommand();
    try {
      switch (sub) {
        case 'add': return this.handleTokenAdd(interaction);
        case 'edit': return this.handleTokenEdit(interaction);
        case 'remove': return this.handleTokenRemove(interaction);
        case 'list': return this.handleTokenList(interaction);
        case 'feed': return this.handleTokenFeed(interaction);
        default:
          return interaction.reply({ content: 'Unknown token-tracker subcommand.', ephemeral: true });
      }
    } catch (error) {
      logger.error('[token-tracker]', error);
      const msg = 'An error occurred. Please try again.';
      if (interaction.deferred || interaction.replied) return interaction.editReply({ content: msg });
      return interaction.reply({ content: msg, ephemeral: true });
    }
  },

  async handleTokenAdd(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const mint = interaction.options.getString('mint');
    const symbol = interaction.options.getString('symbol');
    const name = interaction.options.getString('name');
    const alertChannel = interaction.options.getChannel('alert_channel');
    const minAlertAmount = interaction.options.getNumber('min_alert_amount');
    const alertBuys = interaction.options.getBoolean('alert_buys');
    const alertSells = interaction.options.getBoolean('alert_sells');
    const alertTransfers = interaction.options.getBoolean('alert_transfers');
    const enabled = interaction.options.getBoolean('enabled');

    const result = trackedWalletsService.addTrackedToken({
      guildId: interaction.guildId,
      tokenMint: mint,
      tokenSymbol: symbol,
      tokenName: name,
      alertChannelId: alertChannel?.id || null,
      alertChannelIds: alertChannel?.id ? [alertChannel.id] : [],
      minAlertAmount: minAlertAmount ?? 0,
      alertBuys: alertBuys !== false,
      alertSells: alertSells !== false,
      alertTransfers: alertTransfers === true,
      enabled: enabled !== false,
    });

    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });

    const embed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('✅ Token Mint Tracked')
      .addFields(
        { name: 'Mint', value: `\`${mint}\``, inline: false },
        { name: 'Symbol', value: symbol || '—', inline: true },
        { name: 'Name', value: name || '—', inline: true },
        { name: 'ID', value: `#${result.id}`, inline: true },
        { name: 'Alert Channel', value: alertChannel ? `<#${alertChannel.id}>` : 'Wallet default', inline: true },
        {
          name: 'Alert Rules',
          value: `Buys: ${alertBuys !== false ? 'On' : 'Off'} | Sells: ${alertSells !== false ? 'On' : 'Off'} | Transfers: ${alertTransfers === true ? 'On' : 'Off'}\nMin Amount: ${Number(minAlertAmount ?? 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}`,
          inline: false
        }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },

  async handleTokenEdit(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const id = interaction.options.getInteger('id');
    const mint = interaction.options.getString('mint');
    const symbol = interaction.options.getString('symbol');
    const name = interaction.options.getString('name');
    const alertChannel = interaction.options.getChannel('alert_channel');
    const minAlertAmount = interaction.options.getNumber('min_alert_amount');
    const alertBuys = interaction.options.getBoolean('alert_buys');
    const alertSells = interaction.options.getBoolean('alert_sells');
    const alertTransfers = interaction.options.getBoolean('alert_transfers');
    const enabled = interaction.options.getBoolean('enabled');

    const updates = {};
    if (mint !== null) updates.tokenMint = mint;
    if (symbol !== null) updates.tokenSymbol = symbol;
    if (name !== null) updates.tokenName = name;
    if (alertChannel !== null) updates.alertChannelId = alertChannel?.id || null;
    if (alertChannel !== null) updates.alertChannelIds = alertChannel?.id ? [alertChannel.id] : [];
    if (minAlertAmount !== null) updates.minAlertAmount = minAlertAmount;
    if (alertBuys !== null) updates.alertBuys = alertBuys;
    if (alertSells !== null) updates.alertSells = alertSells;
    if (alertTransfers !== null) updates.alertTransfers = alertTransfers;
    if (enabled !== null) updates.enabled = enabled;

    if (!Object.keys(updates).length) {
      return interaction.editReply({ content: '⚠️ No changes provided.' });
    }

    const result = trackedWalletsService.updateTrackedToken(id, updates, interaction.guildId);
    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });
    await interaction.editReply({ content: `✅ Tracked token #${id} updated.` });
  },

  async handleTokenRemove(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const id = interaction.options.getInteger('id');
    const result = trackedWalletsService.removeTrackedToken(id, interaction.guildId);
    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });
    await interaction.editReply({ content: result.removed ? `✅ Tracked token #${id} removed.` : `⚠️ Tracked token #${id} not found.` });
  },

  async handleTokenList(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const tokens = trackedWalletsService.getTrackedTokens(interaction.guildId);

    if (!tokens.length) {
      return interaction.editReply({ content: '📭 No token mints tracked yet. Use `/token-tracker add` to get started.' });
    }

    const lines = tokens.map(t => {
      const mint = String(t.token_mint || '');
      const mintShort = mint ? `\`${mint.slice(0, 6)}...${mint.slice(-4)}\`` : '—';
      const symbol = t.token_symbol ? ` **${t.token_symbol}**` : '';
      const name = t.token_name ? ` (${t.token_name})` : '';
      const status = Number(t.enabled || 0) === 1 ? '' : ' *(disabled)*';
      const alerts = `B:${t.alert_buys ? 'on' : 'off'} S:${t.alert_sells ? 'on' : 'off'} T:${t.alert_transfers ? 'on' : 'off'} Min:${Number(t.min_alert_amount || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
      const channels = Array.isArray(t.alert_channel_ids) ? t.alert_channel_ids : [];
      const channel = channels.length
        ? `Alert channels: ${channels.map(id => `<#${id}>`).join(', ')}`
        : (t.alert_channel_id ? `Alert channel: <#${t.alert_channel_id}>` : 'Alert channel: Wallet default');
      return `**#${t.id}** ${mintShort}${symbol}${name}${status}\n${alerts}\n${channel}`;
    });

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🪙 Tracked Token Mints')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${tokens.length} token mint(s)` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },

  async handleTokenFeed(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const limit = interaction.options.getInteger('limit') || 10;
    const events = trackedWalletsService.listTrackedTokenEvents(interaction.guildId, limit);

    if (!events.length) {
      return interaction.editReply({ content: 'No tracked token activity events yet.' });
    }

    const iconByType = {
      buy: '🟢',
      sell: '🔴',
      transfer_in: '📥',
      transfer_out: '📤',
      swap_in: '🟣',
      swap_out: '🟠'
    };

    const lines = events.slice(0, limit).map((evt, idx) => {
      const mint = String(evt.token_mint || '');
      const symbol = evt.token_symbol || evt.token_name || (mint ? `${mint.slice(0, 4)}...${mint.slice(-4)}` : 'Token');
      const type = String(evt.event_type || 'activity').toLowerCase();
      const icon = iconByType[type] || '🧩';
      const amount = Number(evt.amount_delta || 0);
      const when = evt.event_time ? `<t:${Math.floor(new Date(evt.event_time).getTime() / 1000)}:R>` : 'unknown';
      const wallet = String(evt.wallet_address || '');
      const walletShort = wallet ? `\`${wallet.slice(0, 6)}...${wallet.slice(-4)}\`` : '—';
      return `${idx + 1}. ${icon} **${type.toUpperCase()}** ${symbol} ${amount >= 0 ? '+' : ''}${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} • ${walletShort} • ${when}`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🪙 Tracked Token Activity')
      .setDescription(lines)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
