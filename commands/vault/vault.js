const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('vault')
    .setDescription('Reward Vault module commands')
    .addSubcommand(sub =>
      sub.setName('balance').setDescription('Show your vault balance and season stats'))
    .addSubcommand(sub =>
      sub.setName('open').setDescription('Spend one key to open the vault'))
    .addSubcommand(sub =>
      sub
        .setName('history')
        .setDescription('Show your recent vault openings')
        .addIntegerOption(o => o.setName('limit').setDescription('Entries to show (1-20)').setRequired(false).setMinValue(1).setMaxValue(20)))
    .addSubcommand(sub =>
      sub
        .setName('leaderboard')
        .setDescription('Show top users in this season')
        .addStringOption(o =>
          o.setName('sort_by')
            .setDescription('Sort field')
            .setRequired(false)
            .addChoices(
              { name: 'Keys Used', value: 'keys_used' },
              { name: 'Points', value: 'points' },
              { name: 'Paid Mints', value: 'paid_mints' },
              { name: 'Pressure', value: 'pressure' },
              { name: 'Bonus Entries', value: 'bonus_entries' }
            ))
        .addIntegerOption(o => o.setName('limit').setDescription('Rows to show (1-25)').setRequired(false).setMinValue(1).setMaxValue(25)))
    .addSubcommandGroup(group =>
      group
        .setName('admin')
        .setDescription('Vault administration')
        .addSubcommand(sub =>
          sub
            .setName('setup')
            .setDescription('Initialize/update baseline vault settings')
            .addBooleanOption(o => o.setName('enabled').setDescription('Enable vault module').setRequired(false))
            .addStringOption(o => o.setName('project_name').setDescription('Project display name').setRequired(false))
            .addStringOption(o => o.setName('vault_name').setDescription('Vault game name').setRequired(false)))
        .addSubcommand(sub =>
          sub.setName('config-view').setDescription('View current vault config summary'))
        .addSubcommand(sub =>
          sub
            .setName('config-set')
            .setDescription('Set a config key path to a value')
            .addStringOption(o => o.setName('key').setDescription('Path, e.g. mintRules.keysPerPaidMint').setRequired(true))
            .addStringOption(o => o.setName('value').setDescription('Value (supports JSON)').setRequired(true)))
        .addSubcommand(sub =>
          sub
            .setName('addkeys')
            .setDescription('Add keys to a user')
            .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
            .addIntegerOption(o => o.setName('amount').setDescription('Amount to add').setRequired(true).setMinValue(1))
            .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)))
        .addSubcommand(sub =>
          sub
            .setName('removekeys')
            .setDescription('Remove available keys from a user')
            .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
            .addIntegerOption(o => o.setName('amount').setDescription('Amount to remove').setRequired(true).setMinValue(1))
            .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)))
        .addSubcommand(sub =>
          sub
            .setName('rewards-list')
            .setDescription('List configured reward table entries'))
        .addSubcommand(sub =>
          sub
            .setName('rewards-add')
            .setDescription('Add reward to reward table')
            .addStringOption(o => o.setName('code').setDescription('Unique reward code').setRequired(true))
            .addStringOption(o => o.setName('name').setDescription('Display name').setRequired(true))
            .addStringOption(o =>
              o.setName('tier')
                .setDescription('Reward tier')
                .setRequired(true)
                .addChoices(
                  { name: 'Common', value: 'common' },
                  { name: 'Rare', value: 'rare' },
                  { name: 'Epic', value: 'epic' },
                  { name: 'Legendary', value: 'legendary' }
                ))
            .addIntegerOption(o => o.setName('weight').setDescription('Weight >= 0').setRequired(true).setMinValue(0))
            .addStringOption(o => o.setName('type').setDescription('points|bonus_entries|claimable_reward|none').setRequired(false))
            .addStringOption(o => o.setName('payload_json').setDescription('JSON payload').setRequired(false)))
        .addSubcommand(sub =>
          sub
            .setName('rewards-update')
            .setDescription('Update a reward entry')
            .addStringOption(o => o.setName('code').setDescription('Reward code').setRequired(true))
            .addStringOption(o => o.setName('name').setDescription('Display name').setRequired(false))
            .addStringOption(o =>
              o.setName('tier')
                .setDescription('Reward tier')
                .setRequired(false)
                .addChoices(
                  { name: 'Common', value: 'common' },
                  { name: 'Rare', value: 'rare' },
                  { name: 'Epic', value: 'epic' },
                  { name: 'Legendary', value: 'legendary' }
                ))
            .addIntegerOption(o => o.setName('weight').setDescription('Weight >= 0').setRequired(false).setMinValue(0))
            .addBooleanOption(o => o.setName('enabled').setDescription('Enable/disable reward').setRequired(false))
            .addStringOption(o => o.setName('type').setDescription('points|bonus_entries|claimable_reward|none').setRequired(false))
            .addStringOption(o => o.setName('payload_json').setDescription('JSON payload').setRequired(false)))
        .addSubcommand(sub =>
          sub
            .setName('rewards-remove')
            .setDescription('Remove reward from table')
            .addStringOption(o => o.setName('code').setDescription('Reward code').setRequired(true)))
        .addSubcommand(sub =>
          sub
            .setName('setstatus')
            .setDescription('Set vault active/inactive')
            .addBooleanOption(o => o.setName('enabled').setDescription('Enable vault').setRequired(true)))
        .addSubcommand(sub =>
          sub
            .setName('backfill')
            .setDescription('Backfill active season key grants for linked wallet')
            .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
            .addStringOption(o => o.setName('wallet').setDescription('Linked wallet address').setRequired(true)))),

  async execute(interaction) {
    if (!await moduleGuard.checkModuleEnabled(interaction, 'vault')) return;

    const subGroup = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(false);
    const guildId = interaction.guildId;

    try {
      if (subGroup === 'admin') {
        if (!await moduleGuard.checkAdmin(interaction)) return;
        switch (sub) {
          case 'setup': return this.handleAdminSetup(interaction, guildId);
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

      switch (sub) {
        case 'balance': return this.handleBalance(interaction, guildId);
        case 'open': return this.handleOpen(interaction, guildId);
        case 'history': return this.handleHistory(interaction, guildId);
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

  async handleBalance(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const result = vaultService.getBalance(guildId, interaction.user.id);
    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });
    const cfg = vaultService.getConfig(guildId);
    const s = result.stats;
    const embed = new EmbedBuilder()
      .setColor('#f59e0b')
      .setTitle(`🔐 ${cfg?.general?.gameName || 'Vault'} Status`)
      .addFields(
        { name: 'Season', value: String(result.season?.season_name || result.season?.season_id || 'default'), inline: true },
        { name: 'Available Keys', value: String(s.available_keys || 0), inline: true },
        { name: 'Keys Used', value: String(s.keys_used || 0), inline: true },
        { name: 'Bonus Entries', value: String(s.bonus_entries || 0), inline: true },
        { name: 'Points', value: String(s.points || 0), inline: true },
        { name: 'Rewards Won', value: String(s.rewards_won || 0), inline: true }
      )
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  },

  async handleOpen(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const result = vaultService.openVault(guildId, interaction.user.id);
    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });
    const rewardName = String(result.reward?.name || 'Unknown Reward');
    const tier = String(result.reward?.tier || 'common');
    return interaction.editReply({
      content: `🔓 Vault opened!\nReward: **${rewardName}** (${tier})\nAvailable keys now: **${result.stats.available_keys}**`,
    });
  },

  async handleHistory(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const limit = interaction.options.getInteger('limit') || 10;
    const rows = vaultService.listHistory(guildId, interaction.user.id, limit);
    if (!rows.length) return interaction.editReply({ content: 'No vault openings yet.' });
    const lines = rows.map((r, i) => {
      const when = r.created_at ? new Date(r.created_at).toLocaleString() : 'unknown';
      return `${i + 1}. [${r.reward_tier}] ${r.reward_name} — ${when}`;
    });
    return interaction.editReply({ content: `Your recent vault openings:\n${lines.join('\n')}` });
  },

  async handleLeaderboard(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const sortBy = interaction.options.getString('sort_by') || 'keys_used';
    const limit = interaction.options.getInteger('limit') || 10;
    const result = vaultService.getLeaderboard(guildId, null, sortBy, limit);
    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });
    if (!result.rows.length) return interaction.editReply({ content: 'No leaderboard data yet.' });

    const lines = result.rows.map((row, idx) =>
      `${idx + 1}. <@${row.discord_user_id}> — keys used: ${row.keys_used}, points: ${row.points}, paid mints: ${row.paid_mints}`
    );
    return interaction.editReply({
      content: `**${result.season?.season_name || result.season?.season_id || 'Season'} Leaderboard**\n${lines.join('\n')}`,
    });
  },

  async handleAdminSetup(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const cfg = vaultService.getConfig(guildId);
    cfg.general.enabled = interaction.options.getBoolean('enabled') ?? cfg.general.enabled;
    const projectName = interaction.options.getString('project_name');
    const vaultName = interaction.options.getString('vault_name');
    if (projectName) cfg.general.projectName = projectName;
    if (vaultName) cfg.general.gameName = vaultName;
    const saveResult = vaultService.saveConfig(guildId, cfg);
    vaultService.ensureDefaultSeason(guildId);
    if (!saveResult.success) return interaction.editReply({ content: `❌ ${saveResult.message}` });
    return interaction.editReply({ content: '✅ Vault setup updated.' });
  },

  async handleAdminConfigView(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const cfg = vaultService.getConfig(guildId);
    const season = vaultService.getActiveSeason(guildId);
    const rewards = vaultService.getRewards(guildId);
    const lines = [
      `Enabled: ${cfg?.general?.enabled ? 'yes' : 'no'}`,
      `Project: ${cfg?.general?.projectName || '-'}`,
      `Vault Name: ${cfg?.general?.gameName || '-'}`,
      `Active Season: ${season?.season_name || season?.season_id || 'none'}`,
      `Rewards: ${rewards.length}`,
      `Mint Mode: ${cfg?.mintSource?.mode || 'custom_webhook'}`,
      `Keys per paid mint: ${cfg?.mintRules?.keysPerPaidMint ?? 0}`,
      `Keys per free mint: ${cfg?.mintRules?.keysPerFreeMint ?? 0}`,
    ];
    return interaction.editReply({ content: lines.join('\n') });
  },

  async handleAdminConfigSet(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const key = interaction.options.getString('key', true);
    const value = parseConfigValue(interaction.options.getString('value', true));
    const result = vaultService.setConfigValue(guildId, key, value);
    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });
    vaultService.logAdminAction(guildId, interaction.user.id, 'config_set', null, { key, value });
    return interaction.editReply({ content: `✅ Updated \`${key}\`.` });
  },

  async handleAdminAddKeys(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const user = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);
    const reason = interaction.options.getString('reason') || 'manual_add';
    const season = vaultService.getActiveSeason(guildId);
    const result = vaultService.addKeys(guildId, season?.season_id || 'default', user.id, amount, reason, interaction.user.id);
    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });
    return interaction.editReply({ content: `✅ Added ${amount} keys to <@${user.id}>.` });
  },

  async handleAdminRemoveKeys(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const user = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);
    const reason = interaction.options.getString('reason') || 'manual_remove';
    const season = vaultService.getActiveSeason(guildId);
    const result = vaultService.removeKeys(guildId, season?.season_id || 'default', user.id, amount, reason, interaction.user.id);
    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });
    return interaction.editReply({ content: `✅ Removed ${amount} keys from <@${user.id}>.` });
  },

  async handleAdminRewardsList(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const rewards = vaultService.getRewards(guildId);
    if (!rewards.length) return interaction.editReply({ content: 'No rewards configured.' });
    const lines = rewards.map(r => `• \`${r.code}\` | ${r.name} | ${r.tier} | weight=${r.weight} | ${r.enabled === false ? 'disabled' : 'enabled'}`);
    return interaction.editReply({ content: lines.join('\n') });
  },

  async handleAdminRewardsAdd(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const code = interaction.options.getString('code', true);
    const name = interaction.options.getString('name', true);
    const tier = interaction.options.getString('tier', true);
    const weight = interaction.options.getInteger('weight', true);
    const type = interaction.options.getString('type') || 'none';
    const payloadRaw = interaction.options.getString('payload_json');
    const payload = payloadRaw ? parseConfigValue(payloadRaw) : null;
    const result = vaultService.addReward(guildId, { code, name, tier, weight, type, payload, enabled: true });
    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });
    vaultService.logAdminAction(guildId, interaction.user.id, 'reward_add', null, { code, tier, weight });
    return interaction.editReply({ content: `✅ Added reward \`${code}\`.` });
  },

  async handleAdminRewardsUpdate(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const code = interaction.options.getString('code', true);
    const patch = {};
    const name = interaction.options.getString('name');
    const tier = interaction.options.getString('tier');
    const weight = interaction.options.getInteger('weight');
    const enabled = interaction.options.getBoolean('enabled');
    const type = interaction.options.getString('type');
    const payloadRaw = interaction.options.getString('payload_json');
    if (name !== null) patch.name = name;
    if (tier !== null) patch.tier = tier;
    if (weight !== null) patch.weight = weight;
    if (enabled !== null) patch.enabled = enabled;
    if (type !== null) patch.type = type;
    if (payloadRaw !== null) patch.payload = parseConfigValue(payloadRaw);
    const result = vaultService.updateReward(guildId, code, patch);
    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });
    vaultService.logAdminAction(guildId, interaction.user.id, 'reward_update', null, { code, patch });
    return interaction.editReply({ content: `✅ Updated reward \`${code}\`.` });
  },

  async handleAdminRewardsRemove(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const code = interaction.options.getString('code', true);
    const result = vaultService.removeReward(guildId, code);
    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });
    vaultService.logAdminAction(guildId, interaction.user.id, 'reward_remove', null, { code });
    return interaction.editReply({ content: `✅ Removed reward \`${code}\`.` });
  },

  async handleAdminSetStatus(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const enabled = interaction.options.getBoolean('enabled', true);
    const result = vaultService.setConfigValue(guildId, 'general.enabled', enabled);
    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });
    vaultService.logAdminAction(guildId, interaction.user.id, 'set_status', null, { enabled });
    return interaction.editReply({ content: `✅ Vault ${enabled ? 'enabled' : 'disabled'}.` });
  },

  async handleAdminBackfill(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const user = interaction.options.getUser('user', true);
    const wallet = interaction.options.getString('wallet', true);
    const result = vaultService.backfillWalletForActiveSeason(guildId, wallet, user.id);
    if (!result.success) return interaction.editReply({ content: `❌ ${result.message}` });
    vaultService.logAdminAction(guildId, interaction.user.id, 'manual_backfill', user.id, { wallet, processed: result.processed || 0 });
    return interaction.editReply({ content: `✅ Backfill completed for <@${user.id}>. Processed events: ${result.processed || 0}` });
  },
};
