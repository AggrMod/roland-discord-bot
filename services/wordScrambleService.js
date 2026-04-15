const { EmbedBuilder } = require('discord.js');
const { applyEmbedBranding, getBranding } = require('./embedBranding');

const JOIN_EMOJI = '🧩';
const ROUNDS     = 5;
const ROUND_SECS = 30;

const WORDS = [
  'discord','crypto','bitcoin','solana','wallet','blockchain','diamond','thunder',
  'castle','pirate','galaxy','dragon','trophy','legend','market','rocket','phantom',
  'jungle','frozen','bridge','candle','forest','planet','silver','bottle','goblin',
  'scroll','anchor','portal','wizard','hunter','shadow','knight','falcon','empire',
  'cobalt','matrix','signal','vertex','quartz','oxygen','fusion','turbo','vortex',
  'enigma','abyss','cipher','oracle','nexus','cosmos',
];

function scramble(word) {
  const arr = word.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const result = arr.join('');
  return result === word ? scramble(word) : result; // re-scramble if identical
}

function pickWords(n) {
  const pool = [...WORDS].sort(() => Math.random() - 0.5);
  return pool.slice(0, n);
}

class WordScrambleService {
  constructor() { this._games = new Map(); }
  get JOIN_EMOJI()  { return JOIN_EMOJI; }
  get ROUNDS()      { return ROUNDS; }
  get ROUND_SECS()  { return ROUND_SECS; }

  createLobby({ channelId, messageId, creatorId, gatherSecs = 60 }) {
    const words = pickWords(ROUNDS);
    const game = { lobbyMessageId: messageId, channelId, creatorId, gatherSecs,
      status: 'waiting', players: new Set(), scores: new Map(),
      words, round: 0, gatherTimer: null };
    this._games.set(messageId, game);
    return game;
  }
  getGameByLobby(id) { return this._games.get(id) || null; }
  addPlayer(id, userId) {
    const g = this._games.get(id);
    if (!g || g.status !== 'waiting') return { success: false };
    if (g.players.has(userId)) return { success: false };
    g.players.add(userId); g.scores.set(userId, 0);
    return { success: true, count: g.players.size };
  }
  removePlayer(id, userId) {
    const g = this._games.get(id);
    if (!g || g.status !== 'waiting') return { success: false };
    g.players.delete(userId); g.scores.delete(userId);
    return { success: true, count: g.players.size };
  }
  endGame(id) {
    const g = this._games.get(id);
    if (!g) return;
    clearTimeout(g.gatherTimer);
    g.status = 'ended'; this._games.delete(id);
  }

  winner(game) {
    const sorted = [...game.scores.entries()].sort((a,b)=>b[1]-a[1]);
    if (!sorted.length) return null;
    const top = sorted[0][1];
    return { winners: sorted.filter(([,s])=>s===top).map(([id])=>id), score: top, sorted };
  }

  _applyAuthor(embed, guildId) {
    try { const br = getBranding(guildId, 'minigames'); if (br.logo) embed.setAuthor({ name: br.brandName||'Guild Pilot', iconURL: br.logo }); else embed.setAuthor({ name: br.brandName||'Guild Pilot' }); } catch {}
  }

  buildLobbyEmbed(game, guildId) {
    const e = new EmbedBuilder().setTitle('🧩 Word Scramble — Join Now!')
      .setDescription(`React ${JOIN_EMOJI} to join!\n\n**How it works:**\nBot shows a scrambled word — type the correct word in chat!\nFirst to get it right wins the round.\n${ROUNDS} rounds, most wins takes the trophy! 🏆`)
      .addFields({ name: '👥 Players', value: game.players.size > 0 ? `${game.players.size} waiting` : '*Be the first!*', inline: true })
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#6366f1', defaultFooter: `Starts in ${game.gatherSecs}s � Need at least 2 players` });
    return e;
  }

  buildRoundEmbed({ round, total, scrambled, guildId }) {
    const blanks = '_ '.repeat(scrambled.length).trim();
    const e = new EmbedBuilder().setTitle(`🧩 Round ${round}/${total} — Unscramble it!`)
      .setDescription(`**\`${scrambled.toUpperCase()}\`**\n\n${blanks}\n\nType the correct word in chat!\nYou have **${ROUND_SECS} seconds**. First correct answer wins the round!`)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#6366f1', defaultFooter: `Round ${round} of ${total} � ${scrambled.length} letters` });
    return e;
  }

  buildRoundWinEmbed({ round, total, word, winnerId, scores, guildId }) {
    const sorted = [...scores.entries()].sort((a,b)=>b[1]-a[1]);
    const board = sorted.map(([id,s],i)=>`${i===0?'🥇':i===1?'🥈':i===2?'🥉':`${i+1}.`} <@${id}> — **${s} pt${s===1?'':'s'}**`).join('\n');
    const e = new EmbedBuilder().setTitle(`🧩 Round ${round} — ${winnerId ? `<@${winnerId}> got it!` : 'Time\'s up!'}`)
      .setDescription(`The word was **${word}**!\n\n📊 **Standings:**\n${board}`)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: winnerId ? '#4ade80' : '#ef4444', defaultFooter: round < total ? 'Next round soon...' : 'Final round done!' });
    return e;
  }

  buildWinnerEmbed({ winners, score, guildId }) {
    const mention = winners.map(id=>`<@${id}>`).join(' & ');
    const e = new EmbedBuilder().setTitle('🏆 Word Scramble — Champion!')
      .setDescription(`🎉 ${mention} wins with **${score} round${score===1?'':'s'}** won!\n\n**🧩 Word Scramble Champion${winners.length>1?'s':''}!**`)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#f59e0b', defaultFooter: 'GuildPilot � Word Scramble' });
    return e;
  }

  buildCancelledEmbed(reason, guildId) {
    const e = new EmbedBuilder().setTitle('🧩 Word Scramble').setDescription(reason).setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#64748b', defaultFooter: 'GuildPilot � Word Scramble' });
    return e;
  }
}

const instance = new WordScrambleService();
require('./gameRegistry').register(JOIN_EMOJI, instance);
module.exports = instance;
