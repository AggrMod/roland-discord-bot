module.exports = {
  version: 38,
  name: 'battle_stats_tenant_scope',
  up: ({ db, logger }) => {
    const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'battle_stats'").get();
    if (!existing) {
      db.exec(`
        CREATE TABLE battle_stats (
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          battles_played INTEGER DEFAULT 0,
          battles_won INTEGER DEFAULT 0,
          total_damage_dealt INTEGER DEFAULT 0,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (guild_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_battle_stats_guild_wins
          ON battle_stats(guild_id, battles_won DESC, total_damage_dealt DESC);
      `);
      logger.log('[DB] Migration v38 created tenant-scoped Battle statistics');
      return;
    }

    const columns = db.prepare('PRAGMA table_info(battle_stats)').all();
    const hasGuildId = columns.some(column => column.name === 'guild_id');
    const primaryKeyColumns = columns
      .filter(column => Number(column.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map(column => column.name);
    if (hasGuildId && primaryKeyColumns.join(',') === 'guild_id,user_id') return;

    db.transaction(() => {
      db.exec(`
        CREATE TABLE battle_stats_v38 (
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          battles_played INTEGER DEFAULT 0,
          battles_won INTEGER DEFAULT 0,
          total_damage_dealt INTEGER DEFAULT 0,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (guild_id, user_id)
        )
      `);

      if (hasGuildId) {
        db.exec(`
          INSERT OR REPLACE INTO battle_stats_v38
            (guild_id, user_id, username, battles_played, battles_won, total_damage_dealt, updated_at)
          SELECT COALESCE(NULLIF(guild_id, ''), 'legacy'), user_id, username,
                 battles_played, battles_won, total_damage_dealt, updated_at
          FROM battle_stats
        `);
      } else {
        db.exec(`
          INSERT OR REPLACE INTO battle_stats_v38
            (guild_id, user_id, username, battles_played, battles_won, total_damage_dealt, updated_at)
          SELECT 'legacy', user_id, username,
                 battles_played, battles_won, total_damage_dealt, updated_at
          FROM battle_stats
        `);
      }

      db.exec(`
        DROP TABLE battle_stats;
        ALTER TABLE battle_stats_v38 RENAME TO battle_stats;
        CREATE INDEX IF NOT EXISTS idx_battle_stats_guild_wins
          ON battle_stats(guild_id, battles_won DESC, total_damage_dealt DESC);
      `);
    })();

    logger.log('[DB] Migration v38 isolated Battle statistics per guild; legacy totals were preserved under the legacy scope');
  },
};
