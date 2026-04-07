const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const walletService = require('../../services/walletService');
const roleService = require('../../services/roleService');
const nftService = require('../../services/nftService');
const vpService = require('../../services/vpService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');
const nftActivityService = require('../../services/nftActivityService');

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
            .setDescription('Export verified wallets (optionally filtered by role)')
            .addRoleOption(option =>
              option
                .setName('role')
                .setDescription('Only export wallets for members with this role')
                .setRequired(false))
            .addBooleanOption(option =>
              option
                .setName('primary-only')
                .setDescription('Only include primary wallets')
                .setRequired(false)))
        
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
                  { name: 'Set Trait Role', value: 'set_trait' },
                  { name: 'Remove Trait Role', value: 'remove_trait' }
                ))
            .addStringOption(option =>
              option.setName('trait-type')
                .setDescription('Trait type (e.g. Background, Role)')
                .setRequired(false))
            .addStringOption(option =>
              option.setName('trait-value')
                .setDescription('Trait value (e.g. Gold, Hitman)')
                .setRequired(false))
            .addStringOption(option =>
              option.setName('collection-id')
                .setDescription('Solana collection address (required)')
                .setRequired(false))
            .addRoleOption(option =>
              option.setName('role')
                .setDescription('Discord role to assign')
                .setRequired(false))
            .addStringOption(option =>
              option.setName('description')
                .setDescription('Description for the trait rule')
                .setRequired(false)))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('actions')
            .setDescription('View all verification actions and role assignments'))
        
        // OG Role Management
        .addSubcommand(subcommand =>
          subcommand
            .setName('og-view')
            .setDescription('View OG role configuration and eligible members'))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('og-enable')
            .setDescription('Enable or disable the OG role system')
            .addBooleanOption(option =>
              option
                .setName('enabled')
                .setDescription('Enable (true) or disable (false)')
                .setRequired(true)))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('og-role')
            .setDescription('Set the OG role to assign')
            .addRoleOption(option =>
              option
                .setName('role')
                .setDescription('The role to assign to OG members')
                .setRequired(true)))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('og-limit')
            .setDescription('Set the number of OG slots (first X verified users)')
            .addIntegerOption(option =>
              option
                .setName('count')
                .setDescription('Number of OG slots')
                .setRequired(true)
                .setMinValue(1)))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('og-sync')
            .setDescription('Sync OG role to eligible users')
            .addBooleanOption(option =>
              option
                .setName('full')
                .setDescription('Full sync (also removes from ineligible users)')
                .setRequired(false)))

        .addSubcommand(subcommand =>
          subcommand
            .setName('activity-watch-add')
            .setDescription('Add NFT collection key to activity watchlist')
            .addStringOption(option =>
              option
                .setName('collection')
                .setDescription('Collection key/slug/address')
                .setRequired(true)))

        .addSubcommand(subcommand =>
          subcommand
            .setName('activity-watch-remove')
            .setDescription('Remove NFT collection key from activity watchlist')
            .addStringOption(option =>
              option
                .setName('collection')
                .setDescription('Collection key/slug/address')
                .setRequired(true)))

        .addSubcommand(subcommand =>
          subcommand
            .setName('activity-watch-list')
            .setDescription('List NFT activity watched collections'))

        .addSubcommand(subcommand =>
          subcommand
            .setName('activity-feed')
            .setDescription('Show recent NFT activity feed')
            .addIntegerOption(option =>
              option
                .setName('limit')
                .setDescription('Number of events (1-30)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(30)))

        .addSubcommand(subcommand =>
          subcommand
            .setName('activity-alerts')
            .setDescription('Configure NFT activity auto-post alerts')
            .addBooleanOption(option =>
              option
                .setName('enabled')
                .setDescription('Enable or disable auto alerts')
                .setRequired(true))
            .addChannelOption(option =>
              option
                .setName('channel')
                .setDescription('Alert channel (required when enabling)')
                .setRequired(false))
            .addStringOption(option =>
              option
                .setName('types')
                .setDescription('Comma-separated types (mint,sell,list,delist,transfer)')
                .setRequired(false))
            .addNumberOption(option =>
              option
                .setName('min_sol')
                .setDescription('Minimum SOL price to alert')
                .setRequired(false)
                .setMinValue(0)))),

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
          case 'og-view':
            await this.handleAdminOGView(interaction);
            break;
          case 'og-enable':
            await this.handleAdminOGEnable(interaction);
            break;
          case 'og-role':
            await this.handleAdminOGRole(interaction);
            break;
          case 'og-limit':
            await this.handleAdminOGLimit(interaction);
            break;
          case 'og-sync':
            await this.handleAdminOGSync(interaction);
            break;
          case 'activity-watch-add':
            await this.handleAdminActivityWatchAdd(interaction);
            break;
          case 'activity-watch-remove':
            await this.handleAdminActivityWatchRemove(interaction);
            break;
          case 'activity-watch-list':
            await this.handleAdminActivityWatchList(interaction);
            break;
          case 'activity-feed':
            await this.handleAdminActivityFeed(interaction);
            break;
          case 'activity-alerts':
            await this.handleAdminActivityAlerts(interaction);
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
      console.error('[CommandError]', error);
      const userMsg = 'An error occurred. Please try again or contact an admin.';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: userMsg });
      } else {
        await interaction.reply({ content: userMsg, ephemeral: true });
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
      await roleService.updateUserRoles(discordId, interaction.user.username, interaction.guildId);
      if (interaction.guild) {
        await roleService.syncUserDiscordRoles(interaction.guild, discordId, interaction.guildId || null);
      }
    }

    await roleService.updateUserRoles(discordId, interaction.user.username, interaction.guildId);
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
    const allNFTs = await nftService.getAllNFTsForWallets(walletAddresses, { guildId: interaction.guildId || null });
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
      await roleService.updateUserRoles(discordId, interaction.user.username, interaction.guildId);
      if (interaction.guild) {
        await roleService.syncUserDiscordRoles(interaction.guild, discordId, interaction.guildId || null);
      }
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

    const result = microVerifyService.createRequest(discordId, username);

    if (!result.success) {
      return interaction.editReply({ 
        content: `❌ ${result.message}`, 
        ephemeral: true 
      });
    }

    const req = result.request;
    const expiresTs = Math.floor(new Date(req.expiresAt).getTime() / 1000);

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('⚡ Quick Verification')
      .setDescription('Send the exact tiny SOL amount from your wallet to complete verification.')
      .addFields(
        { name: 'Amount', value: `\`${req.amount} SOL\``, inline: true },
        { name: 'Destination', value: `\`${req.destinationWallet}\``, inline: false },
        { name: 'Expires', value: `<t:${expiresTs}:R>`, inline: true },
        { name: 'Check Status', value: 'Use button below after sending.', inline: true }
      )
      .setFooter({ text: 'Quick verification via micro-transfer' })
      .setTimestamp();

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('micro_verify_copy_amount')
          .setLabel('Copy Amount')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('micro_verify_check_status')
          .setLabel('Check Status')
          .setStyle(ButtonStyle.Primary)
      );

    await interaction.editReply({ embeds: [embed], components: [row] });
    logger.log(`User ${username} initiated quick verification`);
  },

  // ==================== ADMIN COMMANDS ====================

  async handleAdminPanel(interaction) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }

    const webUrl = process.env.WEB_URL || 'http://localhost:3000';

    const title = interaction.options.getString('title') || '🔗 Verify your wallet!';
    const description = interaction.options.getString('description') || 'To get access to Family roles, verify your wallet with Solpranos by clicking the button below.';
    const colorHex = interaction.options.getString('color') || '#FFD700';

    const colorValue = colorHex.startsWith('#') ? colorHex : `#${colorHex}`;
    if (!/^#[0-9A-F]{6}$/i.test(colorValue)) {
      return interaction.editReply({
        content: '❌ Invalid color format. Use hex code (e.g., #FFD700)'
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
    await interaction.editReply({ content: '✅ Verification panel posted!' });
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
    const selectedRole = interaction.options.getRole('role');
    const primaryOnly = interaction.options.getBoolean('primary-only') || false;
    let wallets = [];

    if (selectedRole) {
      // Ensure role.members reflects the full guild membership, not only cache.
      await interaction.guild.members.fetch();
      const memberIds = Array.from(selectedRole.members.keys());

      if (memberIds.length === 0) {
        return interaction.editReply({
          content: `❌ Role **${selectedRole.name}** has no members in this server.`,
          ephemeral: true
        });
      }

      const placeholders = memberIds.map(() => '?').join(',');
      wallets = db.prepare(`
        SELECT 
          w.discord_id,
          u.username,
          w.wallet_address,
          w.primary_wallet,
          w.verified,
          w.created_at
        FROM wallets w
        LEFT JOIN users u ON w.discord_id = u.discord_id
        WHERE w.verified = 1
          ${primaryOnly ? 'AND w.primary_wallet = 1' : ''}
          AND w.discord_id IN (${placeholders})
        ORDER BY w.discord_id, w.created_at
      `).all(...memberIds);
    } else {
      wallets = db.prepare(`
      SELECT 
        w.discord_id,
        u.username,
        w.wallet_address,
        w.primary_wallet,
        w.verified,
        w.created_at
      FROM wallets w
      LEFT JOIN users u ON w.discord_id = u.discord_id
      WHERE w.verified = 1
      ${primaryOnly ? 'AND w.primary_wallet = 1' : ''}
      ORDER BY w.discord_id, w.created_at
    `).all();
    }

    if (wallets.length === 0) {
      return interaction.editReply({ 
        content: selectedRole
          ? `❌ No verified ${primaryOnly ? 'primary ' : ''}wallets found for role **${selectedRole.name}**.`
          : `❌ No verified ${primaryOnly ? 'primary ' : ''}wallets in database.`,
        ephemeral: true 
      });
    }

    const csvEscape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const csv = 'discord_id,username,wallet_address,primary_wallet,verified,created_at\n' +
      wallets.map(w => [
        csvEscape(w.discord_id),
        csvEscape(w.username || ''),
        csvEscape(w.wallet_address),
        csvEscape(w.primary_wallet ? 'true' : 'false'),
        csvEscape(w.verified ? 'true' : 'false'),
        csvEscape(w.created_at || '')
      ].join(',')).join('\n');

    const buffer = Buffer.from(csv, 'utf-8');
    const roleSuffix = selectedRole
      ? `-${selectedRole.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 40)}`
      : '';
    const primarySuffix = primaryOnly ? '-primary' : '';
    const attachment = { name: `wallets${roleSuffix}${primarySuffix}.csv`, attachment: buffer };

    await interaction.editReply({ 
      content: selectedRole
        ? `✅ ${primaryOnly ? 'Primary wallet' : 'Wallet'} export complete for role **${selectedRole.name}** (${wallets.length} wallet(s)).`
        : `✅ ${primaryOnly ? 'Primary wallet' : 'Wallet'} export complete (${wallets.length} wallet(s)).`,
      files: [attachment],
      ephemeral: true 
    });
    logger.log(`Admin ${interaction.user.tag} exported ${primaryOnly ? 'primary ' : ''}wallets${selectedRole ? ` for role ${selectedRole.id}` : ''}`);
  },

  async handleAdminRoleConfig(interaction) {
    await interaction.deferReply({ ephemeral: true });
    
    const action = interaction.options.getString('action');

    if (action === 'view') {
      // Show current trait roles configuration
      const config = roleService.getRoleConfigSummary();
      const traitsText = config.traitRoles.map(t => {
        const status = t.configured ? '✅' : '⚠️';
        const roleInfo = t.roleId ? `<@&${t.roleId}>` : '_No role assigned_';
        return `${status} **${t.trait}** → ${roleInfo}`;
      }).join('\n') || '_No trait roles configured_';

      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🎨 Trait Role Configuration')
        .setDescription('Current trait-to-role mappings')
        .addFields(
          { name: 'Configured Traits', value: traitsText, inline: false },
          { 
            name: 'To Configure', 
            value: 'Trait roles are set via the web admin panel at `/admin` → Admin Panel → Verification Roles tab.\n\nAlternatively, use the web API:\n`POST /api/admin/roles/traits` with trait name and roleId.',
            inline: false
          }
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } else if (action === 'set_tier') {
      // Placeholder - tier roles should be configured via admin
      await interaction.editReply({ 
        content: '⚙️ Tier role configuration: Use `/verification admin actions` to view tier settings.\n\nTier roles are configured in the web admin panel → Dashboard → Verification Roles.', 
        ephemeral: true 
      });
    } else if (action === 'set_trait') {
      const traitType = interaction.options.getString('trait-type');
      const traitValue = interaction.options.getString('trait-value');
      const collectionId = interaction.options.getString('collection-id');
      const role = interaction.options.getRole('role');
      const description = interaction.options.getString('description') || null;

      if (!traitType || !traitValue || !collectionId || !role) {
        return interaction.editReply({
          content: '❌ Missing required options. Usage: `trait-type`, `trait-value`, `collection-id`, and `role` are all required.',
          ephemeral: true
        });
      }

      const result = roleService.addTrait(traitType, traitValue, role.id, description, collectionId);
      if (result.success) {
        const embed = new EmbedBuilder()
          .setColor('#00FF88')
          .setTitle('✅ Trait Rule Added')
          .addFields(
            { name: 'Trait', value: `${traitType}: ${traitValue}`, inline: true },
            { name: 'Collection', value: collectionId, inline: true },
            { name: 'Role', value: `<@&${role.id}>`, inline: true }
          )
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.editReply({ content: `❌ ${result.message}`, ephemeral: true });
      }
    } else if (action === 'remove_trait') {
      const traitType = interaction.options.getString('trait-type');
      const traitValue = interaction.options.getString('trait-value');

      if (!traitType || !traitValue) {
        return interaction.editReply({
          content: '❌ Missing required options. Usage: `trait-type` and `trait-value` are required for removal.',
          ephemeral: true
        });
      }

      const result = roleService.deleteTrait(traitType, traitValue);
      if (result.success) {
        await interaction.editReply({ content: `✅ Removed trait rule: **${traitType}: ${traitValue}**` });
      } else {
        await interaction.editReply({ content: `❌ ${result.message}`, ephemeral: true });
      }
    }
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
  },

  // ==================== OG ROLE ADMIN COMMANDS ====================

  async handleAdminOGView(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const ogRoleService = require('../../services/ogRoleService');
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

    embed.setFooter({ text: 'Use /verification admin og-sync to apply changes to Discord roles' });

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed OG config`);
  },

  async handleAdminOGEnable(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const ogRoleService = require('../../services/ogRoleService');
    const enabled = interaction.options.getBoolean('enabled');
    const result = ogRoleService.setEnabled(enabled);

    const embed = new EmbedBuilder()
      .setColor(result.success ? '#57F287' : '#ED4245')
      .setTitle(result.success ? '✅ Success' : '❌ Error')
      .setDescription(result.message)
      .setTimestamp();

    if (result.success && enabled) {
      embed.setFooter({ text: 'Don\'t forget to run /verification admin og-sync to apply the role!' });
    }

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} ${enabled ? 'enabled' : 'disabled'} OG role`);
  },

  async handleAdminOGRole(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const ogRoleService = require('../../services/ogRoleService');
    const role = interaction.options.getRole('role');
    const result = ogRoleService.setRole(role.id);

    const embed = new EmbedBuilder()
      .setColor(result.success ? '#57F287' : '#ED4245')
      .setTitle(result.success ? '✅ Success' : '❌ Error')
      .setDescription(result.success ? `OG role set to: ${role.name}` : result.message)
      .setTimestamp();

    if (result.success) {
      embed.setFooter({ text: 'Run /verification admin og-sync to apply this role to eligible users' });
    }

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} set OG role to ${role.name}`);
  },

  async handleAdminOGLimit(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const ogRoleService = require('../../services/ogRoleService');
    const count = interaction.options.getInteger('count');
    const result = ogRoleService.setLimit(count);

    const embed = new EmbedBuilder()
      .setColor(result.success ? '#57F287' : '#ED4245')
      .setTitle(result.success ? '✅ Success' : '❌ Error')
      .setDescription(result.message)
      .setTimestamp();

    if (result.success) {
      embed.setFooter({ text: 'Run /verification admin og-sync to apply the new limit' });
    }

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} set OG limit to ${count}`);
  },

  async handleAdminOGSync(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const ogRoleService = require('../../services/ogRoleService');
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
  },

  async handleAdminActivityWatchAdd(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const collection = interaction.options.getString('collection');
    const result = nftActivityService.addWatchedCollection(collection);
    await interaction.editReply({ content: result.success ? `✅ Added watch: \`${collection}\`` : `❌ ${result.message}`, ephemeral: true });
  },

  async handleAdminActivityWatchRemove(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const collection = interaction.options.getString('collection');
    const result = nftActivityService.removeWatchedCollection(collection);
    await interaction.editReply({ content: result.success ? `✅ Removed watch: \`${collection}\` (${result.removed || 0})` : `❌ ${result.message}`, ephemeral: true });
  },

  async handleAdminActivityWatchList(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const watches = nftActivityService.listWatchedCollections();
    if (!watches.length) return interaction.editReply({ content: 'No watched collections configured yet.', ephemeral: true });

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('👁️ NFT Activity Watchlist')
      .setDescription(watches.map((w, i) => `${i + 1}. \`${w.collection_key}\``).join('\n'))
      .setTimestamp();

    await interaction.editReply({ embeds: [embed], ephemeral: true });
  },

  async handleAdminActivityFeed(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const limit = interaction.options.getInteger('limit') || 10;
    const events = nftActivityService.listEvents(limit);
    if (!events.length) return interaction.editReply({ content: 'No NFT activity events yet.', ephemeral: true });

    const lines = events.slice(0, limit).map((e, i) => {
      const t = e.event_time ? Math.floor(new Date(e.event_time).getTime() / 1000) : null;
      const when = t ? `<t:${t}:R>` : 'unknown';
      const price = e.price_sol !== null && e.price_sol !== undefined ? ` | ${e.price_sol} SOL` : '';
      return `${i + 1}. **${e.event_type}** ${e.collection_key ? `(${e.collection_key})` : ''} ${e.token_name || ''}${price} • ${when}`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('📡 NFT Activity Feed')
      .setDescription(lines)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed], ephemeral: true });
  },

  async handleAdminActivityAlerts(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const enabled = interaction.options.getBoolean('enabled');
    const channel = interaction.options.getChannel('channel');
    const types = interaction.options.getString('types');
    const minSol = interaction.options.getNumber('min_sol');

    if (enabled && !channel) {
      return interaction.editReply({ content: '❌ Channel is required when enabling alerts.', ephemeral: true });
    }

    const result = nftActivityService.updateAlertConfig({
      enabled,
      channelId: channel ? channel.id : undefined,
      eventTypes: types !== null ? types : undefined,
      minSol: minSol !== null ? minSol : undefined
    });

    if (!result.success) {
      return interaction.editReply({ content: `❌ ${result.message}`, ephemeral: true });
    }

    const cfg = nftActivityService.getAlertConfig();
    await interaction.editReply({
      content: enabled
        ? `✅ NFT activity alerts enabled in <#${cfg.channel_id}> | types=${cfg.event_types} | min_sol=${cfg.min_sol}`
        : '✅ NFT activity alerts disabled.',
      ephemeral: true
    });
  }
};
