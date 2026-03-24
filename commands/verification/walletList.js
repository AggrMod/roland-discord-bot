const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const walletService = require('../../services/walletService');
const roleService = require('../../services/roleService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('wallet-list')
    .setDescription('View your linked wallets and NFT holdings'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    const wallets = walletService.getLinkedWallets(discordId);

    if (wallets.length === 0) {
      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('💼 No Wallets Linked')
        .setDescription('You haven\'t linked any wallets yet. Use `/verify <wallet>` to get started.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const userInfo = await roleService.getUserInfo(discordId);

    const walletList = wallets.map((wallet, index) => {
      const address = wallet.wallet_address;
      const shortened = `${address.slice(0, 6)}...${address.slice(-4)}`;
      const marker = wallet.primary_wallet ? '⭐' : '•';
      return `${marker} \`${shortened}\``;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('💼 Your Linked Wallets')
      .setDescription(walletList)
      .addFields(
        { name: '🎴 Total NFTs', value: userInfo?.total_nfts?.toString() || '0', inline: true },
        { name: '🏆 Current Tier', value: userInfo?.tier || 'None', inline: true },
        { name: '🗳️ Voting Power', value: userInfo?.voting_power?.toString() || '0', inline: true }
      )
      .setFooter({ text: '⭐ = Primary Wallet' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
