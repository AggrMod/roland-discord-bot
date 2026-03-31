const { SlashCommandBuilder } = require('discord.js');
const gnService = require('../../services/gameNightService');
const moduleGuard = require('../../utils/moduleGuard');
const logger = require('../../utils/logger');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const VALID_GAME_KEYS = gnService.GAME_KEYS;
const GAME_META = gnService.GAME_META;

// ── Main game night runner ─────────────────────────────────────────────────
async function runGameNight(session, lobbyMessage, guildId) {
  const channel = lobbyMessage.channel;
  session.status = 'playing';

  // Edit lobby to "started"
  try {
    await lobbyMessage.edit({ embeds: [gnService.buildCancelledEmbed('🎮 Game Night has started! Get ready...', guildId)] });
    await lobbyMessage.reactions.removeAll().catch(() => {});
  } catch (_) {}

  const players = [...session.players];
  const total = session.games.length;

  for (let i = 0; i < total; i++) {
    if (session.status === 'ended') break;
    const gameKey = session.games[i];
    session.currentGameIndex = i;

    // Pre-game announcement
    await sleep(3000);
    await channel.send({ embeds: [gnService.buildPreGameEmbed({ gameIndex: i, total, gameKey, guildId })] });
    await sleep(10000);

    // Run the game
    let ranked = [];
    try {
      ranked = await gnService.runGame(gameKey, channel, guildId, players);
    } catch (err) {
      logger.error(`[GameNight] Error in game ${gameKey}:`, err);
      await channel.send({ embeds: [gnService.buildCancelledEmbed(`⚠️ Error in ${GAME_META[gameKey]?.name || gameKey} — skipping.`, guildId)] });
      ranked = [...players]; // No change to scores
    }

    // Award points
    gnService.awardPoints(session, ranked);

    // Leaderboard
    await sleep(2000);
    await channel.send({ embeds: [gnService.buildLeaderboardEmbed({ session, gameIndex: i, total, lastGameKey: gameKey, ranked, guildId })] });

    if (i < total - 1) {
      await sleep(8000); // Breather between games
    }
  }

  // Crown champion
  await sleep(3000);
  const sorted = gnService.sortedScores(session);
  const champMention = sorted.length ? `<@${sorted[0][0]}>` : '';
  await channel.send({ content: champMention, embeds: [gnService.buildChampionEmbed({ session, guildId })] });
  gnService.endSession(session.lobbyMessageId);
}

// ── Reaction handler (lobby join/leave) ───────────────────────────────────
// Registered in index.js via gameRegistry — see JOIN_EMOJI
const gameRegistry = require('../../services/gameRegistry');
gameRegistry.register(gnService.JOIN_EMOJI, {
  JOIN_EMOJI: gnService.JOIN_EMOJI,
  getGameByLobby: (id) => gnService.getByLobby(id),
  addPlayer: (id, userId, username) => gnService.addPlayer(id, userId, username),
  removePlayer: (id, userId) => gnService.removePlayer(id, userId),
  buildLobbyEmbed: (session, guildId) => gnService.buildLobbyEmbed(session, guildId),
});

// ── Command definition ─────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('gamenight')
    .setDescription('🎮 Game Night — multi-game community event!')
    .addSubcommand(s => s.setName('start')
      .setDescription('Start a Game Night session (Growth plan required)')
      .addStringOption(o => o.setName('games')
        .setDescription('Comma-separated game keys to include (default: all). E.g: diceduel,trivia,slots')
        .setRequired(false))
      .addIntegerOption(o => o.setName('join_time')
        .setDescription('Seconds to gather players (30–180, default 90)')
        .setMinValue(30).setMaxValue(180).setRequired(false)))
    .addSubcommand(s => s.setName('skip')
      .setDescription('Skip the current game in the rotation (host only)'))
    .addSubcommand(s => s.setName('cancel')
      .setDescription('Cancel the current Game Night session (host only)'))
    .addSubcommand(s => s.setName('games')
      .setDescription('List all available game keys and their descriptions')),

  async execute(interaction) {
    try {
      const sub = interaction.options.getSubcommand();
      const { guildId, user, channel } = interaction;

      // ── /gamenight games ── (no auth needed)
      if (sub === 'games') {
        const list = VALID_GAME_KEYS.map(k => {
          const m = GAME_META[k];
          return `${m.icon} \`${k}\` — **${m.name}**: ${m.desc}`;
        }).join('\n');
        return interaction.reply({
          content: `**🎮 Available Game Night games:**\n${list}\n\nUse in \`/gamenight start games:diceduel,trivia,slots\``,
          ephemeral: true,
        });
      }

      // ── Auth gates ─────────────────────────────────────────────────────
      if (!await moduleGuard.checkModuleEnabled(interaction, 'battle')) return;
      if (!await moduleGuard.checkAdminOrModerator(interaction)) return;
      if (!await moduleGuard.checkMinimumPlan(interaction, 'growth')) return;

      // ── /gamenight start ───────────────────────────────────────────────
      if (sub === 'start') {
        await interaction.deferReply({ ephemeral: true });

        // Check for existing session
        const existing = gnService.getByChannel(channel.id);
        if (existing) return interaction.editReply({ content: '❌ A Game Night session is already active in this channel.' });

        const gatherSecs = interaction.options.getInteger('join_time') || 90;
        const gamesInput = interaction.options.getString('games');
        let games = [...VALID_GAME_KEYS]; // default: all

        if (gamesInput) {
          const keys = gamesInput.split(',').map(k => k.trim().toLowerCase()).filter(k => VALID_GAME_KEYS.includes(k));
          if (keys.length === 0) {
            return interaction.editReply({
              content: `❌ No valid game keys found. Valid keys: \`${VALID_GAME_KEYS.join(', ')}\``,
            });
          }
          games = keys;
        }

        const placeholder = await channel.send({ content: '🎮 Setting up Game Night...' });
        const session = gnService.createSession({ channelId: channel.id, messageId: placeholder.id, creatorId: user.id, gatherSecs, games });

        await placeholder.edit({ content: '', embeds: [gnService.buildLobbyEmbed(session, guildId)] });
        await placeholder.react(gnService.JOIN_EMOJI).catch(() => {});
        await interaction.editReply({ content: `✅ Game Night lobby created with **${games.length} game${games.length === 1 ? '' : 's'}**! React ${gnService.JOIN_EMOJI} to join. Starting in **${gatherSecs}s**.` });

        session.gatherTimer = setTimeout(async () => {
          try {
            if (session.status !== 'waiting') return;
            if (session.players.size < 2) {
              await placeholder.edit({ embeds: [gnService.buildCancelledEmbed('❌ Not enough players. Game Night cancelled.', guildId)] });
              await placeholder.reactions.removeAll().catch(() => {});
              gnService.endSession(session.lobbyMessageId);
              return;
            }
            await runGameNight(session, placeholder, guildId);
          } catch (err) {
            logger.error('[GameNight] Fatal error:', err);
            try { await channel.send({ embeds: [gnService.buildCancelledEmbed('❌ Game Night encountered an error. Session ended.', guildId)] }); } catch (_) {}
            gnService.endSession(session.lobbyMessageId);
          }
        }, gatherSecs * 1000);

        return;
      }

      // ── /gamenight skip ────────────────────────────────────────────────
      if (sub === 'skip') {
        await interaction.deferReply({ ephemeral: true });
        const session = gnService.getByChannel(channel.id);
        if (!session) return interaction.editReply({ content: '❌ No active Game Night session in this channel.' });
        if (session.creatorId !== user.id) return interaction.editReply({ content: '❌ Only the host can skip games.' });
        if (session.status !== 'playing') return interaction.editReply({ content: '❌ Game Night is not currently running.' });
        session.skipped = true;
        await channel.send({ embeds: [gnService.buildCancelledEmbed('⏭️ Host skipped this game. Moving on...', guildId)] });
        return interaction.editReply({ content: '✅ Skip signal sent.' });
      }

      // ── /gamenight cancel ──────────────────────────────────────────────
      if (sub === 'cancel') {
        await interaction.deferReply({ ephemeral: true });
        const session = gnService.getByChannel(channel.id);
        if (!session) return interaction.editReply({ content: '❌ No active Game Night session in this channel.' });
        if (session.creatorId !== user.id) return interaction.editReply({ content: '❌ Only the host can cancel.' });

        try {
          const msg = await channel.messages.fetch(session.lobbyMessageId);
          await msg.edit({ embeds: [gnService.buildCancelledEmbed('❌ Game Night cancelled by host.', guildId)] });
          await msg.reactions.removeAll().catch(() => {});
        } catch (_) {}

        gnService.endSession(session.lobbyMessageId);
        return interaction.editReply({ content: '✅ Game Night cancelled.' });
      }

    } catch (err) {
      logger.error('[GameNight] execute error:', err);
      try {
        const r = { content: '❌ An error occurred.', ephemeral: true };
        if (interaction.deferred || interaction.replied) await interaction.editReply(r);
        else await interaction.reply(r);
      } catch (_) {}
    }
  },
};
