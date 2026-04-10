const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const moduleGuard = require('../../utils/moduleGuard');
const inviteTrackerService = require('../../services/inviteTrackerService');
const logger = require('../../utils/logger');

function getPeriodLabel(days) {
  if (!days) return 'All-time';
  return `${days}d`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Invite tracker tools: who-invited-who, leaderboard, and export')
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
          option.setName('limit').setDescription('Rows to show').setRequired(false).setMinValue(1).setMaxValue(200)))
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
      return interaction.editReply({ content: `❌ ${result.message || 'Could not fetch invite data.'}` });
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
    const days = periodRaw === 'all' ? null : Number(periodRaw);
    const requestedLimit = interaction.options.getInteger('limit') || 25;

    const result = inviteTrackerService.getLeaderboard(interaction.guildId, { limit: requestedLimit, days });
    if (!result.success) {
      return interaction.editReply({ content: `❌ ${result.message || 'Could not load leaderboard.'}` });
    }

    if (!Array.isArray(result.rows) || result.rows.length === 0) {
      const suffix = result.limitedByPlan ? ' (time filter unavailable on current plan)' : '';
      return interaction.editReply({ content: `No invite leaderboard data yet for ${getPeriodLabel(result.periodDays)}.${suffix}` });
    }

    const lines = result.rows.map(row => {
      const inviter = row.inviterUserId ? `<@${row.inviterUserId}>` : (row.inviterUsername || 'Unknown');
      return `**#${row.rank}** ${inviter} — **${row.inviteCount}**`;
    });

    const footerBits = [`Period: ${getPeriodLabel(result.periodDays)}`, `Rows: ${result.rows.length}`];
    if (result.limitedByPlan) footerBits.push('Time filter restricted by plan');

    const embed = new EmbedBuilder()
      .setColor('#22C55E')
      .setTitle('Invite Leaderboard')
      .setDescription(lines.join('\n'))
      .setFooter({ text: footerBits.join(' • ') })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },

  async handleExport(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const periodRaw = interaction.options.getString('period') || 'all';
    const days = periodRaw === 'all' ? null : Number(periodRaw);
    const result = inviteTrackerService.exportCsv(interaction.guildId, { days });

    if (!result.success) {
      return interaction.editReply({ content: `❌ ${result.message || 'Could not export invite events.'}` });
    }

    const fileBuffer = Buffer.from(result.csv || '', 'utf8');
    return interaction.editReply({
      content: `✅ Export ready (${getPeriodLabel(result.periodDays)}).`,
      files: [{ attachment: fileBuffer, name: result.filename || 'invite-tracker.csv' }],
    });
  },
};
