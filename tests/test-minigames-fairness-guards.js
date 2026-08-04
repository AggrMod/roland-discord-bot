#!/usr/bin/env node

const assert = require('assert');
const gameNightService = require('../services/gameNightService');
const numberGuessService = require('../services/numberGuessService');
const rpsService = require('../services/rpsService');

function run() {
  assert.strictEqual(numberGuessService.isValidGuess('1'), true, 'lower bound should be accepted');
  assert.strictEqual(numberGuessService.isValidGuess('100'), true, 'upper bound should be accepted');
  assert.strictEqual(numberGuessService.isValidGuess('0'), false, 'zero must be rejected');
  assert.strictEqual(numberGuessService.isValidGuess('101'), false, 'values above the range must be rejected');
  assert.strictEqual(numberGuessService.isValidGuess('12.5'), false, 'decimal guesses must be rejected');
  assert.strictEqual(numberGuessService.isValidGuess('not-a-number'), false, 'non-numeric guesses must be rejected');

  const session = gameNightService.createSession({
    channelId: `fairness-${Date.now()}`,
    messageId: `message-${Date.now()}`,
    creatorId: 'host',
    selectedGames: ['trivia', 'trivia', 'slots', 'unknown', 'slots'],
  });
  assert.deepStrictEqual(session.games, ['trivia', 'slots'], 'Game Night should deduplicate and discard unsupported service inputs');
  gameNightService.endSession(session.channelId);

  const noShow = rpsService.resolveMatchup(null, null, 'player-a', 'player-b');
  assert.strictEqual(noShow.bothAbsent, true, 'two RPS no-shows should be terminal');
  assert.deepStrictEqual(noShow.eliminated, ['player-a', 'player-b'], 'both no-shows should be eliminated');
  assert.strictEqual(rpsService.shouldForceTiebreaker(2, 3), false, 'early draws should permit a rematch');
  assert.strictEqual(rpsService.shouldForceTiebreaker(3, 3), true, 'the configured draw limit should force a result');

  const firstWins = rpsService.resolveTiebreaker('player-a', 'player-b', 0.1);
  const secondWins = rpsService.resolveTiebreaker('player-a', 'player-b', 0.9);
  assert.deepStrictEqual([firstWins.winner, firstWins.loser], ['player-a', 'player-b'], 'lower tiebreaker roll should select first player');
  assert.deepStrictEqual([secondWins.winner, secondWins.loser], ['player-b', 'player-a'], 'higher tiebreaker roll should select second player');

  console.log('minigames fairness guard assertions passed');
}

run();
