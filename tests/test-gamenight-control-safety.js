#!/usr/bin/env node

const assert = require('assert');
const { EventEmitter } = require('events');
const gameNightService = require('../services/gameNightService');

class FakeCollector extends EventEmitter {
  constructor() {
    super();
    this.stopReason = null;
  }

  stop(reason) {
    this.stopReason = reason;
    this.emit('end');
  }
}

function createSession(channelId) {
  const session = gameNightService.createSession({
    channelId,
    messageId: `message-${channelId}`,
    creatorId: `host-${channelId}`,
    gatherSecs: 30,
    selectedGames: ['trivia', 'slots'],
  });
  session.status = 'playing';
  return session;
}

function run() {
  const skipSession = createSession(`skip-${Date.now()}`);
  const skipCollector = new FakeCollector();
  skipSession.activeCollectors.add(skipCollector);

  assert.strictEqual(gameNightService.requestSkip(skipSession.channelId), true, 'active game should accept skip');
  assert.strictEqual(skipSession.skipRequested, true, 'skip should be visible to the active runner');
  assert.strictEqual(skipCollector.stopReason, 'game_skipped', 'skip should stop the active collector immediately');
  assert.strictEqual(gameNightService.getSession(skipSession.channelId), skipSession, 'skip should keep Game Night active');
  gameNightService.endSession(skipSession.channelId);

  const cancelSession = createSession(`cancel-${Date.now()}`);
  const cancelCollector = new FakeCollector();
  cancelSession.activeCollectors.add(cancelCollector);

  assert.strictEqual(gameNightService.cancelSession(cancelSession.channelId), true, 'active Game Night should cancel');
  assert.strictEqual(cancelSession.cancelRequested, true, 'cancel flag should remain visible to the running task');
  assert.strictEqual(cancelSession.status, 'cancelled', 'cancelled session should not look completed');
  assert.strictEqual(cancelCollector.stopReason, 'session_cancelled', 'cancel should stop the active collector immediately');
  assert.strictEqual(gameNightService.getSession(cancelSession.channelId), null, 'cancelled session should be removed');

  console.log('Game Night control safety assertions passed');
}

run();
