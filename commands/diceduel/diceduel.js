const { SlashCommandBuilder } = require('discord.js');
const ddService = require('../../services/diceDuelService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

const ROUND_DELAY_MS  = 3500;
const RESULT_DELAY_MS = 4000;
const MAX_TIEBREAKER  = 5;   // max tiebreaker rounds before declaring a draw

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Game runner ───────────────────────────────────────────────────────────────
async function runGame(game, lobbyMessage, guildId) {
  const channel = lobbyMessage.channel;

  // Mark started, clean up lobby
  try {
    const startedEmbed = ddService.buildCancelledEmbed('✅ Game started! Good luck everyone! 🎲', guildId);
    await lobbyMessage.edit({ embeds: [startedEmbed] });
    await lobbyMessage.reactions.removeAll().catch(() => {});
  } catch (_) {}

  const alive = () => ddService.activePlayers(game);

  while (alive().length > 1) {
    game.roundNumber++;
    await sleep(ROUND_DELAY_MS);

    // Initial roll
    let result = ddService.rollRound(game);
    let roundEmbed = ddService.buildRoundEmbed({ game, ...result, guildId });
    await channel.send({ embeds: [roundEmbed] });

    // Handle tiebreaker at the bottom
    let tbRound = 0;
    while (result.needsTiebreaker && tbRound < MAX_TIEBREAKER) {
      tbRound++;
      await sleep(ROUND_DELAY_MS);

      const tbIds = result.atMin;
      result = ddService.rollRound(game, tbIds);
      roundEmbed = ddService.buildRoundEmbed({ game, ...result, isTiebreaker: true, guildId });
      await channel.send({ embeds: [roundEmbed] });
    }

    // If still tied after max tiebreakers, eliminate all tied players
    if (result.needsTiebreaker) {
      for (const id of result.atMin) game.eliminated.add(id);
      result.losers = result.atMin;
      result.needsTiebreaker = false;
    }

    if (result.losers.length > 0) {
      await sleep(1500);
      const elimEmbed = ddService.buildEliminationEmbed({
        losers: result.losers,
        roundNumber: game.roundNumber,
        remaining: alive().length,
        guildId,
      });
      await channel.send({ embeds: [elimEmbed] });
    }

    if (alive().length <= 1) break;
    await sleep(RESULT_DELAY_MS);
  }

  // ── End ─────────────────────────────────────────────────────────────────────
  const survivors = alive();
  if (survivors.length === 1) {
    const winEmbed = ddService.buildWinnerEmbed({
      winnerId: survivors[0],
      roundsPlayed: game.roundNumber,
      guildId,
    });
    await channel.send({ content: `🏆 <@${survivors[0]}>`, embeds: [winEmbed] });
  } else if (survivors.length === 0) {
    await channel.send({ embeds: [ddService.buildCancelledEmbed('💀 Everyone eliminated — no winner this time!', guildId)] });
  } else {
    const mentions = survivors.map(id => `<@${id}>`).join(', ');
    await channel.send({ content: `🏆 Multiple survivors: ${mentions}`, embeds: [ddService.buildCancelledEmbed(`🤝 Draw! Survivors: ${mentions}`, guildId)] });
  }

  ddService.endGame(game.lobbyMessageId);
}

// ── Slash command ─────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('diceduel')
    .setDescription('🎲 Dice Duel — last roller standing wins')
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('Start a Dice Duel lobby')
        .addIntegerOption(opt =>
          opt.setName('join_time')
            .setDescription('Seconds to gather players (10–120, default 60)')
            .setMinValue(10).setMaxValue(120).setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('cancel')
        .setDescription('Cancel the current Dice Duel lobby')
    ),

  async execute(interaction) {
    try {
      const allowed = await moduleGuard.checkModuleEnabled(interaction, 'battle');
      if (!allowed) return;

      const sub     = interaction.options.getSubcommand();
      const guildId = interaction.guildId;
      const userId  = interaction.user.id;
      const channel = interaction.channel;

      if (sub === 'start') {
        const gatherSecs = interaction.options.getInteger('join_time') || 60;
        await interaction.deferReply({ ephemeral: true });

        for (const [, g] of ddService._games) {
          if (g.channelId === channel.id && g.status === 'waiting') {
            return interaction.editReply({ content: '❌ There is already a Dice Duel lobby open in this channel.' });
          }
        }

        const placeholder = await channel.send({ content: '🎲 Setting up Dice Duel...' });
        const game = ddService.createLobby({ channelId: channel.id, messageId: placeholder.id, creatorId: userId, gatherSecs });

        await placeholder.edit({ content: '', embeds: [ddService.buildLobbyEmbed(game, guildId)] });
        await placeholder.react(ddService.JOIN_EMOJI).catch(() => {});

        await interaction.editReply({ content: `✅ Dice Duel lobby created! React ${ddService.JOIN_EMOJI} to join. Starting in **${gatherSecs}s**.` });
        logger.log(`[DiceDuel] ${interaction.user.username} created lobby`);

        game.gatherTimer = setTimeout(async () => {
          try {
            if (game.status !== 'waiting') return;
            if (game.players.size < 2) {
              await placeholder.edit({ embeds: [ddService.buildCancelledEmbed('❌ Not enough players (need at least 2). Game cancelled.', guildId)] });
              await placeholder.reactions.removeAll().catch(() => {});
              ddService.endGame(game.lobbyMessageId);
              return;
            }
            await runGame(game, placeholder, guildId);
          } catch (err) {
            logger.error('[DiceDuel] runGame error:', err);
            ddService.endGame(game.lobbyMessageId);
          }
        }, gatherSecs * 1000);

        return;
      }

      if (sub === 'cancel') {
        await interaction.deferReply({ ephemeral: true });
        let found = null;
        for (const [, g] of ddService._games) {
          if (g.channelId === channel.id && g.status === 'waiting' && g.creatorId === userId) { found = g; break; }
        }
        if (!found) return interaction.editReply({ content: '❌ No open Dice Duel lobby found for you in this channel.' });

        try {
          const msg = await channel.messages.fetch(found.lobbyMessageId);
          await msg.edit({ embeds: [ddService.buildCancelledEmbed('❌ Game cancelled by the host.', guildId)] });
          await msg.reactions.removeAll().catch(() => {});
        } catch (_) {}

        ddService.endGame(found.lobbyMessageId);
        logger.log(`[DiceDuel] ${interaction.user.username} cancelled lobby`);
        return interaction.editReply({ content: '✅ Dice Duel lobby cancelled.' });
      }

    } catch (err) {
      logger.error('[DiceDuel] command error:', err);
      try {
        const r = { content: '❌ An error occurred.', ephemeral: true };
        if (interaction.deferred || interaction.replied) await interaction.editReply(r);
        else await interaction.reply(r);
      } catch (_) {}
    }
  },
};
