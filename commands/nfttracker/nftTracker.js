const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const nftActivityService = require('../../services/nftActivityService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nft-tracker')
    .setDescription('Track NFT collections and collection activity feeds')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup(group =>
      group
        .setName('collection')
        .setDescription('Manage tracked NFT collections for alerts')
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
              o.setName('limit').setDescription('Events to show (1-30)').setRequired(false).setMinValue(1).setMaxValue(30)))),

  async execute(interaction) {
    if (!await moduleGuard.checkModuleEnabled(interaction, 'nfttracker')) return;
    if (!await moduleGuard.checkAdmin(interaction)) return;

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (group !== 'collection') {
      return interaction.reply({ content: 'Unsupported subcommand group for /nft-tracker.', ephemeral: true });
    }

    try {
      switch (sub) {
        case 'add':
          await this.handleCollectionAdd(interaction);
          break;
        case 'remove':
          await this.handleCollectionRemove(interaction);
          break;
        case 'list':
          await this.handleCollectionList(interaction);
          break;
        case 'feed':
          await this.handleCollectionFeed(interaction);
          break;
        default:
          await interaction.reply({ content: 'Unknown nft-tracker subcommand.', ephemeral: true });
          break;
      }
    } catch (err) {
      logger.error('[nft-tracker]', err);
      const msg = 'An error occurred. Please try again.';
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: msg });
      else await interaction.reply({ content: msg, ephemeral: true });
    }
  },

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

    nftActivityService.syncAddressToHelius(address, 'add').catch(() => {});

    const embed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('✅ Collection Tracked')
      .addFields(
        { name: 'Collection', value: name, inline: true },
        { name: 'Address', value: `\`${address.slice(0, 8)}...${address.slice(-6)}\``, inline: true },
        { name: 'Alert Channel', value: `<#${channel.id}>`, inline: true },
        { name: 'ME Symbol', value: meSymbol || '-', inline: true },
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
      const ch = c.channel_id ? `<#${c.channel_id}>` : '-';
      const me = c.me_symbol ? ` (ME: ${c.me_symbol})` : '';
      const status = c.enabled ? '' : ' *(disabled)*';
      return `**#${c.id}** ${addr} - **${c.collection_name}**${me} -> ${ch}${status}`;
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
};
