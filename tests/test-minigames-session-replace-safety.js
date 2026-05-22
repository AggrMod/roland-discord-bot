#!/usr/bin/env node

const assert = require('assert');
const gameNightService = require('../services/gameNightService');

function resetChannel(channelId) {
  gameNightService.endSession(channelId);
}

async function run() {
  const channelId = 'channel-minigame-replace';
  resetChannel(channelId);

  const originalClearTimeout = global.clearTimeout;
  const cleared = [];
  global.clearTimeout = (timer) => {
    cleared.push(timer);
  };

  try {
    const first = gameNightService.createSession({
      channelId,
      messageId: 'msg-1',
      creatorId: 'host-1',
      gatherSecs: 45
    });
    first.gatherTimer = { timer: 'first-timer' };

    const second = gameNightService.createSession({
      channelId,
      messageId: 'msg-2',
      creatorId: 'host-1',
      gatherSecs: 30
    });

    assert.ok(second, 'replacement session should be created');
    assert.strictEqual(
      gameNightService.getSession(channelId)?.lobbyMessageId,
      'msg-2',
      'latest session should be active after replacement'
    );
    assert.strictEqual(cleared.length, 1, 'previous gather timer should be cleared on replacement');
    assert.deepStrictEqual(cleared[0], { timer: 'first-timer' }, 'cleared timer should belong to prior session');

    gameNightService.endSession(channelId);
    assert.strictEqual(gameNightService.getSession(channelId), null, 'session should be removed after endSession');
    assert.strictEqual(cleared.length, 2, 'endSession should also clear the active session timer');
  } finally {
    global.clearTimeout = originalClearTimeout;
    resetChannel(channelId);
  }

  console.log('minigames session replacement safety assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

