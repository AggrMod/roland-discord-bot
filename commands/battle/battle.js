const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const battleService = require('../../services/battleService');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('battle')
    .setDescription('Mafia battle commands')
    .addSubcommand(subcommand =>
      subcommand
        .setName('create')
        .setDescription('Create a new battle lobby')
        .addIntegerOption(option =>
          option
            .setName('max_players')
            .setDescription('Maximum players (optional, leave empty for unlimited)')
            .setMinValue(2)
            .setRequired(false)
        )
        .addRoleOption(option =>
          option
            .setName('required_role')
            .setDescription('Required role to join (optional)')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('start')
        .setDescription('Start the battle (creator only)')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('cancel')
        .setDescription('Cancel the battle lobby (creator only)')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('stats')
        .setDescription('View battle statistics')
        .addUserOption(option =>
          option
            .setName('user')
            .setDescription('User to check stats for (leave empty for yourself)')
            .setRequired(false)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'create':
        await handleCreate(interaction);
        break;
      case 'start':
        await handleStart(interaction);
        break;
      case 'cancel':
        await handleCancel(interaction);
        break;
      case 'stats':
        await handleStats(interaction);
        break;
      default:
        await interaction.reply({ content: 'Unknown subcommand', ephemeral: true });
    }
  },
};

async function handleCreate(interaction) {
  await interaction.deferReply();

  const creatorId = interaction.user.id;
  const channelId = interaction.channelId;
  const maxPlayers = interaction.options.getInteger('max_players') || null; // null = unlimited
  const requiredRole = interaction.options.getRole('required_role');
  const requiredRoleId = requiredRole ? requiredRole.id : null;

  // Create initial embed
  const embed = battleService.buildLobbyEmbed(
    { 
      status: 'open', 
      min_players: 2, 
      max_players: maxPlayers,
      required_role_id: requiredRoleId 
    },
    [],
    requiredRole
  );

  // Send message
  const message = await interaction.editReply({ embeds: [embed] });

  // Create lobby in database
  const result = battleService.createLobby(
    channelId, 
    message.id, 
    creatorId, 
    2, 
    maxPlayers || 999, // 999 = effectively unlimited
    requiredRoleId
  );

  if (!result.success) {
    await interaction.editReply({ content: 'Failed to create battle lobby', embeds: [] });
    return;
  }

  // Add reaction
  try {
    await message.react(battleService.SWORD_EMOJI);
    logger.log(`Battle lobby ${result.lobbyId} created (max: ${maxPlayers || 'unlimited'}, role: ${requiredRoleId || 'none'})`);
  } catch (error) {
    logger.error('Failed to add reaction to battle lobby:', error);
  }
}

async function handleStart(interaction) {
  await interaction.deferReply({ ephemeral: true });

  // Find active lobby created by this user
  const db = require('../../database/battleDb');
  const lobby = db.prepare(`
    SELECT * FROM battle_lobbies 
    WHERE creator_id = ? AND status = 'open' AND channel_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(interaction.user.id, interaction.channelId);

  if (!lobby) {
    await interaction.editReply({ content: '❌ No open lobby found. Create one with `/battle create` first.' });
    return;
  }

  const result = battleService.startBattle(lobby.lobby_id, interaction.user.id);

  if (!result.success) {
    await interaction.editReply({ content: `❌ ${result.message}` });
    return;
  }

  await interaction.editReply({ content: '⚔️ Battle starting! Watch the carnage unfold...' });

  // Update lobby message
  try {
    const channel = await interaction.client.channels.fetch(lobby.channel_id);
    const message = await channel.messages.fetch(lobby.message_id);

    // Fetch required role if set
    let requiredRole = null;
    if (lobby.required_role_id) {
      try {
        requiredRole = await interaction.guild.roles.fetch(lobby.required_role_id);
      } catch (error) {
        logger.error('Failed to fetch required role:', error);
      }
    }

    const updatedEmbed = battleService.buildLobbyEmbed(lobby, result.participants, requiredRole);
    updatedEmbed.setColor('#FF0000');
    updatedEmbed.setDescription('🔴 **BATTLE IN PROGRESS**\n\nThe family is settling scores...');
    
    await message.edit({ embeds: [updatedEmbed] });
  } catch (error) {
    logger.error('Failed to update lobby message:', error);
  }

  // Simulate battle
  const battleResult = battleService.simulateBattle(lobby.lobby_id);

  // Post rounds as embeds (Rumble Royale style)
  for (const round of battleResult.rounds) {
    const roundEmbed = new EmbedBuilder()
      .setColor('#FF6B6B')
      .setTitle(`⚔️ Round ${round.round}`)
      .setDescription(round.events.join('\n'))
      .setFooter({ text: `Players Left: ${round.playersLeft} | Era: Solpranos` })
      .setTimestamp();
    
    await interaction.followUp({ embeds: [roundEmbed] });
    
    // Small delay between rounds for drama
    if (round.round < battleResult.rounds.length) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }

  // Post HYPE winner finale with @mention
  const winnerEmbed = new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle('👑 The Family Crown Goes To...')
    .setDescription(
      `<@${battleResult.winner.user_id}>\n\n` +
      `${battleResult.finaleOutro}`
    )
    .addFields(
      { name: '🏆 Champion', value: battleResult.winner.username, inline: true },
      { name: '❤️ HP Remaining', value: battleResult.winner.hp.toString(), inline: true },
      { name: '💥 Total Damage', value: battleResult.winner.total_damage_dealt.toString(), inline: true },
      { name: '⚔️ Rounds Survived', value: battleResult.roundCount.toString(), inline: true },
      { name: '👥 Total Fighters', value: battleResult.totalPlayers.toString(), inline: true },
      { name: '📊 Win Rate', value: '100% (this battle)', inline: true }
    )
    .setFooter({ text: 'Use /battle stats to see your overall record | Era: Solpranos' })
    .setTimestamp();

  await interaction.followUp({ 
    content: `🎊 Congratulations <@${battleResult.winner.user_id}>! 🎊`,
    embeds: [winnerEmbed] 
  });

  // Update original lobby message
  try {
    const channel = await interaction.client.channels.fetch(lobby.channel_id);
    const message = await channel.messages.fetch(lobby.message_id);

    const finalEmbed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('⚔️ Battle Complete')
      .setDescription(`**Winner:** ${battleResult.winner.username} 👑`)
      .setFooter({ text: 'Battle concluded' })
      .setTimestamp();

    await message.edit({ embeds: [finalEmbed] });
  } catch (error) {
    logger.error('Failed to update final lobby message:', error);
  }

  logger.log(`Battle ${lobby.lobby_id} completed, winner: ${battleResult.winner.username}`);
}

async function handleCancel(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const db = require('../../database/battleDb');
  const lobby = db.prepare(`
    SELECT * FROM battle_lobbies 
    WHERE creator_id = ? AND status = 'open' AND channel_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(interaction.user.id, interaction.channelId);

  if (!lobby) {
    await interaction.editReply({ content: '❌ No open lobby found to cancel.' });
    return;
  }

  const result = battleService.cancelBattle(lobby.lobby_id, interaction.user.id);

  if (!result.success) {
    await interaction.editReply({ content: `❌ ${result.message}` });
    return;
  }

  // Update lobby message
  try {
    const channel = await interaction.client.channels.fetch(lobby.channel_id);
    const message = await channel.messages.fetch(lobby.message_id);

    const cancelEmbed = new EmbedBuilder()
      .setColor('#808080')
      .setTitle('⚔️ Battle Cancelled')
      .setDescription('The boss called it off. Maybe next time.')
      .setFooter({ text: 'Lobby closed' })
      .setTimestamp();

    await message.edit({ embeds: [cancelEmbed] });
  } catch (error) {
    logger.error('Failed to update cancelled lobby message:', error);
  }

  await interaction.editReply({ content: '✅ Battle lobby cancelled.' });
  logger.log(`Battle ${lobby.lobby_id} cancelled by ${interaction.user.id}`);
}

async function handleStats(interaction) {
  await interaction.deferReply();

  const targetUser = interaction.options.getUser('user') || interaction.user;
  const stats = battleService.getStats(targetUser.id);

  if (!stats) {
    const embed = new EmbedBuilder()
      .setColor('#808080')
      .setTitle('📊 Battle Statistics')
      .setDescription(`${targetUser.username} hasn't joined any battles yet.\n\nUse \`/battle create\` to start your first fight!`)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const winRate = stats.battles_played > 0 
    ? ((stats.battles_won / stats.battles_played) * 100).toFixed(1)
    : '0.0';

  const embed = new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle(`📊 Battle Statistics - ${targetUser.username}`)
    .addFields(
      { name: '🎮 Battles Played', value: stats.battles_played.toString(), inline: true },
      { name: '🏆 Battles Won', value: stats.battles_won.toString(), inline: true },
      { name: '📈 Win Rate', value: `${winRate}%`, inline: true },
      { name: '💥 Total Damage Dealt', value: stats.total_damage_dealt.toString(), inline: true }
    )
    .setFooter({ text: 'Keep fighting to climb the ranks!' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
  logger.log(`Stats viewed for ${targetUser.username}`);
}
