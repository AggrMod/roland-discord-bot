const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const missionService = require('../../services/missionService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('heist-status')
    .setDescription('View your active and completed missions'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    const missions = missionService.getUserMissions(discordId);

    if (missions.length === 0) {
      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('📋 No Missions')
        .setDescription('You haven\'t joined any missions yet. Use `/heist-view` to see available missions!')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const activeMissions = missions.filter(m => m.status === 'recruiting' || m.status === 'ready' || m.status === 'active');
    const completedMissions = missions.filter(m => m.status === 'completed');

    const activeList = activeMissions.length > 0
      ? activeMissions.map(m => 
          `• **${m.mission_id}**: ${m.title}\n  Role: ${m.assigned_role} | NFT: ${m.assigned_nft_name}\n  Status: ${m.status.toUpperCase()}`
        ).join('\n\n')
      : 'None';

    const completedList = completedMissions.length > 0
      ? completedMissions.slice(0, 5).map(m => 
          `• **${m.mission_id}**: ${m.title}\n  Points Earned: ${m.points_awarded || 0}`
        ).join('\n\n')
      : 'None';

    const totalPoints = missions.reduce((sum, m) => sum + (m.points_awarded || 0), 0);

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('📋 Your Heist Missions')
      .addFields(
        { name: '🎯 Active Missions', value: activeList, inline: false },
        { name: '✅ Completed Missions', value: completedList, inline: false },
        { name: '🎁 Total Points Earned', value: totalPoints.toString(), inline: true },
        { name: '📊 Missions Completed', value: completedMissions.length.toString(), inline: true }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
