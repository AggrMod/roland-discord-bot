const { EmbedBuilder } = require('discord.js');
const { applyEmbedBranding, getBranding } = require('./embedBranding');

const JOIN_EMOJI = '🎰';

const SYMBOLS = ['🍒','🍋','🍇','🔔','💎','⭐','7️⃣'];
const SYM_VAL  = { '7️⃣':7,'💎':6,'⭐':5,'🔔':4,'🍇':3,'🍋':2,'🍒':1 };

class SlotsService {
  constructor() { this._games = new Map(); }
  get JOIN_EMOJI() { return JOIN_EMOJI; }

  createLobby({ channelId, messageId, creatorId, gatherSecs = 45 }) {
    const game = { lobbyMessageId: messageId, channelId, creatorId, gatherSecs,
      status: 'waiting', players: new Set(), gatherTimer: null };
    this._games.set(messageId, game);
    return game;
  }
  getGameByLobby(id)   { return this._games.get(id) || null; }
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
  endGame(id) {
    const g = this._games.get(id);
    if (!g) return;
    clearTimeout(g.gatherTimer);
    g.status = 'ended';
    this._games.delete(id);
  }

  spin() {
    const reels = [0,1,2].map(() => SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)]);
    return reels;
  }

  score(reels) {
    const [a, b, c] = reels;
    if (a === b && b === c) return 100 + (SYM_VAL[a] || 0) * 10; // 3 of a kind jackpot
    if (a === b || b === c || a === c) {                           // 2 of a kind
      const pair = a === b ? a : a === c ? a : b;
      return 20 + (SYM_VAL[pair] || 0) * 3;
    }
    return (SYM_VAL[a] || 0) + (SYM_VAL[b] || 0) + (SYM_VAL[c] || 0); // all unique
  }

  comboLabel(reels) {
    const [a, b, c] = reels;
    if (a === b && b === c) return '🎰 JACKPOT';
    if (a === b || b === c || a === c) return '✨ Two of a Kind';
    return 'No Match';
  }

  _applyAuthor(embed, guildId) {
    try { const br = getBranding(guildId, 'minigames'); if (br.logo) embed.setAuthor({ name: br.brandName || 'Guild Pilot', iconURL: br.logo }); else embed.setAuthor({ name: br.brandName || 'Guild Pilot' }); } catch {}
  }

  buildLobbyEmbed(game, guildId) {
    const e = new EmbedBuilder().setTitle('🎰 Slots — Join Now!')
      .setDescription(`React ${JOIN_EMOJI} to enter!\n\n**How it works:**\nEveryone gets one spin on the slot machine.\nHighest score wins!\n\n🎰 JACKPOT (3 of a kind) > ✨ Two of a Kind > No Match\nAmong ties: rarest symbols win.`)
      .addFields({ name: '👥 Players', value: game.players.size > 0 ? `${game.players.size} waiting` : '*Be the first!*', inline: true })
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#f59e0b', defaultFooter: `Starts in ${game.gatherSecs}s � Need at least 2 players` });
    return e;
  }

  buildSpinEmbed({ results, guildId }) {
    // results: [{userId, reels, score, combo}] sorted by score desc
    const lines = results.map((r, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
      return `${medal} <@${r.userId}> ${r.reels.join(' ')} — ${r.combo} (**${r.score} pts**)`;
    }).join('\n');

    const e = new EmbedBuilder().setTitle('🎰 Slots — Results!')
      .setDescription(lines)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#f59e0b', defaultFooter: 'GuildPilot � Slots' });
    return e;
  }

  buildWinnerEmbed({ winnerId, reels, score, combo, guildId }) {
    const e = new EmbedBuilder().setTitle('🏆 Slots — Winner!')
      .setDescription(`🎉 <@${winnerId}> wins with **${combo}** — ${reels.join(' ')} (**${score} pts**)!\n\n**🎰 Slots Champion!**`)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#f59e0b', defaultFooter: 'GuildPilot � Slots' });
    return e;
  }

  buildCancelledEmbed(reason, guildId) {
    const e = new EmbedBuilder().setTitle('🎰 Slots').setDescription(reason).setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#64748b', defaultFooter: 'GuildPilot � Slots' });
    return e;
  }
}

const instance = new SlotsService();
require('./gameRegistry').register(JOIN_EMOJI, instance);
module.exports = instance;
