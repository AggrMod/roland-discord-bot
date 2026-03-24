const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const missionService = require('../../services/missionService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('heist-view')
    .setDescription('View available heist missions'),

  async execute(interaction) {
    await interaction.deferReply();

    const missions = missionService.getAvailableMissions();

    if (missions.length === 0) {
      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🎯 No Active Missions')
        .setDescription('There are no missions available at the moment. Check back soon!')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const embeds = missions.slice(0, 5).map(mission => {
      const requiredRoles = Array.isArray(mission.required_roles) 
        ? mission.required_roles 
        : [];

      const rolesList = requiredRoles.length > 0
        ? requiredRoles.map(r => `• ${r.quantity}x ${r.role}`).join('\n')
        : 'No specific role required';

      const slotProgress = `${'█'.repeat(Math.floor(mission.filled_slots / mission.total_slots * 10))}${'░'.repeat(10 - Math.floor(mission.filled_slots / mission.total_slots * 10))}`;

      return new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`🎯 ${mission.title}`)
        .setDescription(mission.description)
        .addFields(
          { name: '🆔 Mission ID', value: mission.mission_id, inline: true },
          { name: '👥 Slots', value: `${mission.filled_slots}/${mission.total_slots}`, inline: true },
          { name: '🎁 Reward', value: `${mission.reward_points} points`, inline: true },
          { name: '📋 Required Roles', value: rolesList, inline: false },
          { name: '📊 Progress', value: `[${slotProgress}] ${Math.round(mission.filled_slots / mission.total_slots * 100)}%`, inline: false }
        )
        .setFooter({ text: `Use /heist-signup ${mission.mission_id} to join` })
        .setTimestamp();
    });

    await interaction.editReply({ embeds });
  },
};
