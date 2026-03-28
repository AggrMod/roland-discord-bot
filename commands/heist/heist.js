const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const missionService = require('../../services/missionService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('heist')
    .setDescription('🎯 Heist module - collaborative missions (disabled by default)')
    
    // User commands
    .addSubcommand(subcommand =>
      subcommand
        .setName('view')
        .setDescription('View available heist missions'))
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('signup')
        .setDescription('Sign up for a heist mission')
        .addStringOption(option =>
          option
            .setName('mission_id')
            .setDescription('Mission ID to join')
            .setRequired(true))
        .addStringOption(option =>
          option
            .setName('role')
            .setDescription('Your role in the heist')
            .setRequired(true)
            .addChoices(
              { name: 'Driver', value: 'driver' },
              { name: 'Hacker', value: 'hacker' },
              { name: 'Muscle', value: 'muscle' },
              { name: 'Lookout', value: 'lookout' }
            )))
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('View your mission status'))
    
    // Admin subgroup
    .addSubcommandGroup(group =>
      group
        .setName('admin')
        .setDescription('Admin heist management')
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('create')
            .setDescription('Create a new heist mission')
            .addStringOption(option =>
              option
                .setName('title')
                .setDescription('Mission title')
                .setRequired(true))
            .addStringOption(option =>
              option
                .setName('description')
                .setDescription('Mission description')
                .setRequired(true))
            .addIntegerOption(option =>
              option
                .setName('slots')
                .setDescription('Total slots')
                .setRequired(true)
                .setMinValue(2)
                .setMaxValue(20))
            .addIntegerOption(option =>
              option
                .setName('reward')
                .setDescription('Reward points')
                .setRequired(true)
                .setMinValue(1)))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('list')
            .setDescription('List all missions (any status)'))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('cancel')
            .setDescription('Cancel a heist mission')
            .addStringOption(option =>
              option
                .setName('mission_id')
                .setDescription('Mission ID to cancel')
                .setRequired(true))
            .addBooleanOption(option =>
              option
                .setName('confirm')
                .setDescription('Confirm cancellation')
                .setRequired(true)))),

  async execute(interaction) {
    // Check if heist module is enabled
    if (!await moduleGuard.checkModuleEnabled(interaction, 'heist')) {
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
          case 'create':
            await this.handleAdminCreate(interaction);
            break;
          case 'list':
            await this.handleAdminList(interaction);
            break;
          case 'cancel':
            await this.handleAdminCancel(interaction);
            break;
        }
      } else {
        // User commands
        switch (subcommand) {
          case 'view':
            await this.handleView(interaction);
            break;
          case 'signup':
            await this.handleSignup(interaction);
            break;
          case 'status':
            await this.handleStatus(interaction);
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

  async handleView(interaction) {
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

      const slotProgress = '█'.repeat(Math.floor(mission.filled_slots / mission.total_slots * 10)) +
                          '░'.repeat(10 - Math.floor(mission.filled_slots / mission.total_slots * 10));

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
        .setFooter({ text: `Use /heist signup ${mission.mission_id} to join` })
        .setTimestamp();
    });

    await interaction.editReply({ embeds });
    logger.log(`User ${interaction.user.username} viewed heist missions`);
  },

  async handleSignup(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const missionId = interaction.options.getString('mission_id');
    const role = interaction.options.getString('role');
    const userId = interaction.user.id;

    const result = missionService.addParticipant(missionId, userId, interaction.user.username, role);

    if (!result.success) {
      return interaction.editReply({ 
        content: `❌ ${result.message}`,
        ephemeral: true 
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('✅ Signed Up for Mission')
      .setDescription(`You've joined the heist as **${role}**!`)
      .addFields(
        { name: '🆔 Mission ID', value: missionId, inline: true },
        { name: '🎭 Your Role', value: role, inline: true }
      )
      .setFooter({ text: 'Wait for the mission to start!' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${interaction.user.username} signed up for heist ${missionId} as ${role}`);
  },

  async handleStatus(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const status = missionService.getUserMissionStatus(userId);

    if (!status || status.length === 0) {
      return interaction.editReply({ 
        content: '❌ You are not participating in any missions.',
        ephemeral: true 
      });
    }

    const statusList = status.map(s => 
      `🎯 **${s.missionId}**: ${s.role} (Status: ${s.status})`
    ).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🎯 Your Mission Status')
      .setDescription(statusList)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${interaction.user.username} viewed heist status`);
  },

  // ==================== ADMIN COMMANDS ====================

  async handleAdminCreate(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');
    const slots = interaction.options.getInteger('slots');
    const reward = interaction.options.getInteger('reward');

    const result = missionService.createMission(title, description, slots, reward);

    if (!result.success) {
      return interaction.editReply({ 
        content: `❌ ${result.message}`,
        ephemeral: true 
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🎯 New Heist Mission Created')
      .setDescription(`**${title}**\n\n${description}`)
      .addFields(
        { name: '🆔 Mission ID', value: result.missionId, inline: true },
        { name: '👥 Slots', value: `${slots}`, inline: true },
        { name: '🎁 Reward', value: `${reward} points`, inline: true }
      )
      .setFooter({ text: 'Mission is now available!' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} created heist mission ${result.missionId}`);
  },

  async handleAdminList(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const missions = missionService.getAllMissions();

    if (missions.length === 0) {
      return interaction.editReply({ 
        content: '❌ No missions found.',
        ephemeral: true 
      });
    }

    const missionList = missions.map((m, i) => {
      return `${i + 1}. **${m.mission_id}**: ${m.title} (${m.filled_slots}/${m.total_slots} slots, ${m.status})`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🎯 All Heist Missions')
      .setDescription(missionList)
      .setFooter({ text: `Total: ${missions.length}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed heist mission list`);
  },

  async handleAdminCancel(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const missionId = interaction.options.getString('mission_id');
    const confirm = interaction.options.getBoolean('confirm');

    if (!confirm) {
      return interaction.editReply({ 
        content: '❌ You must set confirm=true to cancel a mission.',
        ephemeral: true 
      });
    }

    const result = missionService.cancelMission(missionId);

    if (!result.success) {
      return interaction.editReply({ 
        content: `❌ ${result.message}`,
        ephemeral: true 
      });
    }

    await interaction.editReply({ 
      content: `✅ Mission ${missionId} cancelled by admin.`,
      ephemeral: true 
    });
    logger.log(`Admin ${interaction.user.tag} cancelled heist mission ${missionId}`);
  }
};
