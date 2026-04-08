const { EmbedBuilder } = require('discord.js');
const { applyEmbedBranding, getBranding } = require('./embedBranding');

const JOIN_EMOJI   = '❓';
const ANSWER_EMOJIS = ['🇦','🇧','🇨','🇩'];
const Q_PER_GAME   = 5;
const Q_SECS       = 20;

// ── Question bank (index of correct answer is 0-based) ──────────────────────
const QUESTION_BANK = [
  { q:'What is the largest planet in our solar system?', a:1, c:['Mars','Jupiter','Saturn','Neptune'] },
  { q:'How many sides does a hexagon have?', a:1, c:['Five','Six','Seven','Eight'] },
  { q:'What year was Bitcoin created?', a:1, c:['2006','2009','2011','2013'] },
  { q:'What does "NFT" stand for?', a:0, c:['Non-Fungible Token','New Financial Tool','Network File Transfer','No Fixed Term'] },
  { q:'Which blockchain is Solana?', a:2, c:['EVM-compatible','Proof of Work','Proof of History','Layer 2'] },
  { q:'What gas is most abundant in Earth\'s atmosphere?', a:1, c:['Oxygen','Nitrogen','Carbon Dioxide','Argon'] },
  { q:'How many cards are in a standard deck?', a:2, c:['48','50','52','54'] },
  { q:'What is the capital of Japan?', a:0, c:['Tokyo','Osaka','Kyoto','Hiroshima'] },
  { q:'What is the chemical symbol for gold?', a:2, c:['Gd','Gl','Au','Go'] },
  { q:'In chess, which piece can only move diagonally?', a:3, c:['Rook','Knight','Queen','Bishop'] },
  { q:'How many players are on a basketball team on the court?', a:1, c:['4','5','6','7'] },
  { q:'What is the hardest natural substance on Earth?', a:2, c:['Quartz','Ruby','Diamond','Sapphire'] },
  { q:'Which planet is known as the Red Planet?', a:0, c:['Mars','Venus','Mercury','Jupiter'] },
  { q:'What does "DeFi" stand for?', a:2, c:['Digital Finance','Deflation Index','Decentralized Finance','Deferred Funds'] },
  { q:'How many bits are in a byte?', a:1, c:['4','8','16','32'] },
  { q:'What year did Discord launch?', a:1, c:['2013','2015','2017','2019'] },
  { q:'Which language runs in the browser natively?', a:0, c:['JavaScript','Python','Ruby','Go'] },
  { q:'What is the max supply of Bitcoin?', a:2, c:['10 million','18 million','21 million','100 million'] },
  { q:'What does "DAO" stand for?', a:1, c:['Digital Asset Organization','Decentralized Autonomous Organization','Distributed Application Output','Direct Access Override'] },
  { q:'Which ocean is the largest?', a:0, c:['Pacific','Atlantic','Indian','Arctic'] },
  { q:'What is the smallest prime number?', a:1, c:['0','2','1','3'] },
  { q:'In what country was the Eiffel Tower built?', a:2, c:['Italy','Germany','France','Spain'] },
  { q:'What does HTTP stand for?', a:0, c:['HyperText Transfer Protocol','High Transfer Text Protocol','HyperText Transmission Process','Hybrid Text Transfer Protocol'] },
  { q:'How many strings does a standard guitar have?', a:2, c:['4','5','6','7'] },
  { q:'What is the speed of light (approx) in km/s?', a:3, c:['100,000','200,000','250,000','300,000'] },
  { q:'Which emoji is the Slots jackpot in GuildPilot?', a:1, c:['🎲','7️⃣','🎰','💎'] },
  { q:'What year did Ethereum launch?', a:1, c:['2013','2015','2017','2020'] },
  { q:'Which crypto uses "Proof of History"?', a:2, c:['Ethereum','Bitcoin','Solana','Cardano'] },
  { q:'How many minutes in a day?', a:2, c:['1200','1320','1440','1560'] },
  { q:'What does "APY" stand for in DeFi?', a:0, c:['Annual Percentage Yield','Average Payment Year','Asset Pool Yield','Automated Protocol Yield'] },
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class TriviaService {
  constructor() { this._games = new Map(); }
  get JOIN_EMOJI()    { return JOIN_EMOJI; }
  get ANSWER_EMOJIS() { return ANSWER_EMOJIS; }
  get Q_SECS()        { return Q_SECS; }

  createLobby({ channelId, messageId, creatorId, gatherSecs = 60 }) {
    const questions = shuffle(QUESTION_BANK).slice(0, Q_PER_GAME);
    const game = { lobbyMessageId: messageId, channelId, creatorId, gatherSecs,
      status: 'waiting', players: new Set(), scores: new Map(),
      questions, qIndex: 0, gatherTimer: null };
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

  currentQuestion(game) { return game.questions[game.qIndex]; }

  resolveAnswers(game, reactions) {
    const q = this.currentQuestion(game);
    const correct = ANSWER_EMOJIS[q.a];
    const winners = [], losers = [];
    for (const userId of game.players) {
      const picked = reactions.get(userId);
      if (picked === correct) { game.scores.set(userId, (game.scores.get(userId)||0)+1); winners.push(userId); }
      else losers.push(userId);
    }
    return { winners, losers, correctEmoji: correct, correctText: q.c[q.a] };
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
    const e = new EmbedBuilder().setTitle('❓ Trivia — Join Now!')
      .setDescription(`React ${JOIN_EMOJI} to join!\n\n**${Q_PER_GAME} questions**, each with 4 choices.\nReact 🇦🇧🇨🇩 to answer — ${Q_SECS}s per question.\nMost correct answers wins! 🏆`)
      .addFields({ name: '👥 Players', value: game.players.size > 0 ? `${game.players.size} waiting` : '*Be the first!*', inline: true })
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#6366f1', defaultFooter: `Starts in ${game.gatherSecs}s · Need at least 2 players` });
    return e;
  }

  buildQuestionEmbed({ q, qNum, total, guildId }) {
    const choices = q.c.map((c, i) => `${ANSWER_EMOJIS[i]} ${c}`).join('\n');
    const e = new EmbedBuilder().setTitle(`❓ Question ${qNum}/${total}`)
      .setDescription(`**${q.q}**\n\n${choices}\n\n*React with your answer — ${Q_SECS}s!*`)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#6366f1', defaultFooter: `Question ${qNum} of ${total}` });
    return e;
  }

  buildAnswerEmbed({ q, qNum, total, winners, losers, correctEmoji, correctText, guildId }) {
    const e = new EmbedBuilder().setTitle(`✅ Question ${qNum} Answer: ${correctEmoji} ${correctText}`)
      .setDescription([
        winners.length ? `✅ **Correct:** ${winners.map(id=>`<@${id}>`).join(', ')}` : '😬 Nobody got it right!',
        losers.length  ? `❌ **Wrong:** ${losers.map(id=>`<@${id}>`).join(', ')}` : '',
      ].filter(Boolean).join('\n'))
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#4ade80', defaultFooter: `Q${qNum}/${total} resolved` });
    return e;
  }

  buildScoreboardEmbed({ qNum, total, scores, guildId }) {
    const sorted = [...scores.entries()].sort((a,b)=>b[1]-a[1]);
    const lines = sorted.map(([id,s],i) => `${i===0?'🥇':i===1?'🥈':i===2?'🥉':`${i+1}.`} <@${id}> — **${s}/${qNum}**`).join('\n');
    const e = new EmbedBuilder().setTitle(`📊 Standings after Q${qNum}/${total}`).setDescription(lines||'*No scores yet*').setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#6366f1', defaultFooter: qNum < total ? 'Next question coming up...' : 'Final standings!' });
    return e;
  }

  buildWinnerEmbed({ winners, score, total, guildId }) {
    const mention = winners.map(id=>`<@${id}>`).join(' & ');
    const e = new EmbedBuilder().setTitle('🏆 Trivia — Champion!')
      .setDescription(`🎉 ${mention} wins with **${score}/${total}** correct!\n\n**❓ Trivia Champion${winners.length>1?'s':''}!**`)
      .setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#f59e0b', defaultFooter: 'GuildPilot · Trivia' });
    return e;
  }

  buildCancelledEmbed(reason, guildId) {
    const e = new EmbedBuilder().setTitle('❓ Trivia').setDescription(reason).setTimestamp();
    this._applyAuthor(e, guildId);
    applyEmbedBranding(e, { guildId, moduleKey: 'minigames', defaultColor: '#64748b', defaultFooter: 'GuildPilot · Trivia' });
    return e;
  }
}

const instance = new TriviaService();
require('./gameRegistry').register(JOIN_EMOJI, instance);
module.exports = instance;
