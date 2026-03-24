const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../utils/logger');

const dbPath = path.join(__dirname, 'solpranos.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

function initDatabase() {
  logger.log('Initializing database...');

  // Migration: add missing columns
  try { db.exec('ALTER TABLE proposals ADD COLUMN voting_message_id TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE proposals ADD COLUMN message_id TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE proposals ADD COLUMN channel_id TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE wallets ADD COLUMN is_favorite BOOLEAN DEFAULT 0'); } catch(e) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      total_nfts INTEGER DEFAULT 0,
      tier TEXT,
      voting_power INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL UNIQUE,
      verified BOOLEAN DEFAULT 1,
      primary_wallet BOOLEAN DEFAULT 0,
      is_favorite BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (discord_id) REFERENCES users(discord_id)
    );

    CREATE TABLE IF NOT EXISTS micro_verify_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      username TEXT NOT NULL,
      expected_amount REAL NOT NULL,
      destination_wallet TEXT NOT NULL,
      sender_wallet TEXT,
      tx_signature TEXT,
      status TEXT DEFAULT 'pending',
      expires_at DATETIME NOT NULL,
      verified_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (discord_id) REFERENCES users(discord_id)
    );

    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT UNIQUE NOT NULL,
      creator_id TEXT NOT NULL,
      creator_wallet TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      total_vp INTEGER DEFAULT 0,
      yes_vp INTEGER DEFAULT 0,
      no_vp INTEGER DEFAULT 0,
      abstain_vp INTEGER DEFAULT 0,
      quorum_threshold INTEGER DEFAULT 25,
      start_time DATETIME,
      end_time DATETIME,
      message_id TEXT,
      channel_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (creator_id) REFERENCES users(discord_id)
    );

    CREATE TABLE IF NOT EXISTS proposal_supporters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL,
      supporter_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id),
      FOREIGN KEY (supporter_id) REFERENCES users(discord_id),
      UNIQUE(proposal_id, supporter_id)
    );

    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL,
      voter_id TEXT NOT NULL,
      vote_choice TEXT NOT NULL,
      voting_power INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id),
      FOREIGN KEY (voter_id) REFERENCES users(discord_id),
      UNIQUE(proposal_id, voter_id)
    );

    CREATE TABLE IF NOT EXISTS missions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      required_roles TEXT,
      min_tier TEXT,
      total_slots INTEGER NOT NULL,
      filled_slots INTEGER DEFAULT 0,
      reward_points INTEGER DEFAULT 0,
      status TEXT DEFAULT 'recruiting',
      start_time DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS mission_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      assigned_nft_mint TEXT NOT NULL,
      assigned_nft_name TEXT,
      assigned_role TEXT NOT NULL,
      points_awarded INTEGER DEFAULT 0,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (mission_id) REFERENCES missions(mission_id),
      FOREIGN KEY (participant_id) REFERENCES users(discord_id),
      UNIQUE(mission_id, participant_id)
    );

    CREATE INDEX IF NOT EXISTS idx_wallets_discord_id ON wallets(discord_id);
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
    CREATE INDEX IF NOT EXISTS idx_votes_proposal ON votes(proposal_id);
    CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);
    CREATE INDEX IF NOT EXISTS idx_mission_participants_mission ON mission_participants(mission_id);
    CREATE INDEX IF NOT EXISTS idx_micro_verify_discord_id ON micro_verify_requests(discord_id);
    CREATE INDEX IF NOT EXISTS idx_micro_verify_status ON micro_verify_requests(status);
    CREATE INDEX IF NOT EXISTS idx_micro_verify_amount ON micro_verify_requests(expected_amount);
  `);

  logger.log('Database initialized successfully');
}

initDatabase();

module.exports = db;
