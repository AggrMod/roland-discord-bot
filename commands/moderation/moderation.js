const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const tenantService = require('../../services/tenantService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');
const moderationService = require('../../services/moderationService');

function parseDuration(minutes) {
  const parsed = Number(minutes);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 1 || parsed > 40320) return null;
  return Math.floor(parsed);
}

function parsePurgeAmount(amount) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 1 || parsed > 100) return null;
  return Math.floor(parsed);
}

function canModerateTarget(interaction, targetMember) {
  if (!targetMember) return { ok: false, reason: 'Target member was not found in this server.' };
  if (!interaction.guild?.members?.me) return { ok: false, reason: 'Bot member context is unavailable.' };
  if (targetMember.id === interaction.user.id) return { ok: false, reason: 'You cannot target yourself.' };
  if (targetMember.id === interaction.guild.ownerId) return { ok: false, reason: 'Server owner cannot be moderated.' };

  const actorHighest = interaction.member?.roles?.highest;
  const targetHighest = targetMember.roles?.highest;
  if (actorHighest && targetHighest && targetHighest.comparePositionTo(actorHighest) >= 0) {
    return { ok: false, reason: 'You can only moderate members below your top role.' };
  }

  const botHighest = interaction.guild.members.me.roles?.highest;
  if (botHighest && targetHighest && targetHighest.comparePositionTo(botHighest) >= 0) {
    return { ok: false, reason: 'I cannot moderate this member due to role hierarchy.' };
  }

  return { ok: true };
}

function safeAudit(guildId, actorId, action, beforeValue, afterValue) {
  try {
    tenantService.logAudit(guildId, actorId, action, beforeValue, afterValue);
  } catch (_error) {}
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('moderation')
    .setDescription('Moderation tools for admins and moderators')
    .addSubcommand(subcommand =>
      subcommand
        .setName('kick')
        .setDescription('Kick a member from this server')
        .addUserOption(option => option.setName('user').setDescription('Member to kick').setRequired(true))
        .addStringOption(option => option.setName('reason').setDescription('Reason for the kick').setRequired(false).setMaxLength(512)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('ban')
        .setDescription('Ban a member from this server')
        .addUserOption(option => option.setName('user').setDescription('Member to ban').setRequired(true))
        .addStringOption(option => option.setName('reason').setDescription('Reason for the ban').setRequired(false).setMaxLength(512))
        .addIntegerOption(option => option.setName('delete_days').setDescription('Delete last N days of message history (0-7)').setRequired(false).setMinValue(0).setMaxValue(7)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('timeout')
        .setDescription('Timeout (mute) a member for a duration')
        .addUserOption(option => option.setName('user').setDescription('Member to timeout').setRequired(true))
        .addIntegerOption(option => option.setName('minutes').setDescription('Timeout duration in minutes (1-40320)').setRequired(true).setMinValue(1).setMaxValue(40320))
        .addStringOption(option => option.setName('reason').setDescription('Reason for the timeout').setRequired(false).setMaxLength(512)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('purge')
        .setDescription('Delete recent messages in this channel')
        .addIntegerOption(option => option.setName('amount').setDescription('Number of messages to delete (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
        .addUserOption(option => option.setName('user').setDescription('Only purge messages from this user (optional)').setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('settings-view')
        .setDescription('View anti-raid and keyword filter settings'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('settings-raid')
        .setDescription('Configure anti-raid thresholds and action')
        .addBooleanOption(option => option.setName('enabled').setDescription('Enable anti-raid').setRequired(true))
        .addIntegerOption(option => option.setName('window_seconds').setDescription('Join window in seconds (10-300)').setRequired(false).setMinValue(10).setMaxValue(300))
        .addIntegerOption(option => option.setName('join_threshold').setDescription('Joins before trigger (2-50)').setRequired(false).setMinValue(2).setMaxValue(50))
        .addStringOption(option => option.setName('action').setDescription('Auto action on trigger').setRequired(false).addChoices(
          { name: 'Timeout', value: 'timeout' },
          { name: 'Kick', value: 'kick' }
        ))
        .addIntegerOption(option => option.setName('timeout_minutes').setDescription('Timeout minutes if action=timeout (1-120)').setRequired(false).setMinValue(1).setMaxValue(120)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('settings-keywords')
        .setDescription('Configure keyword filter behavior')
        .addBooleanOption(option => option.setName('enabled').setDescription('Enable keyword filter').setRequired(true))
        .addBooleanOption(option => option.setName('delete_message').setDescription('Delete matched messages').setRequired(false))
        .addBooleanOption(option => option.setName('warn_user').setDescription('Warn user in channel').setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('keyword-add')
        .setDescription('Add a blocked keyword')
        .addStringOption(option => option.setName('keyword').setDescription('Keyword or phrase').setRequired(true).setMinLength(2).setMaxLength(64)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('keyword-remove')
        .setDescription('Remove a blocked keyword')
        .addStringOption(option => option.setName('keyword').setDescription('Keyword or phrase').setRequired(true).setMinLength(2).setMaxLength(64)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('keyword-list')
        .setDescription('List blocked keywords')),

  async execute(interaction) {
    if (!await moduleGuard.checkAdminOrModerator(interaction)) {
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    try {
      switch (subcommand) {
        case 'kick':
          await this.handleKick(interaction);
          break;
        case 'ban':
          await this.handleBan(interaction);
          break;
        case 'timeout':
          await this.handleTimeout(interaction);
          break;
        case 'purge':
          await this.handlePurge(interaction);
          break;
        case 'settings-view':
          await this.handleSettingsView(interaction);
          break;
        case 'settings-raid':
          await this.handleSettingsRaid(interaction);
          break;
        case 'settings-keywords':
          await this.handleSettingsKeywords(interaction);
          break;
        case 'keyword-add':
          await this.handleKeywordAdd(interaction);
          break;
        case 'keyword-remove':
          await this.handleKeywordRemove(interaction);
          break;
        case 'keyword-list':
          await this.handleKeywordList(interaction);
          break;
        default:
          await interaction.reply({ content: 'Unknown moderation action.', ephemeral: true });
      }
    } catch (error) {
      logger.error('[moderation] command error:', error);
      const msg = { content: 'Moderation action failed. Please try again.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg).catch(() => {});
      } else {
        await interaction.reply(msg).catch(() => {});
      }
    }
  },

  async handleKick(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    const moderationCheck = canModerateTarget(interaction, member);
    if (!moderationCheck.ok) {
      await interaction.editReply({ content: `? ${moderationCheck.reason}` });
      return;
    }

    await member.kick(reason);
    safeAudit(interaction.guildId, interaction.user.id, 'moderation_kick', { targetUserId: targetUser.id, targetTag: targetUser.tag, reason }, { kicked: true, at: new Date().toISOString() });
    await interaction.editReply({ content: `? Kicked **${targetUser.tag}**.` });
  },

  async handleBan(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const deleteDays = Number(interaction.options.getInteger('delete_days') || 0);
    const deleteSeconds = Math.max(0, Math.min(7, deleteDays)) * 24 * 60 * 60;

    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (member) {
      const moderationCheck = canModerateTarget(interaction, member);
      if (!moderationCheck.ok) {
        await interaction.editReply({ content: `? ${moderationCheck.reason}` });
        return;
      }
    }

    await interaction.guild.members.ban(targetUser.id, { reason, deleteMessageSeconds: deleteSeconds });
    safeAudit(interaction.guildId, interaction.user.id, 'moderation_ban', { targetUserId: targetUser.id, targetTag: targetUser.tag, reason, deleteDays }, { banned: true, at: new Date().toISOString() });
    await interaction.editReply({ content: `? Banned **${targetUser.tag}**.` });
  },

  async handleTimeout(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user', true);
    const minutesRaw = interaction.options.getInteger('minutes', true);
    const reason = interaction.options.getString('reason') || 'No reason provided';

    const minutes = parseDuration(minutesRaw);
    if (!minutes) {
      await interaction.editReply({ content: '? Duration must be between 1 and 40320 minutes.' });
      return;
    }

    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    const moderationCheck = canModerateTarget(interaction, member);
    if (!moderationCheck.ok) {
      await interaction.editReply({ content: `? ${moderationCheck.reason}` });
      return;
    }

    const timeoutMs = minutes * 60 * 1000;
    await member.timeout(timeoutMs, reason);
    safeAudit(interaction.guildId, interaction.user.id, 'moderation_timeout', { targetUserId: targetUser.id, targetTag: targetUser.tag, reason, minutes }, { timedOutUntil: new Date(Date.now() + timeoutMs).toISOString(), at: new Date().toISOString() });
    await interaction.editReply({ content: `? Timed out **${targetUser.tag}** for **${minutes} minute(s)**.` });
  },

  async handlePurge(interaction) {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.editReply({ content: '? You need Manage Messages permission for purge.' });
      return;
    }

    const amountRaw = interaction.options.getInteger('amount', true);
    const targetUser = interaction.options.getUser('user', false);
    const amount = parsePurgeAmount(amountRaw);

    if (!amount) {
      await interaction.editReply({ content: '? Amount must be between 1 and 100.' });
      return;
    }

    let deleted = 0;

    if (!targetUser) {
      const result = await interaction.channel.bulkDelete(amount, true);
      deleted = result?.size || 0;
    } else {
      const fetched = await interaction.channel.messages.fetch({ limit: Math.min(100, Math.max(amount * 3, 30)) });
      const toDelete = fetched.filter(message => message.author?.id === targetUser.id).first(amount);
      if (!toDelete.length) {
        await interaction.editReply({ content: `?? No recent messages found for **${targetUser.tag}**.` });
        return;
      }
      const result = await interaction.channel.bulkDelete(toDelete, true);
      deleted = result?.size || 0;
    }

    safeAudit(interaction.guildId, interaction.user.id, 'moderation_purge', { channelId: interaction.channelId, requestedAmount: amount, targetUserId: targetUser?.id || null }, { deleted, at: new Date().toISOString() });

    const embed = new EmbedBuilder()
      .setColor('#22c55e')
      .setTitle('Purge Complete')
      .setDescription(targetUser ? `Deleted **${deleted}** message(s) from **${targetUser.tag}**.` : `Deleted **${deleted}** recent message(s).`)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },

  async handleSettingsView(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const settings = moderationService.getSettings(interaction.guildId);
    const keywords = moderationService.listKeywords(interaction.guildId);
    const embed = new EmbedBuilder()
      .setColor('#6366f1')
      .setTitle('Moderation Settings')
      .addFields(
        { name: 'Anti-Raid', value: settings.antiRaidEnabled ? `Enabled (${settings.antiRaidJoinThreshold} joins / ${settings.antiRaidWindowSeconds}s, action: ${settings.antiRaidAction})` : 'Disabled', inline: false },
        { name: 'Keyword Filter', value: settings.keywordFilterEnabled ? `Enabled (delete=${settings.keywordFilterDelete ? 'yes' : 'no'}, warn=${settings.keywordFilterWarn ? 'yes' : 'no'})` : 'Disabled', inline: false },
        { name: 'Blocked Keywords', value: keywords.length ? keywords.slice(0, 20).map((k) => `• ${k}`).join('\n') : 'None configured', inline: false }
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  },

  async handleSettingsRaid(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const result = moderationService.saveSettings(interaction.guildId, {
      antiRaidEnabled: interaction.options.getBoolean('enabled', true),
      antiRaidWindowSeconds: interaction.options.getInteger('window_seconds', false),
      antiRaidJoinThreshold: interaction.options.getInteger('join_threshold', false),
      antiRaidAction: interaction.options.getString('action', false),
      antiRaidTimeoutMinutes: interaction.options.getInteger('timeout_minutes', false),
    });
    if (!result.success) {
      await interaction.editReply({ content: `❌ ${result.message || 'Failed to save anti-raid settings.'}` });
      return;
    }
    await interaction.editReply({ content: '✅ Anti-raid settings updated.' });
  },

  async handleSettingsKeywords(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const result = moderationService.saveSettings(interaction.guildId, {
      keywordFilterEnabled: interaction.options.getBoolean('enabled', true),
      keywordFilterDelete: interaction.options.getBoolean('delete_message', false),
      keywordFilterWarn: interaction.options.getBoolean('warn_user', false),
    });
    if (!result.success) {
      await interaction.editReply({ content: `❌ ${result.message || 'Failed to save keyword filter settings.'}` });
      return;
    }
    await interaction.editReply({ content: '✅ Keyword filter settings updated.' });
  },

  async handleKeywordAdd(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const keyword = interaction.options.getString('keyword', true);
    const result = moderationService.addKeyword(interaction.guildId, keyword);
    await interaction.editReply({ content: result.success ? `✅ Added keyword: \`${keyword.trim().toLowerCase()}\`` : `❌ ${result.message || 'Failed to add keyword.'}` });
  },

  async handleKeywordRemove(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const keyword = interaction.options.getString('keyword', true);
    const result = moderationService.removeKeyword(interaction.guildId, keyword);
    await interaction.editReply({ content: result.success ? `✅ Removed keyword: \`${keyword.trim().toLowerCase()}\`` : '❌ Keyword was not found.' });
  },

  async handleKeywordList(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const keywords = moderationService.listKeywords(interaction.guildId);
    if (!keywords.length) {
      await interaction.editReply({ content: 'ℹ️ No blocked keywords configured.' });
      return;
    }
    await interaction.editReply({ content: `Blocked keywords (${keywords.length}):\n${keywords.slice(0, 100).map((k) => `• ${k}`).join('\n')}` });
  },
};
