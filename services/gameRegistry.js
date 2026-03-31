/**
 * gameRegistry — central registry for mini-game lobby join/leave reactions.
 * Each game service self-registers with its lobby JOIN emoji.
 * index.js uses this to handle lobby reactions without per-game handlers.
 *
 * Required interface on registered services:
 *   getGameByLobby(messageId) → game | null
 *   addPlayer(lobbyMessageId, userId, username) → { success, count }
 *   removePlayer(lobbyMessageId, userId) → { success, count }
 *   buildLobbyEmbed(game, guildId) → EmbedBuilder
 */
const registry = new Map(); // joinEmoji → service

function register(joinEmoji, service) {
  registry.set(joinEmoji, service);
}

function getByJoinEmoji(emoji) {
  return registry.get(emoji) || null;
}

module.exports = { register, getByJoinEmoji };
