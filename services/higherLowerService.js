const { EmbedBuilder } = require('discord.js');
const { applyEmbedBranding, getBranding } = require('./embedBranding');
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

  // ── Embed helpers ──────────────────────────────────────────────────────────
  _applyAuthor(embed, guildId) {
    try {
      const br = getBranding(guildId, 'minigames');
      const name = br.brandName || 'Guild Pilot';
      if (br.logo) embed.setAuthor({ name, iconURL: br.logo });
      else embed.setAuthor({ name });
    } catch {}
    return embed;
  }

  // ── Embeds ─────────────────────────────────────────────────────────────────
  buildLobbyEmbed(game, guildId) {
    const embed = new EmbedBuilder()
      .setTitle('🃏 Higher or Lower — Join Now!')
      .setDescription(
        `React with ${JOIN_EMOJI} to enter the game!\n\n` +
        `**How it works:**\n` +
        `Each round a card is revealed. Guess if the next card is ⬆️ **Higher** or ⬇️ **Lower**.\n` +
        `Wrong guess or no guess? You're eliminated.\n` +
        `Last one standing wins! 🏆\n\n` +
        `> Card values: **2 (low) → A (highest)**\n` +
        `> Ties: both cards same value → everyone survives`
      )
      .addFields({ name: '👥 Players Joined', value: game.players.size > 0 ? `${game.players.size} waiting` : '*Be the first to join!*', inline: true })
      .setTimestamp();

    this._applyAuthor(embed, guildId);
    applyEmbedBranding(embed, {
      guildId,
      moduleKey: 'minigames',
      defaultColor: '#f59e0b',
      defaultFooter: `Starts in ${game.gatherSecs}s � Need at least 2 players`,
    });
    return embed;
  }

  buildRoundEmbed(game, guildId) {
    const card = game.currentCard;
    const alive = this.activePlayers(game);
    const isRed = card.suit.name === 'Hearts' || card.suit.name === 'Diamonds';

    const embed = new EmbedBuilder()
      .setTitle(`🃏 Round ${game.roundNumber} — Higher or Lower?`)
      .setDescription(`Will the **next card** be ⬆️ **Higher** or ⬇️ **Lower**?\nReact now — you have **60 seconds**. First reaction counts!`)
      .addFields(
        { name: '🃏 Current Card', value: cardLabel(card), inline: true },
        { name: '👥 Players Left', value: `${alive.length}`, inline: true },
        { name: '🎴 Cards in Deck', value: `${game.deck.length}`, inline: true },
      )
      .setTimestamp();

    this._applyAuthor(embed, guildId);
    applyEmbedBranding(embed, {
      guildId,
      moduleKey: 'minigames',
      defaultColor: isRed ? '#e74c3c' : '#2c3e50',
      defaultFooter: `Round ${game.roundNumber} � ⬆️ Higher or ⬇️ Lower`,
    });
    return embed;
  }

  buildResultEmbed({ game, result, guildId }) {
    const { losers, nextCard, prevCard, correct, tieBreaker } = result;
    const alive = this.activePlayers(game);

    let outcomeTitle, outcomeDesc;
    if (tieBreaker) {
      outcomeTitle = `🤝 Tie! Both **${prevCard.rank}** — everyone survives`;
      outcomeDesc  = `${cardLabel(prevCard)} → ${cardLabel(nextCard)}`;
    } else if (correct === 'higher') {
      outcomeTitle = `📈 Higher! Correct answer was ⬆️`;
      outcomeDesc  = `${cardLabel(prevCard)} → ${cardLabel(nextCard)}`;
    } else {
      outcomeTitle = `📉 Lower! Correct answer was ⬇️`;
      outcomeDesc  = `${cardLabel(prevCard)} → ${cardLabel(nextCard)}`;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🃏 Round ${game.roundNumber - 1} Result`)
      .setDescription(outcomeDesc)
      .addFields(
        { name: outcomeTitle, value: losers.length ? `☠️ Eliminated: ${losers.map(id => `<@${id}>`).join(', ')}` : '✅ Everyone guessed correctly!', inline: false },
        ...(alive.length > 0 ? [{ name: `👥 ${alive.length} Remaining`, value: alive.map(id => `<@${id}>`).join(', '), inline: false }] : []),
      )
      .setTimestamp();

    this._applyAuthor(embed, guildId);
    applyEmbedBranding(embed, {
      guildId,
      moduleKey: 'minigames',
      defaultColor: losers.length > 0 ? '#ef4444' : '#4ade80',
      defaultFooter: alive.length <= 1 ? 'Game ending...' : 'Next round starting shortly...',
    });
    return embed;
  }

  buildWinnerEmbed({ winnerId, roundsPlayed, guildId }) {
    const embed = new EmbedBuilder()
      .setTitle('🏆 Higher or Lower — We Have a Winner!')
      .setDescription(`🎉 <@${winnerId}> outlasted everyone over **${roundsPlayed} round${roundsPlayed === 1 ? '' : 's'}**!\n\n**🃏 Higher or Lower Champion!**`)
      .setTimestamp();

    this._applyAuthor(embed, guildId);
    applyEmbedBranding(embed, {
      guildId,
      moduleKey: 'minigames',
      defaultColor: '#f59e0b',
      defaultFooter: 'GuildPilot � Higher or Lower',
    });
    return embed;
  }

  buildNoSurvivorsEmbed({ roundsPlayed, guildId }) {
    const embed = new EmbedBuilder()
      .setTitle('💀 Higher or Lower — Everyone Eliminated!')
      .setDescription(`No survivors after round ${roundsPlayed}! The deck wins this time. Better luck next game! 🃏`)
      .setTimestamp();

    this._applyAuthor(embed, guildId);
    applyEmbedBranding(embed, {
      guildId,
      moduleKey: 'minigames',
      defaultColor: '#6366f1',
      defaultFooter: 'GuildPilot � Higher or Lower',
    });
    return embed;
  }

  buildCancelledEmbed(reason, guildId) {
    const embed = new EmbedBuilder()
      .setTitle('🃏 Higher or Lower')
      .setDescription(reason)
      .setTimestamp();

    this._applyAuthor(embed, guildId);
    applyEmbedBranding(embed, {
      guildId,
      moduleKey: 'minigames',
      defaultColor: '#64748b',
      defaultFooter: 'GuildPilot � Higher or Lower',
    });
    return embed;
  }
}

const instance = new HigherLowerService();
require('./gameRegistry').register(JOIN_EMOJI, instance);
module.exports = instance;
