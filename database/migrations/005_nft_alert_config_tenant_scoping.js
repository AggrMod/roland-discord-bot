module.exports = {
  version: 5,
  name: 'nft_alert_config_tenant_scoping',
  up: ({ db, logger }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS nft_activity_alert_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL DEFAULT '',
        enabled INTEGER DEFAULT 0,
        channel_id TEXT,
        event_types TEXT DEFAULT 'mint,sell,list,delist,transfer',
        min_sol REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guild_id)
      )
    `);

    db.exec('CREATE INDEX IF NOT EXISTS idx_nft_activity_alert_configs_guild ON nft_activity_alert_configs(guild_id)');

    const legacy = db.prepare(`
      SELECT enabled, channel_id, event_types, min_sol
      FROM nft_activity_alert_config
      WHERE id = 1
      LIMIT 1
    `).get();

    if (legacy) {
      db.prepare(`
        INSERT INTO nft_activity_alert_configs (guild_id, enabled, channel_id, event_types, min_sol)
        VALUES ('', ?, ?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
          enabled = excluded.enabled,
          channel_id = excluded.channel_id,
          event_types = excluded.event_types,
          min_sol = excluded.min_sol,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        Number(legacy.enabled || 0) === 1 ? 1 : 0,
        legacy.channel_id || null,
        legacy.event_types || 'mint,sell,list,delist,transfer',
        Number(legacy.min_sol || 0)
      );
    } else {
      db.prepare(`
        INSERT OR IGNORE INTO nft_activity_alert_configs (guild_id, enabled, channel_id, event_types, min_sol)
        VALUES ('', 0, NULL, 'mint,sell,list,delist,transfer', 0)
      `).run();
    }

    logger.log('[DB] Migration v5 ensured tenant-scoped NFT alert config table');
  }
};
