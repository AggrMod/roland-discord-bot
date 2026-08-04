const { EmbedBuilder } = require('discord.js');
const { applyEmbedBranding, getBranding } = require('./embedBranding');

const JOIN_EMOJI = '🔐';
const CODE_LENGTH = 4;
const MAX_ROUNDS = 6;
const GUESS_SECS = 25;

class CodebreakerService {
  constructor() {
    this._games = new Map();
  }

  get JOIN_EMOJI() { return JOIN_EMOJI; }
  get CODE_LENGTH() { return CODE_LENGTH; }
  get MAX_ROUNDS() { return MAX_ROUNDS; }
  get GUESS_SECS() { return GUESS_SECS; }

  createLobby({ channelId, messageId, creatorId, gatherSecs = 60 }) {
    const game = {
      lobbyMessageId: messageId,
      channelId,
      creatorId,
      gatherSecs,
      status: 'waiting',
      players: new Set(),
      playerNames: new Map(),
      progress: new Map(),
      round: 0,
      gatherTimer: null,
      secret: null,
    };
    this._games.set(messageId, game);
    return game;
  }

  getGameByLobby(id) { return this._games.get(id) || null; }

  addPlayer(id, userId, username = null) {
    const game = this._games.get(id);
    if (!game || game.status !== 'waiting' || game.players.has(userId)) return { success: false };
    game.players.add(userId);
    game.playerNames.set(userId, username || userId);
    game.progress.set(userId, this.emptyProgress(userId));
    return { success: true, count: game.players.size };
  }

  removePlayer(id, userId) {
    const game = this._games.get(id);
    if (!game || game.status !== 'waiting') return { success: false };
    game.players.delete(userId);
    game.playerNames.delete(userId);
    game.progress.delete(userId);
    return { success: true, count: game.players.size };
  }

  endGame(id) {
    const game = this._games.get(id);
    if (!game) return;
    clearTimeout(game.gatherTimer);
    game.status = 'ended';
    game.secret = null;
    this._games.delete(id);
  }

  emptyProgress(userId) {
    return { userId, bestExact: 0, bestMisplaced: 0, totalSignal: 0, crackedRound: null, lastGuess: null };
  }

  generateSecret(random = Math.random) {
    const digits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    for (let index = digits.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Number(random()) * (index + 1));
      [digits[index], digits[swapIndex]] = [digits[swapIndex], digits[index]];
    }
    return digits.slice(0, CODE_LENGTH).join('');
  }

  isValidGuess(value) {
    const guess = String(value ?? '').trim();
    return /^\d{4}$/.test(guess) && new Set(guess).size === CODE_LENGTH;
  }

  scoreGuess(secret, value) {
    const guess = String(value ?? '').trim();
    if (!this.isValidGuess(secret) || !this.isValidGuess(guess)) {
      return { exact: 0, misplaced: 0, cracked: false };
    }
    let exact = 0;
    let misplaced = 0;
    for (let index = 0; index < CODE_LENGTH; index += 1) {
      if (guess[index] === secret[index]) exact += 1;
      else if (secret.includes(guess[index])) misplaced += 1;
    }
    return { exact, misplaced, cracked: exact === CODE_LENGTH };
  }

  resolveRound(game, guesses, round) {
    const results = [...game.players].map(userId => {
      const guess = guesses.get(userId) || null;
      const score = guess ? this.scoreGuess(game.secret, guess) : { exact: 0, misplaced: 0, cracked: false };
      const progress = game.progress.get(userId) || this.emptyProgress(userId);
      if (guess) {
        const improvesBest = score.exact > progress.bestExact
          || (score.exact === progress.bestExact && score.misplaced > progress.bestMisplaced);
        if (improvesBest) {
          progress.bestExact = score.exact;
          progress.bestMisplaced = score.misplaced;
        }
        progress.totalSignal += (score.exact * 3) + score.misplaced;
        progress.lastGuess = guess;
        if (score.cracked && progress.crackedRound === null) progress.crackedRound = round;
      }
      game.progress.set(userId, progress);
      return { userId, guess, ...score };
    });
    results.sort((a, b) => Number(b.cracked) - Number(a.cracked)
      || b.exact - a.exact
      || b.misplaced - a.misplaced
      || String(a.userId).localeCompare(String(b.userId)));
    return results;
  }

  rankings(game) {
    return [...game.progress.values()].sort((a, b) => {
      const aCracked = a.crackedRound !== null;
      const bCracked = b.crackedRound !== null;
      return Number(bCracked) - Number(aCracked)
        || (aCracked && bCracked ? a.crackedRound - b.crackedRound : 0)
        || b.bestExact - a.bestExact
        || b.bestMisplaced - a.bestMisplaced
        || b.totalSignal - a.totalSignal
        || String(a.userId).localeCompare(String(b.userId));
    });
  }

  _applyAuthor(embed, guildId) {
    try {
      const branding = getBranding(guildId, 'minigames');
      embed.setAuthor({ name: branding.brandName || 'Guild Pilot', ...(branding.logo ? { iconURL: branding.logo } : {}) });
    } catch (_) {}
  }

  _brand(embed, guildId, color, footer) {
    this._applyAuthor(embed, guildId);
    applyEmbedBranding(embed, { guildId, moduleKey: 'minigames', defaultColor: color, defaultFooter: footer });
    return embed;
  }

  buildLobbyEmbed(game, guildId) {
    const embed = new EmbedBuilder()
      .setTitle('🔐 Codebreaker — Join now')
      .setDescription(`React ${JOIN_EMOJI} to join.\n\nCrack a **4-digit code** with no repeated digits. After every guess you learn how many digits are in the **right place** and how many are correct but **misplaced**.\n\nUp to **${MAX_ROUNDS} rounds**. First to crack the code wins.`)
      .addFields({ name: 'Players', value: game.players.size ? `${game.players.size} ready` : 'Be the first to join', inline: true })
      .setTimestamp();
    return this._brand(embed, guildId, '#8b7cff', `Starts in ${game.gatherSecs}s · Need at least 2 players`);
  }

  buildRoundEmbed(round, guildId) {
    const embed = new EmbedBuilder()
      .setTitle(`🔐 Codebreaker — Round ${round}/${MAX_ROUNDS}`)
      .setDescription(`Type one **4-digit guess** with no repeated digits, for example \`5072\`.\nYou have **${GUESS_SECS} seconds**. Your first valid guess counts.`)
      .setTimestamp();
    return this._brand(embed, guildId, '#6366f1', `Round ${round} of ${MAX_ROUNDS}`);
  }

  buildRoundResultEmbed({ round, results, playerNames, guildId }) {
    const lines = results.map(result => {
      const name = playerNames.get(result.userId) || result.userId;
      if (!result.guess) return `— **${name}** did not submit a guess`;
      if (result.cracked) return `🔓 **${name}** · \`${result.guess}\` · **Code cracked**`;
      return `• **${name}** · \`${result.guess}\` · ${result.exact} right place · ${result.misplaced} misplaced`;
    });
    const embed = new EmbedBuilder()
      .setTitle(`Codebreaker — Round ${round} clues`)
      .setDescription(lines.join('\n').slice(0, 3900) || 'No valid guesses were submitted.')
      .setTimestamp();
    return this._brand(embed, guildId, results.some(result => result.cracked) ? '#4ade80' : '#8b7cff', 'Use each clue to improve your next guess');
  }

  buildWinnerEmbed({ game, rankings, guildId }) {
    const winner = rankings[0] || null;
    const cracked = winner?.crackedRound !== null;
    const leaders = winner
      ? rankings.filter(entry => entry.crackedRound === winner.crackedRound
        && entry.bestExact === winner.bestExact
        && entry.bestMisplaced === winner.bestMisplaced
        && entry.totalSignal === winner.totalSignal)
      : [];
    const names = leaders.map(entry => `**${game.playerNames.get(entry.userId) || entry.userId}**`).join(' & ');
    const outcome = cracked
      ? `${names} cracked the code in round **${winner.crackedRound}**.`
      : `${names || 'Nobody'} came closest before the round limit.`;
    const standings = rankings.slice(0, 5).map((entry, index) =>
      `${index + 1}. **${game.playerNames.get(entry.userId) || entry.userId}** · ${entry.bestExact} right place · ${entry.bestMisplaced} misplaced`
    ).join('\n');
    const embed = new EmbedBuilder()
      .setTitle('🏆 Codebreaker complete')
      .setDescription(`${outcome}\n\nThe secret was \`${game.secret}\`.\n\n${standings}`)
      .setTimestamp();
    return this._brand(embed, guildId, '#e7ce9c', 'GuildPilot · Codebreaker');
  }

  buildCancelledEmbed(reason, guildId) {
    return this._brand(new EmbedBuilder().setTitle('🔐 Codebreaker').setDescription(reason).setTimestamp(), guildId, '#64748b', 'GuildPilot · Codebreaker');
  }
}

const instance = new CodebreakerService();
require('./gameRegistry').register(JOIN_EMOJI, instance);
module.exports = instance;
