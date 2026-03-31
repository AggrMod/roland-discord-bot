const { EmbedBuilder } = require('discord.js');
const { applyEmbedBranding } = require('./embedBranding');
const logger = require('../utils/logger');

// ── Constants ─────────────────────────────────────────────────────────────────
const JOIN_EMOJI   = '🃏';
const HIGHER_EMOJI = '⬆️';
const LOWER_EMOJI  = '⬇️';

const SUITS = [
  { name: 'Hearts',   emoji: '♥️', color: '#e74c3c' },
  { name: 'Diamonds', emoji: '♦️', color: '#e74c3c' },
  { name: 'Clubs',    emoji: '♣️', color: '#2c3e50' },
  { name: 'Spades',   emoji: '♠️', color: '#2c3e50' },
];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VALUE = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

// ── Deck helpers ──────────────────────────────────────────────────────────────
function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit, value: RANK_VALUE[rank] });
    }
  }
  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardLabel(card) {
  return `**${card.rank}** ${card.suit.emoji} ${card.suit.name}`;
}

// ── Game manager ──────────────────────────────────────────────────────────────
class HigherLowerService {
  constructor() {
    // Map: messageId → game state
    this._games      = new Map(); // lobbyMessageId → game
    this._roundMsgs  = new Map(); // roundMessageId → game
  }

  get JOIN_EMOJI()   { return JOIN_EMOJI; }
  get HIGHER_EMOJI() { return HIGHER_EMOJI; }
  get LOWER_EMOJI()  { return LOWER_EMOJI; }

  // ── Lobby ──────────────────────────────────────────────────────────────────
  createLobby({ channelId, messageId, creatorId, gatherSecs = 60 }) {
    const game = {
      lobbyMessageId: messageId,
      channelId,
      creatorId,
      gatherSecs,
      status: 'waiting',        // waiting | playing | ended
      players: new Set(),       // userId
      eliminated: new Set(),
      deck: [],
      currentCard: null,
      roundNumber: 0,
      roundMessageId: null,
      guesses: new Map(),       // userId → 'higher' | 'lower'
      roundTimer: null,
      gatherTimer: null,
    };
    this._games.set(messageId, game);
    return game;
  }

  getGameByLobby(messageId) {
    return this._games.get(messageId) || null;
  }

  getGameByRound(messageId) {
    return this._roundMsgs.get(messageId) || null;
  }

  addPlayer(lobbyMessageId, userId, username) {
    const game = this._games.get(lobbyMessageId);
    if (!game || game.status !== 'waiting') return { success: false, reason: 'not_open' };
    if (game.players.has(userId)) return { success: false, reason: 'already_joined' };
    game.players.add(userId);
    return { success: true, count: game.players.size };
  }

  removePlayer(lobbyMessageId, userId) {
    const game = this._games.get(lobbyMessageId);
    if (!game || game.status !== 'waiting') return { success: false };
    const had = game.players.delete(userId);
    return { success: had, count: game.players.size };
  }

  // ── Round lifecycle ────────────────────────────────────────────────────────
  startGame(lobbyMessageId) {
    const game = this._games.get(lobbyMessageId);
    if (!game) return { success: false, reason: 'not_found' };
    if (game.players.size < 2) return { success: false, reason: 'not_enough_players' };
    game.status = 'playing';
    game.deck   = buildDeck();
    game.currentCard = game.deck.pop();
    game.roundNumber = 1;
    return { success: true, game };
  }

  /** Returns surviving players after evaluating a round */
  resolveRound(game) {
    const next  = game.deck.pop();
    const prev  = game.currentCard;
    const survivors = [];
    const losers    = [];

    const correct = next.value > prev.value ? 'higher' : next.value < prev.value ? 'lower' : null; // null = tie

    for (const userId of game.players) {
      if (game.eliminated.has(userId)) continue;
      const guess = game.guesses.get(userId);
      // No guess = eliminated
      if (!guess || (correct !== null && guess !== correct)) {
        losers.push(userId);
        game.eliminated.add(userId);
      } else {
        survivors.push(userId);
      }
    }

    game.currentCard = next;
    game.guesses.clear();
    game.roundNumber++;

    return { survivors, losers, nextCard: next, prevCard: prev, correct, tieBreaker: correct === null };
  }

  recordGuess(roundMessageId, userId, guess) {
    const game = this._roundMsgs.get(roundMessageId);
    if (!game || game.status !== 'playing') return { success: false };
    if (game.eliminated.has(userId)) return { success: false, reason: 'eliminated' };
    if (!game.players.has(userId))   return { success: false, reason: 'not_a_player' };
    // First guess wins; ignore double-reactions
    if (game.guesses.has(userId)) return { success: false, reason: 'already_guessed' };
    game.guesses.set(userId, guess);
    return { success: true };
  }

  registerRoundMessage(roundMessageId, game) {
    if (game === null) {
      this._roundMsgs.delete(roundMessageId);
    } else {
      this._roundMsgs.set(roundMessageId, game);
    }
  }

  endGame(lobbyMessageId) {
    const game = this._games.get(lobbyMessageId);
    if (!game) return;
    game.status = 'ended';
    clearTimeout(game.gatherTimer);
    clearTimeout(game.roundTimer);
    // Clean up round message mapping
    if (game.roundMessageId) this._roundMsgs.delete(game.roundMessageId);
    this._games.delete(lobbyMessageId);
  }

  activePlayers(game) {
    return [...game.players].filter(id => !game.eliminated.has(id));
  }

  // ── Embeds ─────────────────────────────────────────────────────────────────
  buildLobbyEmbed(game, guildId) {
    const embed = new EmbedBuilder()
      .setTitle('🃏 Higher or Lower — Join Now!')
      .setDescription(
        `A card game is about to begin!\n\n` +
        `React with ${JOIN_EMOJI} to join the game.\n\n` +
        `**How it works:**\n` +
        `A card is drawn each round. Guess if the next card is **⬆️ Higher** or **⬇️ Lower**.\n` +
        `Wrong guess? You're out. Last one standing wins! 🏆\n\n` +
        `**Players joined: ${game.players.size}**\n` +
        (game.players.size > 0 ? `*(${game.players.size} waiting)*` : '*Be the first to join!*')
      )
      .setColor('#f59e0b')
      .setFooter({ text: `Game starts in ${game.gatherSecs}s · Need at least 2 players` });

    applyEmbedBranding(embed, { guildId });
    return embed;
  }

  buildRoundEmbed(game, guildId) {
    const card = game.currentCard;
    const alive = this.activePlayers(game);
    const suit = card.suit;

    const embed = new EmbedBuilder()
      .setTitle(`🃏 Round ${game.roundNumber} — Higher or Lower?`)
      .setDescription(
        `**Current card:** ${cardLabel(card)}\n\n` +
        `Will the next card be **⬆️ Higher** or **⬇️ Lower**?\n\n` +
        `React to vote! You have **60 seconds**.\n\n` +
        `👥 **${alive.length}** player${alive.length === 1 ? '' : 's'} remaining\n` +
        `🃏 **${game.deck.length}** cards left in deck`
      )
      .setColor(suit.color === '#e74c3c' ? 0xe74c3c : 0x2c3e50)
      .setFooter({ text: `Round ${game.roundNumber} · React ⬆️ or ⬇️ — first react counts` });

    applyEmbedBranding(embed, { guildId });
    return embed;
  }

  buildResultEmbed({ game, result, guildId }) {
    const { survivors, losers, nextCard, prevCard, correct, tieBreaker } = result;
    const alive = this.activePlayers(game);

    let outcome = '';
    if (tieBreaker) {
      outcome = `🤝 **Tie!** Both cards were **${prevCard.rank}** — everyone survives this round!`;
    } else if (correct === 'higher') {
      outcome = `📈 **Higher!** ${cardLabel(nextCard)} beats ${cardLabel(prevCard)}`;
    } else {
      outcome = `📉 **Lower!** ${cardLabel(nextCard)} is under ${cardLabel(prevCard)}`;
    }

    const loserText = losers.length
      ? `☠️ **Eliminated:** ${losers.map(id => `<@${id}>`).join(', ')}`
      : '✅ Everyone guessed correctly!';

    const survivorText = alive.length > 0
      ? `👥 **${alive.length}** player${alive.length === 1 ? '' : 's'} remain: ${alive.map(id => `<@${id}>`).join(', ')}`
      : '';

    const embed = new EmbedBuilder()
      .setTitle(`🃏 Round ${game.roundNumber - 1} Result`)
      .setDescription([outcome, '', loserText, survivorText].filter(Boolean).join('\n'))
      .setColor(losers.length > 0 ? 0xef4444 : 0x4ade80)
      .setFooter({ text: alive.length <= 1 ? 'Game ending...' : 'Next round starting shortly...' });

    applyEmbedBranding(embed, { guildId });
    return embed;
  }

  buildWinnerEmbed({ winnerId, roundsPlayed, guildId }) {
    const embed = new EmbedBuilder()
      .setTitle('🏆 We Have a Winner!')
      .setDescription(
        `🎉 <@${winnerId}> has survived all ${roundsPlayed} rounds and wins the game!\n\n` +
        `**🃏 Higher or Lower Champion!**`
      )
      .setColor(0xf59e0b)
      .setFooter({ text: 'GuildPilot · Higher or Lower' });

    applyEmbedBranding(embed, { guildId });
    return embed;
  }

  buildNoSurvivorsEmbed({ roundsPlayed, guildId }) {
    const embed = new EmbedBuilder()
      .setTitle('💀 Everyone Eliminated!')
      .setDescription(
        `No survivors in round ${roundsPlayed}! It's a draw — the cards win this time.\n\n` +
        `Better luck next game! 🃏`
      )
      .setColor(0x6366f1)
      .setFooter({ text: 'GuildPilot · Higher or Lower' });

    applyEmbedBranding(embed, { guildId });
    return embed;
  }

  buildCancelledEmbed(reason, guildId) {
    const embed = new EmbedBuilder()
      .setTitle('🃏 Higher or Lower — Cancelled')
      .setDescription(reason)
      .setColor(0x64748b);
    applyEmbedBranding(embed, { guildId });
    return embed;
  }
}

module.exports = new HigherLowerService();
