const { SlashCommandBuilder } = require('discord.js');
const codebreakerService = require('../../services/codebreakerService');
const engagementService = require('../../services/engagementService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runGame(game, lobbyMessage, guildId) {
  const channel = lobbyMessage.channel;
  game.status = 'playing';
  game.secret = codebreakerService.generateSecret();

  await lobbyMessage.edit({ embeds: [codebreakerService.buildCancelledEmbed('Lobby closed. The code has been secured; the first round starts now.', guildId)] }).catch(() => {});
  await lobbyMessage.reactions.removeAll().catch(() => {});

  for (let round = 1; round <= codebreakerService.MAX_ROUNDS; round += 1) {
    game.round = round;
    await channel.send({ embeds: [codebreakerService.buildRoundEmbed(round, guildId)] });
    const guesses = new Map();
    const collector = channel.createMessageCollector({
      filter: message => game.players.has(message.author.id) && codebreakerService.isValidGuess(message.content),
      time: codebreakerService.GUESS_SECS * 1000,
    });
    collector.on('collect', message => {
      if (guesses.has(message.author.id)) return;
      guesses.set(message.author.id, message.content.trim());
      if (guesses.size === game.players.size) collector.stop('all_guessed');
    });
    await new Promise(resolve => collector.on('end', resolve));

    const results = codebreakerService.resolveRound(game, guesses, round);
    await channel.send({ embeds: [codebreakerService.buildRoundResultEmbed({ round, results, playerNames: game.playerNames, guildId })] });
    if (results.some(result => result.cracked)) break;
    await sleep(1500);
  }

  const rankings = codebreakerService.rankings(game);
  await channel.send({ embeds: [codebreakerService.buildWinnerEmbed({ game, rankings, guildId })] });
  const rewardUsers = rankings.slice(0, 3).map(entry => ({ userId: entry.userId, username: game.playerNames.get(entry.userId) || entry.userId }));
  if (rewardUsers.length) {
    engagementService.awardMinigamePlacements(guildId, rewardUsers, 'codebreaker', game.lobbyMessageId);
  }
  codebreakerService.endGame(game.lobbyMessageId);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('codebreaker')
    .setDescription('Crack a secret four-digit code using logic clues')
    .addSubcommand(command => command
      .setName('start')
      .setDescription('Start a Codebreaker lobby')
      .addIntegerOption(option => option.setName('join_time').setDescription('Seconds to gather players (10–120, default 60)').setMinValue(10).setMaxValue(120).setRequired(false)))
    .addSubcommand(command => command.setName('cancel').setDescription('Cancel your current Codebreaker lobby')),

  async execute(interaction) {
    try {
      if (!await moduleGuard.checkModuleEnabled(interaction, 'minigames')) return;
      if (!await moduleGuard.checkAdminOrModerator(interaction)) return;
      const subcommand = interaction.options.getSubcommand();
      const { guildId, user, channel } = interaction;

      if (subcommand === 'start') {
        const gatherSecs = interaction.options.getInteger('join_time') || 60;
        await interaction.deferReply({ ephemeral: true });
        for (const game of codebreakerService._games.values()) {
          if (game.channelId === channel.id && game.status === 'waiting') {
            return interaction.editReply({ content: 'A Codebreaker lobby is already open in this channel.' });
          }
        }
        const placeholder = await channel.send({ content: 'Securing a Codebreaker challenge...' });
        const game = codebreakerService.createLobby({ channelId: channel.id, messageId: placeholder.id, creatorId: user.id, gatherSecs });
        await placeholder.edit({ content: '', embeds: [codebreakerService.buildLobbyEmbed(game, guildId)] });
        await placeholder.react(codebreakerService.JOIN_EMOJI).catch(() => {});
        await interaction.editReply({ content: `Codebreaker lobby created. React ${codebreakerService.JOIN_EMOJI} to join; it starts in **${gatherSecs}s**.` });

        game.gatherTimer = setTimeout(async () => {
          try {
            if (game.status !== 'waiting') return;
            if (game.players.size < 2) {
              await placeholder.edit({ embeds: [codebreakerService.buildCancelledEmbed('Not enough players. Codebreaker was cancelled.', guildId)] });
              await placeholder.reactions.removeAll().catch(() => {});
              codebreakerService.endGame(game.lobbyMessageId);
              return;
            }
            await runGame(game, placeholder, guildId);
          } catch (error) {
            logger.error('[Codebreaker] game error:', error);
            codebreakerService.endGame(game.lobbyMessageId);
          }
        }, gatherSecs * 1000);
        return;
      }

      if (subcommand === 'cancel') {
        await interaction.deferReply({ ephemeral: true });
        const game = [...codebreakerService._games.values()].find(candidate =>
          candidate.channelId === channel.id && candidate.status === 'waiting' && candidate.creatorId === user.id
        );
        if (!game) return interaction.editReply({ content: 'No Codebreaker lobby owned by you is open here.' });
        try {
          const message = await channel.messages.fetch(game.lobbyMessageId);
          await message.edit({ embeds: [codebreakerService.buildCancelledEmbed('Codebreaker cancelled by the host.', guildId)] });
          await message.reactions.removeAll().catch(() => {});
        } catch (_) {}
        codebreakerService.endGame(game.lobbyMessageId);
        return interaction.editReply({ content: 'Codebreaker cancelled.' });
      }
    } catch (error) {
      logger.error('[Codebreaker] command error:', error);
      const response = { content: 'Codebreaker could not be started.', ephemeral: true };
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply(response);
        else await interaction.reply(response);
      } catch (_) {}
    }
  },
};
