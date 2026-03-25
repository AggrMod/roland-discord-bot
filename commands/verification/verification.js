const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const walletService = require('../../services/walletService');
const roleService = require('../../services/roleService');
const nftService = require('../../services/nftService');
const vpService = require('../../services/vpService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verification')
    .setDescription('🔐 Verification module - wallet linking and role management')
    
    // User commands
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('Check your wallet verification status and view your holdings'))
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('wallets')
        .setDescription('List all your linked wallets'))
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('refresh')
        .setDescription('Refresh your roles based on current holdings'))
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('quick')
        .setDescription('Quick micro-verification for instant role assignment'))
    
    // Admin subgroup
    .addSubcommandGroup(group =>
      group
        .setName('admin')
        .setDescription('Admin verification management')
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('panel')
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
                .setRequired(false)))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('export-user')
            .setDescription('Export a member\'s verification data')
            .addUserOption(option =>
              option.setName('user')
                .setDescription('The member to export')
                .setRequired(true)))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('remove-user')
            .setDescription('Remove a member from the Family (cannot be undone)')
            .addUserOption(option =>
              option.setName('user')
                .setDescription('The member to remove')
                .setRequired(true))
            .addBooleanOption(option =>
              option.setName('confirm')
                .setDescription('Confirm removal (must be true)')
                .setRequired(true)))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('export-wallets')
            .setDescription('Export all verified wallets (CSV)'))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('role-config')
            .setDescription('Configure role assignment rules')
            .addStringOption(option =>
              option.setName('action')
                .setDescription('Configuration action')
                .setRequired(true)
                .addChoices(
                  { name: 'View', value: 'view' },
                  { name: 'Set Tier Role', value: 'set_tier' },
                  { name: 'Set Trait Role', value: 'set_trait' }
                )))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('actions')
            .setDescription('View all verification actions and role assignments'))),

  async execute(interaction) {
    // Check if verification module is enabled
    if (!await moduleGuard.checkModuleEnabled(interaction, 'verification')) {
      return;
    }

    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommandGroup === 'admin') {
        // Admin commands require admin check
        if (!await moduleGuard.checkAdmin(interaction)) {
          return;
        }

        switch (subcommand) {
          case 'panel':
            await this.handleAdminPanel(interaction);
            break;
          case 'export-user':
            await this.handleAdminExportUser(interaction);
            break;
          case 'remove-user':
            await this.handleAdminRemoveUser(interaction);
            break;
          case 'export-wallets':
            await this.handleAdminExportWallets(interaction);
            break;
          case 'role-config':
            await this.handleAdminRoleConfig(interaction);
            break;
          case 'actions':
            await this.handleAdminActions(interaction);
            break;
        }
      } else {
        // User commands
        switch (subcommand) {
          case 'status':
            await this.handleStatus(interaction);
            break;
          case 'wallets':
            await this.handleWallets(interaction);
            break;
          case 'refresh':
            await this.handleRefresh(interaction);
            break;
          case 'quick':
            await this.handleQuick(interaction);
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

  // ==================== USER COMMANDS ====================

  async handleStatus(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';
    
    let wallets = walletService.getLinkedWallets(discordId);

    // Mock mode auto-registration
    if ((!wallets || wallets.length === 0) && process.env.MOCK_MODE === 'true') {
      const mockWallet = `MOCK${discordId.slice(0, 8)}${Math.random().toString(36).slice(2, 8)}`;
      walletService.linkWallet(discordId, interaction.user.username, mockWallet);
      wallets = walletService.getLinkedWallets(discordId);
      await roleService.updateUserRoles(discordId, interaction.user.username);
    }

    await roleService.updateUserRoles(discordId, interaction.user.username);
    const userInfo = await roleService.getUserInfo(discordId);

    if (!wallets || wallets.length === 0) {
      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🔗 Wallet Verification')
        .setDescription('You have no verified wallets yet. Verify your wallet to access all features!')
        .addFields(
          { name: '📝 How to Verify', value: 'Click the **Verify** button below to connect your wallet and unlock your roles, voting power, and more.', inline: false }
        )
        .setFooter({ text: 'Secure wallet verification via cryptographic signature' })
        .setTimestamp();

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setLabel('Verify')
            .setStyle(ButtonStyle.Link)
            .setURL(`${webUrl}/verify`),
          new ButtonBuilder()
            .setLabel('Get Help')
            .setStyle(ButtonStyle.Link)
            .setURL('https://the-solpranos.com/help')
        );

      await interaction.editReply({ embeds: [embed], components: [row] });
      logger.log(`User ${interaction.user.username} (${discordId}) requested verification - not yet verified`);
      return;
    }

    const walletAddresses = wallets.map(w => w.wallet_address);
    const allNFTs = await nftService.getAllNFTsForWallets(walletAddresses);
    const totalNFTs = allNFTs.length;
    const userTier = vpService.getTierForNFTCount(totalNFTs);
    
    let rolesList = '';
    if (userTier) {
      rolesList = `You have been verified for **@${userTier.name}** (holding ${totalNFTs}/${userTier.minNFTs})`;
    } else {
      rolesList = 'No tier roles qualified yet. Get more NFTs to unlock roles!';
    }

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('✅ Wallet Verification Status')
      .setDescription(
        `You have **${wallets.length}** verified wallet${wallets.length > 1 ? 's' : ''}\n` +
        `You have **${totalNFTs}** NFTs in your wallet${wallets.length > 1 ? 's' : ''}\n\n` +
        rolesList
      )
      .addFields(
        { name: '💪 Voting Power', value: userInfo?.voting_power?.toString() || '0', inline: true },
        { name: '🎭 Tier', value: userTier?.name || 'None', inline: true }
      )
      .setFooter({ text: 'Keep collecting to unlock higher tiers!' })
      .setTimestamp();

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setLabel('Add Wallet')
          .setStyle(ButtonStyle.Link)
          .setURL(`${webUrl}/verify?action=add`),
        new ButtonBuilder()
          .setLabel('Get Help')
          .setStyle(ButtonStyle.Link)
          .setURL('https://the-solpranos.com/help')
      );

    await interaction.editReply({ embeds: [embed], components: [row] });
    logger.log(`User ${interaction.user.username} viewed verification status`);
  },

  async handleWallets(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    const wallets = walletService.getLinkedWallets(discordId);

    if (!wallets || wallets.length === 0) {
      return interaction.editReply({ 
        content: '❌ You have no verified wallets. Use `/verification status` to get started.', 
        ephemeral: true 
      });
    }

    const walletList = wallets.map((w, i) => {
      const primary = w.primary_wallet ? ' ⭐ (Primary)' : '';
      return `${i + 1}. \`${w.wallet_address}\`${primary}`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('💼 Your Verified Wallets')
      .setDescription(walletList)
      .setFooter({ text: `Total: ${wallets.length} wallet(s)` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${interaction.user.username} viewed wallet list`);
  },

  async handleRefresh(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    
    try {
      await roleService.updateUserRoles(discordId, interaction.user.username);
      const userInfo = await roleService.getUserInfo(discordId);

      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Roles Refreshed')
        .setDescription('Your roles have been updated based on your current holdings.')
        .addFields(
          { name: '💪 Voting Power', value: userInfo?.voting_power?.toString() || '0', inline: true },
          { name: '🎭 Tier', value: userInfo?.tier || 'Associate', inline: true },
          { name: '📦 NFTs', value: userInfo?.total_nfts?.toString() || '0', inline: true }
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      logger.log(`User ${interaction.user.username} refreshed roles`);
    } catch (error) {
      logger.error('Error refreshing roles:', error);
      await interaction.editReply({ 
        content: '❌ Failed to refresh roles. Please try again later.', 
        ephemeral: true 
      });
    }
  },

  async handleQuick(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const microVerifyService = require('../../services/microVerifyService');
    
    const discordId = interaction.user.id;
    const username = interaction.user.username;

    // Check if user already has wallets
    const existingWallets = walletService.getLinkedWallets(discordId);
    if (existingWallets && existingWallets.length > 0) {
      return interaction.editReply({ 
        content: '✅ You\'re already verified! Use `/verification refresh` to update your roles.',
        ephemeral: true 
      });
    }

    const result = await microVerifyService.createMicroVerifySession(discordId, username);

    if (!result.success) {
      return interaction.editReply({ 
        content: `❌ ${result.message}`, 
        ephemeral: true 
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('⚡ Quick Verification')
      .setDescription(`Click the link below to complete quick verification:\n\n${result.url}`)
      .addFields(
        { name: '⏱️ Expires', value: 'In 10 minutes', inline: true },
        { name: '🔐 Secure', value: 'Wallet signature required', inline: true }
      )
      .setFooter({ text: 'Quick verification for instant role assignment' })
      .setTimestamp();

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setLabel('Quick Verify')
          .setStyle(ButtonStyle.Link)
          .setURL(result.url)
      );

    await interaction.editReply({ embeds: [embed], components: [row] });
    logger.log(`User ${username} initiated quick verification`);
  },

  // ==================== ADMIN COMMANDS ====================

  async handleAdminPanel(interaction) {
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';

    const title = interaction.options.getString('title') || '🔗 Verify your wallet!';
    const description = interaction.options.getString('description') || 'To get access to Family roles, verify your wallet with Solpranos by clicking the button below.';
    const colorHex = interaction.options.getString('color') || '#FFD700';

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
    logger.log(`Admin ${interaction.user.username} posted verification panel`);
  },

  async handleAdminExportUser(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
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
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} exported user data for ${targetUser.tag}`);
  },

  async handleAdminRemoveUser(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const confirm = interaction.options.getBoolean('confirm');

    if (!confirm) {
      return interaction.editReply({ 
        content: '❌ You must set confirm=true to remove a Family member. This action cannot be undone.',
        ephemeral: true 
      });
    }

    const userInfo = await roleService.getUserInfo(targetUser.id);
    
    if (!userInfo) {
      return interaction.editReply({ 
        content: `❌ <@${targetUser.id}> is not in the Family database.`,
        ephemeral: true 
      });
    }

    walletService.removeAllWallets(targetUser.id);

    if (interaction.guild) {
      await roleService.removeAllTierRoles(interaction.guild, targetUser.id);
    }

    const db = require('../../database/db');
    db.prepare('DELETE FROM users WHERE discord_id = ?').run(targetUser.id);

    await interaction.editReply({ 
      content: `✅ <@${targetUser.id}> has been removed from the Family.\n\nAll wallets, roles, and verification data have been deleted.`,
      ephemeral: true 
    });
    logger.log(`Admin ${interaction.user.tag} removed user ${targetUser.tag}`);
  },

  async handleAdminExportWallets(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const db = require('../../database/db');
    const wallets = db.prepare('SELECT * FROM wallets').all();

    if (wallets.length === 0) {
      return interaction.editReply({ 
        content: '❌ No wallets in database.', 
        ephemeral: true 
      });
    }

    const csv = 'discord_id,username,wallet_address,primary_wallet,verified_at\n' +
      wallets.map(w => `${w.discord_id},${w.username},${w.wallet_address},${w.primary_wallet ? 'true' : 'false'},${w.verified_at}`).join('\n');

    const buffer = Buffer.from(csv, 'utf-8');
    const attachment = { name: 'wallets.csv', attachment: buffer };

    await interaction.editReply({ 
      content: '✅ Wallet export complete',
      files: [attachment],
      ephemeral: true 
    });
    logger.log(`Admin ${interaction.user.tag} exported all wallets`);
  },

  async handleAdminRoleConfig(interaction) {
    await interaction.deferReply({ ephemeral: true });
    
    // Placeholder - integrate with existing role-config logic
    await interaction.editReply({ 
      content: '⚙️ Role configuration - use `/verification admin actions` for now.', 
      ephemeral: true 
    });
  },

  async handleAdminActions(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const config = roleService.getRoleConfigSummary();
    const collections = roleService.getCollectionsSummary();
    const { resolveCollectionInput, formatCollectionForDisplay } = require('../../utils/collectionResolver');

    const collectionsConfigured = collections.filter(c => c.configured).length;
    const collectionsTotal = collections.length;
    const collectionsText = collections.map(c => formatCollectionForDisplay(c)).join('\n') || '_No collections configured_';

    const tiersConfigured = config.tiers.filter(t => t.configured).length;
    const tiersTotal = config.tiers.length;
    const tiersText = config.tiers.map(t => {
      const status = t.configured ? '✅' : '⚠️';
      const roleInfo = t.roleId ? `<@&${t.roleId}>` : '_No role assigned_';
      return `${status} **${t.name}** (${t.minNFTs}-${t.maxNFTs} NFTs, VP ${t.votingPower}) → ${roleInfo}`;
    }).join('\n');

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
      .setDescription('Active verification actions and role assignments')
      .addFields(
        { name: `📦 Collections (${collectionsConfigured}/${collectionsTotal})`, value: collectionsText, inline: false },
        { name: `📊 Tier Roles (${tiersConfigured}/${tiersTotal})`, value: tiersText, inline: false },
        { name: `🎨 Trait Roles (${traitsConfigured}/${traitsTotal})`, value: traitsText, inline: false }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed verification actions`);
  }
};
