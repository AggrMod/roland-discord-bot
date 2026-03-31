const { EmbedBuilder } = require('discord.js');
const { applyEmbedBranding, getBranding } = require('./embedBranding');

const JOIN_EMOJI   = '👊';
const ROCK         = '🪨';
const SCISSORS     = '✂️';
const PAPER        = '📄';
const CHOICES      = [ROCK, SCISSORS, PAPER];
const MATCH_SECS   = 30;

// beats[a] returns true if a beats b
function beats(a, b) {
  return (a === ROCK && b === SCISSORS) ||
         (a === SCISSORS && b === PAPER) ||
         (a === PAPER && b === ROCK);
}

function choiceLabel(emoji) {
  if (emoji === ROCK)     return '🪨 Rock';
  if (emoji === SCISSORS) return '✂️ Scissors';
  if (emoji === PAPER)    return '📄 Paper';
  return '❓ No choice';
}

class RpsService {
  constructor() { this._games = new Map(); }
  get JOIN_EMOJI() { return JOIN_EMOJI; }
  get CHOICES()    { return CHOICES; }
  get MATCH_SECS() { return MATCH_SECS; }

  createLobby({ channelId, messageId, creatorId, gatherSecs = 60 }) {
    const game = { lobbyMessageId: messageId, channelId, creatorId, gatherSecs,
      status: 'waiting', players: new Set(), eliminated: new Set(),
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
    return { success: true, count: g.players.size };
  }
  removePlayer(id, userId) {
    const g = this._games.get(id);
    if (!g || g.status !== 'waiting') return { success: false };
    g.players.delete(userId);
    return { success: true, count: g.players.size };
  }
  activePlayers(game) { return [...game.players].filter(id => !game.eliminated.has(id)); }
  endGame(id) {
    const g = this._games.get(id);
    if (!g) return;
    clearTimeout(g.gatherTimer);
    g.status = 'ended'; this._games.delete(id);
  }

  /** Build bracket matchups from current alive players. Odd → one player gets a bye. */
  buildMatchups(game) {
    const alive = this.activePlayers(game);
    const shuffled = [...alive].sort(() => Math.random() - 0.5);
    const matchups = [];
    let bye = null;
    for (let i = 0; i < shuffled.length; i += 2) {
      if (i + 1 < shuffled.length) matchups.push([shuffled[i], shuffled[i+1]]);
      else bye = shuffled[i]; // odd player out
    }
    return { matchups, bye };
  }

  /** Resolve a single matchup. Returns { winner, loser, draw } */
  resolveMatchup(choiceA, choiceB, idA, idB) {
    if (!choiceA && !choiceB) return { winner: null, loser: null, draw: true, both: [idA, idB] };
    if (!choiceA) return { winner: idB, loser: idA, draw: false };
    if (!choiceB) return { winner: idA, loser: idB, draw: false };
    if (beats(choiceA, choiceB)) return { winner: idA, loser: idB, draw: false };
    if (beats(choiceB, choiceA)) return { winner: idB, loser: idA, draw: false };
    return { winner: null, loser: null, draw: true, both: [idA, idB] };
  }

  _applyAuthor(embed, guildId) {
    try { const br = getBranding(guildId,'battle'); if (br.logo) embed.setAuthor({ name: br.brandName||'Guild Pilot', iconURL: br.logo }); else embed.setAuthor({ name: br.brandName||'Guild Pilot' }); } catch {}
  }

  buildLobbyEmbed(game, guildId) {
    const e = new EmbedBuilder().setTitle('🪨 RPS Tournament — Join Now!')
      .setDescription(`React ${JOIN_EMOJI} to join!\n\n**How it works:**\nRandom bracket matchups each round.\nReact 🪨 Rock, ✂️ Scissors, or 📄 Paper.\nLoser is eliminated. Ties → both survive, re-matched next round.\nLast one standing wins! 🏆`)
      .addFields({ name: '👥 Players', value: game.players.size > 0 ? `${game.players.size} waiting` : '*Be the first!*', inline: true })
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: '#6366f1', defaultFooter: `Starts in ${game.gatherSecs}s · Need at least 2 players` });
    return e;
  }

  buildMatchupEmbed({ round, playerA, playerB, guildId }) {
    const e = new EmbedBuilder().setTitle(`🪨 Round ${round} — Matchup!`)
      .setDescription(`<@${playerA}> **vs** <@${playerB}>\n\nBoth react within **${MATCH_SECS}s**!\n🪨 Rock · ✂️ Scissors · 📄 Paper\n\n*First reaction counts!*`)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: '#e74c3c', defaultFooter: `Round ${round} · React to vote` });
    return e;
  }

  buildMatchupResultEmbed({ round, playerA, choiceA, playerB, choiceB, result, guildId }) {
    let outcome;
    if (result.draw) outcome = `🤝 **Draw!** Both survive and will be re-matched.`;
    else outcome = `🏆 <@${result.winner}> wins!\n☠️ <@${result.loser}> is eliminated.`;
    const e = new EmbedBuilder().setTitle(`🪨 Round ${round} Result`)
      .setDescription(`<@${playerA}> played **${choiceLabel(choiceA)}**\n<@${playerB}> played **${choiceLabel(choiceB)}**\n\n${outcome}`)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: result.draw ? '#6366f1' : '#4ade80', defaultFooter: `Round ${round}` });
    return e;
  }

  buildByeEmbed({ round, playerId, guildId }) {
    const e = new EmbedBuilder().setTitle(`🪨 Round ${round} — Bye!`)
      .setDescription(`<@${playerId}> has a **bye** this round and automatically advances! 🍀`)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: '#4ade80', defaultFooter: `Round ${round} bye` });
    return e;
  }

  buildWinnerEmbed({ winnerId, rounds, guildId }) {
    const e = new EmbedBuilder().setTitle('🏆 RPS Tournament — Champion!')
      .setDescription(`🎉 <@${winnerId}> defeats all challengers after **${rounds} round${rounds===1?'':'s'}**!\n\n**🪨 RPS Champion!**`)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: '#f59e0b', defaultFooter: 'GuildPilot · RPS Tournament' });
    return e;
  }

  buildCancelledEmbed(reason, guildId) {
    const e = new EmbedBuilder().setTitle('🪨 RPS Tournament').setDescription(reason).setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: '#64748b', defaultFooter: 'GuildPilot · RPS Tournament' });
    return e;
  }
}

const instance = new RpsService();
require('./gameRegistry').register(JOIN_EMOJI, instance);
module.exports = instance;
