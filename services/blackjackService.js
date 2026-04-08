const { EmbedBuilder } = require('discord.js');
const { applyEmbedBranding, getBranding } = require('./embedBranding');

const JOIN_EMOJI = '🎴';
const HIT_EMOJI  = '👆';
const STAND_EMOJI = '✋';
const TURN_SECS  = 25;

const SUITS = ['♠️','♥️','♦️','♣️'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

function buildDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ r, s });
  for (let i = deck.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [deck[i],deck[j]] = [deck[j],deck[i]];
  }
  return deck;
}

function cardVal(rank) {
  if (['J','Q','K'].includes(rank)) return 10;
  if (rank === 'A') return 11; // handled in handValue
  return parseInt(rank);
}

function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    if (c.r === 'A') { total += 11; aces++; }
    else total += cardVal(c.r);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function cardStr(c) { return `${c.r}${c.s}`; }
function handStr(cards) { return cards.map(cardStr).join(' '); }

class BlackjackService {
  constructor() { this._games = new Map(); }
  get JOIN_EMOJI()   { return JOIN_EMOJI; }
  get HIT_EMOJI()    { return HIT_EMOJI; }
  get STAND_EMOJI()  { return STAND_EMOJI; }
  get TURN_SECS()    { return TURN_SECS; }

  createLobby({ channelId, messageId, creatorId, gatherSecs = 60 }) {
    const game = { lobbyMessageId: messageId, channelId, creatorId, gatherSecs,
      status: 'waiting', players: new Set(), gatherTimer: null,
      deck: [], hands: new Map(), dealerHand: [], results: new Map() };
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
  endGame(id) {
    const g = this._games.get(id);
    if (!g) return;
    clearTimeout(g.gatherTimer);
    g.status = 'ended'; this._games.delete(id);
  }

  deal(game) {
    game.deck = buildDeck();
    const draw = () => game.deck.pop();
    game.dealerHand = [draw(), draw()]; // dealer[1] is face-down
    for (const id of game.players) {
      game.hands.set(id, [draw(), draw()]);
    }
  }

  dealerPlay(game) {
    while (handValue(game.dealerHand) < 17) {
      game.dealerHand.push(game.deck.pop());
    }
    return handValue(game.dealerHand);
  }

  resolveAll(game) {
    const dealerVal = handValue(game.dealerHand);
    const dealerBust = dealerVal > 21;
    const results = new Map();
    for (const id of game.players) {
      const hand = game.hands.get(id) || [];
      const val  = handValue(hand);
      const bust = val > 21;
      let outcome;
      if (bust) outcome = 'bust';
      else if (dealerBust || val > dealerVal) outcome = 'win';
      else if (val === dealerVal) outcome = 'push';
      else outcome = 'lose';
      results.set(id, { hand, val, outcome });
    }
    game.results = results;
    return { results, dealerVal, dealerBust };
  }

  _applyAuthor(embed, guildId) {
    try { const br = getBranding(guildId, 'minigames'); if (br.logo) embed.setAuthor({ name: br.brandName||'Guild Pilot', iconURL: br.logo }); else embed.setAuthor({ name: br.brandName||'Guild Pilot' }); } catch {}
  }

  buildLobbyEmbed(game, guildId) {
    const e = new EmbedBuilder().setTitle('🎴 Blackjack — Join Now!')
      .setDescription(`React ${JOIN_EMOJI} to join!\n\n**How it works:**\nEveryone plays against the dealer.\nGet as close to **21** as you can without going bust!\nReact 👆 to **Hit** (take a card) or ✋ to **Stand** (stay).\n\n> Dealer must hit until 17+\n> Aces = 11 or 1`)
      .addFields({ name: '👥 Players', value: game.players.size > 0 ? `${game.players.size} waiting` : '*Be the first!*', inline: true })
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#f59e0b', defaultFooter: `Starts in ${game.gatherSecs}s · Need at least 2 players` });
    return e;
  }

  buildTableEmbed({ game, dealerVisible, guildId }) {
    const dealerShow = dealerVisible
      ? `${handStr(game.dealerHand)} (${handValue(game.dealerHand)})`
      : `${cardStr(game.dealerHand[0])} 🂠`;
    const playerLines = [...game.players].map(id => {
      const hand = game.hands.get(id) || [];
      const val  = handValue(hand);
      const bust = val > 21;
      return `<@${id}>: ${handStr(hand)} — **${val}**${bust ? ' 💀 BUST' : ''}`;
    }).join('\n');
    const e = new EmbedBuilder().setTitle('🎴 Blackjack — Table')
      .setDescription(`**Dealer:** ${dealerShow}\n\n**Players:**\n${playerLines}`)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#6366f1', defaultFooter: 'GuildPilot · Blackjack' });
    return e;
  }

  buildTurnEmbed({ userId, hand, guildId }) {
    const val  = handValue(hand);
    const bust = val > 21;
    const e = new EmbedBuilder().setTitle(`🎴 <@${userId}>'s Turn`)
      .setDescription(`Your hand: ${handStr(hand)} — **${val}**${bust ? '\n\n💀 **BUST!**' : ''}\n\nReact 👆 to **Hit** or ✋ to **Stand**. You have **${TURN_SECS}s**.`)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: bust ? '#ef4444' : val >= 17 ? '#fbbf24' : '#4ade80', defaultFooter: 'React to take your turn' });
    return e;
  }

  buildResultEmbed({ results, dealerVal, dealerBust, dealerHand, guildId }) {
    const dealerStr = `${handStr(dealerHand)} — **${dealerVal}**${dealerBust ? ' 💀 BUST' : ''}`;
    const lines = [...results.entries()].map(([id, r]) => {
      const icon = { win:'🏆', lose:'❌', push:'🤝', bust:'💀' }[r.outcome] || '';
      return `${icon} <@${id}>: ${handStr(r.hand)} (${r.val}) — **${r.outcome.toUpperCase()}**`;
    }).join('\n');
    const e = new EmbedBuilder().setTitle('🎴 Blackjack — Final Results')
      .setDescription(`**Dealer:** ${dealerStr}\n\n${lines}`)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#f59e0b', defaultFooter: 'GuildPilot · Blackjack' });
    return e;
  }

  buildWinnerEmbed({ winners, guildId }) {
    const mention = winners.map(id=>`<@${id}>`).join(', ');
    const e = new EmbedBuilder().setTitle('🏆 Blackjack — Winner!')
      .setDescription(`🎉 ${mention} beat${winners.length===1?'s':''} the dealer!\n\n**🎴 Blackjack Champion${winners.length>1?'s':''}!**`)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#f59e0b', defaultFooter: 'GuildPilot · Blackjack' });
    return e;
  }

  buildCancelledEmbed(reason, guildId) {
    const e = new EmbedBuilder().setTitle('🎴 Blackjack').setDescription(reason).setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#64748b', defaultFooter: 'GuildPilot · Blackjack' });
    return e;
  }
}

const instance = new BlackjackService();
require('./gameRegistry').register(JOIN_EMOJI, instance);
module.exports = instance;
