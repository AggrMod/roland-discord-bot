const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const roleService = require('../../services/roleService');
const logger = require('../../utils/logger');
const fs = require('fs');
const path = require('path');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('role-config')
    .setDescription('Manage role configuration and mappings (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    
    // List
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('View current role configuration'))
    
    // Add Tier
    .addSubcommand(subcommand =>
      subcommand
        .setName('add-tier')
        .setDescription('Add a new tier')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Tier name')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('min_nfts')
            .setDescription('Minimum NFTs')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('max_nfts')
            .setDescription('Maximum NFTs')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('voting_power')
            .setDescription('Voting power')
            .setRequired(true))
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('Discord role to assign')
            .setRequired(false)))
    
    // Edit Tier
    .addSubcommand(subcommand =>
      subcommand
        .setName('edit-tier')
        .setDescription('Edit an existing tier')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Tier name to edit')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('min_nfts')
            .setDescription('Minimum NFTs')
            .setRequired(false))
        .addIntegerOption(option =>
          option.setName('max_nfts')
            .setDescription('Maximum NFTs')
            .setRequired(false))
        .addIntegerOption(option =>
          option.setName('voting_power')
            .setDescription('Voting power')
            .setRequired(false))
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('Discord role to assign')
            .setRequired(false)))
    
    // Delete Tier
    .addSubcommand(subcommand =>
      subcommand
        .setName('delete-tier')
        .setDescription('Delete a tier')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Tier name to delete')
            .setRequired(true)))
    
    // Add Trait
    .addSubcommand(subcommand =>
      subcommand
        .setName('add-trait')
        .setDescription('Add a trait-role mapping')
        .addStringOption(option =>
          option.setName('trait_type')
            .setDescription('Trait type (e.g., Role)')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('trait_value')
            .setDescription('Trait value (e.g., The Hitman)')
            .setRequired(true))
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('Discord role to assign')
            .setRequired(true)))
    
    // Edit Trait
    .addSubcommand(subcommand =>
      subcommand
        .setName('edit-trait')
        .setDescription('Edit a trait-role mapping')
        .addStringOption(option =>
          option.setName('trait_type')
            .setDescription('Trait type')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('trait_value')
            .setDescription('Trait value')
            .setRequired(true))
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('New Discord role to assign')
            .setRequired(true)))
    
    // Delete Trait
    .addSubcommand(subcommand =>
      subcommand
        .setName('delete-trait')
        .setDescription('Delete a trait-role mapping')
        .addStringOption(option =>
          option.setName('trait_type')
            .setDescription('Trait type')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('trait_value')
            .setDescription('Trait value')
            .setRequired(true)))
    
    // Sync
    .addSubcommand(subcommand =>
      subcommand
        .setName('sync')
        .setDescription('Manually trigger role sync')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to sync (leave empty for all users)')
            .setRequired(false))),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    try {
      switch (subcommand) {
        case 'list':
          await this.handleList(interaction);
          break;
        case 'add-tier':
          await this.handleAddTier(interaction);
          break;
        case 'edit-tier':
          await this.handleEditTier(interaction);
          break;
        case 'delete-tier':
          await this.handleDeleteTier(interaction);
          break;
        case 'add-trait':
          await this.handleAddTrait(interaction);
          break;
        case 'edit-trait':
          await this.handleEditTrait(interaction);
          break;
        case 'delete-trait':
          await this.handleDeleteTrait(interaction);
          break;
        case 'sync':
          await this.handleSync(interaction);
          break;
      }
    } catch (error) {
      logger.error('Error executing role-config command:', error);
      
      const reply = { 
        content: `❌ An error occurred: ${error.message}`, 
        ephemeral: true 
      };
      
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply);
      } else {
        await interaction.reply(reply);
      }
    }
  },

  async handleList(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const config = roleService.getRoleConfigSummary();

    // Build tier roles field
    const tiersConfigured = config.tiers.filter(t => t.configured).length;
    const tiersTotal = config.tiers.length;
    const tiersText = config.tiers.map(t => {
      const status = t.configured ? '✅' : '❌';
      const roleInfo = t.roleId ? `<@&${t.roleId}>` : '_Not configured_';
      return `${status} **${t.name}** (${t.minNFTs}-${t.maxNFTs} NFTs, VP:${t.votingPower}): ${roleInfo}`;
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
        text: 'Use /role-config add-tier, add-trait, edit-*, delete-* to manage roles' 
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed role configuration`);
  },

  async handleAddTier(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const name = interaction.options.getString('name');
    const minNFTs = interaction.options.getInteger('min_nfts');
    const maxNFTs = interaction.options.getInteger('max_nfts');
    const votingPower = interaction.options.getInteger('voting_power');
    const role = interaction.options.getRole('role');

    // Validation
    if (minNFTs < 1 || maxNFTs < minNFTs) {
      return interaction.editReply({ 
        content: '❌ Invalid NFT range. Min must be ≥1 and Max must be ≥ Min.', 
        ephemeral: true 
      });
    }

    const result = roleService.addTier(name, minNFTs, maxNFTs, votingPower, role ? role.id : null);

    if (result.success) {
      await interaction.editReply({ 
        content: `✅ Tier **${name}** added successfully!\n\`\`\`json\n${JSON.stringify(result.tier, null, 2)}\n\`\`\``,
        ephemeral: true 
      });
      logger.log(`Admin ${interaction.user.tag} added tier: ${name}`);
    } else {
      await interaction.editReply({ 
        content: `❌ ${result.message}`, 
        ephemeral: true 
      });
    }
  },

  async handleEditTier(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const name = interaction.options.getString('name');
    const minNFTs = interaction.options.getInteger('min_nfts');
    const maxNFTs = interaction.options.getInteger('max_nfts');
    const votingPower = interaction.options.getInteger('voting_power');
    const role = interaction.options.getRole('role');

    const updates = {};
    if (minNFTs !== null) updates.minNFTs = minNFTs;
    if (maxNFTs !== null) updates.maxNFTs = maxNFTs;
    if (votingPower !== null) updates.votingPower = votingPower;
    if (role !== null) updates.roleId = role.id;

    if (Object.keys(updates).length === 0) {
      return interaction.editReply({ 
        content: '❌ No updates provided. Specify at least one field to update.', 
        ephemeral: true 
      });
    }

    const result = roleService.editTier(name, updates);

    if (result.success) {
      await interaction.editReply({ 
        content: `✅ Tier **${name}** updated successfully!\n\`\`\`json\n${JSON.stringify(result.tier, null, 2)}\n\`\`\``,
        ephemeral: true 
      });
      logger.log(`Admin ${interaction.user.tag} edited tier: ${name}`);
    } else {
      await interaction.editReply({ 
        content: `❌ ${result.message}`, 
        ephemeral: true 
      });
    }
  },

  async handleDeleteTier(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const name = interaction.options.getString('name');
    const result = roleService.deleteTier(name);

    if (result.success) {
      await interaction.editReply({ 
        content: `✅ Tier **${name}** deleted successfully!`,
        ephemeral: true 
      });
      logger.log(`Admin ${interaction.user.tag} deleted tier: ${name}`);
    } else {
      await interaction.editReply({ 
        content: `❌ ${result.message}`, 
        ephemeral: true 
      });
    }
  },

  async handleAddTrait(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const traitType = interaction.options.getString('trait_type');
    const traitValue = interaction.options.getString('trait_value');
    const role = interaction.options.getRole('role');

    const result = roleService.addTrait(traitType, traitValue, role.id);

    if (result.success) {
      await interaction.editReply({ 
        content: `✅ Trait mapping added: **${traitType}: ${traitValue}** → <@&${role.id}>`,
        ephemeral: true 
      });
      logger.log(`Admin ${interaction.user.tag} added trait: ${traitType}:${traitValue}`);
    } else {
      await interaction.editReply({ 
        content: `❌ ${result.message}`, 
        ephemeral: true 
      });
    }
  },

  async handleEditTrait(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const traitType = interaction.options.getString('trait_type');
    const traitValue = interaction.options.getString('trait_value');
    const role = interaction.options.getRole('role');

    const result = roleService.editTrait(traitType, traitValue, role.id);

    if (result.success) {
      await interaction.editReply({ 
        content: `✅ Trait mapping updated: **${traitType}: ${traitValue}** → <@&${role.id}>`,
        ephemeral: true 
      });
      logger.log(`Admin ${interaction.user.tag} edited trait: ${traitType}:${traitValue}`);
    } else {
      await interaction.editReply({ 
        content: `❌ ${result.message}`, 
        ephemeral: true 
      });
    }
  },

  async handleDeleteTrait(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const traitType = interaction.options.getString('trait_type');
    const traitValue = interaction.options.getString('trait_value');

    const result = roleService.deleteTrait(traitType, traitValue);

    if (result.success) {
      await interaction.editReply({ 
        content: `✅ Trait mapping deleted: **${traitType}: ${traitValue}**`,
        ephemeral: true 
      });
      logger.log(`Admin ${interaction.user.tag} deleted trait: ${traitType}:${traitValue}`);
    } else {
      await interaction.editReply({ 
        content: `❌ ${result.message}`, 
        ephemeral: true 
      });
    }
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

    // If specific user, sync that user
    if (targetUser) {
      return this.syncSingleUser(interaction, targetUser, guild);
    }

    // Sync all users
    try {
      const allUsers = roleService.getAllVerifiedUsers();
      let syncedCount = 0;
      let errorCount = 0;

      await interaction.editReply({ 
        content: `🔄 Starting role sync for ${allUsers.length} verified users...`,
        ephemeral: true 
      });

      for (const user of allUsers) {
        try {
          await roleService.updateUserRoles(user.discord_id, user.username);
          const syncResult = await roleService.syncUserDiscordRoles(guild, user.discord_id);
          
          if (syncResult.success) {
            syncedCount++;
          } else {
            errorCount++;
          }
        } catch (error) {
          logger.error(`Error syncing user ${user.discord_id}:`, error);
          errorCount++;
        }
      }

      await interaction.editReply({ 
        content: `✅ Bulk sync complete!\n✅ Synced: ${syncedCount}\n❌ Errors: ${errorCount}`,
        ephemeral: true 
      });
      logger.log(`Admin ${interaction.user.tag} ran bulk role sync: ${syncedCount} synced, ${errorCount} errors`);
    } catch (error) {
      logger.error('Error in bulk sync:', error);
      await interaction.editReply({ 
        content: '❌ An error occurred during bulk sync.',
        ephemeral: true 
      });
    }
  },

  async syncSingleUser(interaction, targetUser, guild) {
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
