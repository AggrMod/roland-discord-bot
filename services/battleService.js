const db = require('../database/battleDb');
const mainDb = require('../database/db');
const logger = require('../utils/logger');
const { applyEmbedBranding } = require('./embedBranding');
const { EmbedBuilder } = require('discord.js');
const { randomInt } = require('crypto');
const { BATTLE_ERAS } = require('../config/battleEras');

// Mafia-themed flavor text
const ATTACK_LINES = [
  "{attacker} sends {defender} to sleep with the fishes for {damage} HP!",
  "{attacker} delivers an offer {defender} can't refuse - {damage} damage!",
  "{attacker} whacks {defender} with a tire iron for {damage} HP!",
  "{attacker} gives {defender} a concrete shoe fitting - {damage} damage!",
  "{attacker} breaks {defender}'s kneecaps for {damage} HP!",
  "{attacker} puts a hit on {defender} - {damage} damage taken!",
  "{attacker} makes {defender} kiss the ring... with their face! {damage} HP!",
  "{attacker} pistol-whips {defender} for {damage} damage!",
  "{attacker} sends {defender} a message - {damage} HP worth!",
  "{attacker} shows {defender} who's boss - {damage} damage!",
  "{attacker} throws {defender} through a window! {damage} HP shattered!",
  "{attacker} introduces {defender} to their baseball bat! {damage} damage!",
  "{attacker} shoves {defender} into a dumpster for {damage} HP!",
  "{attacker} runs {defender} over with a Cadillac! {damage} damage!",
  "{attacker} feeds {defender} poisoned cannoli - {damage} HP!",
  "{attacker} uses {defender}'s face as a speedbag! {damage} damage!",
  "{attacker} slams {defender} in a car door! {damage} HP crushed!",
  "{attacker} throws hot espresso on {defender}! {damage} scalding damage!",
  "{attacker} drops a piano on {defender}! {damage} HP flattened!",
  "{attacker} gives {defender} the old Jersey send-off! {damage} damage!",
  "{attacker} introduces {defender} to their knuckle sandwich! {damage} HP!",
  "{attacker} makes {defender} an example! {damage} damage dealt!",
  "{attacker} shoots {defender}'s kneecaps! {damage} HP lost!",
  "{attacker} hits {defender} with a rolled-up newspaper! {damage} damage! (It's a very thick paper)",
  "{attacker} throws {defender} down the stairs! {damage} HP tumbled!",
  "{attacker} smacks {defender} with a cannoli! {damage} delicious damage!",
  "{attacker} teaches {defender} about respect the hard way! {damage} HP!",
  "{attacker} uses {defender} as a stress ball! {damage} squeezed damage!",
];

const CRIT_LINES = [
  "{attacker} double-taps {defender} for a BRUTAL {damage} HP! 💥",
  "{attacker} catches {defender} slippin' - CRITICAL HIT for {damage} damage! 💥",
  "{attacker} goes full Scarface on {defender} - {damage} CRITICAL damage! 💥",
  "{attacker} delivers a headshot to {defender} - {damage} CRITICAL! 💥",
  "{attacker} executes {defender} execution-style! {damage} CRITICAL HP! 💥",
  "{attacker} lands a DEVASTATING uppercut on {defender}! {damage} CRIT! 💥",
  "{attacker} goes berserk on {defender}! {damage} CRITICAL damage! 💥",
  "{attacker} channels pure rage into {defender}'s face! {damage} BRUTAL CRIT! 💥",
  "{attacker} finds {defender}'s weak spot! {damage} CRITICAL strike! 💥",
  "{attacker} delivers the kiss of death to {defender}! {damage} CRIT! 💥",
  "{attacker} unleashes hell on {defender}! {damage} CRITICAL mayhem! 💥",
  "{attacker} shows NO MERCY to {defender}! {damage} BRUTAL CRITICAL! 💥",
  "{attacker} lands the perfect shot on {defender}! {damage} CRIT! 💥",
  "{attacker} goes absolutely FERAL on {defender}! {damage} CRITICAL! 💥",
];

const DEATH_LINES = [
  "☠️ {defender} has been iced. Room temperature.",
  "☠️ {defender} sleeps with the fishes now.",
  "☠️ {defender} got clipped. It's nothing personal, just business.",
  "☠️ {defender} won't be coming back from this one.",
  "☠️ {defender} got whacked. Say goodnight.",
  "☠️ {defender} slipped on a banana peel into a cement mixer. Classic.",
  "☠️ {defender} confused the espresso machine with a tommy gun. Fatal mistake.",
  "☠️ {defender} tried to outrun a horse. The horse won.",
  "☠️ {defender} ate the cannoli that was DEFINITELY poisoned.",
  "☠️ {defender} took a nap in the wrong trunk. Permanent nap.",
  "☠️ {defender} challenged the boss to poker. Lost everything. Including their life.",
  "☠️ {defender} got locked in the walk-in freezer. Very chilly farewell.",
  "☠️ {defender} mistook dynamite for a cigar. Explosive exit.",
  "☠️ {defender} tried to skip out on a tab at Luigi's. Luigi doesn't forget.",
  "☠️ {defender} insulted someone's mother. The streets are ruthless.",
  "☠️ {defender} walked into the wrong social club. Very wrong.",
  "☠️ {defender} bet against the family. Bad investment.",
  "☠️ {defender} forgot to pay respects. The family remembered.",
  "☠️ {defender} accidentally sat in the boss's chair. Last mistake ever.",
  "☠️ {defender} tried to rob the Solpranos piggy bank. Piggy fought back.",
  "☠️ {defender} talked to the feds. The family talked back.",
  "☠️ {defender} laughed at the wrong joke. The punchline was lethal.",
  "☠️ {defender} thought they could swim faster than the concrete. They couldn't.",
  "☠️ {defender} ordered pineapple on pizza at the family dinner. Unforgivable.",
  "☠️ {defender} tried to count cards at Tony's poker night. Tony counted them out.",
  "☠️ {defender} showed up late to a hit. Irony got them first.",
  "☠️ {defender} opened an umbrella indoors. Superstition killed them.",
  "☠️ {defender} spilled wine on the tablecloth. The family spilled their blood.",
  "☠️ {defender} forgot the boss's birthday. The boss didn't forget them.",
  "☠️ {defender} tried to parallel park the getaway car. Still parked there. Forever.",
];

const ITEM_FIND_LINES = [
  "💰 {player} finds a briefcase of cash! (+15 HP)",
  "🍕 {player} grabs a slice from the corner joint! (+10 HP)",
  "💊 {player} pops some painkillers! (+12 HP)",
  "🥃 {player} takes a shot of whiskey for courage! (+8 HP)",
  "🔫 {player} finds a spare piece! (Damage +20% next round)",
  "🛡️ {player} puts on a bulletproof vest! (+18 HP)",
  "🍝 {player} inhales a plate of mama's spaghetti! (+14 HP)",
  "☕ {player} chugs an espresso shot! (+9 HP)",
  "🚬 {player} finds a pack of lucky strikes! (+11 HP)",
];

const ERA_ALIASES = {
  'cowboy': 'wild_west',
  'west': 'wild_west',
  'knight': 'medieval',
  'middle_ages': 'medieval',
  'samurai': 'feudal_japan',
  'cyber': 'cyberpunk',
  'future': 'cyberpunk',
  'scifi': 'cyberpunk',
};

const ASSIGNMENT_REQUIRED_ERAS = new Set([
  'medieval', 'cyberpunk', 'feudal_japan', 'ancient_rome', 'space_marines', 'wild_west'
]);

class BattleService {
  constructor() {
    this.activeGames = new Map();
  }

  normalizeEraKey(eraKey) {
    if (!eraKey) return '';
    const normalized = String(eraKey).trim().toLowerCase().replace(/[\s-]+/g, '_');
    return ERA_ALIASES[normalized] || normalized;
  }

  isEraAssignmentRequired(eraKey) {
    const normalized = this.normalizeEraKey(eraKey);
    if (!normalized || !BATTLE_ERAS[normalized]) return false;
    return ASSIGNMENT_REQUIRED_ERAS.has(normalized) || BATTLE_ERAS[normalized].exclusive === true;
  }

  getAssignedEras(guildId) {
    try {
      if (!guildId) return [];
      const rows = mainDb.prepare('SELECT era_key FROM battle_era_assignments WHERE guild_id = ?').all(guildId);
      return [...new Set(
        rows
          .map(r => this.normalizeEraKey(r.era_key))
          .filter(key => key && BATTLE_ERAS[key])
      )];
    } catch (error) {
      logger.error('Error getting assigned eras:', error);
      return [];
    }
  }

  getAvailableEras(guildId) {
    const assignedSet = new Set(this.getAssignedEras(guildId));

    return Object.values(BATTLE_ERAS)
      .map(era => ({
        key: this.normalizeEraKey(era.key),
        name: era.name,
        description: era.description,
      }))
      .filter(era => era.key && BATTLE_ERAS[era.key])
      .filter(era => !this.isEraAssignmentRequired(era.key) || assignedSet.has(era.key));
  }

  getAvailableEraKeys(guildId) {
    return this.getAvailableEras(guildId).map(era => era.key);
  }

  getAssignableEras() {
    return Object.values(BATTLE_ERAS)
      .map(era => ({
        key: this.normalizeEraKey(era.key),
        name: era.name,
        description: era.description,
      }))
      .filter(era => era.key && BATTLE_ERAS[era.key] && this.isEraAssignmentRequired(era.key));
  }

  isEraAssignable(eraKey) {
    const normalized = this.normalizeEraKey(eraKey);
    return !!(normalized && BATTLE_ERAS[normalized] && this.isEraAssignmentRequired(normalized));
  }

  getEraName(eraKey) {
    const normalized = this.normalizeEraKey(eraKey);
    return BATTLE_ERAS[normalized]?.name || normalized;
  }

  getDefaultAvailableEra(guildId, preferredEra = null) {
    const availableEraKeys = this.getAvailableEraKeys(guildId);
    if (!availableEraKeys.length) return 'mafia';

    const normalizedPreferred = this.normalizeEraKey(preferredEra);
    if (normalizedPreferred && availableEraKeys.includes(normalizedPreferred)) {
      return normalizedPreferred;
    }

    return availableEraKeys[0];
  }

  rand(maxExclusive) {
    if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) return 0;
    return randomInt(maxExclusive);
  }

  roll() {
    return randomInt(1_000_000) / 1_000_000;
  }

  chance(probability) {
    return this.roll() < probability;
  }

  pick(arr) {
    if (!arr || !arr.length) return null;
    return arr[this.rand(arr.length)];
  }

  normalizeBountyTargets(targetIds) {
    if (!Array.isArray(targetIds)) return [];
    const seen = new Set();
    const out = [];
    for (const rawId of targetIds) {
      const id = String(rawId || '').trim();
      if (!/^\d{17,20}$/.test(id)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= 3) break;
    }
    return out;
  }

  parseBountyTargets(rawValue) {
    if (!rawValue) return [];
    if (Array.isArray(rawValue)) return this.normalizeBountyTargets(rawValue);

    const rawText = String(rawValue).trim();
    if (!rawText) return [];

    try {
      const parsed = JSON.parse(rawText);
      if (Array.isArray(parsed)) return this.normalizeBountyTargets(parsed);
    } catch (_) {
      // Legacy fallback: comma-separated IDs
    }

    return this.normalizeBountyTargets(rawText.split(','));
  }

  getLobbyBountyTargets(lobby) {
    return this.parseBountyTargets(lobby?.bounties_json);
  }

  setLobbyBounties(lobbyId, targetIds = []) {
    try {
      const normalized = this.normalizeBountyTargets(targetIds);
      const serialized = normalized.length ? JSON.stringify(normalized) : null;
      db.prepare('UPDATE battle_lobbies SET bounties_json = ? WHERE lobby_id = ?')
        .run(serialized, lobbyId);
      return { success: true, bounties: normalized };
    } catch (error) {
      logger.error('Error setting lobby bounties:', error);
      return { success: false, message: 'Failed to save bounty targets' };
    }
  }

  createLobby(channelId, messageId, creatorId, minPlayers = 2, maxPlayers = 999, requiredRoleIds = null, excludedRoleIds = null, era = 'mafia', bounties = null, guildId = null) {
    try {
      const lobbyId = `B-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;
      const requiredIdsStr = requiredRoleIds && requiredRoleIds.length ? requiredRoleIds.join(',') : null;
      const excludedIdsStr = excludedRoleIds && excludedRoleIds.length ? excludedRoleIds.join(',') : null;
      const bountyTargets = this.normalizeBountyTargets(bounties || []);
      const bountyJson = bountyTargets.length ? JSON.stringify(bountyTargets) : null;

      const createResult = db.transaction(() => {
        const existing = db.prepare(
          "SELECT lobby_id FROM battle_lobbies WHERE channel_id = ? AND status IN ('open','in_progress') ORDER BY created_at DESC LIMIT 1"
        ).get(channelId);
        if (existing?.lobby_id) {
          return { success: false, reason: 'channel_has_active_battle' };
        }

        db.prepare(`
          INSERT INTO battle_lobbies (lobby_id, channel_id, message_id, creator_id, min_players, max_players, required_role_ids, excluded_role_ids, era, bounties_json, guild_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(lobbyId, channelId, messageId, creatorId, minPlayers, maxPlayers, requiredIdsStr, excludedIdsStr, era, bountyJson, guildId);
        return { success: true };
      })();

      if (!createResult.success) {
        if (createResult.reason === 'channel_has_active_battle') {
          return { success: false, message: 'There is already an active battle in this channel.' };
        }
        return { success: false, message: 'Failed to create battle lobby' };
      }

      logger.log(`Battle lobby created: ${lobbyId} by ${creatorId} in guild ${guildId}`);
      return { success: true, lobbyId };
    } catch (error) {
      logger.error('Error creating battle lobby:', error);
      return { success: false, message: 'Failed to create battle lobby' };
    }
  }

  getLobby(lobbyId) {
    try {
      const lobby = db.prepare('SELECT * FROM battle_lobbies WHERE lobby_id = ?').get(lobbyId);
      return lobby;
    } catch (error) {
      logger.error('Error getting lobby:', error);
      return null;
    }
  }

  getLobbyByMessage(messageId) {
    try {
      const lobby = db.prepare('SELECT * FROM battle_lobbies WHERE message_id = ?').get(messageId);
      return lobby;
    } catch (error) {
      logger.error('Error getting lobby by message:', error);
      return null;
    }
  }

  getParticipants(lobbyId) {
    try {
      return db.prepare('SELECT * FROM battle_participants WHERE lobby_id = ? ORDER BY joined_at ASC').all(lobbyId);
    } catch (error) {
      logger.error('Error getting participants:', error);
      return [];
    }
  }

  addParticipant(lobbyId, userId, username, userRoles = []) {
    try {
      const lobby = this.getLobby(lobbyId);
      if (!lobby) {
        return { success: false, message: 'Lobby not found' };
      }

      if (lobby.status !== 'open') {
        return { success: false, message: 'Lobby is no longer accepting players' };
      }

      // Check required roles (must have at least one)
      if (lobby.required_role_ids) {
        const requiredSet = new Set(lobby.required_role_ids.split(','));
        const hasRequiredRole = userRoles.some(rid => requiredSet.has(rid));
        if (!hasRequiredRole) {
          return { success: false, message: 'You do not have the required roles to join this battle.' };
        }
      }

      // Check excluded roles (must have none)
      if (lobby.excluded_role_ids) {
        const excludedSet = new Set(lobby.excluded_role_ids.split(','));
        const hasExcludedRole = userRoles.some(rid => excludedSet.has(rid));
        if (hasExcludedRole) {
          return { success: false, message: 'You have a role that is excluded from this battle.' };
        }
      }

      const participants = this.getParticipants(lobbyId);
      if (participants.some(p => p.user_id === userId)) {
        return { success: false, message: 'You are already in this battle' };
      }

      if (participants.length >= lobby.max_players) {
        return { success: false, message: 'Lobby is full' };
      }

      db.prepare(`
        INSERT INTO battle_participants (lobby_id, user_id, username)
        VALUES (?, ?, ?)
      `).run(lobbyId, userId, username);

      return { success: true };
    } catch (error) {
      logger.error('Error adding participant:', error);
      return { success: false, message: 'Failed to join battle' };
    }
  }

  removeParticipant(lobbyId, userId) {
    try {
      db.prepare('DELETE FROM battle_participants WHERE lobby_id = ? AND user_id = ?').run(lobbyId, userId);
      return { success: true };
    } catch (error) {
      logger.error('Error removing participant:', error);
      return { success: false };
    }
  }

  startBattle(lobbyId) {
    try {
      const lobby = this.getLobby(lobbyId);
      if (!lobby || lobby.status !== 'open') {
        return { success: false, message: 'Lobby is not open or already started' };
      }

      const participants = this.getParticipants(lobbyId);
      if (participants.length < lobby.min_players) {
        return { success: false, message: `Need at least ${lobby.min_players} players to start` };
      }

      db.prepare("UPDATE battle_lobbies SET status = 'in_progress', started_at = CURRENT_TIMESTAMP WHERE lobby_id = ?").run(lobbyId);

      return { success: true, participants };
    } catch (error) {
      logger.error('Error starting battle:', error);
      return { success: false, message: 'Failed to start battle' };
    }
  }

  cancelBattle(lobbyId) {
    try {
      db.prepare("UPDATE battle_lobbies SET status = 'cancelled' WHERE lobby_id = ?").run(lobbyId);
      return { success: true };
    } catch (error) {
      logger.error('Error cancelling battle:', error);
      return { success: false };
    }
  }

  updateParticipantHp(lobbyId, userId, hp) {
    try {
      db.prepare('UPDATE battle_participants SET hp = ?, is_alive = ? WHERE lobby_id = ? AND user_id = ?').run(hp, hp > 0 ? 1 : 0, lobbyId, userId);
    } catch (error) {
      logger.error('Error updating participant HP:', error);
    }
  }

  addDamageDealt(lobbyId, userId, damage) {
    try {
      db.prepare('UPDATE battle_participants SET total_damage_dealt = total_damage_dealt + ? WHERE lobby_id = ? AND user_id = ?').run(damage, lobbyId, userId);
    } catch (error) {
      logger.error('Error adding damage dealt:', error);
    }
  }

  completeBattle(lobbyId) {
    try {
      const lobby = this.getLobby(lobbyId);
      if (!lobby) return;

      db.prepare("UPDATE battle_lobbies SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE lobby_id = ?").run(lobbyId);

      // Update global stats for all participants
      const participants = this.getParticipants(lobbyId);
      const winner = participants.find(p => p.is_alive);

      for (const p of participants) {
        this.updateGlobalStats(p.user_id, p.username, p.total_damage_dealt, winner && winner.user_id === p.user_id);
      }
    } catch (error) {
      logger.error('Error completing battle:', error);
    }
  }

  updateGlobalStats(userId, username, damage, isWinner) {
    try {
      db.prepare(`
        INSERT INTO battle_stats (user_id, username, battles_played, battles_won, total_damage_dealt, updated_at)
        VALUES (?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          username = excluded.username,
          battles_played = battles_played + 1,
          battles_won = battles_won + ?,
          total_damage_dealt = total_damage_dealt + ?,
          updated_at = CURRENT_TIMESTAMP
      `).run(userId, username, isWinner ? 1 : 0, damage, isWinner ? 1 : 0, damage);
    } catch (error) {
      logger.error('Error updating global stats:', error);
    }
  }

  getGlobalStats(limit = 10) {
    try {
      return db.prepare('SELECT * FROM battle_stats ORDER BY battles_won DESC, total_damage_dealt DESC LIMIT ?').all(limit);
    } catch (error) {
      logger.error('Error getting global stats:', error);
      return [];
    }
  }

  getUserStats(userId) {
    try {
      return db.prepare('SELECT * FROM battle_stats WHERE user_id = ?').get(userId);
    } catch (error) {
      logger.error('Error getting user stats:', error);
      return null;
    }
  }

  buildLobbyEmbed(lobby, brandingGuildId) {
    const participants = this.getParticipants(lobby.lobby_id);
    const eraName = this.getEraName(lobby.era);
    const eraEmoji = BATTLE_ERAS[this.normalizeEraKey(lobby.era)]?.emoji || '⚔️';

    const embed = new EmbedBuilder()
      .setTitle(`${eraEmoji} Battle Arena: ${eraName} Era`)
      .setDescription(
        `A new battle is brewing! React with ⚔️ to join.\n\n` +
        `**Status:** ${lobby.status === 'open' ? '🟢 Open' : '🟡 Starting...'}\n` +
        `**Players:** ${participants.length} / ${lobby.max_players === 999 ? '∞' : lobby.max_players} (Min: ${lobby.min_players})`
      )
      .addFields({
        name: '👥 Participants',
        value: participants.length > 0 ? participants.map(p => `• ${p.username}`).join('\n') : '*None yet*',
      });

    if (lobby.required_role_ids || lobby.excluded_role_ids) {
      let restrictions = '';
      if (lobby.required_role_ids) restrictions += `• Required: at least one of <@&${lobby.required_role_ids.replace(/,/g, '>, <@&')}> \n`;
      if (lobby.excluded_role_ids) restrictions += `• Excluded: <@&${lobby.excluded_role_ids.replace(/,/g, '>, <@&')}> \n`;
      embed.addFields({ name: '🚫 Role Restrictions', value: restrictions });
    }

    const bounties = this.getLobbyBountyTargets(lobby);
    if (bounties.length > 0) {
      embed.addFields({ name: '🎯 Bounty Targets', value: bounties.map(id => `<@${id}>`).join(', ') });
    }

    applyEmbedBranding(embed, {
      guildId: brandingGuildId,
      moduleKey: 'battle',
      defaultColor: '#FF4500',
    });

    return embed;
  }

  getAttackLine(attacker, defender, damage) {
    const line = this.pick(ATTACK_LINES);
    return line.replace('{attacker}', `**${attacker}**`)
               .replace('{defender}', `**${defender}**`)
               .replace('{damage}', `**${damage}**`);
  }

  getCritLine(attacker, defender, damage) {
    const line = this.pick(CRIT_LINES);
    return line.replace('{attacker}', `**${attacker}**`)
               .replace('{defender}', `**${defender}**`)
               .replace('{damage}', `**${damage}**`);
  }

  getDeathLine(defender) {
    const line = this.pick(DEATH_LINES);
    return line.replace('{defender}', `**${defender}**`);
  }

  getItemLine(player) {
    return this.pick(ITEM_FIND_LINES).replace('{player}', `**${player}**`);
  }
}

module.exports = new BattleService();
