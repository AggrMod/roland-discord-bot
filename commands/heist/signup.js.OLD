const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const missionService = require('../../services/missionService');
const roleService = require('../../services/roleService');
const walletService = require('../../services/walletService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('heist-signup')
    .setDescription('Sign up for a heist mission')
    .addStringOption(option =>
      option.setName('mission-id')
        .setDescription('The mission ID (e.g., M-001)')
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    const missionId = interaction.options.getString('mission-id').toUpperCase();

    const userInfo = await roleService.getUserInfo(discordId);
    
    if (!userInfo || !userInfo.voting_power || userInfo.voting_power === 0) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Not Eligible')
        .setDescription('You must verify your wallet and own at least 1 SOLPRANOS NFT to join missions.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const mission = missionService.getMission(missionId);
    
    if (!mission) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Mission Not Found')
        .setDescription(`No mission found with ID: ${missionId}`)
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    if (mission.status !== 'recruiting') {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Mission Not Available')
        .setDescription('This mission is no longer accepting signups.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const requiredRoles = Array.isArray(mission.required_roles) ? mission.required_roles : [];
    
    if (requiredRoles.length === 0) {
      const wallets = walletService.getLinkedWallets(discordId);
      const primaryWallet = wallets.find(w => w.primary_wallet) || wallets[0];

      const result = missionService.signupForMission(
        missionId,
        discordId,
        primaryWallet.wallet_address,
        'GENERAL_SLOT',
        'General Participant',
        'Any'
      );

      if (!result.success) {
        const embed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('❌ Signup Failed')
          .setDescription(result.message)
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('✅ Successfully Signed Up')
        .setDescription(`You've joined **${mission.title}**!`)
        .addFields(
          { name: '🆔 Mission ID', value: missionId, inline: true },
          { name: '🎁 Reward', value: `${mission.reward_points} points`, inline: true }
        )
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    let availableRole = null;
    let eligibleNFTs = [];

    for (const roleReq of requiredRoles) {
      const nfts = await missionService.getEligibleNFTs(discordId, roleReq.role);
      if (nfts.length > 0) {
        availableRole = roleReq.role;
        eligibleNFTs = nfts;
        break;
      }
    }

    if (!availableRole || eligibleNFTs.length === 0) {
      const requiredList = requiredRoles.map(r => `• ${r.quantity}x ${r.role}`).join('\n');
      
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ No Eligible NFTs')
        .setDescription(`You don't own any available NFTs matching the required roles:\n\n${requiredList}`)
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    if (eligibleNFTs.length === 1) {
      const nft = eligibleNFTs[0];
      const wallets = walletService.getLinkedWallets(discordId);
      const primaryWallet = wallets.find(w => w.primary_wallet) || wallets[0];

      const result = missionService.signupForMission(
        missionId,
        discordId,
        primaryWallet.wallet_address,
        nft.mint,
        nft.name,
        availableRole
      );

      if (!result.success) {
        const embed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('❌ Signup Failed')
          .setDescription(result.message)
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('✅ Successfully Signed Up')
        .setDescription(`You've joined **${mission.title}** with **${nft.name}**!`)
        .addFields(
          { name: '🆔 Mission ID', value: missionId, inline: true },
          { name: '🎭 Role', value: availableRole, inline: true },
          { name: '🎴 NFT', value: nft.name, inline: true },
          { name: '🎁 Reward', value: `${mission.reward_points} points`, inline: true }
        )
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const nftList = eligibleNFTs.slice(0, 5).map((nft, index) => 
      `${index + 1}. **${nft.name}** (${availableRole})`
    ).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🎴 Select Your NFT')
      .setDescription(`You have ${eligibleNFTs.length} eligible NFT(s) for this mission:\n\n${nftList}\n\nReply with the number of the NFT you want to assign.`)
      .setFooter({ text: 'Reply with the number (e.g., "1") within 60 seconds' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

    const filter = m => m.author.id === discordId && /^[1-5]$/.test(m.content);
    
    try {
      const collected = await interaction.channel.awaitMessages({ 
        filter, 
        max: 1, 
        time: 60000, 
        errors: ['time'] 
      });

      const choice = parseInt(collected.first().content) - 1;
      
      if (choice < 0 || choice >= eligibleNFTs.length) {
        throw new Error('Invalid choice');
      }

      const selectedNFT = eligibleNFTs[choice];
      const wallets = walletService.getLinkedWallets(discordId);
      const primaryWallet = wallets.find(w => w.primary_wallet) || wallets[0];

      const result = missionService.signupForMission(
        missionId,
        discordId,
        primaryWallet.wallet_address,
        selectedNFT.mint,
        selectedNFT.name,
        availableRole
      );

      if (!result.success) {
        const errorEmbed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('❌ Signup Failed')
          .setDescription(result.message)
          .setTimestamp();

        return interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
      }

      const successEmbed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('✅ Successfully Signed Up')
        .setDescription(`You've joined **${mission.title}** with **${selectedNFT.name}**!`)
        .addFields(
          { name: '🆔 Mission ID', value: missionId, inline: true },
          { name: '🎭 Role', value: availableRole, inline: true },
          { name: '🎴 NFT', value: selectedNFT.name, inline: true },
          { name: '🎁 Reward', value: `${mission.reward_points} points`, inline: true }
        )
        .setTimestamp();

      await interaction.followUp({ embeds: [successEmbed], ephemeral: true });
      await collected.first().delete().catch(() => {});

    } catch (error) {
      const timeoutEmbed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('⏰ Selection Timeout')
        .setDescription('You didn\'t select an NFT in time. Please try `/heist-signup` again.')
        .setTimestamp();

      await interaction.followUp({ embeds: [timeoutEmbed], ephemeral: true });
    }
  },
};
