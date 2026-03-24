const db = require('../db');
const logger = require('../../utils/logger');

function migrate() {
  logger.log('Running migration: 001_add_battle_role_gate');
  
  try {
    // Check if column already exists
    const tableInfo = db.prepare('PRAGMA table_info(battle_lobbies)').all();
    const hasRequiredRoleId = tableInfo.some(col => col.name === 'required_role_id');
    
    if (!hasRequiredRoleId) {
      db.exec(`ALTER TABLE battle_lobbies ADD COLUMN required_role_id TEXT DEFAULT NULL`);
      logger.log('✅ Added required_role_id column to battle_lobbies');
    } else {
      logger.log('✅ Column required_role_id already exists, skipping');
    }
    
    // Update default max_players to 999 for unlimited
    const updateStmt = db.prepare(`
      UPDATE battle_lobbies 
      SET max_players = 999 
      WHERE max_players = 8 AND status = 'open'
    `);
    const result = updateStmt.run();
    
    if (result.changes > 0) {
      logger.log(`✅ Updated ${result.changes} open lobbies to unlimited max_players`);
    }
    
    logger.log('✅ Migration 001_add_battle_role_gate completed successfully');
    return true;
  } catch (error) {
    logger.error('❌ Migration failed:', error);
    return false;
  }
}

module.exports = { migrate };

// Run if executed directly
if (require.main === module) {
  migrate();
  process.exit(0);
}
