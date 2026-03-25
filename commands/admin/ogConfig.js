const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const ogRoleService = require('../../services/ogRoleService');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('og-config')
    .setDescription('Configure the OG role system')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(subcommand =>
      subcommand
        .setName('view')
        .setDescription('View current OG role configuration'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('enable')
        .setDescription('Enable or disable OG role system')
        .addBooleanOption(option =>
          option
            .setName('enabled')
            .setDescription('Enable OG role system')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('role')
        .setDescription('Set the OG role')
        .addRoleOption(option =>
          option
            .setName('role')
            .setDescription('The role to assign to OG members')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('limit')
        .setDescription('Set the number of OG slots')
        .addIntegerOption(option =>
          option
            .setName('count')
            .setDescription('Number of OG slots (first X verified users)')
            .setRequired(true)
            .setMinValue(1)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('sync')
        .setDescription('Sync OG role to eligible users')
        .addBooleanOption(option =>
          option
            .setName('full')
            .setDescription('Full sync (also removes from ineligible users)')
            .setRequired(false))),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommand === 'view') {
        await handleView(interaction);
      } else if (subcommand === 'enable') {
        await handleEnable(interaction);
      } else if (subcommand === 'role') {
        await handleSetRole(interaction);
      } else if (subcommand === 'limit') {
        await handleSetLimit(interaction);
      } else if (subcommand === 'sync') {
        await handleSync(interaction);
      }
    } catch (error) {
      logger.error('Error in og-config command:', error);
      await interaction.editReply({ 
        content: 'An error occurred while processing your request.' 
      });
    }
  },
};

async function handleView(interaction) {
  const status = await ogRoleService.getStatus(interaction.guild);

  const embed = new EmbedBuilder()
    .setColor(status.enabled ? '#57F287' : '#ED4245')
    .setTitle('⭐ OG Role Configuration')
    .setDescription(status.enabled ? 'OG role system is **ENABLED**' : 'OG role system is **DISABLED**')
    .addFields(
      { name: '🎭 Role', value: status.roleName, inline: true },
      { name: '🔢 Limit', value: status.limit.toString(), inline: true },
      { name: '✅ Eligible', value: status.eligibleCount.toString(), inline: true },
      { name: '👥 Current Holders', value: status.currentHoldersCount.toString(), inline: true }
    )
    .setTimestamp();

  if (status.eligible.length > 0) {
    const eligibleList = status.eligible.map((u, idx) => 
      `${idx + 1}. ${u.username} - Verified: ${new Date(u.verifiedAt).toLocaleDateString()}`
    ).join('\n');

    embed.addFields({
      name: '📋 First 10 Eligible Users',
      value: eligibleList || 'None',
      inline: false
    });
  }

  embed.setFooter({ text: 'Use /og-config sync to apply changes to Discord roles' });

  await interaction.editReply({ embeds: [embed] });
  logger.log(`Admin ${interaction.user.tag} viewed OG config`);
}

async function handleEnable(interaction) {
  const enabled = interaction.options.getBoolean('enabled');
  const result = ogRoleService.setEnabled(enabled);

  const embed = new EmbedBuilder()
    .setColor(result.success ? '#57F287' : '#ED4245')
    .setTitle(result.success ? '✅ Success' : '❌ Error')
    .setDescription(result.message)
    .setTimestamp();

  if (result.success && enabled) {
    embed.setFooter({ text: 'Don\'t forget to run /og-config sync to apply the role!' });
  }

  await interaction.editReply({ embeds: [embed] });
  logger.log(`Admin ${interaction.user.tag} ${enabled ? 'enabled' : 'disabled'} OG role`);
}

async function handleSetRole(interaction) {
  const role = interaction.options.getRole('role');
  const result = ogRoleService.setRole(role.id);

  const embed = new EmbedBuilder()
    .setColor(result.success ? '#57F287' : '#ED4245')
    .setTitle(result.success ? '✅ Success' : '❌ Error')
    .setDescription(result.success ? `OG role set to: ${role.name}` : result.message)
    .setTimestamp();

  if (result.success) {
    embed.setFooter({ text: 'Run /og-config sync to apply this role to eligible users' });
  }

  await interaction.editReply({ embeds: [embed] });
  logger.log(`Admin ${interaction.user.tag} set OG role to ${role.name}`);
}

async function handleSetLimit(interaction) {
  const count = interaction.options.getInteger('count');
  const result = ogRoleService.setLimit(count);

  const embed = new EmbedBuilder()
    .setColor(result.success ? '#57F287' : '#ED4245')
    .setTitle(result.success ? '✅ Success' : '❌ Error')
    .setDescription(result.message)
    .setTimestamp();

  if (result.success) {
    embed.setFooter({ text: 'Run /og-config sync to apply the new limit' });
  }

  await interaction.editReply({ embeds: [embed] });
  logger.log(`Admin ${interaction.user.tag} set OG limit to ${count}`);
}

async function handleSync(interaction) {
  const fullSync = interaction.options.getBoolean('full') || false;

  await interaction.editReply({ 
    content: `🔄 Syncing OG roles${fullSync ? ' (full sync - will remove ineligible holders)' : ''}...` 
  });

  const result = await ogRoleService.syncRoles(interaction.guild, fullSync);

  const embed = new EmbedBuilder()
    .setColor(result.success ? '#57F287' : '#ED4245')
    .setTitle(result.success ? '✅ Sync Complete' : '❌ Sync Failed')
    .setDescription(result.message)
    .setTimestamp();

  if (result.success) {
    embed.addFields(
      { name: '➕ Added', value: result.added.toString(), inline: true },
      { name: '➖ Removed', value: result.removed.toString(), inline: true },
      { name: '❌ Errors', value: result.errors.toString(), inline: true },
      { name: '✅ Total Eligible', value: result.eligible.toString(), inline: true }
    );
  }

  await interaction.editReply({ content: null, embeds: [embed] });
  logger.log(`Admin ${interaction.user.tag} ran OG sync: +${result.added} -${result.removed} errors:${result.errors}`);
}
