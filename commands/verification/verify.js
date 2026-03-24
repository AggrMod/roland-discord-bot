const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const walletService = require('../../services/walletService');
const roleService = require('../../services/roleService');
const nftService = require('../../services/nftService');
const vpService = require('../../services/vpService');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Check your wallet verification status and view your holdings'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';
    
    // Check if user has verified wallets
    let wallets = walletService.getLinkedWallets(discordId);

    // In mock mode, auto-register a mock wallet if user has none
    if ((!wallets || wallets.length === 0) && process.env.MOCK_MODE === 'true') {
      const mockWallet = `MOCK${discordId.slice(0, 8)}${Math.random().toString(36).slice(2, 8)}`;
      walletService.linkWallet(discordId, interaction.user.username, mockWallet);
      wallets = walletService.getLinkedWallets(discordId);
      
      // Update NFT counts and roles
      const nftService = require('../../services/nftService');
      const allNFTs = await nftService.getAllNFTsForWallets([mockWallet]);
      const totalNFTs = allNFTs.length;
      const db = require('../../database/db');
      db.prepare('UPDATE users SET total_nfts = ? WHERE discord_id = ?').run(totalNFTs, discordId);
      
      // Assign roles
      await roleService.updateUserRoles(interaction.member, totalNFTs);
    }

    const userInfo = await roleService.getUserInfo(discordId);

    if (!wallets || wallets.length === 0) {
      // User NOT verified - show simple message with Verify and Get Help buttons
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

    // User IS verified - show Solmate-style summary
    const walletAddresses = wallets.map(w => w.wallet_address);
    const allNFTs = await nftService.getAllNFTsForWallets(walletAddresses);
    const totalNFTs = allNFTs.length;
    const totalAssets = totalNFTs; // For simplicity, assets = NFTs (could expand later)
    const totalTokens = 0; // Mock - could be expanded

    // Get role information
    const rolesConfig = vpService.getAllTiers();
    const userTier = vpService.getTierForNFTCount(totalNFTs);
    
    // Build role qualification list
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
        `You have **${totalAssets}** assets in your wallet${wallets.length > 1 ? 's' : ''}\n` +
        `You have **${totalNFTs}** NFTs in your wallet${wallets.length > 1 ? 's' : ''}\n` +
        `You have **${totalTokens}** tokens in your wallet${wallets.length > 1 ? 's' : ''}\n\n` +
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
          .setLabel('Verify')
          .setStyle(ButtonStyle.Link)
          .setURL(`${webUrl}/verify`),
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
    logger.log(`User ${interaction.user.username} (${discordId}) viewed verification status - ${wallets.length} wallet(s), ${totalNFTs} NFTs`);
  },
};
