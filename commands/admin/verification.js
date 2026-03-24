const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const roleService = require('../../services/roleService');
const walletService = require('../../services/walletService');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verification')
    .setDescription('Manage verification system (Solmate-style UX)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    
    // Create verification panel
    .addSubcommand(subcommand =>
      subcommand
        .setName('create')
        .setDescription('Create a verification panel in this channel'))
    
    // Export user
    .addSubcommand(subcommand =>
      subcommand
        .setName('exportuser')
        .setDescription('Export verified user data')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to export')
            .setRequired(true)))
    
    // Remove user
    .addSubcommand(subcommand =>
      subcommand
        .setName('removeuser')
        .setDescription('Remove user verification (admin only)')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to remove')
            .setRequired(true))
        .addBooleanOption(option =>
          option.setName('confirm')
            .setDescription('Confirm deletion')
            .setRequired(true)))
    
    // Actions subcommand group
    .addSubcommandGroup(group =>
      group
        .setName('actions')
        .setDescription('Manage verification actions and mappings')
        
        // List actions
        .addSubcommand(subcommand =>
          subcommand
            .setName('list')
            .setDescription('List all verification actions'))
        
        // Add collection
        .addSubcommand(subcommand =>
          subcommand
            .setName('addcollection')
            .setDescription('Add collection-based verification action')
            .addStringOption(option =>
              option.setName('collection_id')
                .setDescription('Collection identifier')
                .setRequired(true))
            .addStringOption(option =>
              option.setName('name')
                .setDescription('Collection name')
                .setRequired(true))
            .addRoleOption(option =>
              option.setName('role')
                .setDescription('Discord role to assign')
                .setRequired(true))
            .addStringOption(option =>
              option.setName('update_authority')
                .setDescription('Update authority address (optional)')
                .setRequired(false))
            .addStringOption(option =>
              option.setName('creator')
                .setDescription('First verified creator address (optional)')
                .setRequired(false)))
        
        // Add token (trait/tier action)
        .addSubcommand(subcommand =>
          subcommand
            .setName('addtoken')
            .setDescription('Add token/trait-based verification action')
            .addStringOption(option =>
              option.setName('type')
                .setDescription('Action type')
                .setRequired(true)
                .addChoices(
                  { name: 'Trait Role', value: 'trait' },
                  { name: 'NFT Tier', value: 'tier' }
                ))
            .addStringOption(option =>
              option.setName('trait_type')
                .setDescription('Trait type (for trait actions)')
                .setRequired(false))
            .addStringOption(option =>
              option.setName('trait_value')
                .setDescription('Trait value (for trait actions)')
                .setRequired(false))
            .addStringOption(option =>
              option.setName('tier_name')
                .setDescription('Tier name (for tier actions)')
                .setRequired(false))
            .addIntegerOption(option =>
              option.setName('min_nfts')
                .setDescription('Minimum NFTs (for tier actions)')
                .setRequired(false))
            .addIntegerOption(option =>
              option.setName('max_nfts')
                .setDescription('Maximum NFTs (for tier actions)')
                .setRequired(false))
            .addIntegerOption(option =>
              option.setName('voting_power')
                .setDescription('Voting power (for tier actions)')
                .setRequired(false))
            .addRoleOption(option =>
              option.setName('role')
                .setDescription('Discord role to assign')
                .setRequired(true)))
        
        // Remove action
        .addSubcommand(subcommand =>
          subcommand
            .setName('remove')
            .setDescription('Remove a verification action')
            .addStringOption(option =>
              option.setName('type')
                .setDescription('Action type')
                .setRequired(true)
                .addChoices(
                  { name: 'Collection', value: 'collection' },
                  { name: 'Trait Role', value: 'trait' },
                  { name: 'NFT Tier', value: 'tier' }
                ))
            .addStringOption(option =>
              option.setName('identifier')
                .setDescription('Action identifier (collection ID, trait type:value, or tier name)')
                .setRequired(true)))),

  async execute(interaction) {
    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommandGroup === 'actions') {
        switch (subcommand) {
          case 'list':
            await this.handleActionsList(interaction);
            break;
          case 'addcollection':
            await this.handleAddCollection(interaction);
            break;
          case 'addtoken':
            await this.handleAddToken(interaction);
            break;
          case 'remove':
            await this.handleRemove(interaction);
            break;
        }
      } else {
        switch (subcommand) {
          case 'create':
            await this.handleCreate(interaction);
            break;
          case 'exportuser':
            await this.handleExportUser(interaction);
            break;
          case 'removeuser':
            await this.handleRemoveUser(interaction);
            break;
        }
      }
    } catch (error) {
      logger.error('Error executing verification command:', error);
      
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

  async handleCreate(interaction) {
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🔗 Verify your wallet!')
      .setDescription('To get access to roles, verify your wallet with Solpranos by clicking the button below.')
      .setThumbnail(interaction.client.user.displayAvatarURL({ size: 256 }))
      .setFooter({ text: 'Solpranos', iconURL: interaction.client.user.displayAvatarURL({ size: 32 }) });

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('panel_verify')
          .setLabel('Verify')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setLabel('Add Wallet')
          .setStyle(ButtonStyle.Link)
          .setURL(`${webUrl}/verify`),
        new ButtonBuilder()
          .setLabel('Get Help')
          .setStyle(ButtonStyle.Link)
          .setURL('https://the-solpranos.com/help')
      );

    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: '✅ Verification panel posted!', ephemeral: true });
    logger.log(`Verify panel posted in #${interaction.channel.name} by ${interaction.user.username}`);
  },

  async handleActionsList(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const config = roleService.getRoleConfigSummary();
    const collections = roleService.getCollectionsSummary();

    // Build collections field
    const collectionsConfigured = collections.filter(c => c.configured).length;
    const collectionsTotal = collections.length;
    const collectionsText = collections.map(c => {
      const status = c.configured ? '✅' : '❌';
      const roleInfo = c.roleId ? `<@&${c.roleId}>` : '_Not configured_';
      const enabledStatus = c.enabled ? '' : ' (disabled)';
      return `${status} **${c.name}** (${c.id}): ${roleInfo}${enabledStatus}`;
    }).join('\n') || '_No collections configured_';

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
      .setTitle('🔐 Verification Actions')
      .setDescription('Current verification actions and role mappings')
      .addFields(
        { 
          name: `📦 Collections (${collectionsConfigured}/${collectionsTotal} configured)`, 
          value: collectionsText, 
          inline: false 
        },
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
        text: 'Use /verification actions to manage • /role-config available for advanced control' 
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed verification actions`);
  },

  async handleAddCollection(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const collectionId = interaction.options.getString('collection_id');
    const name = interaction.options.getString('name');
    const role = interaction.options.getRole('role');
    const updateAuthority = interaction.options.getString('update_authority');
    const creator = interaction.options.getString('creator');

    // Validation
    if (!collectionId || collectionId.length < 3) {
      return interaction.editReply({ 
        content: '❌ Invalid collection ID. Must be at least 3 characters.', 
        ephemeral: true 
      });
    }

    const result = roleService.addCollection(collectionId, name, role.id, updateAuthority, creator);

    if (result.success) {
      await interaction.editReply({ 
        content: `✅ Collection **${name}** added successfully!\n\`\`\`json\n${JSON.stringify(result.collection, null, 2)}\n\`\`\``,
        ephemeral: true 
      });
      logger.log(`Admin ${interaction.user.tag} added collection: ${name} (${collectionId})`);
    } else {
      await interaction.editReply({ 
        content: `❌ ${result.message}`, 
        ephemeral: true 
      });
    }
  },

  async handleAddToken(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const type = interaction.options.getString('type');
    const role = interaction.options.getRole('role');

    if (type === 'trait') {
      const traitType = interaction.options.getString('trait_type');
      const traitValue = interaction.options.getString('trait_value');

      if (!traitType || !traitValue) {
        return interaction.editReply({ 
          content: '❌ For trait actions, both trait_type and trait_value are required.', 
          ephemeral: true 
        });
      }

      const result = roleService.addTrait(traitType, traitValue, role.id);

      if (result.success) {
        await interaction.editReply({ 
          content: `✅ Trait action added: **${traitType}: ${traitValue}** → <@&${role.id}>`,
          ephemeral: true 
        });
        logger.log(`Admin ${interaction.user.tag} added trait action: ${traitType}:${traitValue}`);
      } else {
        await interaction.editReply({ 
          content: `❌ ${result.message}`, 
          ephemeral: true 
        });
      }
    } else if (type === 'tier') {
      const tierName = interaction.options.getString('tier_name');
      const minNFTs = interaction.options.getInteger('min_nfts');
      const maxNFTs = interaction.options.getInteger('max_nfts');
      const votingPower = interaction.options.getInteger('voting_power');

      if (!tierName || minNFTs === null || maxNFTs === null || votingPower === null) {
        return interaction.editReply({ 
          content: '❌ For tier actions, tier_name, min_nfts, max_nfts, and voting_power are all required.', 
          ephemeral: true 
        });
      }

      if (minNFTs < 1 || maxNFTs < minNFTs) {
        return interaction.editReply({ 
          content: '❌ Invalid NFT range. Min must be ≥1 and Max must be ≥ Min.', 
          ephemeral: true 
        });
      }

      const result = roleService.addTier(tierName, minNFTs, maxNFTs, votingPower, role.id);

      if (result.success) {
        await interaction.editReply({ 
          content: `✅ Tier action **${tierName}** added successfully!\n\`\`\`json\n${JSON.stringify(result.tier, null, 2)}\n\`\`\``,
          ephemeral: true 
        });
        logger.log(`Admin ${interaction.user.tag} added tier action: ${tierName}`);
      } else {
        await interaction.editReply({ 
          content: `❌ ${result.message}`, 
          ephemeral: true 
        });
      }
    } else {
      await interaction.editReply({ 
        content: '❌ Invalid action type. Choose "trait" or "tier".', 
        ephemeral: true 
      });
    }
  },

  async handleRemove(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const type = interaction.options.getString('type');
    const identifier = interaction.options.getString('identifier');

    let result;

    if (type === 'collection') {
      result = roleService.deleteCollection(identifier);
      
      if (result.success) {
        await interaction.editReply({ 
          content: `✅ Collection **${identifier}** removed successfully!`,
          ephemeral: true 
        });
        logger.log(`Admin ${interaction.user.tag} removed collection: ${identifier}`);
      } else {
        await interaction.editReply({ 
          content: `❌ ${result.message}`, 
          ephemeral: true 
        });
      }
    } else if (type === 'trait') {
      // Parse trait_type:trait_value
      const parts = identifier.split(':');
      if (parts.length !== 2) {
        return interaction.editReply({ 
          content: '❌ Invalid trait identifier format. Use: trait_type:trait_value', 
          ephemeral: true 
        });
      }

      const [traitType, traitValue] = parts;
      result = roleService.deleteTrait(traitType, traitValue);

      if (result.success) {
        await interaction.editReply({ 
          content: `✅ Trait action **${identifier}** removed successfully!`,
          ephemeral: true 
        });
        logger.log(`Admin ${interaction.user.tag} removed trait action: ${identifier}`);
      } else {
        await interaction.editReply({ 
          content: `❌ ${result.message}`, 
          ephemeral: true 
        });
      }
    } else if (type === 'tier') {
      result = roleService.deleteTier(identifier);

      if (result.success) {
        await interaction.editReply({ 
          content: `✅ Tier action **${identifier}** removed successfully!`,
          ephemeral: true 
        });
        logger.log(`Admin ${interaction.user.tag} removed tier action: ${identifier}`);
      } else {
        await interaction.editReply({ 
          content: `❌ ${result.message}`, 
          ephemeral: true 
        });
      }
    } else {
      await interaction.editReply({ 
        content: '❌ Invalid action type.', 
        ephemeral: true 
      });
    }
  },

  async handleExportUser(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    
    try {
      const userInfo = await roleService.getUserInfo(targetUser.id);
      
      if (!userInfo) {
        return interaction.editReply({ 
          content: `❌ User <@${targetUser.id}> is not verified or has no data.`,
          ephemeral: true 
        });
      }

      const wallets = walletService.getAllUserWallets(targetUser.id);

      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`📋 User Export: ${targetUser.username}`)
        .setDescription(`Discord: <@${targetUser.id}>`)
        .addFields(
          { name: 'Total NFTs', value: `${userInfo.total_nfts}`, inline: true },
          { name: 'Tier', value: `${userInfo.tier || 'None'}`, inline: true },
          { name: 'Voting Power', value: `${userInfo.voting_power}`, inline: true },
          { 
            name: 'Linked Wallets', 
            value: wallets.length > 0 
              ? wallets.map(w => `\`${w.wallet_address.slice(0, 8)}...${w.wallet_address.slice(-8)}\`${w.primary_wallet ? ' (primary)' : ''}`).join('\n')
              : '_No wallets linked_', 
            inline: false 
          }
        )
        .setFooter({ text: `Created: ${new Date(userInfo.created_at).toLocaleString()}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      logger.log(`Admin ${interaction.user.tag} exported user data for ${targetUser.tag}`);
    } catch (error) {
      logger.error('Error exporting user:', error);
      await interaction.editReply({ 
        content: '❌ An error occurred while exporting user data.',
        ephemeral: true 
      });
    }
  },

  async handleRemoveUser(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const confirm = interaction.options.getBoolean('confirm');

    if (!confirm) {
      return interaction.editReply({ 
        content: '❌ You must set confirm=true to remove a user.',
        ephemeral: true 
      });
    }

    try {
      const userInfo = await roleService.getUserInfo(targetUser.id);
      
      if (!userInfo) {
        return interaction.editReply({ 
          content: `❌ User <@${targetUser.id}> is not in the database.`,
          ephemeral: true 
        });
      }

      // Delete wallets first
      walletService.removeAllWallets(targetUser.id);

      // Remove from Discord roles
      if (interaction.guild) {
        await roleService.removeAllTierRoles(interaction.guild, targetUser.id);
      }

      // Delete user record
      const db = require('../../database/db');
      db.prepare('DELETE FROM users WHERE discord_id = ?').run(targetUser.id);

      await interaction.editReply({ 
        content: `✅ User <@${targetUser.id}> has been completely removed from the verification system.`,
        ephemeral: true 
      });
      logger.log(`Admin ${interaction.user.tag} removed user ${targetUser.tag} from verification system`);
    } catch (error) {
      logger.error('Error removing user:', error);
      await interaction.editReply({ 
        content: '❌ An error occurred while removing user.',
        ephemeral: true 
      });
    }
  }
};
