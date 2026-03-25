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
  "💎 {player} pawns a hot diamond! (+13 HP)",
  "🍷 {player} sips a stolen '47 Bordeaux! (+16 HP)",
  "🧀 {player} discovers aged provolone in their coat! (+10 HP)",
  "🎰 {player} hits a jackpot on the corner slot machine! (+17 HP)",
  "🔨 {player} picks up a lead pipe! (Damage +20% next round)",
  "⚾ {player} grabs a baseball bat from the back room! (Damage +20% next round)",
  "🗡️ {player} finds a switchblade in the alley! (Damage +20% next round)",
  "🧱 {player} discovers a brick. Classic weapon! (Damage +20% next round)",
  "🍞 {player} eats a meatball sub from Sal's deli! (+15 HP)",
  "🥛 {player} drinks whole milk straight from the carton! (+8 HP)",
  "🍔 {player} finds a burger still warm! (+12 HP)",
  "🥃 {player} discovers the boss's private scotch stash! (+18 HP)",
  "💉 {player} injects... vitamins. Totally legal vitamins. (+14 HP)",
  "🎲 {player} rolls snake eyes and feels invincible! (+11 HP)",
  "🔑 {player} finds the key to the safe house! (+10 HP)",
  "📿 {player} kisses their grandmother's rosary! (+9 HP)",
];

const FLAVOR_LINES = [
  "🚬 {player} lights up a cigar and contemplates life.",
  "📞 {player} gets a call from the boss. 'Keep it clean.'",
  "🎰 {player} checks the numbers from last night's game.",
  "🚗 {player} hears sirens in the distance. Feds getting close.",
  "🎵 {player} hums 'That's Amore' while reloading.",
  "💼 {player} checks the briefcase. Everything's there.",
  "🍷 {player} swirls a glass of expensive wine.",
  "🕊️ {player} feeds the pigeons. Even killers have hobbies.",
  "🎭 {player} practices their alibi in the mirror.",
  "🌃 {player} admires the skyline. Beautiful city. Violent, but beautiful.",
  "🔫 {player} cleans their gun. Maintenance is important.",
  "📰 {player} reads the obituaries. Checking for friends.",
  "🎪 {player} juggles grenades. Just kidding. Or are they?",
  "🚪 {player} checks the exits. Always have an escape plan.",
  "👔 {player} adjusts their tie. Looking sharp for the funeral. Theirs? Who knows.",
  "🎬 {player} quotes The Godfather. Classic move.",
  "🍝 {player} debates opening a legitimate restaurant. Nah.",
  "💰 {player} counts money nervously. Is it all there?",
  "🚕 {player} hails a cab. Wait, that's not a cab driver...",
  "🎲 {player} rolls dice on the ground. Snake eyes. Bad omen.",
  "📱 {player} checks their burner phone. 47 missed calls from mom.",
  "🏪 {player} window-shops at the corner store. Maybe they'll rob it later.",
  "⛪ {player} says a quick prayer. Insurance policy.",
  "🎺 {player} hears jazz in the distance. Classy.",
  "🌹 {player} smells a rose. Then sneezes violently.",
  "🚬 {player} offers someone a cigarette. Declined. Rude.",
  "🎩 {player} tips their fedora at a passing stranger.",
  "🍕 {player} debates pineapple on pizza. Decides against it. Smart.",
  "🔮 {player} visits a fortune teller. 'I see violence.' No kidding.",
  "🎸 {player} air-guitars to Frank Sinatra. Embarrassing.",
];

const LUCKY_ESCAPE_LINES = [
  "🍀 {player} dodges a bullet by sheer luck! (Avoided lethal damage)",
  "✨ {player} ducks at just the right moment! (Escaped death)",
  "🎲 {player}'s guardian angel must be working overtime! (Survived)",
  "🙏 {player} trips on their own feet and dodges a headshot! (Lucky klutz)",
  "📿 {player}'s grandmother's rosary deflects the bullet! (Miracle)",
  "🎰 {player} hits the jackpot—survives on a technicality! (1 HP left)",
  "🚪 {player} gets saved by someone opening a door at the perfect moment!",
  "📱 {player}'s phone blocks the fatal shot! (Thanks, Nokia)",
  "🍀 {player} sneezes and moves just enough to survive! (Allergies save lives)",
  "💨 {player} slips on a banana peel—right out of harm's way!",
  "🎭 {player} fakes their own death. The attacker buys it! (Survived)",
  "🐱 {player} has nine lives apparently. Used one just now.",
  "✝️ {player} was wearing a bulletproof Bible! (Faith pays off)",
  "🎲 {player} rolled a natural 20 on their death save! (Critical survival)",
  "🦆 {player} ducks like their life depends on it. Because it does!",
  "🎪 {player} pulls a magic trick—disappears then reappears! (1 HP)",
  "🍀 {player} finds a four-leaf clover at the perfect moment!",
  "👻 {player} briefly becomes a ghost, then un-ghosts! (Glitch in the Matrix)",
  "🎬 {player} yells 'CUT!' and everyone stops. Confusion saves them!",
];

const WINNER_LINES = [
  "{winner} is the last one standing! The family is proud. 👑",
  "{winner} wins! Don't mess with the family. 👑",
  "{winner} came out on top! Respect. 👑",
  "{winner} proved who runs this town! 👑",
];

// Hype finale outro templates (randomized for replayability)
const FINALE_OUTROS = [
  "The streets remember this night. {winner} walks away with the family crown. Nobody saw this coming, but everybody will remember. Capisce?",
  "{winner} climbed over the bodies and earned the respect of every made man watching. This is how legends are born in the Solpranos family.",
  "When the smoke cleared, only {winner} was left standing. The family crown sits heavy—but they wear it well. Salute.",
  "They came. They saw. They conquered. {winner} just wrote their name in blood across this city. The family will not forget.",
  "From {totalPlayers} fighters to one champion: {winner}. That's not luck—that's power. Welcome to the top of the family tree. 👑",
  "{winner} survived {rounds} rounds of pure chaos and walked out breathing. That's the kind of soldier the Solpranos need. Respect earned.",
  "The boss is watching. The streets are talking. And {winner}? They're wearing the crown now. Business just got very personal.",
  "{winner} didn't just survive—they dominated. {rounds} rounds, {totalPlayers} contenders, one undisputed champion. The family is proud.",
  "History lesson: You don't mess with {winner}. Tonight they proved it in blood. The crown is theirs. End of discussion.",
  "Listen close: {winner} just became untouchable. Survived {rounds} rounds, outlasted {totalPlayers} soldiers. That's made-man material right there.",
  "Somewhere, the boss is smiling. {winner} earned their stripes tonight. The family crown fits perfectly. Wear it well, champion.",
  "{winner} walked through hell and came out the other side wearing gold. {rounds} rounds of warfare, and they didn't even break a sweat. Legend status: unlocked.",
  "Tonight, {winner} wrote the definition of survival. {totalPlayers} entered. One walked out. That's not just winning—that's sending a message.",
  "The Solpranos family has a new champion. {winner} crushed {rounds} rounds of chaos and claimed the crown. Respect? Earned. Fear? Justified.",
  "{winner} just went from soldier to legend in {rounds} rounds. The family crown is heavy, but they're built for it. Salute to the new king.",
  "When they tell stories about this battle, they'll start and end with {winner}. {totalPlayers} tried. One succeeded. Crown secured. 👑",
  "You know what's harder than fighting {rounds} rounds? Winning them all. {winner} just did both. The family sees you. The crown is yours.",
  "{winner} survived everything the streets threw at them. {rounds} rounds, {totalPlayers} enemies, one victor. That's Solpranos royalty right there.",
];

class BattleService {
  constructor() {
    this.SWORD_EMOJI = '⚔️';
  }

  createLobby(channelId, messageId, creatorId, minPlayers = 2, maxPlayers = 999, requiredRoleId = null, excludedRoleIds = null) {
    const lobbyId = `battle_${Date.now()}_${creatorId}`;
    
    try {
      const excludedIdsStr = excludedRoleIds && excludedRoleIds.length ? excludedRoleIds.join(',') : null;
      db.prepare(`
        INSERT INTO battle_lobbies (lobby_id, channel_id, message_id, creator_id, min_players, max_players, required_role_id, excluded_role_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(lobbyId, channelId, messageId, creatorId, minPlayers, maxPlayers, requiredRoleId, excludedIdsStr);

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

  addParticipant(lobbyId, userId, username, userRoles = []) {
    try {
      const lobby = this.getLobby(lobbyId);
      if (!lobby) {
        return { success: false, message: 'Lobby not found' };
      }

      if (lobby.status !== 'open') {
        return { success: false, message: 'Lobby is no longer accepting players' };
      }

      // Check required role
      if (lobby.required_role_id) {
        if (!userRoles.includes(lobby.required_role_id)) {
          return { 
            success: false, 
            message: 'You need a specific role to join this battle',
            requiresRole: true 
          };
        }
      }

      // Check excluded roles
      if (lobby.excluded_role_ids) {
        const excludedSet = new Set(lobby.excluded_role_ids.split(','));
        const hasExcludedRole = userRoles.some(rid => excludedSet.has(rid));
        if (hasExcludedRole) {
          return {
            success: false,
            message: 'Your role is excluded from this battle',
            blockedRole: true
          };
        }
      }

      const participants = this.getParticipants(lobbyId);
      
      // Check max players (999 = effectively unlimited)
      if (lobby.max_players < 999 && participants.length >= lobby.max_players) {
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
    const totalPlayers = participants.length;
    const rounds = [];
    let alivePlayers = participants.filter(p => p.is_alive);
    const playerBuffs = {}; // Track temporary buffs

    let roundNum = 0;
    while (alivePlayers.length > 1) {
      roundNum++;
      const events = [];
      
      // Generate 2-5 events per round (scales with player count)
      const eventCount = Math.min(
        Math.floor(Math.random() * 4) + 2, // 2-5
        Math.max(2, Math.ceil(alivePlayers.length / 2)) // At least 2, max half of players
      );

      for (let i = 0; i < eventCount; i++) {
        // Event type distribution:
        // 60% combat, 20% item find, 15% flavor, 5% lucky escape
        const rand = Math.random();
        
        if (rand < 0.60 && alivePlayers.length > 1) {
          // COMBAT EVENT
          const attacker = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
          let defender = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
          
          // Make sure attacker doesn't attack themselves
          let attempts = 0;
          while (defender.user_id === attacker.user_id && alivePlayers.length > 1 && attempts < 10) {
            defender = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
            attempts++;
          }
          if (defender.user_id === attacker.user_id) continue;

          // Calculate damage (10-30, with 20% crit chance for 40-50)
          const isCrit = Math.random() < 0.2;
          let damage = isCrit 
            ? Math.floor(Math.random() * 11) + 40 // 40-50
            : Math.floor(Math.random() * 21) + 10; // 10-30

          // Apply damage buff if exists
          if (playerBuffs[attacker.user_id]) {
            damage = Math.floor(damage * 1.2);
            delete playerBuffs[attacker.user_id]; // One-time use
          }

          // Apply damage
          defender.hp -= damage;
          attacker.total_damage_dealt += damage;

          // Pick flavor text
          const line = isCrit 
            ? CRIT_LINES[Math.floor(Math.random() * CRIT_LINES.length)]
            : ATTACK_LINES[Math.floor(Math.random() * ATTACK_LINES.length)];

          let eventText = line
            .replace('{attacker}', `**${attacker.username}**`)
            .replace('{defender}', `**${defender.username}**`)
            .replace('{damage}', damage);

          events.push(eventText);

          // Check for death
          if (defender.hp <= 0) {
            // 5% chance to survive with 1 HP (lucky escape)
            if (Math.random() < 0.05 && alivePlayers.length > 2) {
              defender.hp = 1;
              const luckyLine = LUCKY_ESCAPE_LINES[Math.floor(Math.random() * LUCKY_ESCAPE_LINES.length)]
                .replace('{player}', `**${defender.username}**`);
              events.push(luckyLine);
              
              db.prepare('UPDATE battle_participants SET hp = 1 WHERE lobby_id = ? AND user_id = ?')
                .run(lobbyId, defender.user_id);
            } else {
              defender.is_alive = false;
              const deathLine = DEATH_LINES[Math.floor(Math.random() * DEATH_LINES.length)]
                .replace('{defender}', `**${defender.username}**`);
              events.push(deathLine);
              
              db.prepare('UPDATE battle_participants SET is_alive = 0, hp = 0 WHERE lobby_id = ? AND user_id = ?')
                .run(lobbyId, defender.user_id);
              
              alivePlayers = alivePlayers.filter(p => p.user_id !== defender.user_id);
            }
          } else {
            db.prepare('UPDATE battle_participants SET hp = ? WHERE lobby_id = ? AND user_id = ?')
              .run(defender.hp, lobbyId, defender.user_id);
          }

          db.prepare('UPDATE battle_participants SET total_damage_dealt = ? WHERE lobby_id = ? AND user_id = ?')
            .run(attacker.total_damage_dealt, lobbyId, attacker.user_id);

        } else if (rand < 0.80 && alivePlayers.length > 0) {
          // ITEM FIND EVENT
          const player = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
          const itemLine = ITEM_FIND_LINES[Math.floor(Math.random() * ITEM_FIND_LINES.length)];
          
          if (itemLine.includes('Damage +20%')) {
            playerBuffs[player.user_id] = true;
            events.push(itemLine.replace('{player}', `**${player.username}**`));
          } else {
            // HP boost items
            const hpBoost = Math.floor(Math.random() * 11) + 8; // 8-18 HP
            player.hp = Math.min(100, player.hp + hpBoost);
            
            const text = itemLine.replace('{player}', `**${player.username}**`);
            events.push(text);
            
            db.prepare('UPDATE battle_participants SET hp = ? WHERE lobby_id = ? AND user_id = ?')
              .run(player.hp, lobbyId, player.user_id);
          }
        } else if (alivePlayers.length > 0) {
          // FLAVOR EVENT (no mechanical effect)
          const player = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
          const flavorLine = FLAVOR_LINES[Math.floor(Math.random() * FLAVOR_LINES.length)]
            .replace('{player}', `**${player.username}**`);
          events.push(flavorLine);
        }

        // Stop if we're down to 1 player
        if (alivePlayers.length <= 1) break;
      }

      rounds.push({ 
        round: roundNum, 
        events,
        playersLeft: alivePlayers.length 
      });
      
      // Safety break
      if (roundNum > 100) break;
    }

    // Winner!
    const winner = alivePlayers[0];
    const winnerLine = WINNER_LINES[Math.floor(Math.random() * WINNER_LINES.length)]
      .replace('{winner}', `**${winner.username}**`);

    // Pick a random finale outro
    const finaleOutro = FINALE_OUTROS[Math.floor(Math.random() * FINALE_OUTROS.length)]
      .replace('{winner}', `**${winner.username}**`)
      .replace('{rounds}', roundNum)
      .replace('{totalPlayers}', totalPlayers);

    // Update battle status
    db.prepare('UPDATE battle_lobbies SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE lobby_id = ?')
      .run('completed', lobbyId);

    // Update stats for all participants
    const allParticipants = this.getParticipants(lobbyId);
    for (const p of allParticipants) {
      this.updateStats(p.user_id, p.username, p.user_id === winner.user_id, p.total_damage_dealt);
    }

    return { 
      rounds, 
      winner, 
      winnerLine, 
      finaleOutro,
      totalPlayers,
      roundCount: roundNum
    };
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

  buildLobbyEmbed(lobby, participants, requiredRole = null, excludedRoles = null) {
    const maxPlayersText = (!lobby.max_players || lobby.max_players >= 999) 
      ? '∞' 
      : lobby.max_players;
    
    let description = `The family is gathering for a showdown.\n` +
      `React with ${this.SWORD_EMOJI} to join the fight!\n\n` +
      `**Status:** ${lobby.status === 'open' ? '🟢 Open' : '🔴 Closed'}\n` +
      `**Players:** ${participants.length}/${maxPlayersText}\n` +
      `**Minimum:** ${lobby.min_players} players to start`;

    if (lobby.required_role_id || requiredRole) {
      const roleName = requiredRole ? requiredRole.name : `<@&${lobby.required_role_id}>`;
      description += `\n**Required Role:** ${roleName}`;
    }

    if ((lobby.excluded_role_ids || excludedRoles) && excludedRoles && excludedRoles.length) {
      const excludedNames = excludedRoles.map(r => r.name).join(', ');
      description += `\n**Excluded Roles:** ${excludedNames}`;
    } else if (lobby.excluded_role_ids) {
      const excludedIds = lobby.excluded_role_ids.split(',');
      const excludedMentions = excludedIds.map(id => `<@&${id}>`).join(', ');
      description += `\n**Excluded Roles:** ${excludedMentions}`;
    }

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('⚔️ Mafia Battle Lobby')
      .setDescription(description)
      .setFooter({ text: 'Creator can /battle start when ready | Era: Solpranos' })
      .setTimestamp();

    if (participants.length > 0) {
      const playerList = participants.map(p => `• ${p.username}`).join('\n');
      embed.addFields({ name: '🥊 Fighters', value: playerList, inline: false });
    }

    return embed;
  }
}

module.exports = new BattleService();
