#!/usr/bin/env node

const assert = require('assert');
const codebreakerService = require('../services/codebreakerService');
const gameNightService = require('../services/gameNightService');
const gameRegistry = require('../services/gameRegistry');

function run() {
  const secret = codebreakerService.generateSecret(() => 0.25);
  assert.strictEqual(secret.length, 4, 'generated code should contain four digits');
  assert.strictEqual(new Set(secret).size, 4, 'generated code should not repeat digits');
  assert.strictEqual(codebreakerService.isValidGuess('5072'), true, 'four unique digits should be accepted');
  assert.strictEqual(codebreakerService.isValidGuess('5502'), false, 'repeated digits should be rejected');
  assert.strictEqual(codebreakerService.isValidGuess('123'), false, 'short guesses should be rejected');
  assert.strictEqual(codebreakerService.isValidGuess('12a4'), false, 'non-digits should be rejected');

  assert.deepStrictEqual(
    codebreakerService.scoreGuess('5072', '5072'),
    { exact: 4, misplaced: 0, cracked: true },
    'an exact guess should crack the code'
  );
  assert.deepStrictEqual(
    codebreakerService.scoreGuess('5072', '5207'),
    { exact: 1, misplaced: 3, cracked: false },
    'clues should distinguish exact and misplaced digits'
  );

  const game = {
    players: new Set(['alpha', 'beta']),
    playerNames: new Map([['alpha', 'Alpha'], ['beta', 'Beta']]),
    progress: new Map([
      ['alpha', codebreakerService.emptyProgress('alpha')],
      ['beta', codebreakerService.emptyProgress('beta')],
    ]),
    secret: '5072',
  };
  const roundOne = codebreakerService.resolveRound(game, new Map([['alpha', '5207'], ['beta', '5813']]), 1);
  assert.strictEqual(roundOne[0].userId, 'alpha', 'strongest clue result should rank first for the round');
  codebreakerService.resolveRound(game, new Map([['alpha', '5072'], ['beta', '5072']]), 2);
  const rankings = codebreakerService.rankings(game);
  assert.strictEqual(rankings[0].crackedRound, 2, 'cracked round should be retained for final ranking');
  assert.strictEqual(rankings[1].crackedRound, 2, 'same-round crackers should both be represented');

  assert.strictEqual(gameRegistry.getByJoinEmoji(codebreakerService.JOIN_EMOJI), codebreakerService, 'Codebreaker lobby reactions should be registered centrally');
  assert.ok(gameNightService.GAME_ROSTER.includes('codebreaker'), 'Codebreaker should be selectable in Game Night');
  assert.ok(gameNightService.GAME_INFO.codebreaker, 'Codebreaker should have Game Night instructions');

  console.log('Codebreaker game assertions passed');
}

run();
