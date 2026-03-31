const { SlashCommandBuilder } = require('discord.js');
const triviaService = require('../../services/triviaService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runGame(game, lobbyMessage, guildId) {
  const channel = lobbyMessage.channel;
  try {
    await lobbyMessage.edit({ embeds: [triviaService.buildCancelledEmbed('✅ Trivia starting! Get your thinking caps on ❓', guildId)] });
    await lobbyMessage.reactions.removeAll().catch(() => {});
  } catch (_) {}

  game.status = 'playing';
  const total = game.questions.length;

  for (let i = 0; i < total; i++) {
    game.qIndex = i;
    const q = triviaService.currentQuestion(game);
    await sleep(3000);

    const qMsg = await channel.send({ embeds: [triviaService.buildQuestionEmbed({ q, qNum: i+1, total, guildId })] });
    for (const emoji of triviaService.ANSWER_EMOJIS) await qMsg.react(emoji).catch(() => {});

    // Collect one reaction per player
    const reactions = new Map(); // userId → emoji
    const collector = qMsg.createReactionCollector({
      filter: (r, u) => triviaService.ANSWER_EMOJIS.includes(r.emoji.name) && !u.bot && game.players.has(u.id),
      time: triviaService.Q_SECS * 1000,
    });
    collector.on('collect', (r, u) => {
      if (!reactions.has(u.id)) reactions.set(u.id, r.emoji.name);
    });
    await new Promise(resolve => collector.on('end', resolve));

    const { winners, losers, correctEmoji, correctText } = triviaService.resolveAnswers(game, reactions);
    await channel.send({ embeds: [triviaService.buildAnswerEmbed({ q, qNum: i+1, total, winners, losers, correctEmoji, correctText, guildId })] });

    if (i < total - 1) {
      await sleep(3000);
      await channel.send({ embeds: [triviaService.buildScoreboardEmbed({ qNum: i+1, total, scores: game.scores, guildId })] });
    }
  }

  await sleep(2000);
  const { winners, score } = triviaService.winner(game);
  await channel.send({ embeds: [triviaService.buildWinnerEmbed({ winners, score, total, guildId })] });
  triviaService.endGame(game.lobbyMessageId);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trivia')
    .setDescription('❓ Trivia — most correct answers wins!')
    .addSubcommand(s => s.setName('start').setDescription('Start a Trivia game')
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
        for (const [, g] of triviaService._games) {
          if (g.channelId === channel.id && g.status === 'waiting')
            return interaction.editReply({ content: '❌ A Trivia lobby is already open here.' });
        }
        const placeholder = await channel.send({ content: '❓ Setting up Trivia...' });
        const game = triviaService.createLobby({ channelId: channel.id, messageId: placeholder.id, creatorId: user.id, gatherSecs });
        await placeholder.edit({ content: '', embeds: [triviaService.buildLobbyEmbed(game, guildId)] });
        await placeholder.react(triviaService.JOIN_EMOJI).catch(() => {});
        await interaction.editReply({ content: `✅ Trivia lobby created! React ${triviaService.JOIN_EMOJI} to join. Starts in **${gatherSecs}s**.` });

        game.gatherTimer = setTimeout(async () => {
          try {
            if (game.status !== 'waiting') return;
            if (game.players.size < 2) {
              await placeholder.edit({ embeds: [triviaService.buildCancelledEmbed('❌ Not enough players. Game cancelled.', guildId)] });
              await placeholder.reactions.removeAll().catch(() => {});
              triviaService.endGame(game.lobbyMessageId); return;
            }
            await runGame(game, placeholder, guildId);
          } catch (err) { logger.error('[Trivia] runGame error:', err); triviaService.endGame(game.lobbyMessageId); }
        }, gatherSecs * 1000);
        return;
      }

      if (sub === 'cancel') {
        await interaction.deferReply({ ephemeral: true });
        let found = null;
        for (const [, g] of triviaService._games) { if (g.channelId === channel.id && g.status === 'waiting' && g.creatorId === user.id) { found = g; break; } }
        if (!found) return interaction.editReply({ content: '❌ No open Trivia lobby found for you here.' });
        try { const msg = await channel.messages.fetch(found.lobbyMessageId); await msg.edit({ embeds: [triviaService.buildCancelledEmbed('❌ Cancelled by host.', guildId)] }); await msg.reactions.removeAll().catch(() => {}); } catch (_) {}
        triviaService.endGame(found.lobbyMessageId);
        return interaction.editReply({ content: '✅ Lobby cancelled.' });
      }
    } catch (err) {
      logger.error('[Trivia] error:', err);
      try { const r = { content: '❌ Error occurred.', ephemeral: true }; if (interaction.deferred || interaction.replied) await interaction.editReply(r); else await interaction.reply(r); } catch (_) {}
    }
  },
};
