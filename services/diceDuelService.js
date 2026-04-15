const { EmbedBuilder } = require('discord.js');
const { applyEmbedBranding, getBranding } = require('./embedBranding');
const logger = require('../utils/logger');

const JOIN_EMOJI = '🎲';
const ROUND_DELAY_MS = 3500; // pause between rolls for drama
const RESULT_DELAY_MS = 5000; // pause before next round

class DiceDuelService {
  constructor() {
    this._games = new Map(); // lobbyMessageId → game
  }

  get JOIN_EMOJI() { return JOIN_EMOJI; }

  // ── Dice helpers ────────────────────────────────────────────────────────────
  roll(sides = 6) {
    return Math.floor(Math.random() * sides) + 1;
  }

  dieFace(n) {
    return ['⚀','⚁','⚂','⚃','⚄','⚅'][n - 1] || `**${n}**`;
  }

  // ── Lobby ───────────────────────────────────────────────────────────────────
  createLobby({ channelId, messageId, creatorId, gatherSecs = 60 }) {
    const game = {
      lobbyMessageId: messageId,
      channelId,
      creatorId,
      gatherSecs,
      status: 'waiting',
      players: new Set(),      // userId
      playerNames: new Map(),  // userId → username
      eliminated: new Set(),
      roundNumber: 0,
      gatherTimer: null,
    };
    this._games.set(messageId, game);
    return game;
  }

  getGameByLobby(messageId) { return this._games.get(messageId) || null; }

  addPlayer(lobbyMessageId, userId, username) {
    const game = this._games.get(lobbyMessageId);
    if (!game || game.status !== 'waiting') return { success: false };
    if (game.players.has(userId)) return { success: false, reason: 'already_joined' };
    game.players.add(userId);
    game.playerNames.set(userId, username || userId);
    return { success: true, count: game.players.size };
  }

  removePlayer(lobbyMessageId, userId) {
    const game = this._games.get(lobbyMessageId);
    if (!game || game.status !== 'waiting') return { success: false };
    game.players.delete(userId);
    game.playerNames.delete(userId);
    return { success: true, count: game.players.size };
  }

  startGame(lobbyMessageId) {
    const game = this._games.get(lobbyMessageId);
    if (!game) return { success: false, reason: 'not_found' };
    if (game.players.size < 2) return { success: false, reason: 'not_enough_players' };
    game.status = 'playing';
    game.roundNumber = 1;
    return { success: true, game };
  }

  // ── Round logic ─────────────────────────────────────────────────────────────
  /**
   * Roll for all surviving players.
   * Eliminate those who rolled the minimum (after tiebreaker resolution).
   * Returns { rolls, minRoll, losers, survivors, isTiebreaker }
   */
  rollRound(game, tiebreakerIds = null) {
    const active = tiebreakerIds || [...game.players].filter(id => !game.eliminated.has(id));
    const rolls = new Map(); // userId → roll
    for (const id of active) rolls.set(id, this.roll(6));

    const minRoll = Math.min(...rolls.values());
    const atMin = [...rolls.entries()].filter(([, v]) => v === minRoll).map(([k]) => k);

    let losers = [];
    let needsTiebreaker = false;

    if (atMin.length === active.length) {
      // Everyone tied — nobody eliminated this round, re-roll everyone
      needsTiebreaker = true;
    } else if (atMin.length === 1) {
      // Clear loser
      losers = atMin;
      for (const id of losers) game.eliminated.add(id);
    } else {
      // Multiple at minimum — tiebreaker needed (caller handles via rollTiebreaker)
      needsTiebreaker = true;
    }

    return { rolls, minRoll, losers, atMin, needsTiebreaker, isTiebreaker: !!tiebreakerIds };
  }

  activePlayers(game) {
    return [...game.players].filter(id => !game.eliminated.has(id));
  }

  endGame(lobbyMessageId) {
    const game = this._games.get(lobbyMessageId);
    if (!game) return;
    clearTimeout(game.gatherTimer);
    game.status = 'ended';
    this._games.delete(lobbyMessageId);
  }

  // ── Embeds ──────────────────────────────────────────────────────────────────
  _applyAuthor(embed, guildId) {
    try {
      const br = getBranding(guildId, 'minigames');
      const name = br.brandName || 'Guild Pilot';
      if (br.logo) embed.setAuthor({ name, iconURL: br.logo });
      else embed.setAuthor({ name });
    } catch {}
    return embed;
  }

  buildLobbyEmbed(game, guildId) {
    const embed = new EmbedBuilder()
      .setTitle('🎲 Dice Duel — Join Now!')
      .setDescription(
        `React with ${JOIN_EMOJI} to enter!\n\n` +
        `**How it works:**\n` +
        `Each round the bot rolls a 🎲 for every player simultaneously.\n` +
        `Lowest roll? You're eliminated.\n` +
        `Ties at the bottom? Tiebreaker roll between those players.\n` +
        `Last one standing wins! 🏆`
      )
      .addFields({ name: `👥 Players (${game.players.size})`, value: game.players.size > 0 ? [...game.playerNames.values()].map(n => `• ${n}`).join('\n') : '*Be the first to join!*', inline: false })
      .setTimestamp();

    this._applyAuthor(embed, guildId);
    applyEmbedBranding(embed, {
      guildId, moduleKey: 'minigames',
      defaultColor: '#f59e0b',
      defaultFooter: `Starts in ${game.gatherSecs}s � Need at least 2 players`,
    });
    return embed;
  }

  buildRoundEmbed({ game, rolls, minRoll, atMin, needsTiebreaker, isTiebreaker, guildId }) {
    const alive = this.activePlayers(game);
    const rollLines = [...rolls.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, val]) => `${this.dieFace(val)} <@${id}> — **${val}**${val === minRoll && rolls.size > 1 ? ' 💀' : ''}`)
      .join('\n');

    let status = '';
    if (needsTiebreaker && isTiebreaker) status = `\n\n🔄 **Tiebreaker!** Rolling again for tied players...`;
    else if (needsTiebreaker) status = `\n\n🤝 **Full tie!** Everyone rolls again...`;
    else status = `\n\n☠️ Rolled **${minRoll}** — lowest is out!`;

    const embed = new EmbedBuilder()
      .setTitle(`🎲 Round ${game.roundNumber}${isTiebreaker ? ' — Tiebreaker' : ''}`)
      .setDescription(rollLines + status)
      .addFields(
        { name: '👥 Players Left', value: `${alive.length}`, inline: true },
        { name: '📍 Round', value: `${game.roundNumber}`, inline: true },
      )
      .setTimestamp();

    this._applyAuthor(embed, guildId);
    applyEmbedBranding(embed, {
      guildId, moduleKey: 'minigames',
      defaultColor: '#e74c3c',
      defaultFooter: `Round ${game.roundNumber}`,
    });
    return embed;
  }

  buildEliminationEmbed({ losers, roundNumber, remaining, guildId }) {
    const embed = new EmbedBuilder()
      .setTitle(`💀 Round ${roundNumber} — Eliminated!`)
      .setDescription(`☠️ ${losers.map(id => `<@${id}>`).join(', ')} rolled the lowest and ${losers.length === 1 ? 'has been' : 'have been'} eliminated!`)
      .addFields({ name: '👥 Remaining', value: `${remaining}`, inline: true })
      .setTimestamp();

    this._applyAuthor(embed, guildId);
    applyEmbedBranding(embed, {
      guildId, moduleKey: 'minigames',
      defaultColor: '#ef4444',
      defaultFooter: remaining <= 1 ? 'Game ending...' : 'Next round starting soon...',
    });
    return embed;
  }

  buildWinnerEmbed({ winnerId, roundsPlayed, guildId }) {
    const embed = new EmbedBuilder()
      .setTitle('🏆 Dice Duel — We Have a Winner!')
      .setDescription(`🎉 <@${winnerId}> outlasted everyone over **${roundsPlayed} round${roundsPlayed === 1 ? '' : 's'}**!\n\n**🎲 Dice Duel Champion!**`)
      .setTimestamp();

    this._applyAuthor(embed, guildId);
    applyEmbedBranding(embed, {
      guildId, moduleKey: 'minigames',
      defaultColor: '#f59e0b',
      defaultFooter: 'GuildPilot � Dice Duel',
    });
    return embed;
  }

  buildCancelledEmbed(reason, guildId) {
    const embed = new EmbedBuilder()
      .setTitle('🎲 Dice Duel')
      .setDescription(reason)
      .setTimestamp();

    this._applyAuthor(embed, guildId);
    applyEmbedBranding(embed, {
      guildId, moduleKey: 'minigames',
      defaultColor: '#64748b',
      defaultFooter: 'GuildPilot � Dice Duel',
    });
    return embed;
  }
}

const instance = new DiceDuelService();
require('./gameRegistry').register(JOIN_EMOJI, instance);
module.exports = instance;
