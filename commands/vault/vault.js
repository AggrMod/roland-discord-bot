const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} = require('discord.js');
const moduleGuard = require('../../utils/moduleGuard');
const vaultService = require('../../services/vaultService');
const logger = require('../../utils/logger');

function parseConfigValue(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed.length) return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (!Number.isNaN(Number(trimmed)) && trimmed !== '') return Number(trimmed);
  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    return trimmed;
  }
}

function normalizeQuantity(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, parsed);
}

function formatRewardInventory(reward) {
  const quantity = normalizeQuantity(reward?.quantity);
  const quantityLabel = quantity === null ? 'unlimited' : `${quantity}`;
  const status = reward?.enabled === false ? 'disabled' : 'enabled';
  return `\`${reward.code}\` | ${reward.name} | tier=${reward.tier} | weight=${reward.weight} | qty=${quantityLabel} | ${status}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('vault')
    .setDescription('Reward Vault module commands')
    .addSubcommand((sub) =>
      sub.setName('balance').setDescription('Show your vault balance and season stats'))
    .addSubcommand((sub) =>
      sub.setName('open').setDescription('Spend one key to open the vault'))
    .addSubcommand((sub) =>
      sub
        .setName('history')
        .setDescription('Show your recent vault openings')
        .addIntegerOption((option) =>
          option.setName('limit').setDescription('Entries to show (1-20)').setRequired(false).setMinValue(1).setMaxValue(20)))
    .addSubcommand((sub) =>
      sub
        .setName('rewards')
        .setDescription('Show all available vault rewards'))
    .addSubcommand((sub) =>
      sub
        .setName('leaderboard')
        .setDescription('Show top users in this season')
        .addStringOption((option) =>
          option.setName('sort_by')
            .setDescription('Sort field')
            .setRequired(false)
            .addChoices(
              { name: 'Keys Used', value: 'keys_used' },
              { name: 'Keys Earned', value: 'keys_earned' },
              { name: 'Paid Mints', value: 'paid_mints' },
              { name: 'Rewards Won', value: 'rewards_won' },
            ))
        .addIntegerOption((option) =>
          option.setName('limit').setDescription('Rows to show (1-25)').setRequired(false).setMinValue(1).setMaxValue(25)))
    .addSubcommandGroup((group) =>
      group
        .setName('admin')
        .setDescription('Vault administration')
        .addSubcommand((sub) =>
          sub
            .setName('setup')
            .setDescription('Initialize/update baseline vault settings')
            .addBooleanOption((option) => option.setName('enabled').setDescription('Enable vault module').setRequired(false))
            .addStringOption((option) => option.setName('project_name').setDescription('Project display name').setRequired(false))
            .addStringOption((option) => option.setName('vault_name').setDescription('Vault game name').setRequired(false)))
        .addSubcommand((sub) =>
          sub.setName('panel').setDescription('Post the Vault action panel')
            .addChannelOption((option) =>
              option
                .setName('channel')
                .setDescription('Channel to post panel in')
                .setRequired(false)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
        .addSubcommand((sub) =>
          sub.setName('config-view').setDescription('View current vault config summary'))
        .addSubcommand((sub) =>
          sub
            .setName('config-set')
            .setDescription('Set a config key path to a value')
            .addStringOption((option) => option.setName('key').setDescription('Path, e.g. mintRules.keysPerPaidMint').setRequired(true))
            .addStringOption((option) => option.setName('value').setDescription('Value (supports JSON)').setRequired(true)))
        .addSubcommand((sub) =>
          sub
            .setName('addkeys')
            .setDescription('Add keys to a user')
            .addUserOption((option) => option.setName('user').setDescription('Target user').setRequired(true))
            .addIntegerOption((option) => option.setName('amount').setDescription('Amount to add').setRequired(true).setMinValue(1))
            .addStringOption((option) => option.setName('reason').setDescription('Reason').setRequired(false)))
        .addSubcommand((sub) =>
          sub
            .setName('removekeys')
            .setDescription('Remove available keys from a user')
            .addUserOption((option) => option.setName('user').setDescription('Target user').setRequired(true))
            .addIntegerOption((option) => option.setName('amount').setDescription('Amount to remove').setRequired(true).setMinValue(1))
            .addStringOption((option) => option.setName('reason').setDescription('Reason').setRequired(false)))
        .addSubcommand((sub) =>
          sub
            .setName('rewards-list')
            .setDescription('List configured reward table entries'))
        .addSubcommand((sub) =>
          sub
            .setName('rewards-add')
            .setDescription('Add reward to reward table')
            .addStringOption((option) => option.setName('code').setDescription('Unique reward code').setRequired(true))
            .addStringOption((option) => option.setName('name').setDescription('Display name').setRequired(true))
            .addStringOption((option) =>
              option.setName('tier')
                .setDescription('Reward tier')
                .setRequired(true)
                .addChoices(
                  { name: 'Common', value: 'common' },
                  { name: 'Rare', value: 'rare' },
                  { name: 'Epic', value: 'epic' },
                  { name: 'Legendary', value: 'legendary' },
                ))
            .addIntegerOption((option) => option.setName('weight').setDescription('Weight >= 0').setRequired(true).setMinValue(0))
            .addIntegerOption((option) => option.setName('quantity').setDescription('Available quantity (leave empty for unlimited)').setRequired(false).setMinValue(0))
            .addStringOption((option) => option.setName('type').setDescription('claimable_reward|none').setRequired(false))
            .addStringOption((option) => option.setName('payload_json').setDescription('JSON payload').setRequired(false)))
        .addSubcommand((sub) =>
          sub
            .setName('rewards-update')
            .setDescription('Update a reward entry')
            .addStringOption((option) => option.setName('code').setDescription('Reward code').setRequired(true))
            .addStringOption((option) => option.setName('name').setDescription('Display name').setRequired(false))
            .addStringOption((option) =>
              option.setName('tier')
                .setDescription('Reward tier')
                .setRequired(false)
                .addChoices(
                  { name: 'Common', value: 'common' },
                  { name: 'Rare', value: 'rare' },
                  { name: 'Epic', value: 'epic' },
                  { name: 'Legendary', value: 'legendary' },
                ))
            .addIntegerOption((option) => option.setName('weight').setDescription('Weight >= 0').setRequired(false).setMinValue(0))
            .addIntegerOption((option) => option.setName('quantity').setDescription('Available quantity (set 0 to disable inventory)').setRequired(false).setMinValue(0))
            .addBooleanOption((option) => option.setName('enabled').setDescription('Enable/disable reward').setRequired(false))
            .addStringOption((option) => option.setName('type').setDescription('claimable_reward|none').setRequired(false))
            .addStringOption((option) => option.setName('payload_json').setDescription('JSON payload').setRequired(false)))
        .addSubcommand((sub) =>
          sub
            .setName('rewards-remove')
            .setDescription('Remove reward from table')
            .addStringOption((option) => option.setName('code').setDescription('Reward code').setRequired(true)))
        .addSubcommand((sub) =>
          sub
            .setName('setstatus')
            .setDescription('Set vault active/inactive')
            .addBooleanOption((option) => option.setName('enabled').setDescription('Enable vault').setRequired(true)))
        .addSubcommand((sub) =>
          sub
            .setName('backfill')
            .setDescription('Backfill active season key grants for linked wallet')
            .addUserOption((option) => option.setName('user').setDescription('Target user').setRequired(true))
            .addStringOption((option) => option.setName('wallet').setDescription('Linked wallet address').setRequired(true)))),

  async execute(interaction) {
    if (!await moduleGuard.checkModuleEnabled(interaction, 'vault')) return;

    const subGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(false);
    const guildId = interaction.guildId;

    try {
      if (subGroup === 'admin') {
        if (!await moduleGuard.checkAdmin(interaction)) return;
        switch (subcommand) {
          case 'setup': return this.handleAdminSetup(interaction, guildId);
          case 'panel': return this.handleAdminPanel(interaction, guildId);
          case 'config-view': return this.handleAdminConfigView(interaction, guildId);
          case 'config-set': return this.handleAdminConfigSet(interaction, guildId);
          case 'addkeys': return this.handleAdminAddKeys(interaction, guildId);
          case 'removekeys': return this.handleAdminRemoveKeys(interaction, guildId);
          case 'rewards-list': return this.handleAdminRewardsList(interaction, guildId);
          case 'rewards-add': return this.handleAdminRewardsAdd(interaction, guildId);
          case 'rewards-update': return this.handleAdminRewardsUpdate(interaction, guildId);
          case 'rewards-remove': return this.handleAdminRewardsRemove(interaction, guildId);
          case 'setstatus': return this.handleAdminSetStatus(interaction, guildId);
          case 'backfill': return this.handleAdminBackfill(interaction, guildId);
          default:
            return interaction.reply({ content: 'Unknown admin subcommand.', ephemeral: true });
        }
      }

      switch (subcommand) {
        case 'balance': return this.handleBalance(interaction, guildId);
        case 'open': return this.handleOpen(interaction, guildId);
        case 'history': return this.handleHistory(interaction, guildId);
        case 'rewards': return this.handleRewards(interaction, guildId);
        case 'leaderboard': return this.handleLeaderboard(interaction, guildId);
        default:
          return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
      }
    } catch (error) {
      logger.error('[vault command] error:', error);
      const payload = { content: 'An error occurred while handling vault command.', ephemeral: true };
      if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
      return interaction.reply(payload);
    }
  },

  async handlePanelButton(interaction) {
    if (!interaction?.isButton?.()) return false;
    if (!await moduleGuard.checkModuleEnabled(interaction, 'vault')) return true;

    const guildId = interaction.guildId;
    const customId = String(interaction.customId || '');
    if (!customId.startsWith('vault_panel_')) return false;

    if (customId === 'vault_panel_open') {
      await interaction.deferReply({ ephemeral: true });
      const result = vaultService.openVault(guildId, interaction.user.id);
      if (!result.success) {
        await interaction.editReply({ content: `ERROR: ${result.message}` });
        return true;
      }
      const config = vaultService.getConfig(guildId);
      if (String(result.reward?.code || '') === 'no_reward') {
        const noRewardText = String(config?.messages?.noRewardOpen || 'Vault opened. No reward this time.');
        await interaction.editReply({
          content: `${noRewardText}\nAvailable keys: ${result.stats.available_keys}`,
        });
        return true;
      }
      await interaction.editReply({
        content: `Vault opened.\nReward: **${result.reward?.name || 'Unknown'}** (${result.reward?.tier || 'common'})\nAvailable keys: ${result.stats.available_keys}`,
      });
      return true;
    }

    if (customId === 'vault_panel_rewards') {
      await interaction.deferReply({ ephemeral: true });
      const rewards = vaultService.getRewards(guildId)
        .filter((reward) => reward && reward.enabled !== false && Number(reward.weight || 0) > 0)
        .filter((reward) => reward.quantity === null || Number(reward.quantity || 0) > 0);
      if (!rewards.length) {
        await interaction.editReply({ content: 'No available rewards configured.' });
        return true;
      }
      const lines = rewards.slice(0, 25).map((reward) => `- ${formatRewardInventory(reward)}`);
      await interaction.editReply({ content: `Available rewards:\n${lines.join('\n')}` });
      return true;
    }

    if (customId === 'vault_panel_leaderboard') {
      await interaction.deferReply({ ephemeral: true });
      const result = vaultService.getLeaderboard(guildId, null, 'keys_used', 10);
      if (!result.success || !Array.isArray(result.rows) || result.rows.length === 0) {
        await interaction.editReply({ content: 'No leaderboard data yet.' });
        return true;
      }
      const lines = result.rows.map((row, index) => `${index + 1}. <@${row.discord_user_id}> - keys used: ${row.keys_used} - rewards won: ${row.rewards_won}`);
      await interaction.editReply({
        content: `${result.season?.season_name || result.season?.season_id || 'Season'} leaderboard:\n${lines.join('\n')}`,
      });
      return true;
    }

    return false;
  },

  buildPanelMessage(guildId) {
    const config = vaultService.getConfig(guildId);
    const season = vaultService.getActiveSeason(guildId);
    const rewards = vaultService.getRewards(guildId)
      .filter((reward) => reward && reward.enabled !== false && Number(reward.weight || 0) > 0)
      .filter((reward) => reward.quantity === null || Number(reward.quantity || 0) > 0);

    const embed = new EmbedBuilder()
      .setColor('#f59e0b')
      .setTitle(`${config?.general?.gameName || 'Reward Vault'} Panel`)
      .setDescription('Open the vault, inspect available rewards, or view leaderboard standing.')
      .addFields(
        { name: 'Season', value: String(season?.season_name || season?.season_id || 'default'), inline: true },
        { name: 'Status', value: config?.general?.enabled ? 'Enabled' : 'Disabled', inline: true },
        { name: 'Available Reward Types', value: String(rewards.length), inline: true },
      )
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vault_panel_open').setLabel('Open Vault').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('vault_panel_rewards').setLabel('View Rewards').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vault_panel_leaderboard').setLabel('Leaderboard').setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row] };
  },

  async handleAdminPanel(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const targetChannel = interaction.options.getChannel('channel', false) || interaction.channel;
    if (!targetChannel || typeof targetChannel.send !== 'function') {
      await interaction.editReply({ content: 'ERROR: Target channel is invalid.' });
      return;
    }

    const payload = this.buildPanelMessage(guildId);
    await targetChannel.send(payload);
    await interaction.editReply({ content: `Vault panel posted in <#${targetChannel.id}>.` });
  },

  async handleBalance(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const result = vaultService.getBalance(guildId, interaction.user.id);
    if (!result.success) return interaction.editReply({ content: `ERROR: ${result.message}` });
    const config = vaultService.getConfig(guildId);
    const stats = result.stats;
    const embed = new EmbedBuilder()
      .setColor('#f59e0b')
      .setTitle(`${config?.general?.gameName || 'Vault'} Status`)
      .addFields(
        { name: 'Season', value: String(result.season?.season_name || result.season?.season_id || 'default'), inline: true },
        { name: 'Available Keys', value: String(stats.available_keys || 0), inline: true },
        { name: 'Keys Used', value: String(stats.keys_used || 0), inline: true },
        { name: 'Keys Earned', value: String(stats.keys_earned || 0), inline: true },
        { name: 'Paid Mints', value: String(stats.paid_mints || 0), inline: true },
        { name: 'Rewards Won', value: String(stats.rewards_won || 0), inline: true },
      )
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  },

  async handleOpen(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const result = vaultService.openVault(guildId, interaction.user.id);
    if (!result.success) return interaction.editReply({ content: `ERROR: ${result.message}` });
    const config = vaultService.getConfig(guildId);

    if (String(result.reward?.code || '') === 'no_reward') {
      const noRewardText = String(config?.messages?.noRewardOpen || 'Vault opened. No reward this time.');
      return interaction.editReply({
        content: `${noRewardText}\nAvailable keys now: ${result.stats.available_keys}`,
      });
    }

    return interaction.editReply({
      content: `Vault opened.\nReward: **${result.reward?.name || 'Unknown Reward'}** (${result.reward?.tier || 'common'})\nAvailable keys now: ${result.stats.available_keys}`,
    });
  },

  async handleHistory(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const limit = interaction.options.getInteger('limit') || 10;
    const rows = vaultService.listHistory(guildId, interaction.user.id, limit);
    if (!rows.length) return interaction.editReply({ content: 'No vault openings yet.' });
    const lines = rows.map((row, index) => {
      const when = row.created_at ? new Date(row.created_at).toLocaleString() : 'unknown';
      return `${index + 1}. [${row.reward_tier}] ${row.reward_name} - ${when}`;
    });
    return interaction.editReply({ content: `Your recent vault openings:\n${lines.join('\n')}` });
  },

  async handleRewards(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const rewards = vaultService.getRewards(guildId)
      .filter((reward) => reward && reward.enabled !== false && Number(reward.weight || 0) > 0)
      .filter((reward) => reward.quantity === null || Number(reward.quantity || 0) > 0);
    if (!rewards.length) return interaction.editReply({ content: 'No available rewards configured.' });
    const lines = rewards.slice(0, 30).map((reward) => `- ${formatRewardInventory(reward)}`);
    return interaction.editReply({ content: `Available rewards:\n${lines.join('\n')}` });
  },

  async handleLeaderboard(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const sortBy = interaction.options.getString('sort_by') || 'keys_used';
    const limit = interaction.options.getInteger('limit') || 10;
    const result = vaultService.getLeaderboard(guildId, null, sortBy, limit);
    if (!result.success) return interaction.editReply({ content: `ERROR: ${result.message}` });
    if (!result.rows.length) return interaction.editReply({ content: 'No leaderboard data yet.' });

    const lines = result.rows.map((row, index) =>
      `${index + 1}. <@${row.discord_user_id}> - keys used: ${row.keys_used}, rewards won: ${row.rewards_won}, paid mints: ${row.paid_mints}`
    );
    return interaction.editReply({
      content: `${result.season?.season_name || result.season?.season_id || 'Season'} Leaderboard\n${lines.join('\n')}`,
    });
  },

  async handleAdminSetup(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const config = vaultService.getConfig(guildId);
    config.general.enabled = interaction.options.getBoolean('enabled') ?? config.general.enabled;
    const projectName = interaction.options.getString('project_name');
    const vaultName = interaction.options.getString('vault_name');
    if (projectName) config.general.projectName = projectName;
    if (vaultName) config.general.gameName = vaultName;
    const saveResult = vaultService.saveConfig(guildId, config);
    vaultService.ensureDefaultSeason(guildId);
    if (!saveResult.success) return interaction.editReply({ content: `ERROR: ${saveResult.message}` });
    return interaction.editReply({ content: 'Vault setup updated.' });
  },

  async handleAdminConfigView(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const config = vaultService.getConfig(guildId);
    const season = vaultService.getActiveSeason(guildId);
    const rewards = vaultService.getRewards(guildId);
    const lines = [
      `Enabled: ${config?.general?.enabled ? 'yes' : 'no'}`,
      `Project: ${config?.general?.projectName || '-'}`,
      `Vault Name: ${config?.general?.gameName || '-'}`,
      `Active Season: ${season?.season_name || season?.season_id || 'none'}`,
      `Rewards: ${rewards.length}`,
      `No Reward Weight: ${Number(config?.rewardTable?.noRewardWeight || 0)}`,
      `Mint Mode: ${config?.mintSource?.mode || 'custom_webhook'}`,
      `Keys per paid mint: ${config?.mintRules?.keysPerPaidMint ?? 0}`,
      `Keys per free mint: ${config?.mintRules?.keysPerFreeMint ?? 0}`,
    ];
    return interaction.editReply({ content: lines.join('\n') });
  },

  async handleAdminConfigSet(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const key = interaction.options.getString('key', true);
    const value = parseConfigValue(interaction.options.getString('value', true));
    const result = vaultService.setConfigValue(guildId, key, value);
    if (!result.success) return interaction.editReply({ content: `ERROR: ${result.message}` });
    vaultService.logAdminAction(guildId, interaction.user.id, 'config_set', null, { key, value });
    return interaction.editReply({ content: `Updated \`${key}\`.` });
  },

  async handleAdminAddKeys(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const user = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);
    const reason = interaction.options.getString('reason') || 'manual_add';
    const season = vaultService.getActiveSeason(guildId);
    const result = vaultService.addKeys(guildId, season?.season_id || 'default', user.id, amount, reason, interaction.user.id);
    if (!result.success) return interaction.editReply({ content: `ERROR: ${result.message}` });
    return interaction.editReply({ content: `Added ${amount} keys to <@${user.id}>.` });
  },

  async handleAdminRemoveKeys(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const user = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);
    const reason = interaction.options.getString('reason') || 'manual_remove';
    const season = vaultService.getActiveSeason(guildId);
    const result = vaultService.removeKeys(guildId, season?.season_id || 'default', user.id, amount, reason, interaction.user.id);
    if (!result.success) return interaction.editReply({ content: `ERROR: ${result.message}` });
    return interaction.editReply({ content: `Removed ${amount} keys from <@${user.id}>.` });
  },

  async handleAdminRewardsList(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const rewards = vaultService.getRewards(guildId);
    if (!rewards.length) return interaction.editReply({ content: 'No rewards configured.' });
    const lines = rewards.map(formatRewardInventory);
    return interaction.editReply({ content: lines.join('\n') });
  },

  async handleAdminRewardsAdd(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const code = interaction.options.getString('code', true);
    const name = interaction.options.getString('name', true);
    const tier = interaction.options.getString('tier', true);
    const weight = interaction.options.getInteger('weight', true);
    const quantity = interaction.options.getInteger('quantity');
    const type = interaction.options.getString('type') || 'claimable_reward';
    const payloadRaw = interaction.options.getString('payload_json');
    const payload = payloadRaw ? parseConfigValue(payloadRaw) : null;
    const result = vaultService.addReward(guildId, { code, name, tier, weight, quantity, type, payload, enabled: true });
    if (!result.success) return interaction.editReply({ content: `ERROR: ${result.message}` });
    vaultService.logAdminAction(guildId, interaction.user.id, 'reward_add', null, { code, tier, weight, quantity });
    return interaction.editReply({ content: `Added reward \`${code}\`.` });
  },

  async handleAdminRewardsUpdate(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const code = interaction.options.getString('code', true);
    const patch = {};
    const name = interaction.options.getString('name');
    const tier = interaction.options.getString('tier');
    const weight = interaction.options.getInteger('weight');
    const quantity = interaction.options.getInteger('quantity');
    const enabled = interaction.options.getBoolean('enabled');
    const type = interaction.options.getString('type');
    const payloadRaw = interaction.options.getString('payload_json');
    if (name !== null) patch.name = name;
    if (tier !== null) patch.tier = tier;
    if (weight !== null) patch.weight = weight;
    if (quantity !== null) patch.quantity = quantity;
    if (enabled !== null) patch.enabled = enabled;
    if (type !== null) patch.type = type;
    if (payloadRaw !== null) patch.payload = parseConfigValue(payloadRaw);
    const result = vaultService.updateReward(guildId, code, patch);
    if (!result.success) return interaction.editReply({ content: `ERROR: ${result.message}` });
    vaultService.logAdminAction(guildId, interaction.user.id, 'reward_update', null, { code, patch });
    return interaction.editReply({ content: `Updated reward \`${code}\`.` });
  },

  async handleAdminRewardsRemove(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const code = interaction.options.getString('code', true);
    const result = vaultService.removeReward(guildId, code);
    if (!result.success) return interaction.editReply({ content: `ERROR: ${result.message}` });
    vaultService.logAdminAction(guildId, interaction.user.id, 'reward_remove', null, { code });
    return interaction.editReply({ content: `Removed reward \`${code}\`.` });
  },

  async handleAdminSetStatus(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const enabled = interaction.options.getBoolean('enabled', true);
    const result = vaultService.setConfigValue(guildId, 'general.enabled', enabled);
    if (!result.success) return interaction.editReply({ content: `ERROR: ${result.message}` });
    vaultService.logAdminAction(guildId, interaction.user.id, 'set_status', null, { enabled });
    return interaction.editReply({ content: `Vault ${enabled ? 'enabled' : 'disabled'}.` });
  },

  async handleAdminBackfill(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const user = interaction.options.getUser('user', true);
    const wallet = interaction.options.getString('wallet', true);
    const result = vaultService.backfillWalletForActiveSeason(guildId, wallet, user.id);
    if (!result.success) return interaction.editReply({ content: `ERROR: ${result.message}` });
    vaultService.logAdminAction(guildId, interaction.user.id, 'manual_backfill', user.id, { wallet, processed: result.processed || 0 });
    return interaction.editReply({ content: `Backfill completed for <@${user.id}>. Processed events: ${result.processed || 0}` });
  },
};
