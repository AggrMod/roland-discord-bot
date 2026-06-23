module.exports = {
  version: 25,
  name: 'treasury_config_per_guild',
  up: ({ db, logger }) => {
    const tolerantExec = (sql) => {
      try {
        db.exec(sql);
      } catch (error) {
        const msg = String(error?.message || '');
        const ignorable = msg.includes('duplicate column name')
          || msg.includes('already exists')
          || msg.includes('no such table');
        if (!ignorable) throw error;
      }
    };

    // Per-guild treasury config. The legacy single-row `treasury_config`
    // (CHECK id = 1) cannot hold multiple rows, so per-tenant config lives in
    // this additive table. The legacy row remains the default/fallback; nothing
    // here changes behavior unless TREASURY_PER_TENANT is enabled at runtime.
    tolerantExec(`
      CREATE TABLE IF NOT EXISTS treasury_config_guild (
        guild_id TEXT PRIMARY KEY,
        enabled BOOLEAN DEFAULT 0,
        solana_wallet TEXT,
        refresh_hours INTEGER DEFAULT 4,
        last_updated DATETIME,
        sol_balance TEXT,
        usdc_balance TEXT,
        last_error TEXT,
        tx_alerts_enabled BOOLEAN DEFAULT 0,
        tx_alert_channel_id TEXT,
        tx_alert_incoming_only BOOLEAN DEFAULT 0,
        tx_alert_min_sol REAL DEFAULT 0,
        tx_last_signature TEXT,
        watch_channel_id TEXT,
        watch_message_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tolerantExec(`
      CREATE INDEX IF NOT EXISTS idx_treasury_config_guild_enabled
      ON treasury_config_guild(enabled)
    `);

    // Backfill the existing global config to the primary guild so the currently
    // live deployment keeps its exact treasury settings when per-tenant mode is
    // turned on. (Also done lazily on first per-guild access; this is belt-and-
    // suspenders and is skipped if the legacy table doesn't exist yet.)
    try {
      const primaryGuild = String(process.env.GUILD_ID || '').trim();
      if (/^\d{17,20}$/.test(primaryGuild)) {
        const legacy = db.prepare('SELECT * FROM treasury_config WHERE id = 1').get();
        const existing = db.prepare('SELECT guild_id FROM treasury_config_guild WHERE guild_id = ?').get(primaryGuild);
        if (legacy && !existing) {
          db.prepare(`
            INSERT INTO treasury_config_guild (
              guild_id, enabled, solana_wallet, refresh_hours, last_updated,
              sol_balance, usdc_balance, last_error, tx_alerts_enabled,
              tx_alert_channel_id, tx_alert_incoming_only, tx_alert_min_sol,
              tx_last_signature, watch_channel_id, watch_message_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            primaryGuild,
            legacy.enabled ?? 0,
            legacy.solana_wallet ?? null,
            legacy.refresh_hours ?? 4,
            legacy.last_updated ?? null,
            legacy.sol_balance ?? null,
            legacy.usdc_balance ?? null,
            legacy.last_error ?? null,
            legacy.tx_alerts_enabled ?? 0,
            legacy.tx_alert_channel_id ?? null,
            legacy.tx_alert_incoming_only ?? 0,
            legacy.tx_alert_min_sol ?? 0,
            legacy.tx_last_signature ?? null,
            legacy.watch_channel_id ?? null,
            legacy.watch_message_id ?? null
          );
          logger.log(`[DB] Migration v25 backfilled treasury config to primary guild ${primaryGuild}`);
        }
      }
    } catch (error) {
      logger.warn(`[DB] Migration v25 treasury backfill skipped: ${error?.message || error}`);
    }

    logger.log('[DB] Migration v25 ensured per-guild treasury config table');
  }
};
