const battleService = require('./battleService');
const gameNightService = require('./gameNightService');
const gameRegistry = require('./gameRegistry');
const higherLowerService = require('./higherLowerService');
const logger = require('../utils/logger');

function reactionContext(reaction) {
  return {
    message: reaction?.message || null,
    messageId: String(reaction?.message?.id || ''),
    guildId: String(reaction?.message?.guildId || reaction?.message?.guild?.id || ''),
    emoji: String(reaction?.emoji?.name || ''),
  };
}

async function refreshLobbyMessage(message, embed) {
  if (!message || typeof message.edit !== 'function' || !embed) return;
  await message.edit({ embeds: [embed] });
}

async function handleBattleAdd(reaction, user, context, deps) {
  const lobby = deps.battleService.getLobbyByMessage(context.messageId);
  if (!lobby || lobby.status !== 'open') return null;

  const joinEmoji = deps.battleService.getLobbyJoinEmoji(lobby.era || 'mafia');
  if (context.emoji !== joinEmoji) return null;

  let member = null;
  try {
    if (typeof context.message?.guild?.members?.fetch === 'function') {
      member = await context.message.guild.members.fetch(user.id);
    }
  } catch (_) {}
  const roles = member?.roles?.cache?.map?.(role => role.id) || [];
  const result = deps.battleService.addParticipant(lobby.lobby_id, user.id, user.username, roles);

  if (result.success) {
    const refreshedLobby = deps.battleService.getLobby(lobby.lobby_id) || lobby;
    const participants = deps.battleService.getParticipants(lobby.lobby_id);
    await refreshLobbyMessage(
      context.message,
      deps.battleService.buildLobbyEmbed(refreshedLobby, participants)
    );
  } else {
    try {
      if (typeof reaction.users?.remove === 'function') await reaction.users.remove(user.id);
    } catch (_) {}
    try {
      if (result.message && typeof user.send === 'function') await user.send(`❌ ${result.message}`);
    } catch (_) {}
  }

  return { handled: true, type: 'battle_lobby', result };
}

async function handleGameNightAdd(reaction, user, context, deps) {
  const session = deps.gameNightService.getByMessage(context.messageId);
  if (!session || context.emoji !== deps.gameNightService.JOIN_EMOJI) return null;

  const result = deps.gameNightService.addPlayer(session.channelId, user.id, user.username);
  if (result.success) {
    await refreshLobbyMessage(
      context.message,
      deps.gameNightService.buildLobbyEmbed(session, context.guildId)
    );
  }
  return { handled: true, type: 'gamenight_lobby', result };
}

function handleHigherLowerGuess(user, context, deps) {
  const guesses = new Map([
    [deps.higherLowerService.HIGHER_EMOJI, 'higher'],
    [deps.higherLowerService.LOWER_EMOJI, 'lower'],
  ]);
  const guess = guesses.get(context.emoji);
  if (!guess || !deps.higherLowerService.getGameByRound(context.messageId)) return null;
  const result = deps.higherLowerService.recordGuess(context.messageId, user.id, guess);
  return { handled: true, type: 'higherlower_round', result };
}

async function handleRegisteredLobbyAdd(reaction, user, context, deps) {
  const service = deps.gameRegistry.getByJoinEmoji(context.emoji);
  const game = service?.getGameByLobby?.(context.messageId);
  if (!service || !game) return null;

  const result = service.addPlayer(context.messageId, user.id, user.username);
  if (result.success) {
    await refreshLobbyMessage(context.message, service.buildLobbyEmbed(game, context.guildId));
  }
  return { handled: true, type: 'minigame_lobby', result };
}

async function handleReactionAdd(reaction, user, overrides = {}) {
  const deps = {
    battleService,
    gameNightService,
    gameRegistry,
    higherLowerService,
    ...overrides,
  };
  const context = reactionContext(reaction);
  if (!context.messageId || !context.emoji || !user?.id) return { handled: false };

  try {
    return await handleBattleAdd(reaction, user, context, deps)
      || await handleGameNightAdd(reaction, user, context, deps)
      || handleHigherLowerGuess(user, context, deps)
      || await handleRegisteredLobbyAdd(reaction, user, context, deps)
      || { handled: false };
  } catch (error) {
    logger.error('[Minigames] reaction add handler failed:', error);
    return { handled: false, error };
  }
}

async function handleBattleRemove(reaction, user, context, deps) {
  const lobby = deps.battleService.getLobbyByMessage(context.messageId);
  if (!lobby || lobby.status !== 'open') return null;
  const joinEmoji = deps.battleService.getLobbyJoinEmoji(lobby.era || 'mafia');
  if (context.emoji !== joinEmoji) return null;

  const result = deps.battleService.removeParticipant(lobby.lobby_id, user.id);
  if (result.success) {
    const refreshedLobby = deps.battleService.getLobby(lobby.lobby_id) || lobby;
    const participants = deps.battleService.getParticipants(lobby.lobby_id);
    await refreshLobbyMessage(
      context.message,
      deps.battleService.buildLobbyEmbed(refreshedLobby, participants)
    );
  }
  return { handled: true, type: 'battle_lobby', result };
}

async function handleReactionRemove(reaction, user, overrides = {}) {
  const deps = {
    battleService,
    gameNightService,
    gameRegistry,
    higherLowerService,
    ...overrides,
  };
  const context = reactionContext(reaction);
  if (!context.messageId || !context.emoji || !user?.id) return { handled: false };

  try {
    const battleResult = await handleBattleRemove(reaction, user, context, deps);
    if (battleResult) return battleResult;

    const session = deps.gameNightService.getByMessage(context.messageId);
    if (session && context.emoji === deps.gameNightService.JOIN_EMOJI) {
      const result = deps.gameNightService.removePlayer(session.channelId, user.id);
      if (result.success) {
        await refreshLobbyMessage(
          context.message,
          deps.gameNightService.buildLobbyEmbed(session, context.guildId)
        );
      }
      return { handled: true, type: 'gamenight_lobby', result };
    }

    const service = deps.gameRegistry.getByJoinEmoji(context.emoji);
    const game = service?.getGameByLobby?.(context.messageId);
    if (service && game) {
      const result = service.removePlayer(context.messageId, user.id);
      if (result.success) {
        await refreshLobbyMessage(context.message, service.buildLobbyEmbed(game, context.guildId));
      }
      return { handled: true, type: 'minigame_lobby', result };
    }

    return { handled: false };
  } catch (error) {
    logger.error('[Minigames] reaction remove handler failed:', error);
    return { handled: false, error };
  }
}

module.exports = {
  handleReactionAdd,
  handleReactionRemove,
};
