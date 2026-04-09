#!/usr/bin/env node

const assert = require('assert');
const battleService = require('../services/battleService');
const battleDb = require('../database/battleDb');

function cleanup(channelId, lobbyId) {
  try {
    if (lobbyId) {
      battleDb.prepare('DELETE FROM battle_participants WHERE lobby_id = ?').run(lobbyId);
      battleDb.prepare('DELETE FROM battle_lobbies WHERE lobby_id = ?').run(lobbyId);
    }
    if (channelId) {
      const rows = battleDb.prepare('SELECT lobby_id FROM battle_lobbies WHERE channel_id = ?').all(channelId);
      for (const row of rows) {
        battleDb.prepare('DELETE FROM battle_participants WHERE lobby_id = ?').run(row.lobby_id);
        battleDb.prepare('DELETE FROM battle_lobbies WHERE lobby_id = ?').run(row.lobby_id);
      }
    }
  } catch (error) {
    // Non-fatal in test cleanup.
  }
}

try {
  const channelId = `race_test_channel_${Date.now()}`;
  const creatorId = 'race_creator_user';
  const msgA = `race_msg_a_${Date.now()}`;
  const msgB = `race_msg_b_${Date.now()}`;

  const first = battleService.createLobby(channelId, msgA, creatorId, 2, 10, null, null, 'mafia');
  assert.strictEqual(first.success, true, 'first lobby should be created');

  const second = battleService.createLobby(channelId, msgB, creatorId, 2, 10, null, null, 'mafia');
  assert.strictEqual(second.success, false, 'second lobby in same active channel should be blocked');

  const lobbyId = first.lobbyId;
  cleanup(null, lobbyId);

  const again = battleService.createLobby(channelId, msgA, creatorId, 2, 10, null, null, 'mafia');
  assert.strictEqual(again.success, true, 'lobby should be creatable after cleanup');

  const activeLobbyId = again.lobbyId;
  const joinA = battleService.addParticipant(activeLobbyId, 'race_user_1', 'race_user_1');
  const joinB = battleService.addParticipant(activeLobbyId, 'race_user_2', 'race_user_2');
  assert.strictEqual(joinA.success, true, 'first participant should join');
  assert.strictEqual(joinB.success, true, 'second participant should join');

  const start1 = battleService.startBattle(activeLobbyId, creatorId);
  assert.strictEqual(start1.success, true, 'first start should succeed');

  const start2 = battleService.startBattle(activeLobbyId, creatorId);
  assert.strictEqual(start2.success, false, 'second start should fail because battle is no longer open');

  cleanup(channelId, activeLobbyId);
  console.log('Battle race-safety assertions passed');
} catch (error) {
  console.error(error);
  process.exit(1);
}

