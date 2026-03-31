const { SlashCommandBuilder } = require('discord.js');
const ngService = require('../../services/numberGuessService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runGame(game, lobbyMessage, guildId) {
  const channel = lobbyMessage.channel;
  try {
    await lobbyMessage.edit({ embeds: [ngService.buildCancelledEmbed('✅ Game started! Get your guessing hats on 🔢', guildId)] });
    await lobbyMessage.reactions.removeAll().catch(() => {});
  } catch (_) {}

  game.status = 'playing';

  for (let round = 1; round <= ngService.ROUNDS; round++) {
    game.round = round;
    const secret = ngService.pickSecret();
    await channel.send({ embeds: [ngService.buildRoundEmbed({ round, total: ngService.ROUNDS, guildId })] });

    // Collect chat guesses
    const guesses = new Map();
    const collector = channel.createMessageCollector({
      filter: m => game.players.has(m.author.id) && /^\d+$/.test(m.content.trim()),
      time: ngService.GUESS_SECS * 1000,
    });
    collector.on('collect', m => {
      if (!guesses.has(m.author.id)) guesses.set(m.author.id, parseInt(m.content.trim()));
    });
    await new Promise(resolve => collector.on('end', resolve));

    const results = ngService.resolveRound(game, guesses, secret);
    await channel.send({ embeds: [ngService.buildResultEmbed({ round, secret, results, guildId })] });
    await sleep(3000);
    await channel.send({ embeds: [ngService.buildScoreboardEmbed({ round, total: ngService.ROUNDS, scores: game.scores, guildId })] });
    if (round < ngService.ROUNDS) await sleep(4000);
  }

  const { winners, score, sorted } = ngService.winner(game);
  await channel.send({ embeds: [ngService.buildWinnerEmbed({ winners, score, guildId })] });
  ngService.endGame(game.lobbyMessageId);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('numberguess')
    .setDescription('🔢 Number Guess — closest to the secret number wins!')
    .addSubcommand(s => s.setName('start').setDescription('Start a Number Guess game')
      .addIntegerOption(o => o.setName('join_time').setDescription('Seconds to gather (10–120, default 60)').setMinValue(10).setMaxValue(120).setRequired(false)))
    .addSubcommand(s => s.setName('cancel').setDescription('Cancel the current lobby')),

  async execute(interaction) {
    try {
      if (!await moduleGuard.checkModuleEnabled(interaction, 'battle')) return;
      if (!await moduleGuard.checkAdminOrModerator(interaction)) return;
      const sub = interaction.options.getSubcommand();
      const { guildId, user, channel } = interaction;

      if (sub === 'start') {
        const gatherSecs = interaction.options.getInteger('join_time') || 60;
        await interaction.deferReply({ ephemeral: true });
        for (const [, g] of ngService._games) {
          if (g.channelId === channel.id && g.status === 'waiting')
            return interaction.editReply({ content: '❌ A Number Guess game is already open here.' });
        }
        const placeholder = await channel.send({ content: '🔢 Setting up Number Guess...' });
        const game = ngService.createLobby({ channelId: channel.id, messageId: placeholder.id, creatorId: user.id, gatherSecs });
        await placeholder.edit({ content: '', embeds: [ngService.buildLobbyEmbed(game, guildId)] });
        await placeholder.react(ngService.JOIN_EMOJI).catch(() => {});
        await interaction.editReply({ content: `✅ Number Guess lobby created! React ${ngService.JOIN_EMOJI} to join. Starts in **${gatherSecs}s**.` });

        game.gatherTimer = setTimeout(async () => {
          try {
            if (game.status !== 'waiting') return;
            if (game.players.size < 2) {
              await placeholder.edit({ embeds: [ngService.buildCancelledEmbed('❌ Not enough players. Game cancelled.', guildId)] });
              await placeholder.reactions.removeAll().catch(() => {});
              ngService.endGame(game.lobbyMessageId); return;
            }
            await runGame(game, placeholder, guildId);
          } catch (err) { logger.error('[NumberGuess] runGame error:', err); ngService.endGame(game.lobbyMessageId); }
        }, gatherSecs * 1000);
        return;
      }

      if (sub === 'cancel') {
        await interaction.deferReply({ ephemeral: true });
        let found = null;
        for (const [, g] of ngService._games) { if (g.channelId === channel.id && g.status === 'waiting' && g.creatorId === user.id) { found = g; break; } }
        if (!found) return interaction.editReply({ content: '❌ No open Number Guess lobby found for you here.' });
        try { const msg = await channel.messages.fetch(found.lobbyMessageId); await msg.edit({ embeds: [ngService.buildCancelledEmbed('❌ Cancelled by host.', guildId)] }); await msg.reactions.removeAll().catch(() => {}); } catch (_) {}
        ngService.endGame(found.lobbyMessageId);
        return interaction.editReply({ content: '✅ Lobby cancelled.' });
      }
    } catch (err) {
      logger.error('[NumberGuess] error:', err);
      try { const r = { content: '❌ Error occurred.', ephemeral: true }; if (interaction.deferred || interaction.replied) await interaction.editReply(r); else await interaction.reply(r); } catch (_) {}
    }
  },
};
