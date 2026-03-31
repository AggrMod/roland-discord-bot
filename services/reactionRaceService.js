const { EmbedBuilder } = require('discord.js');
const { applyEmbedBranding, getBranding } = require('./embedBranding');
const logger = require('../utils/logger');

const JOIN_EMOJI = '🏃';
const RACE_EMOJI = '⚡';
const COLLECT_MS  = 8000;  // 8s window to react after GO
const ROUND_GAP_MS = 4000;

class ReactionRaceService {
  constructor() { this._games = new Map(); }
  get JOIN_EMOJI()  { return JOIN_EMOJI; }
  get RACE_EMOJI()  { return RACE_EMOJI; }

  createLobby({ channelId, messageId, creatorId, gatherSecs = 60 }) {
    const game = { lobbyMessageId: messageId, channelId, creatorId, gatherSecs,
      status: 'waiting', players: new Set(), eliminated: new Set(),
      roundNumber: 0, gatherTimer: null };
    this._games.set(messageId, game);
    return game;
  }
  getGameByLobby(id) { return this._games.get(id) || null; }
  addPlayer(id, userId, username) {
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
    g.status = 'ended';
    this._games.delete(id);
  }

  _applyAuthor(embed, guildId) {
    try { const br = getBranding(guildId, 'battle'); if (br.logo) embed.setAuthor({ name: br.brandName || 'Guild Pilot', iconURL: br.logo }); else embed.setAuthor({ name: br.brandName || 'Guild Pilot' }); } catch {}
  }

  buildLobbyEmbed(game, guildId) {
    const e = new EmbedBuilder().setTitle('⚡ Reaction Race — Join Now!')
      .setDescription(`React with ${JOIN_EMOJI} to join!\n\n**How it works:**\nWhen the bot posts GO, react ⚡ as fast as you can!\nSlowest reactor each round is eliminated.\nLast one standing wins! 🏆`)
      .addFields({ name: '👥 Players Joined', value: game.players.size > 0 ? `${game.players.size} waiting` : '*Be the first!*', inline: true })
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: '#f59e0b', defaultFooter: `Starts in ${game.gatherSecs}s · Need at least 2 players` });
    return e;
  }

  buildReadyEmbed(round, guildId) {
    const e = new EmbedBuilder().setTitle(`⚡ Round ${round} — Get Ready!`).setDescription('A random delay is coming...\n\n🔴 **Wait for it...**').setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: '#f59e0b', defaultFooter: `Round ${round}` });
    return e;
  }

  buildGoEmbed(round, alive, guildId) {
    const e = new EmbedBuilder().setTitle(`⚡ GO! React NOW!`)
      .setDescription(`**React ⚡ as fast as you can!**\nYou have **${COLLECT_MS/1000} seconds!**`)
      .addFields({ name: '👥 Still In', value: `${alive}`, inline: true })
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: '#4ade80', defaultFooter: `Round ${round} · Slowest is out!` });
    return e;
  }

  buildResultEmbed({ round, reacted, eliminated, remaining, guildId }) {
    const lines = reacted.map((id, i) => `${i + 1}. <@${id}>`).join('\n') || '*(nobody reacted)*';
    const e = new EmbedBuilder().setTitle(`⚡ Round ${round} Result`)
      .setDescription(reacted.length ? `**Reaction order:**\n${lines}` : '😱 Nobody reacted in time!')
      .addFields(
        eliminated.length ? { name: '☠️ Eliminated', value: eliminated.map(id => `<@${id}>`).join(', '), inline: false } : { name: '🤝 No Eliminations', value: 'All reacted — full tie, re-rolling!', inline: false },
        { name: '👥 Remaining', value: `${remaining}`, inline: true }
      ).setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: eliminated.length ? '#ef4444' : '#4ade80', defaultFooter: remaining <= 1 ? 'Game ending...' : 'Next round soon...' });
    return e;
  }

  buildWinnerEmbed({ winnerId, rounds, guildId }) {
    const e = new EmbedBuilder().setTitle('🏆 Reaction Race — Champion!').setDescription(`🎉 <@${winnerId}> has the fastest fingers after **${rounds} round${rounds===1?'':'s'}**!\n\n**⚡ Reaction Race Champion!**`).setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: '#f59e0b', defaultFooter: 'GuildPilot · Reaction Race' });
    return e;
  }

  buildCancelledEmbed(reason, guildId) {
    const e = new EmbedBuilder().setTitle('⚡ Reaction Race').setDescription(reason).setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'battle', defaultColor: '#64748b', defaultFooter: 'GuildPilot · Reaction Race' });
    return e;
  }
}

const instance = new ReactionRaceService();
require('./gameRegistry').register(JOIN_EMOJI, instance);
module.exports = instance;
