const { SlashCommandBuilder } = require('discord.js');
const gnService   = require('../../services/gameNightService');
const moduleGuard = require('../../utils/moduleGuard');
const logger      = require('../../utils/logger');

const GAME_CHOICES = gnService.GAME_ROSTER.map(g => {
  const labels = { diceduel:'Dice Duel', higherlower:'Higher or Lower', reactionrace:'Reaction Race', numberguess:'Number Guess', slots:'Slots', trivia:'Trivia', wordscramble:'Word Scramble', rps:'RPS Tournament', blackjack:'Blackjack' };
  return { name: labels[g] || g, value: g };
});

module.exports = {
  data: new SlashCommandBuilder()
    .setName('gamenight')
    .setDescription('🎉 Game Night — multi-game session with cross-game scoring (Growth plan)')
    .addSubcommand(s => s
      .setName('start')
      .setDescription('Start a Game Night lobby')
      .addIntegerOption(o => o.setName('join_time').setDescription('Seconds to gather players (30–180, default 90)').setMinValue(30).setMaxValue(180).setRequired(false))
      .addStringOption(o => o.setName('games').setDescription('Comma-separated game list, e.g. diceduel,trivia,slots (default: all 9)').setRequired(false))
    )
    .addSubcommand(s => s.setName('skip').setDescription('Skip the current game (host only)'))
    .addSubcommand(s => s.setName('cancel').setDescription('Cancel the Game Night lobby or session (host only)'))
    .addSubcommand(s => s.setName('leaderboard').setDescription('Show current Game Night leaderboard')),

  async execute(interaction) {
    try {
      // Module + permission check
      if (!await moduleGuard.checkModuleEnabled(interaction, 'battle')) return;
      if (!await moduleGuard.checkAdminOrModerator(interaction)) return;
      // Plan check — Growth minimum
      if (!await moduleGuard.checkMinimumPlan(interaction, 'growth')) return;

      const sub     = interaction.options.getSubcommand();
      const { guildId, user, channel } = interaction;

      // ── /gamenight start ────────────────────────────────────────────────
      if (sub === 'start') {
        const gatherSecs = interaction.options.getInteger('join_time') || 90;
        const gamesRaw   = interaction.options.getString('games');
        const selectedGames = gamesRaw
          ? gamesRaw.split(',').map(s => s.trim().toLowerCase()).filter(s => gnService.GAME_ROSTER.includes(s))
          : [];

        await interaction.deferReply({ ephemeral: true });

        // Only one Game Night per channel
        if (gnService.getSession(channel.id)) {
          return interaction.editReply({ content: '❌ A Game Night is already running in this channel.' });
        }

        if (selectedGames.length === 0 && gamesRaw) {
          return interaction.editReply({ content: `❌ None of those game names are valid.\nValid: \`${gnService.GAME_ROSTER.join(', ')}\`` });
        }

        const placeholder = await channel.send({ content: '🎉 Setting up Game Night...' });
        const session = gnService.createSession({
          channelId: channel.id, messageId: placeholder.id,
          creatorId: user.id, gatherSecs,
          selectedGames: selectedGames.length > 0 ? selectedGames : [...gnService.GAME_ROSTER],
        });

        await placeholder.edit({ content: '', embeds: [gnService.buildLobbyEmbed(session, guildId)] });
        await placeholder.react(gnService.JOIN_EMOJI).catch(() => {});

        const gameList = (selectedGames.length > 0 ? selectedGames : gnService.GAME_ROSTER).length;
        await interaction.editReply({ content: `✅ Game Night lobby open! ${gameList} games queued.\nReact ${gnService.JOIN_EMOJI} to join. Starts in **${gatherSecs}s**.` });

        session.gatherTimer = setTimeout(async () => {
          try {
            if (session.status !== 'waiting') return;

            if (session.players.size < 2) {
              await placeholder.edit({ embeds: [gnService.buildCancelledEmbed('❌ Not enough players — Game Night cancelled.', guildId)] });
              await placeholder.reactions.removeAll().catch(() => {});
              gnService.endSession(channel.id);
              return;
            }

            // Lock lobby
            await placeholder.edit({ embeds: [gnService.buildCancelledEmbed(`✅ Lobby closed — **${session.players.size} players** locked in! Game Night starting shortly...`, guildId)] });
            await placeholder.reactions.removeAll().catch(() => {});

            await gnService.run(session, channel, guildId);
          } catch (err) {
            logger.error('[GameNight] run error:', err);
            await channel.send({ embeds: [gnService.buildCancelledEmbed('❌ An error occurred during Game Night.', guildId)] }).catch(() => {});
            gnService.endSession(channel.id);
          }
        }, gatherSecs * 1000);

        return;
      }

      // ── /gamenight skip ─────────────────────────────────────────────────
      if (sub === 'skip') {
        await interaction.deferReply({ ephemeral: true });
        const session = gnService.getSession(channel.id);
        if (!session) return interaction.editReply({ content: '❌ No active Game Night in this channel.' });
        if (session.creatorId !== user.id) return interaction.editReply({ content: '❌ Only the Game Night host can skip games.' });
        if (session.status !== 'playing') return interaction.editReply({ content: '❌ Game Night isn\'t in progress yet.' });
        session.skipRequested = true;
        const GL = gnService.GAME_INFO;
        const current = GL[session.games[session.currentGameIndex]]?.name || session.games[session.currentGameIndex];
        await channel.send(`⏭️ **${user.username}** skipped **${current}**. Moving to next game...`);
        return interaction.editReply({ content: `✅ Skipped ${current}.` });
      }

      // ── /gamenight cancel ───────────────────────────────────────────────
      if (sub === 'cancel') {
        await interaction.deferReply({ ephemeral: true });
        const session = gnService.getSession(channel.id);
        if (!session) return interaction.editReply({ content: '❌ No active Game Night in this channel.' });
        if (session.creatorId !== user.id) return interaction.editReply({ content: '❌ Only the host can cancel Game Night.' });
        try {
          const msg = await channel.messages.fetch(session.lobbyMessageId);
          await msg.edit({ embeds: [gnService.buildCancelledEmbed('❌ Game Night cancelled by host.', guildId)] });
          await msg.reactions.removeAll().catch(() => {});
        } catch (_) {}
        gnService.endSession(channel.id);
        return interaction.editReply({ content: '✅ Game Night cancelled.' });
      }

      // ── /gamenight leaderboard ──────────────────────────────────────────
      if (sub === 'leaderboard') {
        const session = gnService.getSession(channel.id);
        if (!session || session.status === 'waiting') {
          return interaction.reply({ content: '❌ No active Game Night in progress.', ephemeral: true });
        }
        const GL = gnService.GAME_INFO;
        const currentGame = GL[session.games[session.currentGameIndex]]?.name || '?';
        const gamesLeft = session.games.length - session.currentGameIndex - 1;
        await interaction.reply({ embeds: [gnService.buildLeaderboardEmbed(session, guildId, `game ${session.currentGameIndex + 1}`, gamesLeft)], ephemeral: false });
      }

    } catch (err) {
      logger.error('[GameNight] command error:', err);
      try {
        const r = { content: '❌ Something went wrong.', ephemeral: true };
        if (interaction.deferred || interaction.replied) await interaction.editReply(r);
        else await interaction.reply(r);
      } catch (_) {}
    }
  },
};
