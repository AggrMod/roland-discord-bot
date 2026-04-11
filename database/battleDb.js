const db = require('./db');
const logger = require('../utils/logger');

function initBattleTables() {
  logger.log('Initializing battle tables...');

  db.exec(`
    CREATE TABLE IF NOT EXISTS battle_lobbies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lobby_id TEXT UNIQUE NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      min_players INTEGER DEFAULT 2,
      max_players INTEGER DEFAULT 999,
      required_role_ids TEXT,
      excluded_role_ids TEXT,
      era TEXT DEFAULT 'mafia',
      bounties_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS battle_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lobby_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      hp INTEGER DEFAULT 100,
      total_damage_dealt INTEGER DEFAULT 0,
      is_alive BOOLEAN DEFAULT 1,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lobby_id) REFERENCES battle_lobbies(lobby_id),
      UNIQUE(lobby_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS battle_stats (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      battles_played INTEGER DEFAULT 0,
      battles_won INTEGER DEFAULT 0,
      total_damage_dealt INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_battle_lobbies_status ON battle_lobbies(status);
    CREATE INDEX IF NOT EXISTS idx_battle_participants_lobby ON battle_participants(lobby_id);
    CREATE INDEX IF NOT EXISTS idx_battle_participants_user ON battle_participants(user_id);
  `);

  // Safe additive migrations
  try { db.exec('ALTER TABLE battle_lobbies ADD COLUMN excluded_role_id TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE battle_lobbies ADD COLUMN excluded_role_ids TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE battle_lobbies ADD COLUMN required_role_ids TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE battle_lobbies ADD COLUMN era TEXT DEFAULT "mafia"'); } catch (e) {}
  try { db.exec('ALTER TABLE battle_lobbies ADD COLUMN bounties_json TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE battle_lobbies ADD COLUMN guild_id TEXT'); } catch (e) {}
  // If old columns exist, populate new columns
  try {
    const rows = db.prepare('SELECT id, required_role_id, excluded_role_id FROM battle_lobbies WHERE (required_role_id IS NOT NULL OR excluded_role_id IS NOT NULL)').all();
    const stmt = db.prepare('UPDATE battle_lobbies SET required_role_ids = ?, excluded_role_ids = ? WHERE id = ?');
    for (const row of rows) {
      const reqIds = row.required_role_id || null;
      const excIds = row.excluded_role_id || null;
      stmt.run(reqIds, excIds, row.id);
    }
  } catch (e) {}

  logger.log('Battle tables initialized successfully');
}

initBattleTables();

module.exports = db;
