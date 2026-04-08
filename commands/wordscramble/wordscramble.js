const { SlashCommandBuilder } = require('discord.js');
const wsService = require('../../services/wordScrambleService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runGame(game, lobbyMessage, guildId) {
  const channel = lobbyMessage.channel;
  try {
    await lobbyMessage.edit({ embeds: [wsService.buildCancelledEmbed('✅ Word Scramble starting! 🧩', guildId)] });
    await lobbyMessage.reactions.removeAll().catch(() => {});
  } catch (_) {}

  game.status = 'playing';
  const total = wsService.ROUNDS;

  for (let round = 1; round <= total; round++) {
    game.round = round;
    const word = game.words[round - 1];
    const { scramble } = require('../../services/wordScrambleService');
    // Use the module-level scramble function via dynamic approach
    const scrambled = (() => {
      const arr = word.split('');
      for (let i = arr.length-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
      const r = arr.join(''); return r === word ? r.split('').reverse().join('') : r;
    })();

    await sleep(3000);
    await channel.send({ embeds: [wsService.buildRoundEmbed({ round, total, scrambled, guildId })] });

    // Message collector — first correct answer wins
    let winnerId = null;
    const collector = channel.createMessageCollector({
      filter: m => game.players.has(m.author.id),
      time: wsService.ROUND_SECS * 1000,
    });

    await new Promise(resolve => {
      collector.on('collect', m => {
        if (m.content.trim().toLowerCase() === word.toLowerCase() && !winnerId) {
          winnerId = m.author.id;
          game.scores.set(winnerId, (game.scores.get(winnerId) || 0) + 1);
          collector.stop('winner');
        }
      });
      collector.on('end', resolve);
    });

    await channel.send({ embeds: [wsService.buildRoundWinEmbed({ round, total, word, winnerId, scores: game.scores, guildId })] });
  }

  await sleep(2000);
  const { winners, score } = wsService.winner(game);
  await channel.send({ embeds: [wsService.buildWinnerEmbed({ winners, score, guildId })] });
  wsService.endGame(game.lobbyMessageId);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('wordscramble')
    .setDescription('🧩 Word Scramble — unscramble it first!')
    .addSubcommand(s => s.setName('start').setDescription('Start a Word Scramble game')
      .addIntegerOption(o => o.setName('join_time').setDescription('Seconds to gather (10–120, default 60)').setMinValue(10).setMaxValue(120).setRequired(false)))
    .addSubcommand(s => s.setName('cancel').setDescription('Cancel the current lobby')),

  async execute(interaction) {
    try {
      if (!await moduleGuard.checkModuleEnabled(interaction, 'minigames')) return;
      if (!await moduleGuard.checkAdminOrModerator(interaction)) return;
      const sub = interaction.options.getSubcommand();
      const { guildId, user, channel } = interaction;

      if (sub === 'start') {
        const gatherSecs = interaction.options.getInteger('join_time') || 60;
        await interaction.deferReply({ ephemeral: true });
        for (const [, g] of wsService._games) {
          if (g.channelId === channel.id && g.status === 'waiting')
            return interaction.editReply({ content: '❌ A Word Scramble game is already open here.' });
        }
        const placeholder = await channel.send({ content: '🧩 Setting up Word Scramble...' });
        const game = wsService.createLobby({ channelId: channel.id, messageId: placeholder.id, creatorId: user.id, gatherSecs });
        await placeholder.edit({ content: '', embeds: [wsService.buildLobbyEmbed(game, guildId)] });
        await placeholder.react(wsService.JOIN_EMOJI).catch(() => {});
        await interaction.editReply({ content: `✅ Word Scramble lobby created! React ${wsService.JOIN_EMOJI} to join. Starts in **${gatherSecs}s**.` });

        game.gatherTimer = setTimeout(async () => {
          try {
            if (game.status !== 'waiting') return;
            if (game.players.size < 2) {
              await placeholder.edit({ embeds: [wsService.buildCancelledEmbed('❌ Not enough players. Game cancelled.', guildId)] });
              await placeholder.reactions.removeAll().catch(() => {});
              wsService.endGame(game.lobbyMessageId); return;
            }
            await runGame(game, placeholder, guildId);
          } catch (err) { logger.error('[WordScramble] runGame error:', err); wsService.endGame(game.lobbyMessageId); }
        }, gatherSecs * 1000);
        return;
      }

      if (sub === 'cancel') {
        await interaction.deferReply({ ephemeral: true });
        let found = null;
        for (const [, g] of wsService._games) { if (g.channelId === channel.id && g.status === 'waiting' && g.creatorId === user.id) { found = g; break; } }
        if (!found) return interaction.editReply({ content: '❌ No open Word Scramble lobby found for you here.' });
        try { const msg = await channel.messages.fetch(found.lobbyMessageId); await msg.edit({ embeds: [wsService.buildCancelledEmbed('❌ Cancelled by host.', guildId)] }); await msg.reactions.removeAll().catch(() => {}); } catch (_) {}
        wsService.endGame(found.lobbyMessageId);
        return interaction.editReply({ content: '✅ Lobby cancelled.' });
      }
    } catch (err) {
      logger.error('[WordScramble] error:', err);
      try { const r = { content: '❌ Error occurred.', ephemeral: true }; if (interaction.deferred || interaction.replied) await interaction.editReply(r); else await interaction.reply(r); } catch (_) {}
    }
  },
};
