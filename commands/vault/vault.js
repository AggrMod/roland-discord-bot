const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const moduleGuard = require('../../utils/moduleGuard');
const vaultService = require('../../services/vaultService');
const ticketService = require('../../services/ticketService');
const logger = require('../../utils/logger');
const { applyEmbedBranding } = require('../../services/embedBranding');
const { getModuleDisplayName } = require('../../services/moduleLabelService');

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
  const keyTier = reward?.keyTier ? String(reward.keyTier) : 'all';
  return `\`${reward.code}\` | ${reward.name} | tier=${reward.tier} | keyTier=${keyTier} | weight=${reward.weight} | qty=${quantityLabel} | ${status}`;
}

function toStringArray(value, fallback = []) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
  }
  return fallback;
}

function pickRandom(values, fallback) {
  const choices = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!choices.length) return fallback;
  return choices[Math.floor(Math.random() * choices.length)] || fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function renderTemplate(rawTemplate, variables = {}) {
  const template = String(rawTemplate || '').trim();
  if (!template) return '';
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => String(variables[key] ?? ''));
}

function rewardTierEmoji(tier) {
  const key = String(tier || '').trim().toLowerCase();
  if (key === 'legendary') return '👑';
  if (key === 'epic') return '💎';
  if (key === 'rare') return '✨';
  if (key === 'uncommon') return '🔹';
  return '📦';
}

function rewardTierColorHex(tier) {
  const key = String(tier || '').trim().toLowerCase();
  if (key === 'legendary') return '#f59e0b';
  if (key === 'epic') return '#a855f7';
  if (key === 'rare') return '#38bdf8';
  if (key === 'uncommon') return '#22c55e';
  if (key === 'none') return '#ef4444';
  return '#f4c430';
}

function formatTierBalancesInline(balances) {
  const pairs = Object.entries(balances && typeof balances === 'object' ? balances : {})
    .map(([tier, amount]) => `${tier}:${Number(amount || 0)}`);
  return pairs.length ? pairs.join(' | ') : 'default:0';
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('vault')
    .setDescription('Reward Vault module commands')
    .addSubcommand((sub) =>
      sub.setName('balance').setDescription('Show your vault balance and season stats'))
    .addSubcommand((sub) =>
      sub
        .setName('open')
        .setDescription('Spend one key to open the vault')
        .addStringOption((option) =>
          option.setName('key_tier').setDescription('Key tier to spend (default/bronze/silver/gold)').setRequired(false)))
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
        .setName('claims')
        .setDescription('Show your pending vault reward claims'))
    .addSubcommand((sub) =>
      sub
        .setName('verify-social')
        .setDescription('Verify X social requirements for a pending reward claim')
        .addIntegerOption((option) =>
          option.setName('reward_id').setDescription('Reward claim ID').setRequired(true).setMinValue(1)))
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
    .addSubcommand((sub) =>
      sub
        .setName('upgrade')
        .setDescription('Upgrade one key tier into another using configured conversion rules')
        .addStringOption((option) => option.setName('from_tier').setDescription('Source key tier (e.g. bronze)').setRequired(true))
        .addStringOption((option) => option.setName('to_tier').setDescription('Target key tier (e.g. gold)').setRequired(true))
        .addIntegerOption((option) => option.setName('times').setDescription('How many conversions to execute').setRequired(false).setMinValue(1).setMaxValue(1000)))
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
            .addStringOption((option) => option.setName('key_tier').setDescription('Key tier').setRequired(false))
            .addStringOption((option) => option.setName('reason').setDescription('Reason').setRequired(false)))
        .addSubcommand((sub) =>
          sub
            .setName('removekeys')
            .setDescription('Remove available keys from a user')
            .addUserOption((option) => option.setName('user').setDescription('Target user').setRequired(true))
            .addIntegerOption((option) => option.setName('amount').setDescription('Amount to remove').setRequired(true).setMinValue(1))
            .addStringOption((option) => option.setName('key_tier').setDescription('Key tier').setRequired(false))
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
            .addStringOption((option) => option.setName('key_tier').setDescription('Key tier pool for this reward').setRequired(false))
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
            .addStringOption((option) => option.setName('key_tier').setDescription('Key tier pool for this reward').setRequired(false))
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
            .addStringOption((option) => option.setName('wallet').setDescription('Linked wallet address').setRequired(true)))
        .addSubcommand((sub) =>
          sub
            .setName('import-csv')
            .setDescription('Import a Solscan CSV to grant keys retroactively')
            .addAttachmentOption((option) => option.setName('csv_file').setDescription('Solscan export CSV').setRequired(true)))),

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
          case 'import-csv': return this.handleAdminImportCsv(interaction, guildId);
          default:
            return interaction.reply({ content: 'Unknown admin subcommand.', ephemeral: true });
        }
      }

      switch (subcommand) {
        case 'balance': return this.handleBalance(interaction, guildId);
        case 'open': return this.handleOpen(interaction, guildId);
        case 'history': return this.handleHistory(interaction, guildId);
        case 'rewards': return this.handleRewards(interaction, guildId);
        case 'claims': return this.handleClaims(interaction, guildId);
        case 'verify-social': return this.handleVerifySocial(interaction, guildId);
        case 'leaderboard': return this.handleLeaderboard(interaction, guildId);
        case 'upgrade': return this.handleUpgrade(interaction, guildId);
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

    if (customId === 'vault_panel_balance') {
      return this.handleBalance(interaction, guildId);
    }

    if (customId.startsWith('vault_panel_open_tier_')) {
      const keyTier = customId.replace('vault_panel_open_tier_', '');
      await interaction.deferReply({ ephemeral: true });
      const result = vaultService.openVault(guildId, interaction.user.id, { keyTier });
      if (!result.success) {
        await interaction.editReply({ content: `ERROR: ${result.message}` });
        return true;
      }
      const announcement = await this.announceVaultWin(guildId, interaction.user, result, interaction);
      const ticket = await this.maybeCreateRewardTicket(guildId, interaction.user, result);
      const ticketLine = ticket?.created ? `\nFulfillment ticket created: #${ticket.ticketNumber || '?'} (<#${ticket.channelId}>)` : '';
      const announceLine = announcement?.posted ? `\nWin posted in <#${announcement.channelId}>.` : '';
      const rewardTier = String(result?.reward?.tier || 'common').toLowerCase();
      const tierEmoji = rewardTierEmoji(rewardTier);
      const isSpotlight = rewardTier === 'epic' || rewardTier === 'legendary';
      const title = isSpotlight
        ? `${tierEmoji} Spotlight Reward Unlocked`
        : 'Vault Opening Result';
      const accentColor = !result?.won
        ? '#ef4444'
        : rewardTierColorHex(rewardTier);
      const details = [
        `Reward: **${String(result?.reward?.name || result?.reward?.code || 'Unknown Reward')}**`,
        `Tier: \`${rewardTier}\``,
        `Key Tier Used: \`${String(result?.keyTier || 'default')}\``,
        `Opening ID: \`${String(result?.openingId || 'n/a')}\``,
        `Tier Balances: ${formatTierBalancesInline(result?.stats?.key_balances)}`,
      ].join('\n');
      await interaction.editReply({
        embeds: [this.buildPanelResponseEmbed(guildId, {
          title,
          description: `${this.buildOpenResultMessage(guildId, result, { trailingLabel: 'Available keys' })}\n\n${details}${announceLine}${ticketLine}`,
          accentColor,
        })],
      });
      return true;
    }

    if (customId === 'vault_panel_open') {
      const balanceResult = vaultService.getBalance(guildId, interaction.user.id);
      if (!balanceResult.success) {
        await interaction.reply({ content: `ERROR: ${balanceResult.message}`, ephemeral: true });
        return true;
      }
      const keyBalances = balanceResult.stats?.key_balances || {};
      const availableTiers = Object.entries(keyBalances).filter((entry) => Number(entry[1] || 0) > 0).map(([tier]) => tier);
      
      if (availableTiers.length === 0) {
        await interaction.reply({ content: `You do not have any keys available to open the vault.`, ephemeral: true });
        return true;
      }

      if (availableTiers.length === 1) {
        const keyTier = availableTiers[0];
        await interaction.deferReply({ ephemeral: true });
        const result = vaultService.openVault(guildId, interaction.user.id, { keyTier });
        if (!result.success) {
          await interaction.editReply({ content: `ERROR: ${result.message}` });
          return true;
        }
        const announcement = await this.announceVaultWin(guildId, interaction.user, result, interaction);
        const ticket = await this.maybeCreateRewardTicket(guildId, interaction.user, result);
        const ticketLine = ticket?.created ? `\nFulfillment ticket created: #${ticket.ticketNumber || '?'} (<#${ticket.channelId}>)` : '';
        const announceLine = announcement?.posted ? `\nWin posted in <#${announcement.channelId}>.` : '';
        const rewardTier = String(result?.reward?.tier || 'common').toLowerCase();
        const tierEmoji = rewardTierEmoji(rewardTier);
        const isSpotlight = rewardTier === 'epic' || rewardTier === 'legendary';
        const title = isSpotlight
          ? `${tierEmoji} Spotlight Reward Unlocked`
          : 'Vault Opening Result';
        const accentColor = !result?.won
          ? '#ef4444'
          : rewardTierColorHex(rewardTier);
        const details = [
          `Reward: **${String(result?.reward?.name || result?.reward?.code || 'Unknown Reward')}**`,
          `Tier: \`${rewardTier}\``,
          `Key Tier Used: \`${String(result?.keyTier || 'default')}\``,
          `Opening ID: \`${String(result?.openingId || 'n/a')}\``,
          `Tier Balances: ${formatTierBalancesInline(result?.stats?.key_balances)}`,
        ].join('\n');
        await interaction.editReply({
          embeds: [this.buildPanelResponseEmbed(guildId, {
            title,
            description: `${this.buildOpenResultMessage(guildId, result, { trailingLabel: 'Available keys' })}\n\n${details}${announceLine}${ticketLine}`,
            accentColor,
          })],
        });
        return true;
      }

      // Prompt for tier
      const embed = this.buildPanelResponseEmbed(guildId, {
        title: 'Choose Key Tier',
        description: 'You have multiple tiers of keys available. Which one would you like to use to open the vault?',
      });
      const row = new ActionRowBuilder();
      for (const tier of availableTiers.slice(0, 5)) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`vault_panel_open_tier_${tier}`)
            .setLabel(`Use ${tier} Key (${keyBalances[tier]})`)
            .setStyle(ButtonStyle.Primary)
        );
      }
      await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      return true;
    }

    if (customId.startsWith('vault_panel_upg_btn_')) {
      const index = parseInt(customId.replace('vault_panel_upg_btn_', ''), 10);
      const conversions = vaultService.getKeyTierConversions(guildId).filter(c => c && c.enabled !== false);
      const c = conversions[index];
      if (!c) {
        await interaction.reply({ content: 'Conversion rule no longer valid.', ephemeral: true });
        return true;
      }
      
      const balanceResult = vaultService.getBalance(guildId, interaction.user.id);
      const keyBalances = balanceResult.stats?.key_balances || {};
      const maxTimes = Math.floor(Number(keyBalances[String(c.fromTier).toLowerCase()] || 0) / Number(c.fromAmount || 1));

      const modal = new ModalBuilder()
        .setCustomId(`vault_panel_upg_do_${index}`)
        .setTitle(`Upgrade ${c.fromTier} ➡️ ${c.toTier}`);
      const timesInput = new TextInputBuilder()
        .setCustomId('times')
        .setLabel(`How many times? (Max: ${maxTimes})`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(5)
        .setPlaceholder('1');
      modal.addComponents(new ActionRowBuilder().addComponents(timesInput));
      await interaction.showModal(modal);
      return true;
    }

    if (customId === 'vault_panel_upgrade') {
      const conversions = vaultService.getKeyTierConversions(guildId).filter(c => c && c.enabled !== false);
      if (!conversions.length) {
         await interaction.reply({ content: 'No conversion rules are currently configured.', ephemeral: true });
         return true;
      }
      const balanceResult = vaultService.getBalance(guildId, interaction.user.id);
      const keyBalances = balanceResult.stats?.key_balances || {};

      const validConversions = conversions.filter(c => {
        const fromAmt = Number(keyBalances[String(c.fromTier).toLowerCase()] || 0);
        return fromAmt >= Number(c.fromAmount || 1);
      });

      if (!validConversions.length) {
         const embed = this.buildPanelResponseEmbed(guildId, {
           title: 'Upgrade Unavailable',
           description: 'You do not have enough keys for any available upgrades.',
           accentColor: '#ef4444'
         });
         const lines = conversions.map(c => `- Need ${c.fromAmount} **${c.fromTier}** to get ${c.toAmount} **${c.toTier}**`);
         embed.addFields({ name: 'Configured Paths', value: lines.join('\n') });
         await interaction.reply({ embeds: [embed], ephemeral: true });
         return true;
      }

      const row = new ActionRowBuilder();
      validConversions.slice(0, 5).forEach((c) => {
        const maxTimes = Math.floor(Number(keyBalances[String(c.fromTier).toLowerCase()] || 0) / Number(c.fromAmount || 1));
        const index = conversions.indexOf(c);
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`vault_panel_upg_btn_${index}`)
            .setLabel(`${c.fromAmount} ${c.fromTier} ➡️ ${c.toAmount} ${c.toTier} (Max: ${maxTimes})`)
            .setStyle(ButtonStyle.Primary)
        );
      });
      const embed = this.buildPanelResponseEmbed(guildId, {
        title: 'Upgrade Keys',
        description: 'Select an upgrade path below:',
      });
      await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      return true;
    }

    if (customId === 'vault_panel_verify_payment') {
      const modal = new ModalBuilder()
        .setCustomId('vault_panel_payment_tx_modal')
        .setTitle('Verify Vault Payment');
      const txInput = new TextInputBuilder()
        .setCustomId('tx_signature')
        .setLabel('Solana transaction signature')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMinLength(40)
        .setMaxLength(120)
        .setPlaceholder('Paste the payment transaction signature here');
      modal.addComponents(new ActionRowBuilder().addComponents(txInput));
      await interaction.showModal(modal);
      return true;
    }

    if (customId === 'vault_panel_conversions') {
      await interaction.deferReply({ ephemeral: true });
      const rules = vaultService.getKeyTierConversions(guildId).filter(rule => rule && rule.enabled !== false);
      if (!rules.length) {
        await interaction.editReply({
          embeds: [this.buildPanelResponseEmbed(guildId, {
            title: 'Key Conversion Rules',
            description: 'No conversion rules configured.',
          })],
        });
        return true;
      }
      const lines = rules.slice(0, 24).map((rule, index) =>
        `${index + 1}. ${Number(rule.fromAmount || 1)} **${String(rule.fromTier || 'default')}** → ${Number(rule.toAmount || 1)} **${String(rule.toTier || 'default')}**`
      );
      const embed = this.buildPanelResponseEmbed(guildId, {
        title: 'Key Conversion Rules',
        description: 'Upgrade paths currently available for your keys.',
        accentColor: '#38bdf8',
      });
      embed.addFields({
        name: `Active Rules (${rules.length})`,
        value: lines.join('\n'),
      });
      await interaction.editReply({ embeds: [embed] });
      return true;
    }

    if (customId === 'vault_panel_rewards') {
      await interaction.deferReply({ ephemeral: true });
      const rewards = vaultService.getRewards(guildId)
        .filter((reward) => reward && reward.enabled !== false && Number(reward.weight || 0) > 0)
        .filter((reward) => String(reward?.type || '').trim().toLowerCase() !== 'no_reward' && String(reward?.code || '').trim().toLowerCase() !== 'no_reward' && String(reward?.code || '').trim().toLowerCase() !== 'nothing')
        .filter((reward) => reward.quantity === null || Number(reward.quantity || 0) > 0);
      if (!rewards.length) {
        await interaction.editReply({
          embeds: [this.buildPanelResponseEmbed(guildId, {
            title: 'Reward Catalog',
            description: 'No available rewards configured.',
          })],
        });
        return true;
      }
      await interaction.editReply({
        embeds: this.buildRewardCatalogEmbeds(guildId, rewards, {
          title: 'Reward Catalog',
          subtitle: 'Current rewards that can be pulled from the vault.',
        }),
      });
      return true;
    }

    if (customId === 'vault_panel_leaderboard') {
      await interaction.deferReply({ ephemeral: true });
      const result = vaultService.getLeaderboard(guildId, null, 'keys_used', 10);
      if (!result.success || !Array.isArray(result.rows) || result.rows.length === 0) {
        await interaction.editReply({
          embeds: [this.buildPanelResponseEmbed(guildId, {
            title: 'Vault Leaderboard',
            description: 'No leaderboard data yet.',
          })],
        });
        return true;
      }
      const lines = result.rows.map((row, index) => `${index + 1}. <@${row.discord_user_id}> - keys used: ${row.keys_used} - rewards won: ${row.rewards_won}`);
      await interaction.editReply({
        embeds: [this.buildPanelResponseEmbed(guildId, {
          title: `${result.season?.season_name || result.season?.season_id || 'Season'} Leaderboard`,
          description: lines.join('\n'),
        })],
      });
      return true;
    }

    return false;
  },

  async handlePanelModal(interaction) {
    if (!interaction?.isModalSubmit?.()) return false;
    if (!await moduleGuard.checkModuleEnabled(interaction, 'vault')) return true;
    const customId = String(interaction.customId || '');
    const guildId = interaction.guildId;
    if (customId === 'vault_panel_payment_tx_modal') {
      const txSignature = String(interaction.fields.getTextInputValue('tx_signature') || '').trim();
      await interaction.deferReply({ ephemeral: true });
      const result = await vaultService.verifyPaymentTransaction(guildId, txSignature, {
        expectedDiscordUserId: interaction.user.id,
        source: 'discord_panel_payment_verify',
      });
      if (!result.success) {
        await interaction.editReply({ content: `Payment could not be verified: ${result.message || 'unknown error'}` });
        return true;
      }
      const duplicateLine = result.duplicate ? '\nThis transaction was already processed, so no extra keys were added.' : '';
      const keysGranted = Number(result?.grants?.keys_granted || 0);
      const balance = vaultService.getBalance(guildId, interaction.user.id, result.seasonId || null);
      const availableKeys = balance?.success ? Number(balance.stats?.available_keys || 0) : null;
      const fields = [
        { name: 'Keys Granted', value: String(keysGranted), inline: true },
        { name: 'Payment', value: `${Number(result?.matchedTransfer?.lamports || 0)} lamports`, inline: true },
      ];
      if (availableKeys !== null) fields.push({ name: 'Available Keys', value: String(availableKeys), inline: true });
      await interaction.editReply({
        embeds: [this.buildPanelResponseEmbed(guildId, {
          title: 'Payment Verified On-Chain',
          description: `Your payment transaction was verified against the configured Vault wallet.${duplicateLine}`,
          accentColor: '#22c55e',
        }).addFields(fields)],
      });
      return true;
    }

    if (customId.startsWith('vault_panel_upg_do_')) {
      const index = parseInt(customId.replace('vault_panel_upg_do_', ''), 10);
      const conversions = vaultService.getKeyTierConversions(guildId).filter(c => c && c.enabled !== false);
      const c = conversions[index];
      if (!c) {
        await interaction.reply({ content: 'Conversion rule no longer valid.', ephemeral: true });
        return true;
      }
      const fromTier = String(c.fromTier);
      const toTier = String(c.toTier);
      const timesRaw = String(interaction.fields.getTextInputValue('times') || '').trim();
      const times = Math.max(1, Math.min(1000, Number.parseInt(timesRaw || '1', 10) || 1));
      await interaction.deferReply({ ephemeral: true });
      const result = vaultService.upgradeKeys(guildId, interaction.user.id, { fromTier, toTier, times });
      if (!result.success) {
        await interaction.editReply({ content: `ERROR: ${result.message}` });
        return true;
      }
      const embed = this.buildPanelResponseEmbed(guildId, {
        title: 'Key Upgrade Completed',
        description: `Converted ${result.moved.consumed} **${fromTier}** keys into ${result.moved.added} **${toTier}** keys.`,
        accentColor: '#22c55e',
      });
      embed.addFields(
        { name: 'Conversion Count', value: `x${times}`, inline: true },
        { name: 'Season', value: String(result?.seasonId || 'default'), inline: true },
        { name: 'Tier Balances', value: formatTierBalancesInline(result?.stats?.key_balances), inline: false },
      );
      await interaction.editReply({ embeds: [embed] });
      return true;
    }    return true;
  },

  buildPanelMessage(guildId) {
    const config = vaultService.getConfig(guildId);
    const moduleName = getModuleDisplayName('vault', guildId);
    const gameName = String(config?.display?.gameName || moduleName || 'Reward Vault');
    const keyLabel = String(config?.display?.keyName || 'Reward Key');

    const embed = new EmbedBuilder()
      .setTitle(`${moduleName} Control Panel`)
      .setDescription(`Use the buttons below to open **${gameName}**, view available rewards, or check leaderboard standings.\nEvery eligible mint can grant a **${keyLabel}**.`)
      .setTimestamp();
    applyEmbedBranding(embed, {
      guildId,
      moduleKey: 'vault',
      defaultColor: '#f4c430',
      defaultFooter: 'Powered by Guild Pilot',
      fallbackLogoUrl: null,
      useThumbnail: false,
    });

    const primaryRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vault_panel_open').setLabel('Open Vault').setEmoji('🔓').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('vault_panel_balance').setLabel('Check Balance').setEmoji('⚖️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('vault_panel_verify_payment').setLabel('Verify Payment').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vault_panel_upgrade').setLabel('Upgrade Key').setEmoji('⬆️').setStyle(ButtonStyle.Secondary),
    );
    const infoRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vault_panel_conversions').setLabel('View Conversions').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vault_panel_rewards').setLabel('Available Rewards').setEmoji('🎁').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vault_panel_leaderboard').setLabel('Leaderboard').setEmoji('🏆').setStyle(ButtonStyle.Primary),
    );

    return { embeds: [embed], components: [primaryRow, infoRow] };
  },

  buildPanelResponseEmbed(guildId, options = {}) {
    const embed = new EmbedBuilder()
      .setTitle(String(options.title || 'Vault Panel'))
      .setDescription(String(options.description || ''))
      .setTimestamp();
    applyEmbedBranding(embed, {
      guildId,
      moduleKey: 'vault',
      defaultColor: String(options.accentColor || '#f4c430'),
      defaultFooter: 'Powered by Guild Pilot',
      fallbackLogoUrl: null,
      useThumbnail: false,
    });
    return embed;
  },

  async maybeCreateRewardTicket(guildId, user, openResult) {
    try {
      const reward = openResult?.reward || {};
      if (!openResult?.success || !openResult?.won || String(reward?.code || '') === 'no_reward') {
        return { created: false, reason: 'no_reward' };
      }
      const cfg = vaultService.getConfig(guildId) || {};
      const ticketing = cfg.ticketing || {};
      if (!ticketing.createTicketOnWin) return { created: false, reason: 'disabled' };
      const categoryId = Number(ticketing.rewardTicketCategoryId || 0);
      if (!Number.isFinite(categoryId) || categoryId <= 0) return { created: false, reason: 'missing_category' };

      const tierBalances = openResult?.stats?.key_balances || {};
      const intro = [
        'Vault reward fulfillment ticket created automatically.',
        `User: <@${user.id}> (${user.username})`,
        `Season: ${openResult?.season?.season_name || openResult?.season?.season_id || 'default'}`,
        `Opening ID: ${openResult?.openingId || 'n/a'}`,
        `Reward: ${reward?.name || reward?.code || 'unknown'}`,
        `Reward Code: ${reward?.code || 'unknown'}`,
        `Reward Tier: ${reward?.tier || 'unknown'}`,
        `Key Tier Used: ${openResult?.keyTier || 'default'}`,
        `Available Keys After Open: ${Number(openResult?.stats?.available_keys || 0)}`,
        `Tier Balances: ${JSON.stringify(tierBalances)}`,
        reward?.payload ? `Reward Payload: ${JSON.stringify(reward.payload)}` : 'Reward Payload: null',
      ].join('\n');

      const ticketResult = await ticketService.createSystemTicketFromCategory(categoryId, {
        guildId,
        openerId: String(user.id),
        openerName: String(user.username || user.tag || user.id),
        title: `Vault Reward: ${String(reward?.name || reward?.code || 'reward').slice(0, 80)}`,
        intro,
        templateResponses: {
          Subject: `Vault Reward Fulfillment: ${reward?.name || reward?.code || 'reward'}`,
          Context: `Auto-created from vault opening ${openResult?.openingId || ''}`.trim(),
        },
      });
      if (!ticketResult?.success) {
        const alertChannelId = String(ticketing.alertChannelId || '').trim();
        if (alertChannelId && ticketService?.client) {
          const channel = await ticketService.client.channels.fetch(alertChannelId).catch(() => null);
          if (channel && channel.isTextBased()) {
            await channel.send({
              content: `[Vault Ticket Failure] guild=${guildId} user=<@${user.id}> reward=${reward?.code || 'unknown'} reason=${ticketResult?.message || 'ticket_failed'}`,
            }).catch(() => {});
          }
        }
        return { created: false, reason: ticketResult?.message || 'ticket_failed' };
      }
      return { created: true, ticketNumber: ticketResult.ticketNumber, channelId: ticketResult.channelId };
    } catch (error) {
      logger.error('[vault] reward ticket creation failed:', error);
      return { created: false, reason: 'exception' };
    }
  },

  buildRewardCatalogEmbeds(guildId, rewards, options = {}) {
    const sorted = [...(Array.isArray(rewards) ? rewards : [])]
      .sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0));
    const totalWeight = sorted.reduce((sum, reward) => sum + Math.max(0, Number(reward.weight || 0)), 0);
    const lines = sorted.slice(0, 24).map((reward) => {
      const qty = normalizeQuantity(reward?.quantity);
      const qtyLabel = qty === null ? '∞' : `${qty}`;
      const weight = Math.max(0, Number(reward.weight || 0));
      const chance = totalWeight > 0 ? ((weight / totalWeight) * 100).toFixed(1) : '0.0';
      const tierEmoji = rewardTierEmoji(reward?.tier);
      return `${tierEmoji} **${reward.name || reward.code}**\n` +
        `• Tier: \`${String(reward.tier || 'common')}\`  • Qty: \`${qtyLabel}\`  • Chance: \`${chance}%\``;
    });

    const embed = this.buildPanelResponseEmbed(guildId, {
      title: String(options.title || 'Reward Catalog'),
      description: String(options.subtitle || ''),
    });
    embed.addFields({
      name: `Available Rewards (${Math.min(sorted.length, 24)} shown)`,
      value: lines.join('\n\n') || 'No rewards available.',
    });
    if (sorted.length > 24) {
      embed.addFields({ name: 'More Rewards', value: `${sorted.length - 24} additional rewards are configured.` });
    }
    return [embed];
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
    const keyBalances = stats?.key_balances && typeof stats.key_balances === 'object' ? stats.key_balances : {};

    const tiers = Array.isArray(config?.keyTiers) ? config.keyTiers.filter(t => t && t.enabled !== false) : [{id:'default'}];
    const keyBalanceLine = tiers.map(t => {
      const id = String(t.id || 'default').toLowerCase();
      const amt = Number(keyBalances[id] || 0);
      const name = id.charAt(0).toUpperCase() + id.slice(1);
      return `**${name}**: ${amt}`;
    }).join('\n') || '**Default**: 0';

    const embed = new EmbedBuilder()
      .setColor('#f59e0b')
      .setTitle(`${config?.display?.gameName || 'Vault'} Status`)
      .addFields(
        { name: 'Season', value: String(result.season?.season_name || result.season?.season_id || 'default'), inline: true },
        { name: 'Available Keys', value: String(stats.available_keys || 0), inline: true },
        { name: 'Tier Balances', value: keyBalanceLine, inline: false },
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
    const keyTier = interaction.options.getString('key_tier');
    const result = vaultService.openVault(guildId, interaction.user.id, { keyTier });
    if (!result.success) return interaction.editReply({ content: `ERROR: ${result.message}` });
    const announcement = await this.announceVaultWin(guildId, interaction.user, result, interaction);
    const ticket = await this.maybeCreateRewardTicket(guildId, interaction.user, result);
    const ticketLine = ticket?.created ? `\nFulfillment ticket created: #${ticket.ticketNumber || '?'} (<#${ticket.channelId}>)` : '';
    const announceLine = announcement?.posted ? `\nWin posted in <#${announcement.channelId}>.` : '';
    const rewardTier = String(result?.reward?.tier || 'common').toLowerCase();
    const tierEmoji = rewardTierEmoji(rewardTier);
    const isSpotlight = rewardTier === 'epic' || rewardTier === 'legendary';
    const title = isSpotlight
      ? `${tierEmoji} Spotlight Reward Unlocked`
      : 'Vault Opening Result';
    const accentColor = !result?.won
      ? '#ef4444'
      : rewardTierColorHex(rewardTier);
    const details = [
      `Reward: **${String(result?.reward?.name || result?.reward?.code || 'Unknown Reward')}**`,
      `Tier: \`${rewardTier}\``,
      `Key Tier Used: \`${String(result?.keyTier || 'default')}\``,
      `Opening ID: \`${String(result?.openingId || 'n/a')}\``,
      `Tier Balances: ${formatTierBalancesInline(result?.stats?.key_balances)}`,
    ].join('\n');
    const embed = this.buildPanelResponseEmbed(guildId, {
      title,
      description: `${this.buildOpenResultMessage(guildId, result, { trailingLabel: 'Available keys now' })}\n\n${details}${announceLine}${ticketLine}`,
      accentColor,
    });
    return interaction.editReply({ embeds: [embed] });
  },

  buildOpenResultMessage(guildId, result, options = {}) {
    const config = vaultService.getConfig(guildId) || {};
    const gameName = String(config?.display?.gameName || 'Reward Vault');
    const rewardName = String(result?.reward?.name || 'Unknown Reward');
    const rewardTier = String(result?.reward?.tier || 'common').toLowerCase();
    const availableKeys = Number(result?.stats?.available_keys || 0);
    const keyTierName = String(result?.keyTierName || result?.keyTier || 'default');
    const trailingLabel = String(options.trailingLabel || 'Available keys');
    const vars = { gameName, rewardName, rewardTier, availableKeys, keyTierName };

    const suspenseFallback = [
      'You slide your key into the lock. Steel groans and everyone holds their breath.',
      'The vault clicks once, then twice. The final lock starts to turn.',
      'The handle moves slowly. For a second, it feels like time stops.',
    ];
    const failFallback = [
      'The vault coughed, laughed, and swallowed your key.',
      'A small note slides out: "Nice try. Come back with better luck."',
      'The door cracks open an inch, then slams shut. Not today.',
      'The lock spins, sparks, and then absolutely refuses to cooperate.',
    ];
    const hitFallback = {
      common: [
        'The vault opens just enough for a small envelope to slide out.',
        'A dusty drawer clicks open with a reward inside.',
      ],
      rare: [
        'The room goes quiet. This pull feels heavier than usual.',
        'The bolts release with a deep thud. Something valuable appears.',
      ],
      epic: [
        'The inner chamber unlocks. This is the kind of pull people remember.',
      ],
      legendary: [
        'Every lock disengages at once. Even the vault did not expect this.',
      ],
    };

    const suspenseLines = toStringArray(config?.display?.openSuspenseLines, suspenseFallback);
    const failLines = toStringArray(config?.display?.noRewardOpenVariants, failFallback);
    const noRewardText = String(config?.display?.noRewardOpen || 'Vault opened, but this key did not reveal a reward.');
    const successTemplate = String(config?.display?.openSuccess || 'Vault opened! You received **{{rewardName}}**.');

    if (!result?.won || String(result?.reward?.code || '') === 'no_reward') {
      const suspense = pickRandom(suspenseLines, suspenseFallback[0]);
      const funnyFail = pickRandom(failLines, failFallback[0]);
      return `${suspense}\n${funnyFail}\n${noRewardText}\nKey Tier: ${keyTierName}\n${trailingLabel}: ${availableKeys}`;
    }

    const tierLines = hitFallback[rewardTier] || hitFallback.common;
    const suspense = pickRandom(suspenseLines, suspenseFallback[0]);
    const hitLead = pickRandom(tierLines, hitFallback.common[0]);
    const rewardLine = renderTemplate(successTemplate, vars) || `Vault opened! You received **${rewardName}**.`;
    return `${suspense}\n${hitLead}\n${rewardLine}\nKey Tier: ${keyTierName}\n${trailingLabel}: ${availableKeys}`;
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
      .filter((reward) => String(reward?.type || '').trim().toLowerCase() !== 'no_reward' && String(reward?.code || '').trim().toLowerCase() !== 'no_reward' && String(reward?.code || '').trim().toLowerCase() !== 'nothing')
      .filter((reward) => reward.quantity === null || Number(reward.quantity || 0) > 0);
    if (!rewards.length) {
      return interaction.editReply({
        embeds: [this.buildPanelResponseEmbed(guildId, {
          title: 'Reward Catalog',
          description: 'No available rewards configured.',
        })],
      });
    }
    return interaction.editReply({
      embeds: this.buildRewardCatalogEmbeds(guildId, rewards, {
        title: 'Reward Catalog',
        subtitle: 'Current rewards that can be pulled from the vault.',
      }),
    });
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

  async handleUpgrade(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const fromTier = String(interaction.options.getString('from_tier', true) || '').trim();
    const toTier = String(interaction.options.getString('to_tier', true) || '').trim();
    const times = interaction.options.getInteger('times') || 1;
    const result = vaultService.upgradeKeys(guildId, interaction.user.id, { fromTier, toTier, times });
    if (!result.success) return interaction.editReply({ content: `ERROR: ${result.message}` });
    const embed = this.buildPanelResponseEmbed(guildId, {
      title: 'Key Upgrade Completed',
      description: `Converted ${result.moved.consumed} **${fromTier}** keys into ${result.moved.added} **${toTier}** keys.`,
      accentColor: '#22c55e',
    });
    embed.addFields(
      { name: 'Conversion Count', value: `x${times}`, inline: true },
      { name: 'Season', value: String(result?.seasonId || 'default'), inline: true },
      { name: 'Tier Balances', value: formatTierBalancesInline(result?.stats?.key_balances), inline: false },
    );
    return interaction.editReply({ embeds: [embed] });
  },

  async handleClaims(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const rewards = vaultService.listUserRewards(guildId, interaction.user.id, { limit: 25 });
    if (!rewards.length) {
      return interaction.editReply({ content: 'No vault reward claims found yet.' });
    }
    const lines = rewards.slice(0, 15).map((row) => {
      const socialReqs = row?.reward_payload ? (Array.isArray(row.reward_payload?.social_requirements) ? row.reward_payload.social_requirements.length : 0) : 0;
      const gate = socialReqs > 0 ? ` | social gates: ${socialReqs}` : '';
      return `#${row.id} | ${row.reward_name} | status: ${row.claim_status}${gate}`;
    });
    return interaction.editReply({ content: `Your reward claims:\n${lines.join('\n')}\n\nUse \`/vault verify-social reward_id:<id>\` to verify gated rewards.` });
  },

  async handleVerifySocial(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const rewardId = interaction.options.getInteger('reward_id', true);
    const result = await vaultService.verifyRewardSocialRequirements(guildId, rewardId, interaction.user.id);
    if (!result.success) {
      return interaction.editReply({ content: `Could not verify reward requirements: ${result.message || 'unknown error'}` });
    }
    if (!result.gated) {
      return interaction.editReply({ content: 'This reward has no social requirements.' });
    }
    if (result.verified) {
      return interaction.editReply({ content: 'All social requirements verified. Admin can now finalize your claim.' });
    }
    const pendingLines = (result.pending || []).map((entry) => {
      if (entry.action === 'x_follow') return `- Follow @${entry.targetAccountHandle || entry.targetAccountId || 'target account'}`;
      if (entry.action === 'x_like') return `- Like post ${entry.targetPostId || entry.targetRef || ''}`;
      if (entry.action === 'x_repost') return `- Repost post ${entry.targetPostId || entry.targetRef || ''}`;
      return `- ${entry.action} ${entry.targetRef || ''}`.trim();
    });
    return interaction.editReply({
      content: `Requirements still pending:\n${pendingLines.join('\n')}\n\nAfter completing them, run this command again.`,
    });
  },

  async handleAdminSetup(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const config = vaultService.getConfig(guildId);
    config.general.enabled = interaction.options.getBoolean('enabled') ?? config.general.enabled;
    const projectName = interaction.options.getString('project_name');
    const vaultName = interaction.options.getString('vault_name');
    if (projectName) config.general.projectName = projectName;
    if (vaultName) {
      config.display = config.display || {};
      config.display.gameName = vaultName;
    }
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
      `Vault Name: ${config?.display?.gameName || '-'}`,
      `Active Season: ${season?.season_name || season?.season_id || 'none'}`,
      `Rewards: ${rewards.length}`,
      `Mint Mode: ${config?.minting?.mintMode || 'none'}`,
      `Keys per paid mint: ${config?.minting?.defaultGrants?.paid ?? 0}`,
      `Keys per free mint: ${config?.minting?.defaultGrants?.free ?? 0}`,
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
    const keyTier = interaction.options.getString('key_tier') || 'default';
    const reason = interaction.options.getString('reason') || 'manual_add';
    const season = vaultService.getActiveSeason(guildId);
    const result = vaultService.addKeys(guildId, season?.season_id || 'default', user.id, amount, reason, interaction.user.id, keyTier);
    if (!result.success) return interaction.editReply({ content: `ERROR: ${result.message}` });
    return interaction.editReply({ content: `Added ${amount} ${keyTier} keys to <@${user.id}>.` });
  },

  async handleAdminRemoveKeys(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const user = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);
    const keyTier = interaction.options.getString('key_tier') || 'default';
    const reason = interaction.options.getString('reason') || 'manual_remove';
    const season = vaultService.getActiveSeason(guildId);
    const result = vaultService.removeKeys(guildId, season?.season_id || 'default', user.id, amount, reason, interaction.user.id, keyTier);
    if (!result.success) return interaction.editReply({ content: `ERROR: ${result.message}` });
    return interaction.editReply({ content: `Removed ${amount} ${keyTier} keys from <@${user.id}>.` });
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
    const keyTier = interaction.options.getString('key_tier');
    const type = interaction.options.getString('type') || 'claimable_reward';
    const payloadRaw = interaction.options.getString('payload_json');
    const payload = payloadRaw ? parseConfigValue(payloadRaw) : null;
    const result = vaultService.addReward(guildId, { code, name, tier, weight, quantity, keyTier, type, payload, enabled: true });
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
    const keyTier = interaction.options.getString('key_tier');
    const enabled = interaction.options.getBoolean('enabled');
    const type = interaction.options.getString('type');
    const payloadRaw = interaction.options.getString('payload_json');
    if (name !== null) patch.name = name;
    if (tier !== null) patch.tier = tier;
    if (weight !== null) patch.weight = weight;
    if (quantity !== null) patch.quantity = quantity;
    if (keyTier !== null) patch.keyTier = keyTier;
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

  async handleAdminImportCsv(interaction, guildId) {
    await interaction.deferReply({ ephemeral: true });
    const attachment = interaction.options.getAttachment('csv_file', true);

    if (!attachment.contentType?.includes('csv') && !attachment.name.endsWith('.csv')) {
      return interaction.editReply({ content: 'ERROR: Please upload a valid CSV file.' });
    }

    try {
      const response = await fetch(attachment.url);
      if (!response.ok) throw new Error('Failed to download CSV');

      const csvText = await response.text();
      const result = vaultService.processCsvImport(guildId, csvText);

      if (!result.success) {
        return interaction.editReply({ content: result.message });
      }

      vaultService.logAdminAction(guildId, interaction.user.id, 'csv_import', null, {
        filename: attachment.name,
        processed: result.processed,
        success: result.successCount,
        duplicates: result.duplicates,
        skipped: result.skipped,
      });

      const linesResult = [
        '**CSV Import Complete**',
        `Rows processed (valid transfers): ${result.processed}`,
        `Successfully ingested: ${result.successCount}`,
        `Skipped (duplicates/already existed): ${result.duplicates}`,
        `Ignored (wrong token/too small): ${result.skipped}`,
      ];

      return interaction.editReply({ content: linesResult.join('\n') });
    } catch (error) {
      return interaction.editReply({ content: `ERROR parsing CSV: ${error.message}` });
    }
  },

  async announceVaultWin(guildId, user, openResult, interaction = null) {
    try {
      if (!openResult?.success || !openResult?.won) return { posted: false, reason: 'no_win' };
      const cfg = vaultService.getConfig(guildId) || {};
      const winChannelId = String(cfg?.general?.winChannelId || '').trim();
      if (!winChannelId) return { posted: false, reason: 'missing_channel' };
      const client = interaction?.client || ticketService?.client;
      const channel = client?.channels?.cache?.get(winChannelId)
        || await client?.channels?.fetch?.(winChannelId).catch(() => null);
      if (!channel || !channel.isTextBased?.()) return { posted: false, reason: 'channel_unavailable' };

      const gameName = String(cfg?.display?.gameName || 'Reward Vault');
      const keyTierName = String(openResult?.keyTierName || openResult?.keyTier || 'default');
      const reward = openResult.reward || {};
      const revealDelaySec = Math.max(0, Math.min(30, Number(cfg?.general?.prizeRevealDelaySeconds ?? 3) || 0));
      const drawEmbed = this.buildPanelResponseEmbed(guildId, {
        title: `${gameName} Win`,
        description: `<@${user.id}> opened the vault with a **${keyTierName}** key and hit a winning roll.\nDrawing the prize now...`,
        accentColor: '#22c55e',
      });
      drawEmbed.addFields(
        { name: 'Opening ID', value: String(openResult.openingId || 'n/a'), inline: true },
        { name: 'Win Chance', value: `${Number(openResult?.odds?.winChancePercent || 0).toFixed(2)}%`, inline: true },
      );
      await channel.send({ embeds: [drawEmbed] });
      if (revealDelaySec > 0) await sleep(revealDelaySec * 1000);

      const rewardTier = String(reward?.tier || 'common').toLowerCase();
      const revealEmbed = this.buildPanelResponseEmbed(guildId, {
        title: `${rewardTierEmoji(rewardTier)} Prize Revealed`,
        description: `<@${user.id}> won **${String(reward?.name || reward?.code || 'Unknown Reward')}**.`,
        accentColor: rewardTierColorHex(rewardTier),
      });
      revealEmbed.addFields(
        { name: 'Prize Tier', value: String(rewardTier || 'common'), inline: true },
        { name: 'Key Tier', value: keyTierName, inline: true },
        { name: 'Prize Pool Weight', value: `${Number(reward?.weight || 0)} / ${Number(openResult?.odds?.prizeTotalWeight || 0)}`, inline: true },
      );
      await channel.send({ embeds: [revealEmbed] });
      return { posted: true, channelId: channel.id };
    } catch (error) {
      logger.warn('[vault] win announcement failed:', error?.message || error);
      return { posted: false, reason: 'exception' };
    }
  },
};
