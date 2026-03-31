const { SlashCommandBuilder } = require('discord.js');
const rpsService = require('../../services/rpsService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runMatchup(channel, game, playerA, playerB, guildId) {
  game.round++;
  const matchMsg = await channel.send({ embeds: [rpsService.buildMatchupEmbed({ round: game.round, playerA, playerB, guildId })] });
  for (const e of rpsService.CHOICES) await matchMsg.react(e).catch(() => {});

  // Collect one reaction per player
  const picks = new Map();
  const collector = matchMsg.createReactionCollector({
    filter: (r, u) => rpsService.CHOICES.includes(r.emoji.name) && !u.bot && [playerA, playerB].includes(u.id),
    time: rpsService.MATCH_SECS * 1000,
  });
  collector.on('collect', (r, u) => {
    if (!picks.has(u.id)) picks.set(u.id, r.emoji.name);
  });
  await new Promise(resolve => collector.on('end', resolve));

  const choiceA = picks.get(playerA) || null;
  const choiceB = picks.get(playerB) || null;
  const result = rpsService.resolveMatchup(choiceA, choiceB, playerA, playerB);

  await channel.send({ embeds: [rpsService.buildMatchupResultEmbed({ round: game.round, playerA, choiceA, playerB, choiceB, result, guildId })] });

  if (!result.draw && result.loser) {
    game.eliminated.add(result.loser);
  }

  return result;
}

async function runGame(game, lobbyMessage, guildId) {
  const channel = lobbyMessage.channel;
  try {
    await lobbyMessage.edit({ embeds: [rpsService.buildCancelledEmbed('✅ RPS Tournament starting! 🪨✂️📄', guildId)] });
    await lobbyMessage.reactions.removeAll().catch(() => {});
  } catch (_) {}

  game.status = 'playing';
  let totalRounds = 0;

  while (rpsService.activePlayers(game).length > 1) {
    const { matchups, bye } = rpsService.buildMatchups(game);
    if (bye) await channel.send({ embeds: [rpsService.buildByeEmbed({ round: totalRounds + 1, playerId: bye, guildId })] });

    for (const [pA, pB] of matchups) {
      await sleep(2000);
      await runMatchup(channel, game, pA, pB, guildId);
      totalRounds++;
    }

    await sleep(2000);
  }

  const survivors = rpsService.activePlayers(game);
  if (survivors.length === 1) {
    await channel.send({ content: `🏆 <@${survivors[0]}>`, embeds: [rpsService.buildWinnerEmbed({ winnerId: survivors[0], rounds: totalRounds, guildId })] });
  } else {
    const mention = survivors.map(id => `<@${id}>`).join(', ');
    await channel.send({ embeds: [rpsService.buildCancelledEmbed(`🤝 Draw! ${mention} are the co-champions!`, guildId)] });
  }
  rpsService.endGame(game.lobbyMessageId);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rps')
    .setDescription('🪨 RPS Tournament — rock, paper, scissors bracket!')
    .addSubcommand(s => s.setName('start').setDescription('Start an RPS Tournament')
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
        for (const [, g] of rpsService._games) {
          if (g.channelId === channel.id && g.status === 'waiting')
            return interaction.editReply({ content: '❌ An RPS Tournament is already open here.' });
        }
        const placeholder = await channel.send({ content: '🪨 Setting up RPS Tournament...' });
        const game = rpsService.createLobby({ channelId: channel.id, messageId: placeholder.id, creatorId: user.id, gatherSecs });
        await placeholder.edit({ content: '', embeds: [rpsService.buildLobbyEmbed(game, guildId)] });
        await placeholder.react(rpsService.JOIN_EMOJI).catch(() => {});
        await interaction.editReply({ content: `✅ RPS Tournament created! React ${rpsService.JOIN_EMOJI} to join. Starts in **${gatherSecs}s**.` });

        game.gatherTimer = setTimeout(async () => {
          try {
            if (game.status !== 'waiting') return;
            if (game.players.size < 2) {
              await placeholder.edit({ embeds: [rpsService.buildCancelledEmbed('❌ Not enough players. Game cancelled.', guildId)] });
              await placeholder.reactions.removeAll().catch(() => {});
              rpsService.endGame(game.lobbyMessageId); return;
            }
            await runGame(game, placeholder, guildId);
          } catch (err) { logger.error('[RPS] runGame error:', err); rpsService.endGame(game.lobbyMessageId); }
        }, gatherSecs * 1000);
        return;
      }

      if (sub === 'cancel') {
        await interaction.deferReply({ ephemeral: true });
        let found = null;
        for (const [, g] of rpsService._games) { if (g.channelId === channel.id && g.status === 'waiting' && g.creatorId === user.id) { found = g; break; } }
        if (!found) return interaction.editReply({ content: '❌ No open RPS Tournament found for you here.' });
        try { const msg = await channel.messages.fetch(found.lobbyMessageId); await msg.edit({ embeds: [rpsService.buildCancelledEmbed('❌ Cancelled by host.', guildId)] }); await msg.reactions.removeAll().catch(() => {}); } catch (_) {}
        rpsService.endGame(found.lobbyMessageId);
        return interaction.editReply({ content: '✅ Tournament cancelled.' });
      }
    } catch (err) {
      logger.error('[RPS] error:', err);
      try { const r = { content: '❌ Error occurred.', ephemeral: true }; if (interaction.deferred || interaction.replied) await interaction.editReply(r); else await interaction.reply(r); } catch (_) {}
    }
  },
};
