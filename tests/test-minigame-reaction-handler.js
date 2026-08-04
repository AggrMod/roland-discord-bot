#!/usr/bin/env node

const assert = require('assert');
const gameReactionHandler = require('../services/gameReactionHandler');
const gameNightService = require('../services/gameNightService');
const higherLowerService = require('../services/higherLowerService');
const slotsService = require('../services/slotsService');

function makeMessage(id, guildId = 'guild-minigame-reactions') {
  const edits = [];
  return {
    id,
    guildId,
    guild: { id: guildId },
    edits,
    async edit(payload) {
      edits.push(payload);
      return payload;
    },
  };
}

function makeReaction(message, emoji) {
  return {
    message,
    emoji: { name: emoji },
    users: { remove: async () => {} },
  };
}

async function run() {
  const suffix = Date.now();
  const user = { id: `user-${suffix}`, username: 'Reaction Tester' };

  // Standalone lobby joins and leaves are routed through the registry.
  const slotsMessage = makeMessage(`slots-message-${suffix}`);
  const slotsGame = slotsService.createLobby({
    channelId: `slots-channel-${suffix}`,
    messageId: slotsMessage.id,
    creatorId: `host-${suffix}`,
    gatherSecs: 30,
  });
  let result = await gameReactionHandler.handleReactionAdd(
    makeReaction(slotsMessage, slotsService.JOIN_EMOJI),
    user
  );
  assert.strictEqual(result.handled, true, 'standalone join reaction should be handled');
  assert.strictEqual(slotsGame.players.has(user.id), true, 'standalone player should be added');
  assert.strictEqual(slotsMessage.edits.length, 1, 'standalone lobby should refresh after join');

  result = await gameReactionHandler.handleReactionRemove(
    makeReaction(slotsMessage, slotsService.JOIN_EMOJI),
    user
  );
  assert.strictEqual(result.handled, true, 'standalone leave reaction should be handled');
  assert.strictEqual(slotsGame.players.has(user.id), false, 'standalone player should be removed');
  slotsService.endGame(slotsMessage.id);

  // Game Night uses its message lookup and channel-scoped session state.
  const gameNightMessage = makeMessage(`gamenight-message-${suffix}`);
  const gameNightSession = gameNightService.createSession({
    channelId: `gamenight-channel-${suffix}`,
    messageId: gameNightMessage.id,
    creatorId: `host-${suffix}`,
    gatherSecs: 30,
    selectedGames: ['slots'],
  });
  result = await gameReactionHandler.handleReactionAdd(
    makeReaction(gameNightMessage, gameNightService.JOIN_EMOJI),
    user
  );
  assert.strictEqual(result.type, 'gamenight_lobby', 'Game Night join should use Game Night routing');
  assert.strictEqual(gameNightSession.players.has(user.id), true, 'Game Night player should be added');
  assert.strictEqual(gameNightMessage.edits.length, 1, 'Game Night lobby should refresh after join');

  await gameReactionHandler.handleReactionRemove(
    makeReaction(gameNightMessage, gameNightService.JOIN_EMOJI),
    user
  );
  assert.strictEqual(gameNightSession.players.has(user.id), false, 'Game Night player should be removed');
  gameNightService.endSession(gameNightSession.channelId);

  // Higher or Lower round selections are recorded on the active round message.
  const higherLobbyId = `higher-lobby-${suffix}`;
  const higherGame = higherLowerService.createLobby({
    channelId: `higher-channel-${suffix}`,
    messageId: higherLobbyId,
    creatorId: `host-${suffix}`,
    gatherSecs: 30,
  });
  higherLowerService.addPlayer(higherLobbyId, user.id, user.username);
  higherLowerService.addPlayer(higherLobbyId, `opponent-${suffix}`, 'Opponent');
  higherLowerService.startGame(higherLobbyId);
  const roundMessage = makeMessage(`higher-round-${suffix}`);
  higherLowerService.registerRoundMessage(roundMessage.id, higherGame);

  result = await gameReactionHandler.handleReactionAdd(
    makeReaction(roundMessage, higherLowerService.HIGHER_EMOJI),
    user
  );
  assert.strictEqual(result.type, 'higherlower_round', 'round reaction should use Higher or Lower routing');
  assert.strictEqual(higherGame.guesses.get(user.id), 'higher', 'Higher guess should be recorded');
  higherLowerService.endGame(higherLobbyId);

  // Battle routing respects the era emoji and rebuilds with a participant array.
  const battleMessage = makeMessage(`battle-message-${suffix}`);
  battleMessage.guild.members = {
    fetch: async () => ({ roles: { cache: { map: callback => [{ id: 'role-1' }].map(callback) } } }),
  };
  const calls = { add: null, participants: null };
  const lobby = { lobby_id: `battle-${suffix}`, status: 'open', era: 'ninja' };
  const battleStub = {
    getLobbyByMessage: () => lobby,
    getLobbyJoinEmoji: () => '🥷',
    addParticipant: (...args) => { calls.add = args; return { success: true }; },
    removeParticipant: () => ({ success: true }),
    getLobby: () => lobby,
    getParticipants: () => [{ user_id: user.id, username: user.username }],
    buildLobbyEmbed: (_lobby, participants) => {
      calls.participants = participants;
      return { battle: true };
    },
  };

  result = await gameReactionHandler.handleReactionAdd(
    makeReaction(battleMessage, '🥷'),
    user,
    { battleService: battleStub }
  );
  assert.strictEqual(result.type, 'battle_lobby', 'era-specific Battle emoji should be handled');
  assert.deepStrictEqual(calls.add[3], ['role-1'], 'member role IDs should be passed to Battle gating');
  assert.ok(Array.isArray(calls.participants), 'Battle lobby renderer should receive participant records');

  console.log('minigame reaction handler assertions passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
