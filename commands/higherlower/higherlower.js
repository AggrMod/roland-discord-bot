const { SlashCommandBuilder } = require('discord.js');
const hlService = require('../../services/higherLowerService');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

const ROUND_SECS  = 60;  // seconds per round for players to react
const RESULT_SECS = 6;   // pause between result and next round
const MAX_GATHER_SECS = 120;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Game runner ───────────────────────────────────────────────────────────────
async function runGame(client, game, lobbyMessage, guildId) {
  const channel = lobbyMessage.channel;

  // Start
  const startResult = hlService.startGame(game.lobbyMessageId);
  if (!startResult.success) {
    await channel.send({ content: `❌ Could not start Higher or Lower: ${startResult.reason}` });
    hlService.endGame(game.lobbyMessageId);
    return;
  }

  // Update lobby message to show game started
  try {
    const startedEmbed = hlService.buildCancelledEmbed('✅ Game has started! Good luck everyone!', guildId);
    await lobbyMessage.edit({ embeds: [startedEmbed] });
    await lobbyMessage.reactions.removeAll().catch(() => {});
  } catch (_) {}

  const alive = () => hlService.activePlayers(game);

  // ── Round loop ──────────────────────────────────────────────────────────────
  while (alive().length > 1 && game.deck.length > 0) {
    const roundEmbed = hlService.buildRoundEmbed(game, guildId);
    const roundMsg = await channel.send({ embeds: [roundEmbed] });

    // Register for reaction handler
    hlService.registerRoundMessage(roundMsg.id, game);
    game.roundMessageId = roundMsg.id;

    // Add reaction options
    await roundMsg.react(hlService.HIGHER_EMOJI).catch(() => {});
    await roundMsg.react(hlService.LOWER_EMOJI).catch(() => {});

    // Wait for guesses
    await sleep(ROUND_SECS * 1000);

    // Clean up round message registration
    hlService.registerRoundMessage(roundMsg.id, null);  // unlink so late reacts are ignored

    // Resolve
    const result = hlService.resolveRound(game);
    const resultEmbed = hlService.buildResultEmbed({ game, result, guildId });
    await channel.send({ embeds: [resultEmbed] });

    if (alive().length <= 1) break;
    if (game.deck.length === 0) break;

    await sleep(RESULT_SECS * 1000);
  }

  // ── Game over ───────────────────────────────────────────────────────────────
  const survivors = alive();
  if (survivors.length === 1) {
    const winnerEmbed = hlService.buildWinnerEmbed({
      winnerId: survivors[0],
      roundsPlayed: game.roundNumber - 1,
      guildId,
    });
    await channel.send({ content: `🏆 <@${survivors[0]}>`, embeds: [winnerEmbed] });
  } else if (survivors.length === 0) {
    const noSurvEmbed = hlService.buildNoSurvivorsEmbed({ roundsPlayed: game.roundNumber - 1, guildId });
    await channel.send({ embeds: [noSurvEmbed] });
  } else {
    // Deck ran out with multiple survivors — everyone remaining wins
    const winnerEmbed = hlService.buildWinnerEmbed({
      winnerId: survivors[0],  // first survivor
      roundsPlayed: game.roundNumber - 1,
      guildId,
    });
    const mentions = survivors.map(id => `<@${id}>`).join(', ');
    await channel.send({
      content: `🏆 Deck ran out! Survivors: ${mentions}`,
      embeds: [winnerEmbed],
    });
  }

  hlService.endGame(game.lobbyMessageId);
}

// ── Slash command ─────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('higherlower')
    .setDescription('🃏 Higher or Lower card game')
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('Start a Higher or Lower game lobby')
        .addIntegerOption(opt =>
          opt.setName('join_time')
            .setDescription(`Seconds to gather players (10–${MAX_GATHER_SECS}, default 60)`)
            .setMinValue(10)
            .setMaxValue(MAX_GATHER_SECS)
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('cancel')
        .setDescription('Cancel the current Higher or Lower lobby')
    ),

  async execute(interaction) {
    try {
      const allowed = await moduleGuard.checkModuleEnabled(interaction, 'battle');
      if (!allowed) return;

      const sub     = interaction.options.getSubcommand();
      const guildId = interaction.guildId;
      const userId  = interaction.user.id;
      const channel = interaction.channel;

      // ── /higherlower start ────────────────────────────────────────────────
      if (sub === 'start') {
        const gatherSecs = interaction.options.getInteger('join_time') || 60;

        await interaction.deferReply({ ephemeral: true });

        // Check for an existing game in this channel
        for (const [, g] of hlService._games) {
          if (g.channelId === channel.id && g.status === 'waiting') {
            return interaction.editReply({ content: '❌ There is already a Higher or Lower lobby open in this channel.' });
          }
        }

        // Post lobby embed placeholder
        const placeholder = await channel.send({ content: '🃏 Setting up Higher or Lower...' });

        const game = hlService.createLobby({
          channelId: channel.id,
          messageId: placeholder.id,
          creatorId: userId,
          gatherSecs,
        });

        const lobbyEmbed = hlService.buildLobbyEmbed(game, guildId);
        await placeholder.edit({ content: '', embeds: [lobbyEmbed] });
        await placeholder.react(hlService.JOIN_EMOJI).catch(() => {});

        await interaction.editReply({ content: `✅ Higher or Lower lobby created! Players react ${hlService.JOIN_EMOJI} to join. Starting in **${gatherSecs}s**.` });
        logger.log(`[HigherLower] ${interaction.user.username} created lobby in ${channel.id}`);

        // ── Gather timer ──────────────────────────────────────────────────
        game.gatherTimer = setTimeout(async () => {
          try {
            if (game.status !== 'waiting') return;

            if (game.players.size < 2) {
              const cancelEmbed = hlService.buildCancelledEmbed(
                `❌ Not enough players joined (need at least 2). Game cancelled.`, guildId
              );
              await placeholder.edit({ embeds: [cancelEmbed] });
              await placeholder.reactions.removeAll().catch(() => {});
              hlService.endGame(game.lobbyMessageId);
              return;
            }

            await runGame(interaction.client, game, placeholder, guildId);
          } catch (err) {
            logger.error('[HigherLower] runGame error:', err);
            hlService.endGame(game.lobbyMessageId);
          }
        }, gatherSecs * 1000);

        return;
      }

      // ── /higherlower cancel ───────────────────────────────────────────────
      if (sub === 'cancel') {
        await interaction.deferReply({ ephemeral: true });

        // Find open lobby in this channel created by this user
        let found = null;
        for (const [, g] of hlService._games) {
          if (g.channelId === channel.id && g.status === 'waiting' && g.creatorId === userId) {
            found = g;
            break;
          }
        }

        if (!found) {
          return interaction.editReply({ content: '❌ No open Higher or Lower lobby found for you in this channel.' });
        }

        try {
          const msg = await channel.messages.fetch(found.lobbyMessageId);
          const cancelEmbed = hlService.buildCancelledEmbed('❌ Game cancelled by the host.', guildId);
          await msg.edit({ embeds: [cancelEmbed] });
          await msg.reactions.removeAll().catch(() => {});
        } catch (_) {}

        hlService.endGame(found.lobbyMessageId);
        logger.log(`[HigherLower] ${interaction.user.username} cancelled lobby`);
        return interaction.editReply({ content: '✅ Higher or Lower lobby cancelled.' });
      }

    } catch (err) {
      logger.error('[HigherLower] command error:', err);
      try {
        const reply = { content: '❌ An error occurred. Please try again.', ephemeral: true };
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(reply);
        } else {
          await interaction.reply(reply);
        }
      } catch (_) {}
    }
  },
};
