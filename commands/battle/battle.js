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
            .setDescription('Maximum players (2-8)')
            .setMinValue(2)
            .setMaxValue(8)
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

  const maxPlayers = interaction.options.getInteger('max_players') || 8;
  const creatorId = interaction.user.id;
  const channelId = interaction.channelId;

  // Create initial embed
  const embed = battleService.buildLobbyEmbed(
    { status: 'open', max_players: maxPlayers, min_players: 2 },
    []
  );

  // Send message
  const message = await interaction.editReply({ embeds: [embed] });

  // Create lobby in database
  const result = battleService.createLobby(channelId, message.id, creatorId, 2, maxPlayers);

  if (!result.success) {
    await interaction.editReply({ content: 'Failed to create battle lobby', embeds: [] });
    return;
  }

  // Add reaction
  try {
    await message.react(battleService.SWORD_EMOJI);
    logger.log(`Battle lobby ${result.lobbyId} created with reaction added`);
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

    const updatedEmbed = battleService.buildLobbyEmbed(lobby, result.participants);
    updatedEmbed.setColor('#FF0000');
    updatedEmbed.setDescription('🔴 **BATTLE IN PROGRESS**\n\nThe family is settling scores...');
    
    await message.edit({ embeds: [updatedEmbed] });
  } catch (error) {
    logger.error('Failed to update lobby message:', error);
  }

  // Simulate battle
  const battleResult = battleService.simulateBattle(lobby.lobby_id);

  // Post rounds (batch every 3 rounds to reduce spam)
  const batchSize = 3;
  for (let i = 0; i < battleResult.rounds.length; i += batchSize) {
    const batch = battleResult.rounds.slice(i, i + batchSize);
    const roundText = batch.map(r => `**Round ${r.round}:**\n${r.text}`).join('\n\n');
    
    await interaction.followUp({ content: roundText });
    
    // Small delay between batches
    if (i + batchSize < battleResult.rounds.length) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // Post winner
  const winnerEmbed = new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle('👑 Battle Complete!')
    .setDescription(battleResult.winnerLine)
    .addFields(
      { name: '🏆 Winner', value: battleResult.winner.username, inline: true },
      { name: '❤️ HP Remaining', value: battleResult.winner.hp.toString(), inline: true },
      { name: '💥 Total Damage', value: battleResult.winner.total_damage_dealt.toString(), inline: true }
    )
    .setFooter({ text: 'Use /battle stats to see your overall record' })
    .setTimestamp();

  await interaction.followUp({ embeds: [winnerEmbed] });

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
