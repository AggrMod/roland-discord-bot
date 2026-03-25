const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const battleService = require('../../services/battleService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('battle')
    .setDescription('⚔️ Battle module - Mafia battle competition')
    
    // User commands
    .addSubcommand(subcommand =>
      subcommand
        .setName('create')
        .setDescription('Create a new battle lobby')
        .addIntegerOption(option =>
          option
            .setName('max_players')
            .setDescription('Maximum players (optional, leave empty for unlimited)')
            .setMinValue(2)
            .setRequired(false))
        .addRoleOption(option =>
          option
            .setName('required_role')
            .setDescription('Required role to join (optional)')
            .setRequired(false)))
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('start')
        .setDescription('Start the battle (creator only)'))
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('cancel')
        .setDescription('Cancel the battle lobby (creator only)'))
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('stats')
        .setDescription('View battle statistics')
        .addUserOption(option =>
          option
            .setName('user')
            .setDescription('User to check stats for (leave empty for yourself)')
            .setRequired(false)))
    
    // Admin subgroup
    .addSubcommandGroup(group =>
      group
        .setName('admin')
        .setDescription('Admin battle management')
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('list')
            .setDescription('List all active battles'))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('force-end')
            .setDescription('Force end a battle (emergency)')
            .addStringOption(option =>
              option
                .setName('battle_id')
                .setDescription('Battle ID to end')
                .setRequired(true))
            .addBooleanOption(option =>
              option
                .setName('confirm')
                .setDescription('Confirm force-end')
                .setRequired(true)))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('settings')
            .setDescription('View/configure battle settings'))),

  async execute(interaction) {
    // Check if battle module is enabled
    if (!await moduleGuard.checkModuleEnabled(interaction, 'battle')) {
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
          case 'list':
            await this.handleAdminList(interaction);
            break;
          case 'force-end':
            await this.handleAdminForceEnd(interaction);
            break;
          case 'settings':
            await this.handleAdminSettings(interaction);
            break;
        }
      } else {
        // User commands
        switch (subcommand) {
          case 'create':
            await this.handleCreate(interaction);
            break;
          case 'start':
            await this.handleStart(interaction);
            break;
          case 'cancel':
            await this.handleCancel(interaction);
            break;
          case 'stats':
            await this.handleStats(interaction);
            break;
        }
      }
    } catch (error) {
      logger.error('Error executing battle command:', error);
      
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

  async handleCreate(interaction) {
    await interaction.deferReply();

    const creatorId = interaction.user.id;
    const channelId = interaction.channelId;
    const maxPlayers = interaction.options.getInteger('max_players') || null;
    const requiredRole = interaction.options.getRole('required_role');
    const requiredRoleId = requiredRole ? requiredRole.id : null;

    // Delegate to battleService (existing logic preserved)
    const result = battleService.createBattle(creatorId, channelId, maxPlayers, requiredRoleId);

    if (!result.success) {
      return interaction.editReply({ 
        content: `❌ ${result.message}`,
        ephemeral: true 
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('⚔️ Battle Lobby Created')
      .setDescription('A new battle lobby has been created! Players can join now.')
      .addFields(
        { name: '🆔 Battle ID', value: result.battleId, inline: true },
        { name: '👤 Creator', value: interaction.user.username, inline: true },
        { name: '👥 Players', value: '1' + (maxPlayers ? `/${maxPlayers}` : ''), inline: true }
      )
      .setFooter({ text: 'Click Join to participate!' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${interaction.user.username} created battle ${result.battleId}`);
  },

  async handleStart(interaction) {
    await interaction.deferReply();

    const userId = interaction.user.id;
    const result = battleService.startBattle(userId);

    if (!result.success) {
      return interaction.editReply({ 
        content: `❌ ${result.message}`,
        ephemeral: true 
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('⚔️ Battle Started!')
      .setDescription('The battle has begun! May the best Family member win.')
      .addFields(
        { name: '🆔 Battle ID', value: result.battleId, inline: true },
        { name: '👥 Participants', value: `${result.playerCount}`, inline: true }
      )
      .setFooter({ text: 'Good luck!' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Battle ${result.battleId} started by ${interaction.user.username}`);
  },

  async handleCancel(interaction) {
    await interaction.deferReply();

    const userId = interaction.user.id;
    const result = battleService.cancelBattle(userId);

    if (!result.success) {
      return interaction.editReply({ 
        content: `❌ ${result.message}`,
        ephemeral: true 
      });
    }

    await interaction.editReply({ 
      content: '✅ Battle lobby cancelled.',
      ephemeral: true 
    });
    logger.log(`Battle ${result.battleId} cancelled by ${interaction.user.username}`);
  },

  async handleStats(interaction) {
    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user') || interaction.user;
    const stats = battleService.getUserStats(targetUser.id);

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle(`⚔️ Battle Stats: ${targetUser.username}`)
      .setDescription('Battle performance overview')
      .addFields(
        { name: '🏆 Wins', value: `${stats.wins || 0}`, inline: true },
        { name: '💀 Losses', value: `${stats.losses || 0}`, inline: true },
        { name: '📊 Win Rate', value: `${stats.winRate || 0}%`, inline: true },
        { name: '⚔️ Total Battles', value: `${stats.total || 0}`, inline: true }
      )
      .setFooter({ text: 'Keep fighting for the Family!' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${interaction.user.username} viewed battle stats for ${targetUser.username}`);
  },

  // ==================== ADMIN COMMANDS ====================

  async handleAdminList(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const battles = battleService.getAllBattles();

    if (battles.length === 0) {
      return interaction.editReply({ 
        content: '❌ No active battles.',
        ephemeral: true 
      });
    }

    const battleList = battles.map((b, i) => {
      return `${i + 1}. **${b.battleId}**: ${b.playerCount} players (Status: ${b.status})`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('⚔️ All Active Battles')
      .setDescription(battleList)
      .setFooter({ text: `Total: ${battles.length}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed battle list`);
  },

  async handleAdminForceEnd(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const battleId = interaction.options.getString('battle_id');
    const confirm = interaction.options.getBoolean('confirm');

    if (!confirm) {
      return interaction.editReply({ 
        content: '❌ You must set confirm=true to force-end a battle.',
        ephemeral: true 
      });
    }

    const result = battleService.forceEndBattle(battleId);

    if (!result.success) {
      return interaction.editReply({ 
        content: `❌ ${result.message}`,
        ephemeral: true 
      });
    }

    await interaction.editReply({ 
      content: `✅ Battle ${battleId} force-ended by admin.`,
      ephemeral: true 
    });
    logger.log(`Admin ${interaction.user.tag} force-ended battle ${battleId}`);
  },

  async handleAdminSettings(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('⚙️ Battle Settings')
      .setDescription('Current battle system configuration')
      .addFields(
        { name: 'Max Players (default)', value: 'Unlimited', inline: true },
        { name: 'Required Role', value: 'Optional', inline: true }
      )
      .setFooter({ text: 'Additional settings in Sprint B' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed battle settings`);
  }
};
