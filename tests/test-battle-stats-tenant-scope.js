#!/usr/bin/env node

const assert = require('assert');
const Database = require('better-sqlite3');
const battleService = require('../services/battleService');
const migration = require('../database/migrations/038_battle_stats_tenant_scope');

function run() {
  const suffix = Date.now();
  const userId = `battle-user-${suffix}`;
  const guildA = `battle-guild-a-${suffix}`;
  const guildB = `battle-guild-b-${suffix}`;

  battleService.updateStats(guildA, userId, 'Battle Tester', true, 120);
  battleService.updateStats(guildB, userId, 'Battle Tester', false, 45);

  const statsA = battleService.getStats(guildA, userId);
  const statsB = battleService.getStats(guildB, userId);

  assert.strictEqual(statsA.battles_played, 1, 'guild A should contain only its own battle');
  assert.strictEqual(statsA.battles_won, 1, 'guild A win should remain in guild A');
  assert.strictEqual(statsA.total_damage_dealt, 120, 'guild A damage should remain in guild A');

  assert.strictEqual(statsB.battles_played, 1, 'guild B should contain only its own battle');
  assert.strictEqual(statsB.battles_won, 0, 'guild B should not inherit guild A wins');
  assert.strictEqual(statsB.total_damage_dealt, 45, 'guild B should not inherit guild A damage');

  assert.strictEqual(battleService.getStats(`missing-${suffix}`, userId), undefined, 'unrelated guild should see no stats');

  const legacyDb = new Database(':memory:');
  legacyDb.exec(`
    CREATE TABLE battle_stats (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      battles_played INTEGER DEFAULT 0,
      battles_won INTEGER DEFAULT 0,
      total_damage_dealt INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO battle_stats (user_id, username, battles_played, battles_won, total_damage_dealt)
    VALUES ('legacy-user', 'Legacy User', 4, 2, 300);
  `);
  migration.up({ db: legacyDb, logger: { log: () => {} } });
  const migratedColumns = legacyDb.prepare('PRAGMA table_info(battle_stats)').all();
  const primaryKey = migratedColumns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
  const legacyStats = legacyDb.prepare("SELECT * FROM battle_stats WHERE guild_id = 'legacy' AND user_id = 'legacy-user'").get();
  assert.deepStrictEqual(primaryKey, ['guild_id', 'user_id'], 'migration should replace the global primary key');
  assert.strictEqual(legacyStats.battles_played, 4, 'migration should preserve historic totals in the legacy scope');
  legacyDb.close();

  console.log('Battle tenant-scoped statistics assertions passed');
}

run();
