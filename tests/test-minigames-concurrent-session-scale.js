#!/usr/bin/env node

const assert = require('assert');
const gameNightService = require('../services/gameNightService');

async function run() {
  const totalChannels = 200;
  const base = 'channel-minigame-scale-';

  for (let i = 0; i < totalChannels; i += 1) {
    const channelId = `${base}${i}`;
    const session = gameNightService.createSession({
      channelId,
      messageId: `msg-${i}`,
      creatorId: `host-${i}`,
      gatherSecs: 10,
      selectedGames: ['slots', 'trivia']
    });
    assert.ok(session, `session should be created for ${channelId}`);
    for (let p = 0; p < 12; p += 1) {
      const addResult = gameNightService.addPlayer(channelId, `user-${i}-${p}`, `User ${i}-${p}`);
      assert.strictEqual(addResult.success, true, 'player add should succeed while waiting');
    }
    assert.strictEqual(gameNightService.getSession(channelId)?.players?.size, 12, 'all players should be tracked');
  }

  // Mutate and close all sessions, ensuring no stale sessions remain.
  for (let i = 0; i < totalChannels; i += 1) {
    const channelId = `${base}${i}`;
    const removed = gameNightService.removePlayer(channelId, `user-${i}-0`);
    assert.strictEqual(removed.success, true, 'player remove should succeed while waiting');
    gameNightService.endSession(channelId);
    assert.strictEqual(gameNightService.getSession(channelId), null, 'session should be fully removed');
  }

  console.log('minigames concurrent session scale assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

