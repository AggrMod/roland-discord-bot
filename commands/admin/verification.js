const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const roleService = require('../../services/roleService');
const walletService = require('../../services/walletService');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verification')
    .setDescription('Manage the Family verification system')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    
    // Create verification panel
    .addSubcommand(subcommand =>
      subcommand
        .setName('create')
        .setDescription('Post a verification panel to this channel')
        .addStringOption(option =>
          option.setName('title')
            .setDescription('Panel title (default: "🔗 Verify your wallet!")')
            .setRequired(false))
        .addStringOption(option =>
          option.setName('description')
            .setDescription('Panel description')
            .setRequired(false))
        .addStringOption(option =>
          option.setName('color')
            .setDescription('Embed color (hex code, e.g., #FFD700)')
            .setRequired(false))
        .addStringOption(option =>
          option.setName('footer_text')
            .setDescription('Footer text (default: "Solpranos")')
            .setRequired(false))
        .addStringOption(option =>
          option.setName('thumbnail')
            .setDescription('Thumbnail URL (default: bot avatar)')
            .setRequired(false))
        .addStringOption(option =>
          option.setName('image')
            .setDescription('Large image URL (optional)')
            .setRequired(false)))
    
    // Export user
    .addSubcommand(subcommand =>
      subcommand
        .setName('exportuser')
        .setDescription('Export a made member\'s verification data')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('The member to export')
            .setRequired(true)))
    
    // Remove user
    .addSubcommand(subcommand =>
      subcommand
        .setName('removeuser')
        .setDescription('Remove a member from the Family (cannot be undone)')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('The member to remove')
            .setRequired(true))
        .addBooleanOption(option =>
          option.setName('confirm')
            .setDescription('Confirm removal (must be true)')
            .setRequired(true)))
    
    // Actions subcommand group
    .addSubcommandGroup(group =>
      group
        .setName('actions')
        .setDescription('Manage verification actions for the Family')
        
        // List actions
        .addSubcommand(subcommand =>
          subcommand
            .setName('list')
            .setDescription('Show all verification actions and role assignments'))
        
        // Add collection
        .addSubcommand(subcommand =>
          subcommand
            .setName('addcollection')
            .setDescription('Assign a role for holding an NFT collection')
            .addRoleOption(option =>
              option.setName('role')
                .setDescription('Discord role to assign')
                .setRequired(true))
            .addStringOption(option =>
              option.setName('collection')
                .setDescription('Collection symbol or name (e.g., "solpranos-main")')
                .setRequired(true))
            .addIntegerOption(option =>
              option.setName('amount')
                .setDescription('Number of NFTs required (default: 1)')
                .setRequired(false)
                .setMinValue(1))
            .addStringOption(option =>
              option.setName('traitname')
                .setDescription('Trait name filter (optional, e.g., "Role")')
                .setRequired(false))
            .addStringOption(option =>
              option.setName('traitvalue')
                .setDescription('Trait value filter (optional, e.g., "The Hitman")')
                .setRequired(false)))
        
        // Add token (SPL token holdings)
        .addSubcommand(subcommand =>
          subcommand
            .setName('addtoken')
            .setDescription('Assign a role for holding SPL tokens')
            .addRoleOption(option =>
              option.setName('role')
                .setDescription('Discord role to assign')
                .setRequired(true))
            .addStringOption(option =>
              option.setName('token')
                .setDescription('Token name or mint address')
                .setRequired(true))
            .addNumberOption(option =>
              option.setName('amount')
                .setDescription('Token amount required (default: 1)')
                .setRequired(false)
                .setMinValue(0.000001)))
        
        // Remove action
        .addSubcommand(subcommand =>
          subcommand
            .setName('remove')
            .setDescription('Remove a verification action')
            .addRoleOption(option =>
              option.setName('role')
                .setDescription('The role to stop assigning')
                .setRequired(true))
            .addStringOption(option =>
              option.setName('type')
                .setDescription('Action type to remove')
                .setRequired(true)
                .addChoices(
                  { name: 'Collection', value: 'collection' },
                  { name: 'Token', value: 'token' },
                  { name: 'Trait', value: 'trait' }
                ))
            .addStringOption(option =>
              option.setName('identifier')
                .setDescription('Collection/token/trait identifier (optional if only one exists for this role)')
                .setRequired(false)))),

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
        content: `❌ Something went wrong: ${error.message}`, 
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

    // Custom panel options
    const title = interaction.options.getString('title') || '🔗 Verify your wallet!';
    const description = interaction.options.getString('description') || 'To get access to Family roles, verify your wallet with Solpranos by clicking the button below.';
    const colorHex = interaction.options.getString('color') || '#FFD700';
    const footerText = interaction.options.getString('footer_text') || 'Solpranos';
    const thumbnail = interaction.options.getString('thumbnail') || interaction.client.user.displayAvatarURL({ size: 256 });
    const image = interaction.options.getString('image');

    // Validate color
    const colorValue = colorHex.startsWith('#') ? colorHex : `#${colorHex}`;
    if (!/^#[0-9A-F]{6}$/i.test(colorValue)) {
      return interaction.reply({
        content: '❌ Invalid color format. Use hex code (e.g., #FFD700)',
        ephemeral: true
      });
    }

    const embed = new EmbedBuilder()
      .setColor(colorValue)
      .setTitle(title)
      .setDescription(description)
      .setThumbnail(thumbnail)
      .setFooter({ text: footerText, iconURL: interaction.client.user.displayAvatarURL({ size: 32 }) });

    if (image) {
      embed.setImage(image);
    }

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
    await interaction.reply({ content: '✅ Verification panel posted to this channel!', ephemeral: true });
    logger.log(`Verification panel posted in #${interaction.channel.name} by ${interaction.user.username}`);
  },

  async handleActionsList(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const config = roleService.getRoleConfigSummary();
    const collections = roleService.getCollectionsSummary();

    // Build collections field
    const collectionsConfigured = collections.filter(c => c.configured).length;
    const collectionsTotal = collections.length;
    const collectionsText = collections.map(c => {
      const status = c.configured ? '✅' : '⚠️';
      const roleInfo = c.roleId ? `<@&${c.roleId}>` : '_No role assigned_';
      const enabledStatus = c.enabled ? '' : ' (disabled)';
      return `${status} **${c.name}** → ${roleInfo}${enabledStatus}`;
    }).join('\n') || '_No collections configured_';

    // Build tier roles field
    const tiersConfigured = config.tiers.filter(t => t.configured).length;
    const tiersTotal = config.tiers.length;
    const tiersText = config.tiers.map(t => {
      const status = t.configured ? '✅' : '⚠️';
      const roleInfo = t.roleId ? `<@&${t.roleId}>` : '_No role assigned_';
      return `${status} **${t.name}** (${t.minNFTs}-${t.maxNFTs} NFTs, VP ${t.votingPower}) → ${roleInfo}`;
    }).join('\n');

    // Build trait roles field
    const traitsConfigured = config.traitRoles.filter(t => t.configured).length;
    const traitsTotal = config.traitRoles.length;
    const traitsText = config.traitRoles.map(t => {
      const status = t.configured ? '✅' : '⚠️';
      const roleInfo = t.roleId ? `<@&${t.roleId}>` : '_No role assigned_';
      return `${status} **${t.trait}** → ${roleInfo}`;
    }).join('\n') || '_No trait roles configured_';

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🔐 Family Verification Actions')
      .setDescription('Active verification actions and role assignments for the Family')
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
        text: 'Use /verification actions to manage • /role-config for advanced control' 
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed verification actions`);
  },

  async handleAddCollection(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const role = interaction.options.getRole('role');
    const collection = interaction.options.getString('collection');
    const amount = interaction.options.getInteger('amount') || 1;
    const traitName = interaction.options.getString('traitname');
    const traitValue = interaction.options.getString('traitvalue');

    // Validation
    if (!collection || collection.length < 3) {
      return interaction.editReply({ 
        content: '❌ Invalid collection identifier. Must be at least 3 characters.', 
        ephemeral: true 
      });
    }

    if ((traitName && !traitValue) || (!traitName && traitValue)) {
      return interaction.editReply({ 
        content: '❌ Both traitname and traitvalue must be provided together.', 
        ephemeral: true 
      });
    }

    // If trait-based, add as trait role
    if (traitName && traitValue) {
      const result = roleService.addTrait(traitName, traitValue, role.id);

      if (result.success) {
        await interaction.editReply({ 
          content: `✅ Trait-based collection action added!\n**${traitName}: ${traitValue}** → <@&${role.id}>\n\nMembers with this trait will receive the role automatically.`,
          ephemeral: true 
        });
        logger.log(`Admin ${interaction.user.tag} added trait action: ${traitName}:${traitValue} → role ${role.id}`);
      } else {
        await interaction.editReply({ 
          content: `❌ ${result.message}`, 
          ephemeral: true 
        });
      }
      return;
    }

    // Standard collection-based role
    const result = roleService.addCollection(collection, collection, role.id);

    if (result.success) {
      const amountText = amount > 1 ? ` (requires ${amount} NFTs)` : '';
      await interaction.editReply({ 
        content: `✅ Collection action added!\n**${collection}** → <@&${role.id}>${amountText}\n\nMembers holding this collection will receive the role automatically.`,
        ephemeral: true 
      });
      logger.log(`Admin ${interaction.user.tag} added collection: ${collection} → role ${role.id} (amount: ${amount})`);
    } else {
      await interaction.editReply({ 
        content: `❌ ${result.message}`, 
        ephemeral: true 
      });
    }
  },

  async handleAddToken(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const role = interaction.options.getRole('role');
    const token = interaction.options.getString('token');
    const amount = interaction.options.getNumber('amount') || 1;

    // Validation
    if (!token || token.length < 3) {
      return interaction.editReply({ 
        content: '❌ Invalid token identifier. Provide a token name or mint address.', 
        ephemeral: true 
      });
    }

    if (amount <= 0) {
      return interaction.editReply({ 
        content: '❌ Amount must be greater than 0.', 
        ephemeral: true 
      });
    }

    // This is a simplified token holder action (extend roleService if needed)
    // For now, we'll store it as a special collection type
    const result = roleService.addCollection(
      `token:${token}`, 
      `Token: ${token} (≥${amount})`, 
      role.id
    );

    if (result.success) {
      await interaction.editReply({ 
        content: `✅ Token holder action added!\n**${token}** (≥${amount}) → <@&${role.id}>\n\nMembers holding this token will receive the role automatically.`,
        ephemeral: true 
      });
      logger.log(`Admin ${interaction.user.tag} added token action: ${token} (amount: ${amount}) → role ${role.id}`);
    } else {
      await interaction.editReply({ 
        content: `❌ ${result.message}`, 
        ephemeral: true 
      });
    }
  },

  async handleRemove(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const role = interaction.options.getRole('role');
    const type = interaction.options.getString('type');
    const identifier = interaction.options.getString('identifier');

    // Find matching action(s) by role and type
    let result;
    let actionDescription = '';

    if (type === 'collection') {
      // If identifier provided, use it; otherwise find by role
      if (identifier) {
        result = roleService.deleteCollection(identifier);
        actionDescription = `collection "${identifier}"`;
      } else {
        // Find collection by roleId
        const collections = roleService.getCollectionsSummary();
        const match = collections.find(c => c.roleId === role.id);
        
        if (!match) {
          return interaction.editReply({ 
            content: `❌ No collection action found for role <@&${role.id}>. Provide an identifier if multiple exist.`,
            ephemeral: true 
          });
        }
        
        result = roleService.deleteCollection(match.id);
        actionDescription = `collection "${match.name}"`;
      }
    } else if (type === 'trait') {
      if (!identifier) {
        return interaction.editReply({ 
          content: '❌ For trait removal, provide identifier in format: trait_type:trait_value',
          ephemeral: true 
        });
      }

      const parts = identifier.split(':');
      if (parts.length !== 2) {
        return interaction.editReply({ 
          content: '❌ Invalid trait identifier format. Use: trait_type:trait_value (e.g., "Role:The Hitman")',
          ephemeral: true 
        });
      }

      const [traitType, traitValue] = parts;
      result = roleService.deleteTrait(traitType, traitValue);
      actionDescription = `trait "${identifier}"`;
    } else if (type === 'token') {
      if (identifier) {
        result = roleService.deleteCollection(`token:${identifier}`);
        actionDescription = `token "${identifier}"`;
      } else {
        return interaction.editReply({ 
          content: '❌ Provide the token identifier to remove.',
          ephemeral: true 
        });
      }
    } else {
      return interaction.editReply({ 
        content: '❌ Invalid action type.',
        ephemeral: true 
      });
    }

    if (result && result.success) {
      await interaction.editReply({ 
        content: `✅ Removed ${actionDescription} from <@&${role.id}>`,
        ephemeral: true 
      });
      logger.log(`Admin ${interaction.user.tag} removed ${actionDescription} from role ${role.id}`);
    } else {
      await interaction.editReply({ 
        content: `❌ ${result ? result.message : 'Action not found or already removed.'}`,
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
          content: `❌ <@${targetUser.id}> is not a verified Family member yet.`,
          ephemeral: true 
        });
      }

      const wallets = walletService.getAllUserWallets(targetUser.id);

      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`📋 Family Member Export: ${targetUser.username}`)
        .setDescription(`Discord: <@${targetUser.id}>`)
        .addFields(
          { name: 'NFT Holdings', value: `${userInfo.total_nfts}`, inline: true },
          { name: 'Rank', value: `${userInfo.tier || 'Associate'}`, inline: true },
          { name: 'Voting Power', value: `${userInfo.voting_power}`, inline: true },
          { 
            name: 'Linked Wallets', 
            value: wallets.length > 0 
              ? wallets.map(w => `\`${w.wallet_address.slice(0, 8)}...${w.wallet_address.slice(-8)}\`${w.primary_wallet ? ' ⭐' : ''}`).join('\n')
              : '_No wallets linked_', 
            inline: false 
          }
        )
        .setFooter({ text: `Member since: ${new Date(userInfo.created_at).toLocaleDateString()}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      logger.log(`Admin ${interaction.user.tag} exported user data for ${targetUser.tag}`);
    } catch (error) {
      logger.error('Error exporting user:', error);
      await interaction.editReply({ 
        content: '❌ An error occurred while exporting member data.',
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
        content: '❌ You must set confirm=true to remove a Family member. This action cannot be undone.',
        ephemeral: true 
      });
    }

    try {
      const userInfo = await roleService.getUserInfo(targetUser.id);
      
      if (!userInfo) {
        return interaction.editReply({ 
          content: `❌ <@${targetUser.id}> is not in the Family database.`,
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
        content: `✅ <@${targetUser.id}> has been removed from the Family.\n\nAll wallets, roles, and verification data have been deleted.`,
        ephemeral: true 
      });
      logger.log(`Admin ${interaction.user.tag} removed user ${targetUser.tag} from verification system`);
    } catch (error) {
      logger.error('Error removing user:', error);
      await interaction.editReply({ 
        content: '❌ An error occurred while removing the member.',
        ephemeral: true 
      });
    }
  }
};
