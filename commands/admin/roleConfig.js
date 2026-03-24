const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const roleService = require('../../services/roleService');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('role-config')
    .setDescription('View role configuration and mappings (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(subcommand =>
      subcommand
        .setName('view')
        .setDescription('View current role configuration'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('sync')
        .setDescription('Manually trigger role sync for a user')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to sync roles for')
            .setRequired(true))),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommand === 'view') {
        await this.handleView(interaction);
      } else if (subcommand === 'sync') {
        await this.handleSync(interaction);
      }
    } catch (error) {
      logger.error('Error executing role-config command:', error);
      await interaction.reply({ 
        content: 'An error occurred while processing role configuration.', 
        ephemeral: true 
      });
    }
  },

  async handleView(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const config = roleService.getRoleConfigSummary();

    // Build tier roles field
    const tiersConfigured = config.tiers.filter(t => t.configured).length;
    const tiersTotal = config.tiers.length;
    const tiersText = config.tiers.map(t => {
      const status = t.configured ? '✅' : '❌';
      const roleInfo = t.roleId ? `<@&${t.roleId}>` : '_Not configured_';
      return `${status} **${t.name}** (${t.minNFTs}-${t.maxNFTs} NFTs): ${roleInfo}`;
    }).join('\n');

    // Build trait roles field
    const traitsConfigured = config.traitRoles.filter(t => t.configured).length;
    const traitsTotal = config.traitRoles.length;
    const traitsText = config.traitRoles.map(t => {
      const status = t.configured ? '✅' : '❌';
      const roleInfo = t.roleId ? `<@&${t.roleId}>` : '_Not configured_';
      return `${status} **${t.trait}**: ${roleInfo}`;
    }).join('\n') || '_No trait roles configured_';

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🎭 Role Configuration')
      .setDescription('Current Discord role mappings for tiers and traits')
      .addFields(
        { 
          name: `📊 Tier Roles (${tiersConfigured}/${tiersTotal} configured)`, 
          value: tiersText, 
          inline: false 
        },
        { 
          name: `🎨 Trait Roles (${traitsConfigured}/${traitsTotal} configured)`, 
          value: traitsText, 
          inline: false 
        }
      )
      .setFooter({ 
        text: 'Configure role IDs in config/roles.json and config/trait-roles.json' 
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed role configuration`);
  },

  async handleSync(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const guild = interaction.guild;

    if (!guild) {
      return interaction.editReply({ 
        content: '❌ This command must be used in a server!', 
        ephemeral: true 
      });
    }

    try {
      // Update user data first
      const userInfo = await roleService.getUserInfo(targetUser.id);
      
      if (!userInfo) {
        return interaction.editReply({ 
          content: `❌ User <@${targetUser.id}> is not verified or has no linked wallets.`,
          ephemeral: true 
        });
      }

      // Re-compute holdings
      await roleService.updateUserRoles(targetUser.id, targetUser.username);

      // Sync Discord roles
      const syncResult = await roleService.syncUserDiscordRoles(guild, targetUser.id);

      if (syncResult.success) {
        const changesText = [];
        
        if (syncResult.changes.added.length > 0) {
          changesText.push(`**Added:** ${syncResult.changes.added.join(', ')}`);
        }
        
        if (syncResult.changes.removed.length > 0) {
          changesText.push(`**Removed:** ${syncResult.changes.removed.join(', ')}`);
        }

        if (changesText.length === 0) {
          changesText.push('_No changes needed - roles already synced_');
        }

        const embed = new EmbedBuilder()
          .setColor('#00FF00')
          .setTitle('✅ Role Sync Complete')
          .setDescription(`Synced roles for <@${targetUser.id}>`)
          .addFields({
            name: 'Changes',
            value: changesText.join('\n'),
            inline: false
          })
          .setFooter({ 
            text: `Total: +${syncResult.totalAdded} -${syncResult.totalRemoved}` 
          })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        logger.log(`Admin ${interaction.user.tag} manually synced roles for ${targetUser.tag}`);
      } else {
        await interaction.editReply({ 
          content: `❌ Failed to sync roles: ${syncResult.message}`,
          ephemeral: true 
        });
      }
    } catch (error) {
      logger.error('Error syncing user roles:', error);
      await interaction.editReply({ 
        content: '❌ An error occurred while syncing roles.',
        ephemeral: true 
      });
    }
  }
};
