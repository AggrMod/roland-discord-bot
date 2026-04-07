const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const trackedWalletsService = require('../../services/trackedWalletsService');
const nftActivityService = require('../../services/nftActivityService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nft-tracker')
    .setDescription('🔎 NFT Wallet Tracker — monitor wallets, TX alerts, and holdings panels')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

    // ── wallet subcommands ──────────────────────────────────────────────────
    .addSubcommandGroup(group =>
      group
        .setName('wallet')
        .setDescription('Manage tracked wallets')

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
              o.setName('id').setDescription('Wallet ID (from /nft-tracker wallet list)').setRequired(true)))

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
            .setDescription('Refresh holdings panels for all tracked wallets that have a panel channel configured')))

    // ── collection subcommands (moved from /verification admin) ───────────
    .addSubcommandGroup(group =>
      group
        .setName('collection')
        .setDescription('Manage tracked NFT collections for TX alerts')

        .addSubcommand(sub =>
          sub
            .setName('add')
            .setDescription('Track a collection for sales/listings/mints')
            .addStringOption(o =>
              o.setName('address').setDescription('Collection address (on-chain)').setRequired(true))
            .addStringOption(o =>
              o.setName('name').setDescription('Display name').setRequired(true))
            .addChannelOption(o =>
              o.setName('channel').setDescription('Channel for alerts').setRequired(true))
            .addStringOption(o =>
              o.setName('me_symbol').setDescription('Magic Eden collection symbol (for poll fallback)').setRequired(false)))

        .addSubcommand(sub =>
          sub
            .setName('remove')
            .setDescription('Stop tracking a collection')
            .addIntegerOption(o =>
              o.setName('id').setDescription('Collection ID from /nft-tracker collection list').setRequired(true)))

        .addSubcommand(sub =>
          sub
            .setName('list')
            .setDescription('List all tracked collections'))

        .addSubcommand(sub =>
          sub
            .setName('feed')
            .setDescription('Show recent NFT activity feed')
            .addIntegerOption(o =>
              o.setName('limit').setDescription('Events to show (1–30)').setRequired(false).setMinValue(1).setMaxValue(30))))

    // ── token subcommands ───────────────────────────────────────────────────
    .addSubcommandGroup(group =>
      group
        .setName('token')
        .setDescription('Track SPL token mints in wallet holdings')

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
              o.setName('id').setDescription('Tracked token ID from /nft-tracker token list').setRequired(true))
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
              o.setName('id').setDescription('Tracked token ID from /nft-tracker token list').setRequired(true)))

        .addSubcommand(sub =>
          sub
            .setName('list')
            .setDescription('List tracked token mints for this server'))

        .addSubcommand(sub =>
          sub
            .setName('feed')
            .setDescription('Show recent tracked token activity events')
            .addIntegerOption(o =>
              o.setName('limit').setDescription('Events to show (1-30)').setRequired(false).setMinValue(1).setMaxValue(30)))),

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    const requiredModule = group === 'token' ? 'tokentracker' : 'nfttracker';
    if (!await moduleGuard.checkModuleEnabled(interaction, requiredModule)) return;
    if (!await moduleGuard.checkAdmin(interaction)) return;

    try {
      if (group === 'wallet') {
        switch (sub) {
          case 'add':      return this.handleWalletAdd(interaction);
          case 'remove':   return this.handleWalletRemove(interaction);
          case 'list':     return this.handleWalletList(interaction);
          case 'edit':     return this.handleWalletEdit(interaction);
          case 'holdings': return this.handleWalletHoldings(interaction);
          case 'refresh-all': return this.handleWalletRefreshAll(interaction);
        }
      }
      if (group === 'collection') {
        switch (sub) {
          case 'add':    return this.handleCollectionAdd(interaction);
          case 'remove': return this.handleCollectionRemove(interaction);
          case 'list':   return this.handleCollectionList(interaction);
          case 'feed':   return this.handleCollectionFeed(interaction);
        }
      }
      if (group === 'token') {
        switch (sub) {
          case 'add':    return this.handleTokenAdd(interaction);
          case 'edit':   return this.handleTokenEdit(interaction);
          case 'remove': return this.handleTokenRemove(interaction);
          case 'list':   return this.handleTokenList(interaction);
          case 'feed':   return this.handleTokenFeed(interaction);
        }
      }
    } catch (err) {
      logger.error('[nft-tracker]', err);
      const msg = 'An error occurred. Please try again.';
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: msg });
      else await interaction.reply({ content: msg, ephemeral: true });
    }
  },

  // ── Wallet Handlers ───────────────────────────────────────────────────────

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
      .setFooter({ text: 'Use /nft-tracker wallet holdings to post the first holdings panel' })
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
      return interaction.editReply({ content: '📭 No wallets tracked yet. Use `/nft-tracker wallet add` to get started.' });
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

  // ── Collection Handlers ────────────────────────────────────────────────────

  async handleCollectionAdd(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const address = interaction.options.getString('address');
    const name = interaction.options.getString('name');
    const channel = interaction.options.getChannel('channel');
    const meSymbol = interaction.options.getString('me_symbol');

    const result = nftActivityService.addTrackedCollection({
      guildId: interaction.guildId,
      collectionAddress: address,
      collectionName: name,
      channelId: channel.id,
      trackMint: true,
      trackSale: true,
      trackList: true,
      trackDelist: true,
      trackTransfer: false,
      trackBid: false,
      meSymbol: meSymbol || '',
    });

    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });

    // Sync to Helius webhook if configured
    nftActivityService.syncAddressToHelius(address, 'add').catch(() => {});

    const embed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('✅ Collection Tracked')
      .addFields(
        { name: 'Collection', value: name, inline: true },
        { name: 'Address', value: `\`${address.slice(0, 8)}...${address.slice(-6)}\``, inline: true },
        { name: 'Alert Channel', value: `<#${channel.id}>`, inline: true },
        { name: 'ME Symbol', value: meSymbol || '—', inline: true },
        { name: 'ID', value: `#${result.id}`, inline: true },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },

  async handleCollectionRemove(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const id = interaction.options.getInteger('id');
    const result = nftActivityService.removeTrackedCollection(id, interaction.guildId);
    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });
    await interaction.editReply({ content: result.removed ? `✅ Collection #${id} removed.` : `⚠️ Collection #${id} not found.` });
  },

  async handleCollectionList(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const collections = nftActivityService.getTrackedCollections(interaction.guildId);

    if (!collections.length) {
      return interaction.editReply({ content: '📭 No collections tracked. Use `/nft-tracker collection add` to get started.' });
    }

    const lines = collections.map(c => {
      const addr = `\`${c.collection_address.slice(0, 6)}...${c.collection_address.slice(-4)}\``;
      const ch = c.channel_id ? `<#${c.channel_id}>` : '—';
      const me = c.me_symbol ? ` (ME: ${c.me_symbol})` : '';
      const status = c.enabled ? '' : ' *(disabled)*';
      return `**#${c.id}** ${addr} — **${c.collection_name}**${me} → ${ch}${status}`;
    });

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('📦 Tracked Collections')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${collections.length} collection(s)` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },

  async handleCollectionFeed(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const limit = interaction.options.getInteger('limit') || 10;
    const events = nftActivityService.listEventsForGuild(interaction.guildId, limit);

    if (!events.length) return interaction.editReply({ content: 'No NFT activity events yet.' });

    const lines = events.slice(0, limit).map((e, i) => {
      const t = e.event_time ? Math.floor(new Date(e.event_time).getTime() / 1000) : null;
      const when = t ? `<t:${t}:R>` : 'unknown';
      const price = e.price_sol != null ? ` | ${e.price_sol} SOL` : '';
      return `${i + 1}. **${e.event_type}** ${e.collection_key ? `(${e.collection_key.slice(0, 8)}...)` : ''} ${e.token_name || ''}${price} • ${when}`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('📡 NFT Activity Feed')
      .setDescription(lines)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
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
      .setFooter({ text: 'Tracked token balances appear in wallet holdings panels and token alerts' })
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
      return interaction.editReply({ content: '📭 No token mints tracked yet. Use `/nft-tracker token add` to get started.' });
    }

    const lines = tokens.map(t => {
      const mint = String(t.token_mint || '');
      const mintShort = mint ? `\`${mint.slice(0, 6)}...${mint.slice(-4)}\`` : '—';
      const symbol = t.token_symbol ? ` **${t.token_symbol}**` : '';
      const name = t.token_name ? ` (${t.token_name})` : '';
      const status = Number(t.enabled || 0) === 1 ? '' : ' *(disabled)*';
      const alerts = `B:${t.alert_buys ? 'on' : 'off'} S:${t.alert_sells ? 'on' : 'off'} T:${t.alert_transfers ? 'on' : 'off'} Min:${Number(t.min_alert_amount || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
      const channel = t.alert_channel_id ? `Alert channel: <#${t.alert_channel_id}>` : 'Alert channel: Wallet default';
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
