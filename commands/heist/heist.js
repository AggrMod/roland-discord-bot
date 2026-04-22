const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const heistService = require('../../services/heistService');
const moduleGuard = require('../../utils/moduleGuard');
const logger = require('../../utils/logger');
const { getModuleDisplayName } = require('../../services/moduleLabelService');

const PANEL_DISCOVER_ID = 'heist_panel_discover';
const PANEL_STATUS_ID = 'heist_panel_status';
const PANEL_JOIN_ID = 'heist_panel_join';
const PANEL_JOIN_MODAL_ID = 'heist_panel_join_modal';
const PANEL_JOIN_MISSION_INPUT_ID = 'mission_id';
const PANEL_JOIN_MINTS_INPUT_ID = 'mints';

function normalizeGuildId(guildId) {
  return String(guildId || '').trim();
}

function parseMintInput(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function missionStatusEmoji(status) {
  const key = String(status || '').trim().toLowerCase();
  if (key === 'recruiting') return '🟡';
  if (key === 'active') return '🟢';
  if (key === 'completed') return '✅';
  if (key === 'failed') return '❌';
  if (key === 'cancelled') return '⛔';
  return '📜';
}

function formatMissionLine(mission) {
  const id = String(mission.mission_id || mission.missionId || '?');
  const title = String(mission.title || 'Untitled').slice(0, 120);
  const status = String(mission.status || 'recruiting');
  const filled = Number(mission.filled_slots || mission.filledSlots || 0);
  const total = Number(mission.total_slots || mission.totalSlots || 0);
  const endsAt = mission.ends_at || mission.endsAt || null;
  const endsText = endsAt ? `<t:${Math.floor(new Date(endsAt).getTime() / 1000)}:R>` : 'N/A';
  return `${missionStatusEmoji(status)} **${id}** - ${title}\nSlots: ${filled}/${total} - Ends: ${endsText}`;
}

function buildBoardEmbed(guildId, missions = []) {
  const moduleName = getModuleDisplayName('heist', guildId);
  const embed = new EmbedBuilder()
    .setColor('#f4c430')
    .setTitle(`${moduleName} Board`)
    .setTimestamp();

  if (!missions.length) {
    embed.setDescription('No recruiting or active missions right now.');
    return embed;
  }

  const lines = missions.slice(0, 10).map((mission) => formatMissionLine(mission));
  embed.setDescription(lines.join('\n\n'));
  const firstImage = missions
    .map((mission) => mission?.image_url || mission?.imageUrl || mission?.metadata?.image_url || mission?.metadata?.imageUrl || '')
    .map((value) => String(value || '').trim())
    .find((value) => /^https?:\/\//i.test(value) || value.startsWith('data:image/'));
  if (firstImage) {
    embed.setThumbnail(firstImage);
  }
  if (missions.length > 10) {
    embed.addFields({ name: 'More Missions', value: `${missions.length - 10} more mission(s) available.` });
  }
  return embed;
}

function buildProfileEmbed(guildId, profile, activeMissions = []) {
  const moduleName = getModuleDisplayName('heist', guildId);
  const xpLabel = String(profile?.xp_label || profile?.xpLabel || 'XP');
  const streetLabel = String(profile?.streetcredit_label || profile?.streetcreditLabel || 'Streetcredit');
  const embed = new EmbedBuilder()
    .setColor('#2c8f6c')
    .setTitle(`Your ${moduleName} Profile`)
    .addFields(
      { name: xpLabel, value: String(Number(profile?.total_xp || 0)), inline: true },
      { name: streetLabel, value: String(Number(profile?.total_streetcredit || 0)), inline: true },
      { name: 'Rank', value: String(profile?.rank_name || 'Associate'), inline: true },
      { name: 'Vault Tier', value: String(Number(profile?.vault_tier || 0)), inline: true },
      { name: 'Completed', value: String(Number(profile?.missions_completed || 0)), inline: true },
      { name: 'Failed', value: String(Number(profile?.missions_failed || 0)), inline: true },
    )
    .setTimestamp();

  if (activeMissions.length) {
    embed.addFields({
      name: 'Active / Recruiting',
      value: activeMissions
        .slice(0, 5)
        .map((mission) => `• ${String(mission.mission_id || mission.missionId)} (${String(mission.status || 'recruiting')})`)
        .join('\n'),
    });
  }

  return embed;
}

function buildPanelMessage(guildId) {
  const moduleName = getModuleDisplayName('heist', guildId);
  const embed = new EmbedBuilder()
    .setColor('#f4c430')
    .setTitle(`${moduleName} Control Panel`)
    .setDescription(`Use the buttons below to discover missions, check your status, or join with locked NFTs.`)
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PANEL_DISCOVER_ID).setLabel('Discover').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(PANEL_STATUS_ID).setLabel('My Status').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PANEL_JOIN_ID).setLabel('Join Mission').setStyle(ButtonStyle.Success),
  );
  return { embed, row };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('heist')
    .setDescription('Missions module')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('board')
        .setDescription('View recruiting and active missions'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('profile')
        .setDescription('View your missions profile'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('join')
        .setDescription('Join a mission with one or more NFT mints')
        .addStringOption((option) =>
          option
            .setName('mission_id')
            .setDescription('Mission ID')
            .setRequired(true))
        .addStringOption((option) =>
          option
            .setName('mints')
            .setDescription('Optional comma-separated NFT mints to lock')
            .setRequired(false)))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('leave')
        .setDescription('Leave a recruiting mission you joined')
        .addStringOption((option) =>
          option
            .setName('mission_id')
            .setDescription('Mission ID')
            .setRequired(true)))
    .addSubcommandGroup((group) =>
      group
        .setName('admin')
        .setDescription('Admin operations')
        .addSubcommand((subcommand) =>
          subcommand
            .setName('panel')
            .setDescription('Post or refresh the missions panel')
            .addChannelOption((option) =>
              option
                .setName('channel')
                .setDescription('Channel to post panel in')
                .setRequired(false)))
        .addSubcommand((subcommand) =>
          subcommand
            .setName('templates')
            .setDescription('List mission templates'))
        .addSubcommand((subcommand) =>
          subcommand
            .setName('template-create')
            .setDescription('Create a mission template')
            .addStringOption((option) =>
              option.setName('name').setDescription('Template name').setRequired(true))
            .addStringOption((option) =>
              option.setName('description').setDescription('Template description').setRequired(true))
            .addStringOption((option) =>
              option
                .setName('mode')
                .setDescription('Mission mode')
                .setRequired(false)
                .addChoices(
                  { name: 'Solo', value: 'solo' },
                  { name: 'Co-op', value: 'coop' },
                ))
            .addIntegerOption((option) =>
              option.setName('duration_minutes').setDescription('Duration in minutes').setRequired(false).setMinValue(15).setMaxValue(10080))
            .addIntegerOption((option) =>
              option.setName('required_slots').setDescription('Required slots to activate').setRequired(false).setMinValue(1).setMaxValue(50))
            .addIntegerOption((option) =>
              option.setName('total_slots').setDescription('Total slots').setRequired(false).setMinValue(1).setMaxValue(100))
            .addIntegerOption((option) =>
              option.setName('max_nfts_per_user').setDescription('Max NFTs per user').setRequired(false).setMinValue(1).setMaxValue(10))
            .addIntegerOption((option) =>
              option.setName('base_xp_reward').setDescription('Total XP reward pool').setRequired(false).setMinValue(1).setMaxValue(100000))
            .addIntegerOption((option) =>
              option.setName('base_streetcredit_reward').setDescription('Total Streetcredit reward pool').setRequired(false).setMinValue(1).setMaxValue(100000))
            .addIntegerOption((option) =>
              option.setName('spawn_weight').setDescription('Random spawn weight').setRequired(false).setMinValue(1).setMaxValue(1000)))
        .addSubcommand((subcommand) =>
          subcommand
            .setName('spawn-now')
            .setDescription('Spawn a mission now')
            .addIntegerOption((option) =>
              option.setName('template_id').setDescription('Template ID').setRequired(true).setMinValue(1)))
        .addSubcommand((subcommand) =>
          subcommand
            .setName('resolve')
            .setDescription('Resolve a mission now')
            .addStringOption((option) =>
              option.setName('mission_id').setDescription('Mission ID').setRequired(true)))
        .addSubcommand((subcommand) =>
          subcommand
            .setName('cancel')
            .setDescription('Cancel a mission')
            .addStringOption((option) =>
              option.setName('mission_id').setDescription('Mission ID').setRequired(true))
            .addBooleanOption((option) =>
              option.setName('confirm').setDescription('Confirm cancellation').setRequired(true)))),

  async execute(interaction) {
    if (!(await moduleGuard.checkModuleEnabled(interaction, 'heist'))) return;

    const guildId = normalizeGuildId(interaction.guildId);
    if (!guildId) {
      await interaction.reply({ content: 'This command must be used inside a server.', ephemeral: true });
      return;
    }

    heistService.ensureGuildScaffold(guildId);

    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommandGroup === 'admin') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }
        await this.handleAdminCommand(interaction, subcommand, guildId);
        return;
      }

      await this.handleUserCommand(interaction, subcommand, guildId);
    } catch (error) {
      logger.error('[heist] command execution error:', error);
      const payload = { content: 'Something went wrong while handling this mission action.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  },

  async handleUserCommand(interaction, subcommand, guildId) {
    if (subcommand === 'board') {
      await interaction.deferReply({ ephemeral: true });
      const missions = heistService.listMissions(guildId, {
        statuses: ['recruiting', 'active'],
        limit: 20,
      });
      await interaction.editReply({ embeds: [buildBoardEmbed(guildId, missions)] });
      return;
    }

    if (subcommand === 'profile') {
      await interaction.deferReply({ ephemeral: true });
      const profile = heistService.getProfile(guildId, interaction.user.id, interaction.user.username);
      const missions = heistService.listUserMissions(guildId, interaction.user.id, {
        statuses: ['recruiting', 'active'],
        limit: 10,
      });
      await interaction.editReply({ embeds: [buildProfileEmbed(guildId, profile, missions)] });
      return;
    }

    if (subcommand === 'join') {
      await interaction.deferReply({ ephemeral: true });
      const missionId = String(interaction.options.getString('mission_id') || '').trim();
      const mints = parseMintInput(interaction.options.getString('mints') || '');
      const result = await heistService.joinMission({
        guildId,
        missionId,
        userId: interaction.user.id,
        username: interaction.user.username,
        selectedMints: mints,
      });
      if (!result?.success) {
        await interaction.editReply({ content: `Could not join mission: ${result?.message || 'Unknown error'}` });
        return;
      }
      const mission = result?.mission || heistService.getMission(guildId, missionId, { includeSlots: true });
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor('#2c8f6c')
            .setTitle('Mission Joined')
            .setDescription(formatMissionLine(mission))
            .setTimestamp(),
        ],
      });
      return;
    }

    if (subcommand === 'leave') {
      await interaction.deferReply({ ephemeral: true });
      const missionId = String(interaction.options.getString('mission_id') || '').trim();
      const result = heistService.leaveMission({
        guildId,
        missionId,
        userId: interaction.user.id,
      });
      if (!result?.success) {
        await interaction.editReply({ content: `Could not leave mission: ${result?.message || 'Unknown error'}` });
        return;
      }
      await interaction.editReply({ content: `Left mission ${missionId}.` });
      return;
    }
  },

  async handleAdminCommand(interaction, subcommand, guildId) {
    if (subcommand === 'panel') {
      await interaction.deferReply({ ephemeral: true });
      const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
      if (!targetChannel || typeof targetChannel.send !== 'function') {
        await interaction.editReply({ content: 'Could not resolve target channel.' });
        return;
      }
      const panel = buildPanelMessage(guildId);
      const message = await targetChannel.send({ embeds: [panel.embed], components: [panel.row] });
      heistService.updateConfig(guildId, {
        panel_channel_id: targetChannel.id,
        panel_message_id: message.id,
      });
      await interaction.editReply({ content: `Panel posted in <#${targetChannel.id}>.` });
      return;
    }

    if (subcommand === 'templates') {
      await interaction.deferReply({ ephemeral: true });
      const templates = heistService.listTemplates(guildId, { includeDisabled: true });
      if (!templates.length) {
        await interaction.editReply({ content: 'No templates configured yet.' });
        return;
      }
      const lines = templates.slice(0, 20).map((template) =>
        `• #${template.id} ${template.enabled ? '✅' : '⛔'} ${template.name} (${template.mode}, weight ${template.spawn_weight})`
      );
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor('#f4c430')
            .setTitle('Mission Templates')
            .setDescription(lines.join('\n'))
            .setTimestamp(),
        ],
      });
      return;
    }

    if (subcommand === 'template-create') {
      await interaction.deferReply({ ephemeral: true });
      const payload = {
        name: interaction.options.getString('name'),
        description: interaction.options.getString('description'),
        mode: interaction.options.getString('mode') || 'solo',
        duration_minutes: interaction.options.getInteger('duration_minutes'),
        required_slots: interaction.options.getInteger('required_slots'),
        total_slots: interaction.options.getInteger('total_slots'),
        max_nfts_per_user: interaction.options.getInteger('max_nfts_per_user'),
        base_xp_reward: interaction.options.getInteger('base_xp_reward'),
        base_streetcredit_reward: interaction.options.getInteger('base_streetcredit_reward'),
        spawn_weight: interaction.options.getInteger('spawn_weight'),
      };
      const result = heistService.createTemplate(guildId, payload);
      if (!result?.success) {
        await interaction.editReply({ content: `Failed to create template: ${result?.message || 'Unknown error'}` });
        return;
      }
      await interaction.editReply({ content: `Template created with ID #${result.template?.id}.` });
      return;
    }

    if (subcommand === 'spawn-now') {
      await interaction.deferReply({ ephemeral: true });
      const templateId = interaction.options.getInteger('template_id');
      const result = heistService.spawnMissionNow(guildId, templateId, { spawnSource: 'admin' });
      if (!result?.success) {
        await interaction.editReply({ content: `Failed to spawn mission: ${result?.message || 'Unknown error'}` });
        return;
      }
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor('#2c8f6c')
            .setTitle('Mission Spawned')
            .setDescription(formatMissionLine(result.mission))
            .setTimestamp(),
        ],
      });
      return;
    }

    if (subcommand === 'resolve') {
      await interaction.deferReply({ ephemeral: true });
      const missionId = String(interaction.options.getString('mission_id') || '').trim();
      const result = await heistService.resolveMission(guildId, missionId);
      if (!result?.success) {
        await interaction.editReply({ content: `Failed to resolve mission: ${result?.message || 'Unknown error'}` });
        return;
      }
      await interaction.editReply({ content: `Mission ${missionId} resolved with status: ${result.status}.` });
      return;
    }

    if (subcommand === 'cancel') {
      await interaction.deferReply({ ephemeral: true });
      const missionId = String(interaction.options.getString('mission_id') || '').trim();
      const confirm = interaction.options.getBoolean('confirm');
      if (!confirm) {
        await interaction.editReply({ content: 'Set confirm=true to cancel this mission.' });
        return;
      }
      const result = heistService.cancelMission(guildId, missionId, interaction.user.id);
      if (!result?.success) {
        await interaction.editReply({ content: `Failed to cancel mission: ${result?.message || 'Unknown error'}` });
        return;
      }
      await interaction.editReply({ content: `Mission ${missionId} cancelled.` });
      return;
    }
  },

  async handlePanelButton(interaction) {
    if (!(await moduleGuard.checkModuleEnabled(interaction, 'heist'))) return;
    const guildId = normalizeGuildId(interaction.guildId);
    if (!guildId) {
      await interaction.reply({ content: 'This interaction can only be used in a server.', ephemeral: true });
      return;
    }

    if (interaction.customId === PANEL_DISCOVER_ID) {
      await interaction.deferReply({ ephemeral: true });
      const missions = heistService.listMissions(guildId, {
        statuses: ['recruiting', 'active'],
        limit: 20,
      });
      await interaction.editReply({ embeds: [buildBoardEmbed(guildId, missions)] });
      return;
    }

    if (interaction.customId === PANEL_STATUS_ID) {
      await interaction.deferReply({ ephemeral: true });
      const profile = heistService.getProfile(guildId, interaction.user.id, interaction.user.username);
      const missions = heistService.listUserMissions(guildId, interaction.user.id, {
        statuses: ['recruiting', 'active'],
        limit: 10,
      });
      await interaction.editReply({ embeds: [buildProfileEmbed(guildId, profile, missions)] });
      return;
    }

    if (interaction.customId === PANEL_JOIN_ID) {
      const modal = new ModalBuilder()
        .setCustomId(PANEL_JOIN_MODAL_ID)
        .setTitle('Join Mission');
      const missionInput = new TextInputBuilder()
        .setCustomId(PANEL_JOIN_MISSION_INPUT_ID)
        .setLabel('Mission ID')
        .setPlaceholder('M-XXXXXXXX')
        .setRequired(true)
        .setStyle(TextInputStyle.Short);
      const mintsInput = new TextInputBuilder()
        .setCustomId(PANEL_JOIN_MINTS_INPUT_ID)
        .setLabel('NFT mints (optional, comma separated)')
        .setRequired(false)
        .setStyle(TextInputStyle.Paragraph);
      modal.addComponents(
        new ActionRowBuilder().addComponents(missionInput),
        new ActionRowBuilder().addComponents(mintsInput),
      );
      await interaction.showModal(modal);
      return;
    }
  },

  async handlePanelModal(interaction) {
    if (!(await moduleGuard.checkModuleEnabled(interaction, 'heist'))) return;
    if (interaction.customId !== PANEL_JOIN_MODAL_ID) return;
    await interaction.deferReply({ ephemeral: true });
    const guildId = normalizeGuildId(interaction.guildId);
    if (!guildId) {
      await interaction.editReply({ content: 'This interaction can only be used in a server.' });
      return;
    }
    const missionId = String(interaction.fields.getTextInputValue(PANEL_JOIN_MISSION_INPUT_ID) || '').trim();
    const mints = parseMintInput(interaction.fields.getTextInputValue(PANEL_JOIN_MINTS_INPUT_ID) || '');
    const result = await heistService.joinMission({
      guildId,
      missionId,
      userId: interaction.user.id,
      username: interaction.user.username,
      selectedMints: mints,
    });
    if (!result?.success) {
      await interaction.editReply({ content: `Could not join mission: ${result?.message || 'Unknown error'}` });
      return;
    }
    const mission = result?.mission || heistService.getMission(guildId, missionId, { includeSlots: true });
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor('#2c8f6c')
          .setTitle('Mission Joined')
          .setDescription(formatMissionLine(mission))
          .setTimestamp(),
      ],
    });
  },
};
