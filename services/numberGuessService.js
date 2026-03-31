const { EmbedBuilder } = require('discord.js');
const { applyEmbedBranding, getBranding } = require('./embedBranding');

const JOIN_EMOJI = '🔢';
const ROUNDS     = 3;
const GUESS_SECS = 30;

class NumberGuessService {
  constructor() { this._games = new Map(); }
  get JOIN_EMOJI() { return JOIN_EMOJI; }
  get ROUNDS()     { return ROUNDS; }
  get GUESS_SECS() { return GUESS_SECS; }

  createLobby({ channelId, messageId, creatorId, gatherSecs = 60 }) {
    const game = { lobbyMessageId: messageId, channelId, creatorId, gatherSecs,
      status: 'waiting', players: new Set(), scores: new Map(),
      round: 0, gatherTimer: null };
    this._games.set(messageId, game);
    return game;
  }
  getGameByLobby(id) { return this._games.get(id) || null; }
  addPlayer(id, userId) {
    const g = this._games.get(id);
    if (!g || g.status !== 'waiting') return { success: false };
    if (g.players.has(userId)) return { success: false };
    g.players.add(userId);
    g.scores.set(userId, 0);
    return { success: true, count: g.players.size };
  }
  removePlayer(id, userId) {
    const g = this._games.get(id);
    if (!g || g.status !== 'waiting') return { success: false };
    g.players.delete(userId);
    g.scores.delete(userId);
    return { success: true, count: g.players.size };
  }
  endGame(id) {
    const g = this._games.get(id);
    if (!g) return;
    clearTimeout(g.gatherTimer);
    g.status = 'ended';
    this._games.delete(id);
  }

  pickSecret(min = 1, max = 100) { return Math.floor(Math.random() * (max - min + 1)) + min; }

  /** Given guesses Map(userId→Number), award points. Returns sorted result. */
  resolveRound(game, guesses, secret) {
    const results = [...game.players].map(id => {
      const guess = guesses.get(id);
      const dist  = guess !== undefined ? Math.abs(guess - secret) : Infinity;
      return { id, guess, dist };
    }).sort((a, b) => a.dist - b.dist);

    const minDist = results[0]?.dist ?? Infinity;
    // Award points to closest (could be multiple)
    for (const r of results) {
      if (r.dist === minDist && minDist !== Infinity) {
        game.scores.set(r.id, (game.scores.get(r.id) || 0) + 1);
      }
    }
    return results;
  }

  winner(game) {
    const sorted = [...game.scores.entries()].sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return null;
    const top = sorted[0][1];
    const winners = sorted.filter(([, s]) => s === top).map(([id]) => id);
    return { winners, score: top, sorted };
  }

  _applyAuthor(embed, guildId) {
    try { const br = getBranding(guildId, 'battle'); if (br.logo) embed.setAuthor({ name: br.brandName || 'Guild Pilot', iconURL: br.logo }); else embed.setAuthor({ name: br.brandName || 'Guild Pilot' }); } catch {}
  }

  buildLobbyEmbed(game, guildId) {
    const e = new EmbedBuilder().setTitle('🔢 Number Guess — Join Now!')
      .setDescription(`React ${JOIN_EMOJI} to join!\n\n**How it works:**\nBot picks a secret number 1–100.\nType your guess in chat — closest wins the round!\n${ROUNDS} rounds, most correct guesses wins! 🏆`)
      .addFields({ name: '👥 Players', value: game.players.size > 0 ? `${game.players.size} waiting` : '*Be the first!*', inline: true })
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: '#6366f1', defaultFooter: `Starts in ${game.gatherSecs}s · Need at least 2 players` });
    return e;
  }

  buildRoundEmbed({ round, total, guildId }) {
    const e = new EmbedBuilder().setTitle(`🔢 Round ${round}/${total} — Guess the Number!`)
      .setDescription(`I'm thinking of a number between **1 and 100**.\nType your guess in chat — you have **${GUESS_SECS} seconds!**\n\n*Closest guess wins the round!*`)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: '#6366f1', defaultFooter: `Round ${round} of ${total}` });
    return e;
  }

  buildResultEmbed({ round, secret, results, guildId }) {
    const lines = results.slice(0, 10).map((r, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
      const guessText = r.guess !== undefined ? `**${r.guess}** (off by ${r.dist})` : '*no guess*';
      return `${medal} <@${r.id}> — ${guessText}`;
    }).join('\n');
    const e = new EmbedBuilder().setTitle(`🔢 Round ${round} Result — Secret was **${secret}**!`)
      .setDescription(lines)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: '#4ade80', defaultFooter: `Round ${round} complete` });
    return e;
  }

  buildScoreboardEmbed({ round, total, scores, guildId }) {
    const sorted = [...scores.entries()].sort((a,b) => b[1]-a[1]);
    const lines = sorted.map(([id,s], i) => `${i===0?'🥇':i===1?'🥈':i===2?'🥉':`${i+1}.`} <@${id}> — **${s} pt${s===1?'':'s'}**`).join('\n');
    const e = new EmbedBuilder().setTitle(`📊 Standings after Round ${round}/${total}`)
      .setDescription(lines || '*No scores yet*').setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: '#6366f1', defaultFooter: round < total ? 'Next round starting soon...' : 'Final standings!' });
    return e;
  }

  buildWinnerEmbed({ winners, score, guildId }) {
    const mention = winners.map(id => `<@${id}>`).join(' & ');
    const e = new EmbedBuilder().setTitle('🏆 Number Guess — Game Over!')
      .setDescription(`🎉 ${mention} wins with **${score} point${score===1?'':'s'}**!\n\n**🔢 Number Guess Champion${winners.length > 1 ? 's' : ''}!**`)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: '#f59e0b', defaultFooter: 'GuildPilot · Number Guess' });
    return e;
  }

  buildCancelledEmbed(reason, guildId) {
    const e = new EmbedBuilder().setTitle('🔢 Number Guess').setDescription(reason).setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: '#64748b', defaultFooter: 'GuildPilot · Number Guess' });
    return e;
  }
}

const instance = new NumberGuessService();
require('./gameRegistry').register(JOIN_EMOJI, instance);
module.exports = instance;
