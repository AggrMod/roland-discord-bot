/**
 * GameNightService — Orchestrates multi-game sessions with cross-game scoring.
 * Growth plan feature. Runs 9 mini-games sequentially, tracks points, crowns champion.
 *
 * Scoring: 1st=10pts � 2nd=7pts � 3rd=5pts � 4th=3pts � 5th+=1pt
 */

const { EmbedBuilder } = require('discord.js');
const { applyEmbedBranding, getBranding } = require('./embedBranding');
const logger = require('../utils/logger');

const JOIN_EMOJI = '🎉';
const SKIP_EMOJI = '⏭️';
const SCORE_TABLE = [10, 7, 5, 3, 1]; // index = (place - 1); 5th+ all get 1pt
const sleep = ms => new Promise(r => setTimeout(r, ms));

const GAME_ROSTER = [
  'diceduel', 'higherlower', 'reactionrace',
  'numberguess', 'slots', 'trivia',
  'wordscramble', 'rps', 'blackjack',
];

const GAME_INFO = {
  diceduel:    { name: '🎲 Dice Duel',       desc: 'Everyone rolls a d6 each round. Lowest roll eliminated. Ties → tiebreaker. Last one standing wins!' },
  higherlower: { name: '🃏 Higher or Lower', desc: 'A card is flipped — guess if the next is Higher ⬆️ or Lower ⬇️. Wrong? You\'re out. Last player wins.' },
  reactionrace:{ name: '⚡ Reaction Race',   desc: 'When GO fires, react ⚡ as fast as possible. Slowest each round is eliminated.' },
  numberguess: { name: '🔢 Number Guess',    desc: 'Bot picks a secret number 1–100. Type your guess in chat. Closest each round scores points. 3 rounds.' },
  slots:       { name: '🎰 Slots',           desc: 'Everyone spins simultaneously. Best combo wins. 💎💎💎 is the jackpot!' },
  trivia:      { name: '❓ Trivia',          desc: '5 questions — react 🇦🇧🇨🇩 for your answer. 20 seconds per question. Most correct wins.' },
  wordscramble:{ name: '🧩 Word Scramble',   desc: 'Unscramble the word by typing it in chat first. 5 rounds, 30 seconds each. Most round wins wins.' },
  rps:         { name: '🪨 RPS Tournament',  desc: 'Bracket matchups! React 🪨 ✂️ 📄. Loser eliminated. Ties re-match. Last one wins.' },
  blackjack:   { name: '🎴 Blackjack',       desc: 'Everyone vs the dealer. React 👆 Hit or ✋ Stand. Get closest to 21 without busting.' },
};

function pointsForPlace(place) {
  return SCORE_TABLE[Math.min(place - 1, SCORE_TABLE.length - 1)];
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE CLASS
// ─────────────────────────────────────────────────────────────────────────────
class GameNightService {
  constructor() {
    this._sessions = new Map(); // channelId → session
  }

  createSession({ channelId, messageId, creatorId, gatherSecs = 60, selectedGames }) {
    const games = (selectedGames && selectedGames.length > 0)
      ? selectedGames.filter(g => GAME_ROSTER.includes(g))
      : [...GAME_ROSTER];
    const session = {
      channelId, lobbyMessageId: messageId, creatorId, gatherSecs,
      status: 'waiting', players: new Set(), playerNames: new Map(),
      scores: new Map(), games, currentGameIndex: 0,
      gatherTimer: null, skipRequested: false,
    };
    this._sessions.set(channelId, session);
    return session;
  }

  getSession(channelId)  { return this._sessions.get(channelId) || null; }
  getByMessage(msgId)    { for (const [, s] of this._sessions) if (s.lobbyMessageId === msgId) return s; return null; }

  addPlayer(channelId, userId, username) {
    const s = this._sessions.get(channelId);
    if (!s || s.status !== 'waiting') return { success: false };
    if (s.players.has(userId)) return { success: false };
    s.players.add(userId);
    s.playerNames.set(userId, username || userId);
    s.scores.set(userId, 0);
    return { success: true, count: s.players.size };
  }

  removePlayer(channelId, userId) {
    const s = this._sessions.get(channelId);
    if (!s || s.status !== 'waiting') return { success: false };
    s.players.delete(userId); s.playerNames.delete(userId); s.scores.delete(userId);
    return { success: true, count: s.players.size };
  }

  endSession(channelId) {
    const s = this._sessions.get(channelId);
    if (!s) return;
    clearTimeout(s.gatherTimer);
    s.status = 'ended';
    this._sessions.delete(channelId);
  }

  awardPoints(session, ranked) {
    ranked.forEach((userId, idx) => {
      session.scores.set(userId, (session.scores.get(userId) || 0) + pointsForPlace(idx + 1));
    });
  }

  // ── Embed builders ──────────────────────────────────────────────────────

  _author(embed, guildId) {
    try { const br = getBranding(guildId, 'minigames'); embed.setAuthor({ name: br.brandName || 'Guild Pilot', ...(br.logo ? { iconURL: br.logo } : {}) }); } catch {}
  }

  buildLobbyEmbed(session, guildId) {
    const GL = { diceduel:'🎲 Dice Duel', higherlower:'🃏 H/L', reactionrace:'⚡ Race', numberguess:'🔢 Guess', slots:'🎰 Slots', trivia:'❓ Trivia', wordscramble:'🧩 Scramble', rps:'🪨 RPS', blackjack:'🎴 Blackjack' };
    const lineup = session.games.map(g => GL[g] || g).join(' → ');
    const playerList = session.players.size > 0 ? [...session.playerNames.values()].map(n => `• ${n}`).join('\n') : '*Be the first!*';
    const e = new EmbedBuilder()
      .setTitle('🎉 Game Night — Join Now!')
      .setDescription(`React ${JOIN_EMOJI} to join!\n\n**Tonight's lineup (${session.games.length} games):**\n${lineup}\n\n**🏆 Scoring:** 🥇 10pts � 🥈 7pts � 🥉 5pts � 4th 3pts � 5th+ 1pt`)
      .addFields({ name: `👥 Players (${session.players.size})`, value: playerList })
      .setTimestamp();
    this._author(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#f59e0b', defaultFooter: `Starts in ${session.gatherSecs}s � Host can react ${SKIP_EMOJI} to skip a game mid-session` });
    return e;
  }

  buildIntroEmbed({ gameIndex, total, gameName, gameDesc, guildId }) {
    const e = new EmbedBuilder()
      .setTitle(`🎮 Game ${gameIndex} of ${total}: ${gameName}`)
      .setDescription(gameDesc + '\n\n*Starting in 4 seconds...*')
      .setTimestamp();
    this._author(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#6366f1', defaultFooter: `Game Night � ${gameIndex}/${total}` });
    return e;
  }

  buildLeaderboardEmbed(session, guildId, afterGame, gamesLeft) {
    const sorted = [...session.scores.entries()].sort((a, b) => b[1] - a[1]);
    const board = sorted.map(([id, s], i) => `${['🥇','🥈','🥉'][i] || `${i+1}.`} **${session.playerNames.get(id) || id}** — ${s} pts`).join('\n');
    const e = new EmbedBuilder()
      .setTitle('📊 Leaderboard')
      .setDescription(`*After ${afterGame}*\n\n${board}`)
      .addFields({ name: '🎮 Games to go', value: `${gamesLeft}`, inline: true })
      .setTimestamp();
    this._author(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#6366f1', defaultFooter: 'GuildPilot � Game Night' });
    return e;
  }

  buildChampionEmbed(session, guildId, totalGames) {
    const sorted = [...session.scores.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted[0][1];
    const winners = sorted.filter(([, s]) => s === top).map(([id]) => id);
    const board = sorted.map(([id, s], i) => `${['🥇','🥈','🥉'][i] || `${i+1}.`} **${session.playerNames.get(id) || id}** — ${s} pts`).join('\n');
    const mention = winners.map(id => `<@${id}>`).join(' & ');
    const e = new EmbedBuilder()
      .setTitle('🏆 Game Night Champion!')
      .setDescription(`🎉 ${mention} wins with **${top} pts**!\n\n**Final Standings:**\n${board}`)
      .addFields({ name: '🎮 Total games', value: `${totalGames}`, inline: true })
      .setTimestamp();
    this._author(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#f59e0b', defaultFooter: 'GuildPilot � Game Night Champion' });
    return e;
  }

  buildCancelledEmbed(reason, guildId) {
    const e = new EmbedBuilder().setTitle('🎉 Game Night').setDescription(reason).setTimestamp();
    this._author(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#64748b', defaultFooter: 'GuildPilot � Game Night' });
    return e;
  }

  // ── Main orchestrator ───────────────────────────────────────────────────

  async run(session, channel, guildId) {
    session.status = 'playing';
    const total = session.games.length;
    const GL = { diceduel:'🎲 Dice Duel', higherlower:'🃏 Higher or Lower', reactionrace:'⚡ Reaction Race', numberguess:'🔢 Number Guess', slots:'🎰 Slots', trivia:'❓ Trivia', wordscramble:'🧩 Word Scramble', rps:'🪨 RPS Tournament', blackjack:'🎴 Blackjack' };

    for (let i = 0; i < total; i++) {
      session.currentGameIndex = i;
      session.skipRequested = false;
      const gameKey = session.games[i];
      const info = GAME_INFO[gameKey] || { name: gameKey, desc: '' };

      await sleep(3000);
      const introMsg = await channel.send({ embeds: [this.buildIntroEmbed({ gameIndex: i + 1, total, gameName: info.name, gameDesc: info.desc, guildId })] });
      await introMsg.react(SKIP_EMOJI).catch(() => {});
      await sleep(4000);

      let ranked = [];
      if (!session.skipRequested) {
        try {
          const runner = RUNNERS[gameKey];
          ranked = runner ? await runner(channel, guildId, new Set(session.players), new Map(session.playerNames), session) : [...session.players];
        } catch (err) {
          logger.error(`[GameNight] ${gameKey} error:`, err);
          ranked = [...session.players];
        }
      } else {
        ranked = [...session.players]; // skipped → no points awarded fairly, give equal
        await channel.send({ embeds: [this.buildCancelledEmbed('⏭️ Game skipped by host.', guildId)] });
      }

      this.awardPoints(session, ranked);

      if (i < total - 1) {
        await sleep(3000);
        await channel.send({ embeds: [this.buildLeaderboardEmbed(session, guildId, GL[gameKey] || gameKey, total - i - 1)] });
        await sleep(5000);
      }
    }

    await sleep(2000);
    const sorted = [...session.scores.entries()].sort((a, b) => b[1] - a[1]);
    const topWinners = sorted.filter(([, s]) => s === sorted[0][1]).map(([id]) => `<@${id}>`);
    await channel.send({ content: topWinners.join(' '), embeds: [this.buildChampionEmbed(session, guildId, total)] });
    this.endSession(channel.id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GAME RUNNERS — each receives (channel, guildId, players Set, playerNames Map, session)
//                and returns ranked userId[] (winner first → last)
// ─────────────────────────────────────────────────────────────────────────────
const RUNNERS = {};

// ── 1. DICE DUEL ─────────────────────────────────────────────────────────────
RUNNERS.diceduel = async (channel, guildId, players, playerNames, session) => {
  const ddSvc = require('./diceDuelService');
  const FACES = ['⚀','⚁','⚂','⚃','⚄','⚅'];
  const roll = () => Math.floor(Math.random() * 6) + 1;

  const alive = new Set(players);
  const eliminated = []; // earliest eliminated = last in final ranking
  let round = 0;

  while (alive.size > 1) {
    if (session.skipRequested) break;
    round++;
    await sleep(1500);

    const rolls = new Map();
    for (const id of alive) rolls.set(id, roll());
    const min = Math.min(...rolls.values());
    const atMin = [...rolls.entries()].filter(([, v]) => v === min).map(([id]) => id);

    const lines = [...rolls.entries()].sort((a, b) => b[1] - a[1])
      .map(([id, v]) => `${FACES[v-1]} **${playerNames.get(id) || id}** — ${v}${v === min && alive.size > 1 ? ' 💀' : ''}`).join('\n');

    let isTie = atMin.length > 1;
    let toElim = atMin;

    if (isTie) {
      // Tiebreaker
      const tieRolls = new Map();
      for (const id of atMin) tieRolls.set(id, roll());
      const tieMin = Math.min(...tieRolls.values());
      toElim = [...tieRolls.entries()].filter(([, v]) => v === tieMin).map(([id]) => id);
      const tieLines = [...tieRolls.entries()].map(([id, v]) => `${FACES[v-1]} ${playerNames.get(id) || id} — ${v}`).join('\n');
      const { EmbedBuilder: EB } = require('discord.js');
      const te = new EB().setTitle(`🎲 Round ${round} — Tiebreaker!`).setDescription(`${lines}\n\n**Tiebreaker:**\n${tieLines}`).setTimestamp();
      applyEmbedBranding(te, { guildId, moduleKey: 'minigames', defaultColor: '#f59e0b', defaultFooter: `Game Night � Dice Duel Round ${round}` });
      await channel.send({ embeds: [te] });
    } else {
      const { EmbedBuilder: EB } = require('discord.js');
      const e = new EB().setTitle(`🎲 Round ${round}`).setDescription(lines).setTimestamp();
      applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#6366f1', defaultFooter: `Game Night � Dice Duel Round ${round}` });
      await channel.send({ embeds: [e] });
    }

    for (const id of toElim) { alive.delete(id); eliminated.unshift(id); }
    await sleep(2000);
  }

  const winner = [...alive][0] || null;
  if (winner) {
    const { EmbedBuilder: EB } = require('discord.js');
    const we = new EB().setTitle('🎲 Dice Duel — Winner!').setDescription(`🏆 **${playerNames.get(winner) || winner}** is the last one standing!`).setTimestamp();
    applyEmbedBranding(we, { guildId, moduleKey: 'minigames', defaultColor: '#4ade80', defaultFooter: 'Game Night � Dice Duel' });
    await channel.send({ embeds: [we] });
    return [winner, ...eliminated];
  }
  return eliminated;
};

// ── 2. HIGHER OR LOWER ───────────────────────────────────────────────────────
RUNNERS.higherlower = async (channel, guildId, players, playerNames, session) => {
  const { EmbedBuilder: EB } = require('discord.js');
  const SUITS = ['♠️','♥️','♦️','♣️'];
  const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const rankVal = r => RANKS.indexOf(r) + 2;
  const buildDeck = () => { const d=[]; for(const s of SUITS) for(const r of RANKS) d.push({r,s}); for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];} return d; };
  const cardStr = c => `**${c.r}${c.s}**`;

  const deck = buildDeck();
  let current = deck.pop();
  const alive = new Set(players);
  const eliminated = [];
  let round = 0;

  while (alive.size > 1 && deck.length > 1) {
    if (session.skipRequested) break;
    round++;
    const next = deck.pop();
    const correctEmoji = rankVal(next.r) > rankVal(current.r) ? '⬆️' : rankVal(next.r) < rankVal(current.r) ? '⬇️' : null;

    const qEmbed = new EB()
      .setTitle(`🃏 Round ${round} — Higher or Lower?`)
      .setDescription(`Current card: ${cardStr(current)}\n\nReact ⬆️ Higher or ⬇️ Lower!\nYou have **20 seconds**.`)
      .setTimestamp();
    applyEmbedBranding(qEmbed, { guildId, moduleKey: 'minigames', defaultColor: '#6366f1', defaultFooter: `Game Night � Higher or Lower � ${alive.size} left` });
    const qMsg = await channel.send({ embeds: [qEmbed] });
    await qMsg.react('⬆️').catch(() => {}); await qMsg.react('⬇️').catch(() => {});

    const picks = new Map();
    const col = qMsg.createReactionCollector({ filter: (r, u) => ['⬆️','⬇️'].includes(r.emoji.name) && !u.bot && alive.has(u.id), time: 20000 });
    col.on('collect', (r, u) => { if (!picks.has(u.id)) picks.set(u.id, r.emoji.name); });
    await new Promise(res => col.on('end', res));

    // Eliminate wrong guesses (or non-reactors)
    const toElim = [];
    for (const id of alive) {
      const pick = picks.get(id);
      if (!correctEmoji) continue; // tie card — nobody eliminated
      if (!pick || pick !== correctEmoji) toElim.push(id);
    }
    // Don't eliminate if everyone would be out
    const willSurvive = [...alive].filter(id => !toElim.includes(id));
    const actualElim = willSurvive.length === 0 ? [] : toElim;

    const lines = [...alive].map(id => {
      const pick = picks.get(id) || '❓';
      const correct = !correctEmoji || pick === correctEmoji;
      return `${correct ? '✅' : '❌'} **${playerNames.get(id) || id}** — ${pick}`;
    }).join('\n');

    const rEmbed = new EB()
      .setTitle(`🃏 Round ${round} — Reveal!`)
      .setDescription(`Card was: ${cardStr(next)}\nCorrect: ${correctEmoji || '🤝 Tie! No eliminations.'}\n\n${lines}`)
      .setTimestamp();
    applyEmbedBranding(rEmbed, { guildId, moduleKey: 'minigames', defaultColor: actualElim.length > 0 ? '#ef4444' : '#4ade80', defaultFooter: `Game Night � Higher or Lower` });
    await channel.send({ embeds: [rEmbed] });

    for (const id of actualElim) { alive.delete(id); eliminated.unshift(id); }
    current = next;
    await sleep(2000);
  }

  const winner = alive.size === 1 ? [...alive][0] : null;
  if (winner) {
    const we = new EB().setTitle('🃏 Higher or Lower — Winner!').setDescription(`🏆 **${playerNames.get(winner) || winner}** is the last one standing!`).setTimestamp();
    applyEmbedBranding(we, { guildId, moduleKey: 'minigames', defaultColor: '#4ade80', defaultFooter: 'Game Night � Higher or Lower' });
    await channel.send({ embeds: [we] });
  }
  return winner ? [winner, ...eliminated] : [...eliminated, ...(winner ? [] : [...alive])];
};

// ── 3. REACTION RACE ─────────────────────────────────────────────────────────
RUNNERS.reactionrace = async (channel, guildId, players, playerNames, session) => {
  const { EmbedBuilder: EB } = require('discord.js');
  const RACE_EMOJI = '⚡';
  const alive = new Set(players);
  const eliminated = [];
  let round = 0;

  while (alive.size > 1) {
    if (session.skipRequested) break;
    round++;
    await sleep(2000);

    const readyE = new EB().setTitle(`⚡ Round ${round} — Get Ready!`).setDescription(`React ${RACE_EMOJI} as fast as you can when GO appears!\nRandom delay incoming...`).setTimestamp();
    applyEmbedBranding(readyE, { guildId, moduleKey: 'minigames', defaultColor: '#6366f1', defaultFooter: `Game Night � Reaction Race � ${alive.size} left` });
    const readyMsg = await channel.send({ embeds: [readyE] });
    await sleep(2000 + Math.floor(Math.random() * 5000));

    const goE = new EB().setTitle(`⚡ GO! GO! GO!`).setDescription(`React ${RACE_EMOJI} NOW! **8 seconds!**`).setTimestamp();
    applyEmbedBranding(goE, { guildId, moduleKey: 'minigames', defaultColor: '#f59e0b', defaultFooter: `Game Night � Reaction Race Round ${round}` });
    await readyMsg.edit({ embeds: [goE] });
    await readyMsg.react(RACE_EMOJI).catch(() => {});

    const order = [];
    const col = readyMsg.createReactionCollector({ filter: (r, u) => r.emoji.name === RACE_EMOJI && !u.bot && alive.has(u.id), time: 8000 });
    col.on('collect', (_, u) => { if (!order.includes(u.id)) order.push(u.id); });
    await new Promise(res => col.on('end', res));

    const noReact = [...alive].filter(id => !order.includes(id));
    let toElim = noReact.length > 0 ? noReact : (order.length > 0 ? [order[order.length - 1]] : []);
    const willSurvive = [...alive].filter(id => !toElim.includes(id));
    if (willSurvive.length === 0) toElim = [toElim[0]]; // at least keep everyone except one

    const lines = [...order].map((id, i) => `${i === order.length - 1 && toElim.includes(id) ? '💀' : '✅'} **${playerNames.get(id) || id}** — reacted #${i+1}`).join('\n');
    const noLines = noReact.map(id => `💀 **${playerNames.get(id) || id}** — didn't react`).join('\n');

    const resE = new EB().setTitle(`⚡ Round ${round} Results`).setDescription(`${lines}${noLines ? '\n' + noLines : ''}`).setTimestamp();
    applyEmbedBranding(resE, { guildId, moduleKey: 'minigames', defaultColor: '#ef4444', defaultFooter: `Game Night � Reaction Race` });
    await channel.send({ embeds: [resE] });

    for (const id of toElim) { alive.delete(id); eliminated.unshift(id); }
    await sleep(2000);
  }

  const winner = [...alive][0] || null;
  if (winner) {
    const { EmbedBuilder: EB2 } = require('discord.js');
    const we = new EB2().setTitle('⚡ Reaction Race — Winner!').setDescription(`🏆 **${playerNames.get(winner) || winner}** has the fastest reflexes!`).setTimestamp();
    applyEmbedBranding(we, { guildId, moduleKey: 'minigames', defaultColor: '#4ade80', defaultFooter: 'Game Night � Reaction Race' });
    await channel.send({ embeds: [we] });
  }
  return winner ? [winner, ...eliminated] : [...eliminated];
};

// ── 4. NUMBER GUESS ───────────────────────────────────────────────────────────
RUNNERS.numberguess = async (channel, guildId, players, playerNames, session) => {
  const { EmbedBuilder: EB } = require('discord.js');
  const ROUNDS = 3;
  const scores = new Map([...players].map(id => [id, 0]));

  for (let round = 1; round <= ROUNDS; round++) {
    if (session.skipRequested) break;
    const secret = Math.floor(Math.random() * 100) + 1;
    const qE = new EB().setTitle(`🔢 Round ${round}/${ROUNDS} — Guess the Number!`).setDescription(`I'm thinking of a number between **1 and 100**.\nType your guess in chat! You have **30 seconds**.\nClosest wins the round!`).setTimestamp();
    applyEmbedBranding(qE, { guildId, moduleKey: 'minigames', defaultColor: '#6366f1', defaultFooter: `Game Night � Number Guess Round ${round}` });
    await channel.send({ embeds: [qE] });

    const guesses = new Map();
    const col = channel.createMessageCollector({ filter: m => players.has(m.author.id) && /^\d+$/.test(m.content.trim()), time: 30000 });
    col.on('collect', m => { if (!guesses.has(m.author.id)) guesses.set(m.author.id, parseInt(m.content.trim())); });
    await new Promise(res => col.on('end', res));

    // Score: 10-(distance) floored at 1, or 10 for exact
    let roundScores = [];
    for (const [id, g] of guesses) {
      const dist = Math.abs(g - secret);
      const pts = Math.max(1, 10 - Math.floor(dist / 5));
      scores.set(id, (scores.get(id) || 0) + pts);
      roundScores.push({ id, g, dist, pts });
    }
    roundScores.sort((a, b) => a.dist - b.dist);
    const lines = roundScores.map((r, i) => `${['🥇','🥈','🥉'][i] || `${i+1}.`} **${playerNames.get(r.id) || r.id}** guessed ${r.g} (off by ${r.dist}) +${r.pts}pts`).join('\n') || '*Nobody guessed!*';
    const nonGuessers = [...players].filter(id => !guesses.has(id)).map(id => `• ${playerNames.get(id) || id}`).join(', ');

    const rE = new EB().setTitle(`🔢 Round ${round} — Answer: ${secret}!`).setDescription(lines + (nonGuessers ? `\n\n*Didn't guess: ${nonGuessers}*` : '')).setTimestamp();
    applyEmbedBranding(rE, { guildId, moduleKey: 'minigames', defaultColor: '#4ade80', defaultFooter: `Game Night � Number Guess Round ${round}` });
    await channel.send({ embeds: [rE] });
    await sleep(3000);
  }

  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const wE = new EB().setTitle('🔢 Number Guess — Results!').setDescription(sorted.map(([id, s], i) => `${['🥇','🥈','🥉'][i] || `${i+1}.`} **${playerNames.get(id) || id}** — ${s} pts`).join('\n')).setTimestamp();
  applyEmbedBranding(wE, { guildId, moduleKey: 'minigames', defaultColor: '#f59e0b', defaultFooter: 'Game Night � Number Guess' });
  await channel.send({ embeds: [wE] });
  return sorted.map(([id]) => id);
};

// ── 5. SLOTS ──────────────────────────────────────────────────────────────────
RUNNERS.slots = async (channel, guildId, players, playerNames, session) => {
  const { EmbedBuilder: EB } = require('discord.js');
  const REELS = ['💎','🍒','🍋','⭐','🔔','🍇'];
  const SCORES = { '💎💎💎': 100, '🍒🍒🍒': 80, '⭐⭐⭐': 70, '🔔🔔🔔': 60, '🍋🍋🍋': 50, '🍇🍇🍇': 40 };
  const spin = () => [0,1,2].map(() => REELS[Math.floor(Math.random()*REELS.length)]);
  const score = r => { const k = r.join(''); if (SCORES[k]) return SCORES[k]; if (r[0]===r[1]||r[1]===r[2]||r[0]===r[2]) return 20; return 5; };

  const results = [...players].map(id => { const r = spin(); return { id, reels: r, score: score(r) }; }).sort((a, b) => b.score - a.score);
  const lines = results.map((r, i) => `${['🥇','🥈','🥉'][i] || `${i+1}.`} **${playerNames.get(r.id) || r.id}** | ${r.reels.join('')} | ${r.score}pts`).join('\n');

  const e = new EB().setTitle('🎰 Slots — Results!').setDescription(lines).setTimestamp();
  applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#f59e0b', defaultFooter: 'Game Night � Slots' });
  await channel.send({ embeds: [e] });
  return results.map(r => r.id);
};

// ── 6. TRIVIA ─────────────────────────────────────────────────────────────────
RUNNERS.trivia = async (channel, guildId, players, playerNames, session) => {
  const { EmbedBuilder: EB } = require('discord.js');
  const triSvc = require('./triviaService');
  const scores = new Map([...players].map(id => [id, 0]));
  const EMOJIS = ['🇦','🇧','🇨','🇩'];
  const pool = [...triSvc._questionBank || []];
  if (!pool.length) { // fallback mini bank
    pool.push(
      { q:'What is 2+2?', opts:['3','4','5','6'], ans:1 },
      { q:'Which planet is closest to the Sun?', opts:['Venus','Mercury','Earth','Mars'], ans:1 },
      { q:'What color do you get mixing red and blue?', opts:['Green','Orange','Purple','Brown'], ans:2 },
      { q:'How many sides does a hexagon have?', opts:['5','6','7','8'], ans:1 },
      { q:'What is the capital of France?', opts:['London','Berlin','Paris','Madrid'], ans:2 },
    );
  }
  const questions = pool.sort(()=>Math.random()-.5).slice(0, Math.min(5, pool.length));

  for (let i = 0; i < questions.length; i++) {
    if (session.skipRequested) break;
    const q = questions[i];
    const opts = (q.options || q.opts || []).slice(0, 4);
    const correctIdx = q.correctIndex ?? q.ans ?? 0;
    const optLines = opts.map((o, j) => `${EMOJIS[j]} ${o}`).join('\n');
    const qE = new EB().setTitle(`❓ Q${i+1}/${questions.length}`).setDescription(`**${q.question || q.q}**\n\n${optLines}\n\nYou have **20 seconds**!`).setTimestamp();
    applyEmbedBranding(qE, { guildId, moduleKey: 'minigames', defaultColor: '#6366f1', defaultFooter: `Game Night � Trivia Q${i+1}` });
    const qMsg = await channel.send({ embeds: [qE] });
    for (const e of EMOJIS) await qMsg.react(e).catch(() => {});

    const picks = new Map();
    const col = qMsg.createReactionCollector({ filter: (r, u) => EMOJIS.includes(r.emoji.name) && !u.bot && players.has(u.id), time: 20000 });
    col.on('collect', (r, u) => { if (!picks.has(u.id)) picks.set(u.id, r.emoji.name); });
    await new Promise(res => col.on('end', res));

    const correctEmoji = EMOJIS[correctIdx];
    const winners = [];
    for (const [id, pick] of picks) if (pick === correctEmoji) { scores.set(id, (scores.get(id)||0)+1); winners.push(id); }

    const lines = [...players].map(id => {
      const p = picks.get(id);
      return `${p === correctEmoji ? '✅' : p ? '❌' : '🔇'} **${playerNames.get(id) || id}**${p ? ` — ${p}` : ' — no answer'}`;
    }).join('\n');
    const aE = new EB().setTitle(`❓ Answer: ${correctEmoji} ${opts[correctIdx] || '?'}`).setDescription(lines).setTimestamp();
    applyEmbedBranding(aE, { guildId, moduleKey: 'minigames', defaultColor: winners.length > 0 ? '#4ade80' : '#ef4444', defaultFooter: `Game Night � Trivia Q${i+1}` });
    await channel.send({ embeds: [aE] });
    await sleep(2500);
  }

  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const wE = new EB().setTitle('❓ Trivia — Results!').setDescription(sorted.map(([id, s], i) => `${['🥇','🥈','🥉'][i] || `${i+1}.`} **${playerNames.get(id) || id}** — ${s} correct`).join('\n')).setTimestamp();
  applyEmbedBranding(wE, { guildId, moduleKey: 'minigames', defaultColor: '#f59e0b', defaultFooter: 'Game Night � Trivia' });
  await channel.send({ embeds: [wE] });
  return sorted.map(([id]) => id);
};

// ── 7. WORD SCRAMBLE ─────────────────────────────────────────────────────────
RUNNERS.wordscramble = async (channel, guildId, players, playerNames, session) => {
  const { EmbedBuilder: EB } = require('discord.js');
  const wsSvc = require('./wordScrambleService');
  const scores = new Map([...players].map(id => [id, 0]));
  const WORDS = ['discord','crypto','bitcoin','solana','wallet','blockchain','diamond','thunder','castle','pirate','galaxy','dragon','trophy','legend','market'];
  const pool = WORDS.sort(() => Math.random() - 0.5).slice(0, 5);

  for (let round = 1; round <= pool.length; round++) {
    if (session.skipRequested) break;
    const word = pool[round - 1];
    const arr = word.split(''); for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];} const scrambled = arr.join('') === word ? arr.reverse().join('') : arr.join('');
    const blanks = '_ '.repeat(word.length).trim();

    const qE = new EB().setTitle(`🧩 Round ${round}/5 — Unscramble!`).setDescription(`**\`${scrambled.toUpperCase()}\`**\n${blanks}\n\nType the correct word in chat! **30 seconds**. First correct wins the round!`).setTimestamp();
    applyEmbedBranding(qE, { guildId, moduleKey: 'minigames', defaultColor: '#6366f1', defaultFooter: `Game Night � Word Scramble Round ${round}` });
    await channel.send({ embeds: [qE] });

    let winnerId = null;
    const col = channel.createMessageCollector({ filter: m => players.has(m.author.id), time: 30000 });
    await new Promise(res => {
      col.on('collect', m => { if (m.content.trim().toLowerCase() === word && !winnerId) { winnerId = m.author.id; scores.set(winnerId, (scores.get(winnerId)||0)+1); col.stop(); } });
      col.on('end', res);
    });

    const rE = new EB().setTitle(`🧩 Round ${round} — The word was **${word}**!`).setDescription(winnerId ? `🏆 **${playerNames.get(winnerId) || winnerId}** got it first!` : '😮 Nobody got it!').setTimestamp();
    applyEmbedBranding(rE, { guildId, moduleKey: 'minigames', defaultColor: winnerId ? '#4ade80' : '#ef4444', defaultFooter: `Game Night � Word Scramble` });
    await channel.send({ embeds: [rE] });
    await sleep(2000);
  }

  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const wE = new EB().setTitle('🧩 Word Scramble — Results!').setDescription(sorted.map(([id, s], i) => `${['🥇','🥈','🥉'][i] || `${i+1}.`} **${playerNames.get(id) || id}** — ${s} round${s===1?'':'s'} won`).join('\n')).setTimestamp();
  applyEmbedBranding(wE, { guildId, moduleKey: 'minigames', defaultColor: '#f59e0b', defaultFooter: 'Game Night � Word Scramble' });
  await channel.send({ embeds: [wE] });
  return sorted.map(([id]) => id);
};

// ── 8. RPS TOURNAMENT ────────────────────────────────────────────────────────
RUNNERS.rps = async (channel, guildId, players, playerNames, session) => {
  const { EmbedBuilder: EB } = require('discord.js');
  const CHOICES = ['🪨','✂️','📄'];
  const beats = (a, b) => (a==='🪨'&&b==='✂️')||(a==='✂️'&&b==='📄')||(a==='📄'&&b==='🪨');
  const alive = new Set(players);
  const eliminated = [];
  let round = 0;

  while (alive.size > 1) {
    if (session.skipRequested) break;
    round++;
    const list = [...alive].sort(() => Math.random() - 0.5);
    const matchups = [];
    let bye = null;
    for (let i = 0; i < list.length; i += 2) {
      if (i + 1 < list.length) matchups.push([list[i], list[i+1]]);
      else bye = list[i];
    }
    if (bye) { const bE = new EB().setTitle(`🪨 Round ${round} — Bye`).setDescription(`**${playerNames.get(bye) || bye}** gets a free pass this round! 🍀`).setTimestamp(); applyEmbedBranding(bE,{guildId,moduleKey: 'minigames',defaultColor:'#4ade80',defaultFooter:`Game Night � RPS Round ${round}`}); await channel.send({embeds:[bE]}); }

    for (const [pA, pB] of matchups) {
      const mE = new EB().setTitle(`🪨 Round ${round} — ${playerNames.get(pA)||pA} vs ${playerNames.get(pB)||pB}`).setDescription(`React 🪨 Rock � ✂️ Scissors � 📄 Paper\nYou have **25 seconds**!`).setTimestamp();
      applyEmbedBranding(mE,{guildId,moduleKey: 'minigames',defaultColor:'#e74c3c',defaultFooter:`Game Night � RPS Round ${round}`});
      const mMsg = await channel.send({embeds:[mE]});
      for (const e of CHOICES) await mMsg.react(e).catch(()=>{});

      const picks = new Map();
      const col = mMsg.createReactionCollector({ filter:(r,u)=>CHOICES.includes(r.emoji.name)&&!u.bot&&[pA,pB].includes(u.id), time:25000 });
      col.on('collect',(r,u)=>{ if(!picks.has(u.id)) picks.set(u.id, r.emoji.name); });
      await new Promise(res=>col.on('end',res));

      const cA = picks.get(pA)||null, cB = picks.get(pB)||null;
      let loser = null;
      if (!cA && !cB) { /* both no-show — both out */  }
      else if (!cA) loser = pA; else if (!cB) loser = pB;
      else if (beats(cA,cB)) loser = pB; else if (beats(cB,cA)) loser = pA;
      // else draw — no elimination

      const label = c => c || '❓';
      const rLine = `**${playerNames.get(pA)||pA}**: ${label(cA)} vs **${playerNames.get(pB)||pB}**: ${label(cB)}`;
      const outcome = loser ? `💀 **${playerNames.get(loser)||loser}** is eliminated!` : '🤝 Draw — both advance!';
      const resE = new EB().setTitle(`🪨 Matchup Result`).setDescription(`${rLine}\n\n${outcome}`).setTimestamp();
      applyEmbedBranding(resE,{guildId,moduleKey: 'minigames',defaultColor:loser?'#ef4444':'#6366f1',defaultFooter:`Game Night � RPS`});
      await channel.send({embeds:[resE]});
      if (loser) { alive.delete(loser); eliminated.unshift(loser); }
      if (!cA && !cB) { alive.delete(pA); alive.delete(pB); eliminated.unshift(pB); eliminated.unshift(pA); }
      await sleep(1500);
    }
  }

  const winner = [...alive][0] || null;
  if (winner) {
    const wE = new EB().setTitle('🪨 RPS — Winner!').setDescription(`🏆 **${playerNames.get(winner)||winner}** wins the RPS Tournament!`).setTimestamp();
    applyEmbedBranding(wE,{guildId,moduleKey: 'minigames',defaultColor:'#4ade80',defaultFooter:'Game Night � RPS'});
    await channel.send({embeds:[wE]});
  }
  return winner ? [winner, ...eliminated] : [...eliminated];
};

// ── 9. BLACKJACK ─────────────────────────────────────────────────────────────
RUNNERS.blackjack = async (channel, guildId, players, playerNames, session) => {
  const { EmbedBuilder: EB } = require('discord.js');
  const SUITS = ['♠️','♥️','♦️','♣️'], RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const buildDeck = () => { const d=[]; for(const s of SUITS) for(const r of RANKS) d.push({r,s}); for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];} return d; };
  const cardVal = r => ['J','Q','K'].includes(r)?10:r==='A'?11:parseInt(r);
  const handVal = cards => { let t=0,a=0; for(const c of cards){ if(c.r==='A'){t+=11;a++;}else t+=cardVal(c.r); } while(t>21&&a>0){t-=10;a--;} return t; };
  const cardStr = c => `${c.r}${c.s}`;
  const handStr = cards => cards.map(cardStr).join(' ');

  const deck = buildDeck();
  const draw = () => deck.pop();
  const dealerHand = [draw(), draw()];
  const hands = new Map([...players].map(id => [id, [draw(), draw()]]));

  // Show initial state
  const tableE = new EB().setTitle('🎴 Blackjack — Cards Dealt!')
    .setDescription(`**Dealer:** ${cardStr(dealerHand[0])} 🂠\n\n` + [...players].map(id => `**${playerNames.get(id)||id}:** ${handStr(hands.get(id))} (${handVal(hands.get(id))})`).join('\n'))
    .setTimestamp();
  applyEmbedBranding(tableE, {guildId, moduleKey: 'minigames', defaultColor:'#6366f1', defaultFooter:'Game Night � Blackjack'});
  await channel.send({embeds:[tableE]});
  await sleep(2000);

  // Each player's turn
  for (const id of players) {
    let hand = hands.get(id);
    let val = handVal(hand);
    if (val === 21) { await channel.send({ content: `🎴 **${playerNames.get(id)||id}** has Blackjack! (${handStr(hand)} = 21)` }); continue; }

    const tE = new EB().setTitle(`🎴 ${playerNames.get(id)||id}'s turn!`)
      .setDescription(`Your hand: ${handStr(hand)} — **${val}**\n\nReact 👆 to **Hit** or ✋ to **Stand**. 20 seconds.`)
      .setTimestamp();
    applyEmbedBranding(tE, {guildId, moduleKey: 'minigames', defaultColor:'#6366f1', defaultFooter:'Game Night � Blackjack'});
    const tMsg = await channel.send({content:`<@${id}>`, embeds:[tE]});
    await tMsg.react('👆').catch(()=>{}); await tMsg.react('✋').catch(()=>{});

    let standing = false;
    while (!standing && handVal(hand) < 21) {
      let decision = null;
      const col = tMsg.createReactionCollector({filter:(r,u)=>['👆','✋'].includes(r.emoji.name)&&u.id===id&&!u.bot, time:20000, max:1});
      await new Promise(res=>{ col.on('collect',r=>{decision=r.emoji.name;res();}); col.on('end',res); });
      if (!decision || decision === '✋') { standing = true; break; }
      hand.push(draw());
      val = handVal(hand);
      if (val >= 21) break;
      const updE = new EB().setTitle(`🎴 ${playerNames.get(id)||id} — Hit!`).setDescription(`Hand: ${handStr(hand)} — **${val}**${val>21?' 💀 BUST!':''}\n\nReact 👆 Hit or ✋ Stand. 20s.`).setTimestamp();
      applyEmbedBranding(updE,{guildId,moduleKey: 'minigames',defaultColor:val>21?'#ef4444':'#6366f1',defaultFooter:'Game Night � Blackjack'});
      await tMsg.edit({embeds:[updE]});
    }
    await sleep(1000);
  }

  // Dealer plays
  while (handVal(dealerHand) < 17) dealerHand.push(draw());
  const dealerVal = handVal(dealerHand);

  // Results
  const results = [];
  for (const id of players) {
    const hand = hands.get(id); const val = handVal(hand);
    const bust = val > 21;
    const outcome = bust ? 'bust' : dealerVal > 21 ? 'win' : val > dealerVal ? 'win' : val === dealerVal ? 'push' : 'lose';
    results.push({ id, hand, val, bust, outcome });
  }
  results.sort((a, b) => {
    const o = { win: 0, push: 1, lose: 2, bust: 3 };
    return (o[a.outcome] - o[b.outcome]) || b.val - a.val;
  });

  const lines = results.map((r, i) => {
    const icon = {win:'🏆',push:'🤝',lose:'❌',bust:'💀'}[r.outcome];
    return `${icon} **${playerNames.get(r.id)||r.id}** — ${handStr(r.hand)} (${r.val}) — ${r.outcome.toUpperCase()}`;
  }).join('\n');

  const resE = new EB().setTitle('🎴 Blackjack — Results!').setDescription(`**Dealer:** ${handStr(dealerHand)} (${dealerVal})${dealerVal>21?' 💀 BUST!':''}\n\n${lines}`).setTimestamp();
  applyEmbedBranding(resE,{guildId,moduleKey: 'minigames',defaultColor:'#f59e0b',defaultFooter:'Game Night � Blackjack'});
  await channel.send({embeds:[resE]});
  return results.map(r => r.id);
};

// ─────────────────────────────────────────────────────────────────────────────
const instance = new GameNightService();
instance.JOIN_EMOJI  = JOIN_EMOJI;
instance.SKIP_EMOJI  = SKIP_EMOJI;
instance.GAME_ROSTER = GAME_ROSTER;
instance.GAME_INFO   = GAME_INFO;
module.exports = instance;
