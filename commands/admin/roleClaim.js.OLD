const { 
  SlashCommandBuilder, 
  PermissionFlagsBits, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle 
} = require('discord.js');
const roleClaimService = require('../../services/roleClaimService');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('role-claim')
    .setDescription('Manage self-serve role claim panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(subcommand =>
      subcommand
        .setName('panel')
        .setDescription('Post the role claim panel with buttons'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('Add a role to the claimable list')
        .addRoleOption(option =>
          option
            .setName('role')
            .setDescription('The role to make claimable')
            .setRequired(true))
        .addStringOption(option =>
          option
            .setName('label')
            .setDescription('Custom label for the button')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('remove')
        .setDescription('Remove a role from the claimable list')
        .addRoleOption(option =>
          option
            .setName('role')
            .setDescription('The role to remove')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('List all claimable roles')),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommand === 'panel') {
        await handlePanel(interaction);
      } else if (subcommand === 'add') {
        await handleAdd(interaction);
      } else if (subcommand === 'remove') {
        await handleRemove(interaction);
      } else if (subcommand === 'list') {
        await handleList(interaction);
      }
    } catch (error) {
      logger.error('Error in role-claim command:', error);
      await interaction.editReply({ 
        content: 'An error occurred while processing your request.' 
      });
    }
  },
};

async function handlePanel(interaction) {
  const claimableRoles = roleClaimService.getClaimableRoles();

  if (claimableRoles.length === 0) {
    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('❌ No Claimable Roles')
      .setDescription('Add roles using `/role-claim add` first!')
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // Validate all roles before posting
  const validRoles = [];
  for (const claimableRole of claimableRoles) {
    const validation = await roleClaimService.validateRole(interaction.guild, claimableRole.roleId);
    if (validation.valid) {
      validRoles.push(claimableRole);
    } else {
      logger.warn(`Skipping invalid role ${claimableRole.roleId}: ${validation.message}`);
    }
  }

  if (validRoles.length === 0) {
    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('❌ No Valid Roles')
      .setDescription('All configured roles are invalid or unmanageable. Check role hierarchy and bot permissions.')
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // Build panel embed
  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🎭 Self-Serve Roles')
    .setDescription(
      'Click a button below to claim or unclaim a role!\n\n' +
      'These roles are optional and help you customize your server experience.'
    )
    .setFooter({ text: 'Click a button to toggle membership' })
    .setTimestamp();

  // Add role list to embed
  const roleList = validRoles.map(r => {
    const role = interaction.guild.roles.cache.get(r.roleId);
    return `• ${role ? role.name : r.label}`;
  }).join('\n');

  embed.addFields({ name: 'Available Roles', value: roleList });

  // Build buttons (max 5 per row, max 5 rows = 25 buttons)
  const rows = [];
  let currentRow = new ActionRowBuilder();
  
  for (let i = 0; i < validRoles.length && i < 25; i++) {
    const claimableRole = validRoles[i];
    const role = interaction.guild.roles.cache.get(claimableRole.roleId);
    
    if (role) {
      const button = new ButtonBuilder()
        .setCustomId(`role_claim_${role.id}`)
        .setLabel(claimableRole.label || role.name)
        .setStyle(ButtonStyle.Secondary);

      currentRow.addComponents(button);

      // Max 5 buttons per row
      if ((i + 1) % 5 === 0) {
        rows.push(currentRow);
        currentRow = new ActionRowBuilder();
      }
    }
  }

  // Add remaining buttons
  if (currentRow.components.length > 0) {
    rows.push(currentRow);
  }

  // Post panel to channel
  const channel = interaction.channel;
  await channel.send({ embeds: [embed], components: rows });

  // Confirm to admin
  const confirmEmbed = new EmbedBuilder()
    .setColor('#57F287')
    .setTitle('✅ Panel Posted')
    .setDescription(`Role claim panel posted with ${validRoles.length} role(s)`)
    .setTimestamp();

  await interaction.editReply({ embeds: [confirmEmbed] });
  logger.log(`Admin ${interaction.user.tag} posted role claim panel in ${channel.name}`);
}

async function handleAdd(interaction) {
  const role = interaction.options.getRole('role');
  const label = interaction.options.getString('label') || role.name;

  // Validate role first
  const validation = await roleClaimService.validateRole(interaction.guild, role.id);

  if (!validation.valid) {
    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('❌ Invalid Role')
      .setDescription(validation.message)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const result = roleClaimService.addRole(role.id, label);

  const embed = new EmbedBuilder()
    .setColor(result.success ? '#57F287' : '#ED4245')
    .setTitle(result.success ? '✅ Role Added' : '❌ Error')
    .setDescription(result.message)
    .setTimestamp();

  if (result.success) {
    embed.addFields(
      { name: 'Role', value: role.name, inline: true },
      { name: 'Label', value: label, inline: true }
    );
    embed.setFooter({ text: 'Use /role-claim panel to post the updated panel' });
  }

  await interaction.editReply({ embeds: [embed] });
  logger.log(`Admin ${interaction.user.tag} added claimable role: ${role.name}`);
}

async function handleRemove(interaction) {
  const role = interaction.options.getRole('role');
  const result = roleClaimService.removeRole(role.id);

  const embed = new EmbedBuilder()
    .setColor(result.success ? '#57F287' : '#ED4245')
    .setTitle(result.success ? '✅ Role Removed' : '❌ Error')
    .setDescription(result.message)
    .setTimestamp();

  if (result.success) {
    embed.setFooter({ text: 'Existing panels will still show this role until you post a new panel' });
  }

  await interaction.editReply({ embeds: [embed] });
  logger.log(`Admin ${interaction.user.tag} removed claimable role: ${role.name}`);
}

async function handleList(interaction) {
  const status = await roleClaimService.getRoleStatus(interaction.guild);

  if (status.roles.length === 0) {
    const embed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('📋 Claimable Roles')
      .setDescription('No claimable roles configured.\n\nUse `/role-claim add` to add roles!')
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('📋 Claimable Roles Configuration')
    .setDescription(`**Total:** ${status.totalRoles} | **Enabled:** ${status.enabledRoles}`)
    .setTimestamp();

  // Group by status
  const validRoles = [];
  const invalidRoles = [];

  for (const role of status.roles) {
    const statusIcon = role.enabled ? '✅' : '⛔';
    const manageable = role.manageable ? '✅' : '❌';
    const roleText = `${statusIcon} **${role.roleName}** (${role.memberCount} members) - Manageable: ${manageable}`;
    
    if (role.manageable && role.enabled) {
      validRoles.push(roleText);
    } else {
      invalidRoles.push(`${roleText}\n   └ ${role.validationMessage}`);
    }
  }

  if (validRoles.length > 0) {
    embed.addFields({
      name: '✅ Valid & Enabled Roles',
      value: validRoles.join('\n') || 'None',
      inline: false
    });
  }

  if (invalidRoles.length > 0) {
    embed.addFields({
      name: '⚠️ Issues',
      value: invalidRoles.join('\n\n') || 'None',
      inline: false
    });
  }

  embed.setFooter({ text: 'Use /role-claim panel to post the panel' });

  await interaction.editReply({ embeds: [embed] });
  logger.log(`Admin ${interaction.user.tag} viewed claimable roles list`);
}
