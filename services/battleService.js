const db = require('../database/battleDb');
const logger = require('../utils/logger');
const { EmbedBuilder } = require('discord.js');

// Mafia-themed flavor text
const ATTACK_LINES = [
  "{attacker} sends {defender} to sleep with the fishes for {damage} HP!",
  "{attacker} delivers an offer {defender} can't refuse - {damage} damage!",
  "{attacker} whacks {defender} with a tire iron for {damage} HP!",
  "{attacker} gives {defender} a concrete shoe fitting - {damage} damage!",
  "{attacker} breaks {defender}'s kneecaps for {damage} HP!",
  "{attacker} puts a hit on {defender} - {damage} damage taken!",
  "{attacker} makes {defender} kiss the ring... with their face! {damage} HP!",
];

const CRIT_LINES = [
  "{attacker} double-taps {defender} for a BRUTAL {damage} HP! 💥",
  "{attacker} catches {defender} slippin' - CRITICAL HIT for {damage} damage! 💥",
  "{attacker} goes full Scarface on {defender} - {damage} CRITICAL damage! 💥",
];

const DEATH_LINES = [
  "{defender} has been iced. Room temperature. ☠️",
  "{defender} sleeps with the fishes now. ☠️",
  "{defender} got clipped. It's nothing personal, just business. ☠️",
  "{defender} won't be coming back from this one. ☠️",
];

const WINNER_LINES = [
  "{winner} is the last one standing! The family is proud. 👑",
  "{winner} wins! Don't mess with the family. 👑",
  "{winner} came out on top! Respect. 👑",
  "{winner} proved who runs this town! 👑",
];

class BattleService {
  constructor() {
    this.SWORD_EMOJI = '⚔️';
  }

  createLobby(channelId, messageId, creatorId, minPlayers = 2, maxPlayers = 8) {
    const lobbyId = `battle_${Date.now()}_${creatorId}`;
    
    try {
      db.prepare(`
        INSERT INTO battle_lobbies (lobby_id, channel_id, message_id, creator_id, min_players, max_players)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(lobbyId, channelId, messageId, creatorId, minPlayers, maxPlayers);

      logger.log(`Battle lobby created: ${lobbyId} by ${creatorId}`);
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

  addParticipant(lobbyId, userId, username) {
    try {
      const lobby = this.getLobby(lobbyId);
      if (!lobby) {
        return { success: false, message: 'Lobby not found' };
      }

      if (lobby.status !== 'open') {
        return { success: false, message: 'Lobby is no longer accepting players' };
      }

      const participants = this.getParticipants(lobbyId);
      if (participants.length >= lobby.max_players) {
        return { success: false, message: 'Lobby is full' };
      }

      db.prepare(`
        INSERT INTO battle_participants (lobby_id, user_id, username)
        VALUES (?, ?, ?)
      `).run(lobbyId, userId, username);

      logger.log(`User ${username} joined battle lobby ${lobbyId}`);
      return { success: true, count: participants.length + 1 };
    } catch (error) {
      if (error.message.includes('UNIQUE constraint')) {
        return { success: false, message: 'Already in this lobby' };
      }
      logger.error('Error adding participant:', error);
      return { success: false, message: 'Failed to join lobby' };
    }
  }

  removeParticipant(lobbyId, userId) {
    try {
      const lobby = this.getLobby(lobbyId);
      if (!lobby || lobby.status !== 'open') {
        return { success: false };
      }

      const result = db.prepare('DELETE FROM battle_participants WHERE lobby_id = ? AND user_id = ?').run(lobbyId, userId);
      
      if (result.changes > 0) {
        logger.log(`User ${userId} left battle lobby ${lobbyId}`);
        return { success: true };
      }
      
      return { success: false };
    } catch (error) {
      logger.error('Error removing participant:', error);
      return { success: false };
    }
  }

  startBattle(lobbyId, starterId) {
    try {
      const lobby = this.getLobby(lobbyId);
      if (!lobby) {
        return { success: false, message: 'Lobby not found' };
      }

      if (lobby.creator_id !== starterId) {
        return { success: false, message: 'Only the lobby creator can start the battle' };
      }

      if (lobby.status !== 'open') {
        return { success: false, message: 'Battle already started or completed' };
      }

      const participants = this.getParticipants(lobbyId);
      if (participants.length < lobby.min_players) {
        return { success: false, message: `Need at least ${lobby.min_players} players to start` };
      }

      db.prepare('UPDATE battle_lobbies SET status = ?, started_at = CURRENT_TIMESTAMP WHERE lobby_id = ?')
        .run('in_progress', lobbyId);

      logger.log(`Battle ${lobbyId} started by ${starterId} with ${participants.length} participants`);
      return { success: true, participants };
    } catch (error) {
      logger.error('Error starting battle:', error);
      return { success: false, message: 'Failed to start battle' };
    }
  }

  cancelBattle(lobbyId, cancelerId) {
    try {
      const lobby = this.getLobby(lobbyId);
      if (!lobby) {
        return { success: false, message: 'Lobby not found' };
      }

      if (lobby.creator_id !== cancelerId) {
        return { success: false, message: 'Only the lobby creator can cancel the battle' };
      }

      if (lobby.status !== 'open') {
        return { success: false, message: 'Cannot cancel a battle in progress' };
      }

      db.prepare('UPDATE battle_lobbies SET status = ? WHERE lobby_id = ?').run('cancelled', lobbyId);
      db.prepare('DELETE FROM battle_participants WHERE lobby_id = ?').run(lobbyId);

      logger.log(`Battle ${lobbyId} cancelled by ${cancelerId}`);
      return { success: true };
    } catch (error) {
      logger.error('Error cancelling battle:', error);
      return { success: false, message: 'Failed to cancel battle' };
    }
  }

  simulateBattle(lobbyId) {
    const participants = this.getParticipants(lobbyId);
    const rounds = [];
    let alivePlayers = participants.filter(p => p.is_alive);

    let roundNum = 0;
    while (alivePlayers.length > 1) {
      roundNum++;
      
      // Pick random attacker and defender
      const attacker = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
      let defender = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
      
      // Make sure attacker doesn't attack themselves
      while (defender.user_id === attacker.user_id && alivePlayers.length > 1) {
        defender = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
      }

      // Calculate damage (10-30, with 20% crit chance for 40-50)
      const isCrit = Math.random() < 0.2;
      const damage = isCrit 
        ? Math.floor(Math.random() * 11) + 40 // 40-50
        : Math.floor(Math.random() * 21) + 10; // 10-30

      // Apply damage
      defender.hp -= damage;
      attacker.total_damage_dealt += damage;

      // Pick flavor text
      const line = isCrit 
        ? CRIT_LINES[Math.floor(Math.random() * CRIT_LINES.length)]
        : ATTACK_LINES[Math.floor(Math.random() * ATTACK_LINES.length)];

      let roundText = line
        .replace('{attacker}', `**${attacker.username}**`)
        .replace('{defender}', `**${defender.username}**`)
        .replace('{damage}', damage);

      if (defender.hp <= 0) {
        defender.is_alive = false;
        const deathLine = DEATH_LINES[Math.floor(Math.random() * DEATH_LINES.length)]
          .replace('{defender}', `**${defender.username}**`);
        roundText += `\n${deathLine}`;
        
        // Update DB
        db.prepare('UPDATE battle_participants SET is_alive = 0, hp = 0 WHERE lobby_id = ? AND user_id = ?')
          .run(lobbyId, defender.user_id);
      } else {
        // Update HP in DB
        db.prepare('UPDATE battle_participants SET hp = ? WHERE lobby_id = ? AND user_id = ?')
          .run(defender.hp, lobbyId, defender.user_id);
      }

      // Update damage dealt in DB
      db.prepare('UPDATE battle_participants SET total_damage_dealt = ? WHERE lobby_id = ? AND user_id = ?')
        .run(attacker.total_damage_dealt, lobbyId, attacker.user_id);

      rounds.push({ round: roundNum, text: roundText });
      
      // Refresh alive players
      alivePlayers = alivePlayers.filter(p => p.is_alive);
    }

    // Winner!
    const winner = alivePlayers[0];
    const winnerLine = WINNER_LINES[Math.floor(Math.random() * WINNER_LINES.length)]
      .replace('{winner}', `**${winner.username}**`);

    // Update battle status
    db.prepare('UPDATE battle_lobbies SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE lobby_id = ?')
      .run('completed', lobbyId);

    // Update stats for all participants
    const allParticipants = this.getParticipants(lobbyId);
    for (const p of allParticipants) {
      this.updateStats(p.user_id, p.username, p.user_id === winner.user_id, p.total_damage_dealt);
    }

    return { rounds, winner, winnerLine };
  }

  updateStats(userId, username, won, damageDealt) {
    try {
      const existing = db.prepare('SELECT * FROM battle_stats WHERE user_id = ?').get(userId);
      
      if (existing) {
        db.prepare(`
          UPDATE battle_stats 
          SET battles_played = battles_played + 1,
              battles_won = battles_won + ?,
              total_damage_dealt = total_damage_dealt + ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ?
        `).run(won ? 1 : 0, damageDealt, userId);
      } else {
        db.prepare(`
          INSERT INTO battle_stats (user_id, username, battles_played, battles_won, total_damage_dealt)
          VALUES (?, ?, 1, ?, ?)
        `).run(userId, username, won ? 1 : 0, damageDealt);
      }
    } catch (error) {
      logger.error('Error updating battle stats:', error);
    }
  }

  getStats(userId) {
    try {
      return db.prepare('SELECT * FROM battle_stats WHERE user_id = ?').get(userId);
    } catch (error) {
      logger.error('Error getting battle stats:', error);
      return null;
    }
  }

  buildLobbyEmbed(lobby, participants) {
    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('⚔️ Mafia Battle Lobby')
      .setDescription(
        `The family is gathering for a showdown.\n` +
        `React with ${this.SWORD_EMOJI} to join the fight!\n\n` +
        `**Status:** ${lobby.status === 'open' ? '🟢 Open' : '🔴 Closed'}\n` +
        `**Players:** ${participants.length}/${lobby.max_players}\n` +
        `**Minimum:** ${lobby.min_players} players to start`
      )
      .setFooter({ text: 'Creator can /battle start when ready' })
      .setTimestamp();

    if (participants.length > 0) {
      const playerList = participants.map(p => `• ${p.username}`).join('\n');
      embed.addFields({ name: '🥊 Fighters', value: playerList, inline: false });
    }

    return embed;
  }
}

module.exports = new BattleService();
