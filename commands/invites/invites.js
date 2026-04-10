const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');
const moduleGuard = require('../../utils/moduleGuard');
const inviteTrackerService = require('../../services/inviteTrackerService');
const logger = require('../../utils/logger');

function getPeriodLabel(days) {
  if (!days) return 'All-time';
  return `${days}d`;
}

function parsePeriod(periodValue) {
  if (!periodValue || periodValue === 'all') return null;
  const n = Number(periodValue);
  return Number.isFinite(n) && n > 0 ? n : null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Invite tracker tools: who-invited-who, leaderboard, panel, and export')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub
        .setName('who')
        .setDescription('See who invited a member')
        .addUserOption(option =>
          option.setName('user').setDescription('Member to inspect').setRequired(true)))
    .addSubcommand(sub =>
      sub
        .setName('leaderboard')
        .setDescription('Show invite leaderboard')
        .addStringOption(option =>
          option
            .setName('period')
            .setDescription('Time period')
            .setRequired(false)
            .addChoices(
              { name: 'All-time', value: 'all' },
              { name: 'Last 7 days', value: '7' },
              { name: 'Last 30 days', value: '30' },
            ))
        .addIntegerOption(option =>
          option.setName('limit').setDescription('Rows to show').setRequired(false).setMinValue(1).setMaxValue(200))
        .addRoleOption(option =>
          option.setName('required_join_role').setDescription('Only count invites where joined member has this role').setRequired(false))
        .addBooleanOption(option =>
          option.setName('verification_stats').setDescription('Include verification NFT holdings stats').setRequired(false)))
    .addSubcommand(sub =>
      sub
        .setName('panel')
        .setDescription('Post or update invite leaderboard panel')
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('Channel to post/update leaderboard panel in')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false))
        .addStringOption(option =>
          option
            .setName('period')
            .setDescription('Leaderboard period for panel')
            .setRequired(false)
            .addChoices(
              { name: 'All-time', value: 'all' },
              { name: 'Last 7 days', value: '7' },
              { name: 'Last 30 days', value: '30' },
            ))
        .addIntegerOption(option =>
          option.setName('limit').setDescription('Rows to show in panel').setRequired(false).setMinValue(1).setMaxValue(50))
        .addRoleOption(option =>
          option.setName('required_join_role').setDescription('Only count invites where joined member has this role').setRequired(false))
        .addBooleanOption(option =>
          option.setName('create_link_button').setDescription('Show "Create My Invite Link" button on panel').setRequired(false))
        .addBooleanOption(option =>
          option.setName('verification_stats').setDescription('Include verification NFT holdings stats').setRequired(false)))
    .addSubcommand(sub =>
      sub
        .setName('export')
        .setDescription('Export invite events as CSV')
        .addStringOption(option =>
          option
            .setName('period')
            .setDescription('Export range')
            .setRequired(false)
            .addChoices(
              { name: 'All-time', value: 'all' },
              { name: 'Last 7 days', value: '7' },
              { name: 'Last 30 days', value: '30' },
            ))),

  async execute(interaction) {
    if (!await moduleGuard.checkModuleEnabled(interaction, 'invites')) return;
    if (!await moduleGuard.checkAdmin(interaction)) return;

    const sub = interaction.options.getSubcommand();
    try {
      if (sub === 'who') return this.handleWho(interaction);
      if (sub === 'leaderboard') return this.handleLeaderboard(interaction);
      if (sub === 'panel') return this.handlePanel(interaction);
      if (sub === 'export') return this.handleExport(interaction);
      return interaction.reply({ content: 'Unknown invites command.', ephemeral: true });
    } catch (error) {
      logger.error('[invites] command error:', error);
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content: 'Could not complete invite tracker command.' });
      }
      return interaction.reply({ content: 'Could not complete invite tracker command.', ephemeral: true });
    }
  },

  async handleWho(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const user = interaction.options.getUser('user', true);
    const result = inviteTrackerService.getInviterForUser(interaction.guildId, user.id);
    if (!result.success) {
      return interaction.editReply({ content: `X ${result.message || 'Could not fetch invite data.'}` });
    }
    if (!result.record) {
      return interaction.editReply({ content: `No invite record found for <@${user.id}> in this server.` });
    }

    const record = result.record;
    const inviterText = record.inviterUserId
      ? `<@${record.inviterUserId}>`
      : 'Unknown';
    const inviteCodeText = record.inviteCode ? `\`${record.inviteCode}\`` : 'Unknown';
    const joinedAtText = record.joinedAt ? `<t:${Math.floor(new Date(record.joinedAt).getTime() / 1000)}:f>` : 'Unknown';

    const embed = new EmbedBuilder()
      .setColor('#6366F1')
      .setTitle('Invite Lookup')
      .addFields(
        { name: 'Member', value: `<@${user.id}>`, inline: true },
        { name: 'Inviter', value: inviterText, inline: true },
        { name: 'Invite Code', value: inviteCodeText, inline: true },
        { name: 'Joined At', value: joinedAtText, inline: false },
      )
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },

  async handleLeaderboard(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const periodRaw = interaction.options.getString('period') || 'all';
    const days = parsePeriod(periodRaw);
    const requestedLimit = interaction.options.getInteger('limit') || 25;
    const requiredRole = interaction.options.getRole('required_join_role');
    const verificationStats = interaction.options.getBoolean('verification_stats');

    const result = await inviteTrackerService.getLeaderboard(interaction.guildId, {
      limit: requestedLimit,
      days,
      requiredJoinRoleId: requiredRole?.id,
      includeVerificationStats: verificationStats === null ? undefined : verificationStats,
    });
    if (!result.success) {
      return interaction.editReply({ content: `X ${result.message || 'Could not load leaderboard.'}` });
    }

    if (!Array.isArray(result.rows) || result.rows.length === 0) {
      const suffix = result.limitedByPlan ? ' (time filter unavailable on current plan)' : '';
      return interaction.editReply({ content: `No invite leaderboard data yet for ${getPeriodLabel(result.periodDays)}.${suffix}` });
    }

    const lines = result.rows.map(row => {
      const inviter = row.inviterUserId ? `<@${row.inviterUserId}>` : (row.inviterUsername || 'Unknown');
      if (result.includeVerificationStats) {
        if (result.includeTokenStats) {
          return `**#${row.rank}** ${inviter} - **${row.inviteCount}** | NFTs: **${Number(row.inviteeNftsTotal || 0)}** | Tokens: **${Number(row.inviteeTokensTotal || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}**`;
        }
        return `**#${row.rank}** ${inviter} - **${row.inviteCount}** | NFTs: **${Number(row.inviteeNftsTotal || 0)}**`;
      }
      return `**#${row.rank}** ${inviter} - **${row.inviteCount}**`;
    });

    const footerBits = [`Period: ${getPeriodLabel(result.periodDays)}`, `Rows: ${result.rows.length}`];
    if (result.limitedByPlan) footerBits.push('Time filter restricted by plan');
    if (result.requiredJoinRoleId) footerBits.push('Role filtered');
    if (result.includeVerificationStats) footerBits.push('Verification stats');
    if (result.includeTokenStats) footerBits.push('Token stats');

    const embed = new EmbedBuilder()
      .setColor('#22C55E')
      .setTitle('Invite Leaderboard')
      .setDescription(lines.join('\n'))
      .setFooter({ text: footerBits.join(' • ') })
      .setTimestamp();

    if (result.requiredJoinRoleId) {
      embed.addFields({ name: 'Required Join Role', value: `<@&${result.requiredJoinRoleId}>`, inline: true });
    }
    if (result.includeVerificationStats) {
      const totalInviteeNfts = result.rows.reduce((sum, row) => sum + Number(row.inviteeNftsTotal || 0), 0);
      embed.addFields({ name: 'Invitee NFT Total', value: String(totalInviteeNfts), inline: true });
      if (result.includeTokenStats) {
        const totalInviteeTokens = result.rows.reduce((sum, row) => sum + Number(row.inviteeTokensTotal || 0), 0);
        embed.addFields({
          name: 'Invitee Token Total',
          value: totalInviteeTokens.toLocaleString(undefined, { maximumFractionDigits: 6 }),
          inline: true,
        });
      }
    }

    return interaction.editReply({ embeds: [embed] });
  },

  async handlePanel(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const targetChannel = interaction.options.getChannel('channel');
    const periodRaw = interaction.options.getString('period');
    const days = periodRaw ? parsePeriod(periodRaw) : undefined;
    const limit = interaction.options.getInteger('limit');
    const requiredRole = interaction.options.getRole('required_join_role');
    const createLinkButton = interaction.options.getBoolean('create_link_button');
    const verificationStats = interaction.options.getBoolean('verification_stats');

    const settingsResult = inviteTrackerService.saveSettings(interaction.guildId, {
      requiredJoinRoleId: requiredRole ? requiredRole.id : undefined,
      panelChannelId: targetChannel ? targetChannel.id : undefined,
      panelPeriodDays: periodRaw === null ? undefined : days,
      panelLimit: limit === null ? undefined : limit,
      panelEnableCreateLink: createLinkButton === null ? undefined : createLinkButton,
      includeVerificationStats: verificationStats === null ? undefined : verificationStats,
    });
    if (!settingsResult.success) {
      return interaction.editReply({ content: `X ${settingsResult.message || 'Could not save invite panel settings.'}` });
    }

    const result = await inviteTrackerService.postOrUpdateLeaderboardPanel(
      interaction.guildId,
      targetChannel?.id || null,
      {
        days,
        limit: limit === null ? undefined : limit,
        requiredJoinRoleId: requiredRole?.id,
        enableCreateLink: createLinkButton === null ? undefined : createLinkButton,
        includeVerificationStats: verificationStats === null ? undefined : verificationStats,
      }
    );
    if (!result.success) {
      return interaction.editReply({ content: `X ${result.message || 'Could not post invite panel.'}` });
    }

    const channelMention = result.channelId ? `<#${result.channelId}>` : 'configured channel';
    return interaction.editReply({
      content: `Done. Invite leaderboard panel ${result.action || 'updated'} in ${channelMention}.`,
    });
  },

  async handleExport(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const periodRaw = interaction.options.getString('period') || 'all';
    const days = parsePeriod(periodRaw);
    const result = await inviteTrackerService.exportCsv(interaction.guildId, { days });

    if (!result.success) {
      return interaction.editReply({ content: `X ${result.message || 'Could not export invite events.'}` });
    }

    const fileBuffer = Buffer.from(result.csv || '', 'utf8');
    return interaction.editReply({
      content: `Export ready (${getPeriodLabel(result.periodDays)}).`,
      files: [{ attachment: fileBuffer, name: result.filename || 'invite-tracker.csv' }],
    });
  },
};
