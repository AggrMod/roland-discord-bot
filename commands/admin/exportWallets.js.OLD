const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const db = require('../../database/db');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('export-wallets')
    .setDescription('Export favorite wallets for members with a specific role (Admin only)')
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('The role to filter members by')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const role = interaction.options.getRole('role');
    
    try {
      // Fetch all members with the specified role
      const guild = interaction.guild;
      await guild.members.fetch();
      
      const membersWithRole = guild.members.cache.filter(member => member.roles.cache.has(role.id));
      
      if (membersWithRole.size === 0) {
        const embed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('❌ No Members Found')
          .setDescription(`No members found with the role **${role.name}**.`)
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      // Collect wallets
      const walletsList = [];
      let skippedCount = 0;

      for (const [memberId, member] of membersWithRole) {
        // Skip bots
        if (member.user.bot) {
          skippedCount++;
          continue;
        }

        // Get favorite wallet (or primary if no favorite set)
        const wallet = db.prepare(`
          SELECT wallet_address 
          FROM wallets 
          WHERE discord_id = ? 
          ORDER BY is_favorite DESC, primary_wallet DESC, created_at ASC 
          LIMIT 1
        `).get(memberId);

        if (wallet) {
          walletsList.push(wallet.wallet_address);
        } else {
          skippedCount++;
          logger.log(`Member ${member.user.username} (${memberId}) has no verified wallet`);
        }
      }

      if (walletsList.length === 0) {
        const embed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('❌ No Wallets Found')
          .setDescription(`None of the ${membersWithRole.size} members with role **${role.name}** have verified wallets.`)
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      // Generate file content
      const fileContent = walletsList.join('\n');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const filename = `wallets_${role.name.replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}.txt`;

      // Create attachment
      const attachment = new AttachmentBuilder(Buffer.from(fileContent, 'utf-8'), { name: filename });

      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('✅ Wallet Export Complete')
        .setDescription(`Successfully exported wallets for members with role **${role.name}**.`)
        .addFields(
          { name: '👥 Total Members', value: membersWithRole.size.toString(), inline: true },
          { name: '💼 Wallets Exported', value: walletsList.length.toString(), inline: true },
          { name: '⚠️ Skipped (No Wallet)', value: skippedCount.toString(), inline: true }
        )
        .setFooter({ text: 'File contains one wallet address per line' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], files: [attachment] });
      
      logger.log(`Admin ${interaction.user.username} exported ${walletsList.length} wallets for role ${role.name}`);
    } catch (error) {
      logger.error('Error exporting wallets:', error);

      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Export Failed')
        .setDescription('An error occurred while exporting wallets.')
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    }
  },
};
