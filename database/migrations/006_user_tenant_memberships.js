module.exports = {
  version: 6,
  name: 'add_user_tenant_memberships',
  up: ({ db, logger }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_tenant_memberships (
        discord_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        source TEXT DEFAULT 'verification_sync',
        last_verified_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (discord_id, guild_id)
      )
    `);

    db.exec('CREATE INDEX IF NOT EXISTS idx_user_tenant_memberships_guild ON user_tenant_memberships(guild_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_tenant_memberships_updated ON user_tenant_memberships(updated_at DESC)');

    const backfillStatements = [
      `
      INSERT OR IGNORE INTO user_tenant_memberships (discord_id, guild_id, source, last_verified_at, created_at, updated_at)
      SELECT w.discord_id, tw.guild_id, 'tracked_wallet', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM tracked_wallets tw
      INNER JOIN wallets w ON LOWER(w.wallet_address) = LOWER(tw.wallet_address)
      WHERE tw.guild_id IS NOT NULL AND tw.guild_id <> ''
        AND w.discord_id IS NOT NULL AND w.discord_id <> ''
      `,
      `
      INSERT OR IGNORE INTO user_tenant_memberships (discord_id, guild_id, source, last_verified_at, created_at, updated_at)
      SELECT DISTINCT mp.participant_id, m.guild_id, 'missions', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM mission_participants mp
      INNER JOIN missions m ON m.mission_id = mp.mission_id
      WHERE m.guild_id IS NOT NULL AND m.guild_id <> ''
        AND mp.participant_id IS NOT NULL AND mp.participant_id <> ''
      `,
      `
      INSERT OR IGNORE INTO user_tenant_memberships (discord_id, guild_id, source, last_verified_at, created_at, updated_at)
      SELECT DISTINCT p.creator_id, p.guild_id, 'governance', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM proposals p
      WHERE p.guild_id IS NOT NULL AND p.guild_id <> ''
        AND p.creator_id IS NOT NULL AND p.creator_id <> ''
      `,
      `
      INSERT OR IGNORE INTO user_tenant_memberships (discord_id, guild_id, source, last_verified_at, created_at, updated_at)
      SELECT DISTINCT v.voter_id, p.guild_id, 'governance_vote', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM votes v
      INNER JOIN proposals p ON p.proposal_id = v.proposal_id
      WHERE p.guild_id IS NOT NULL AND p.guild_id <> ''
        AND v.voter_id IS NOT NULL AND v.voter_id <> ''
      `,
    ];

    for (const sql of backfillStatements) {
      try {
        db.exec(sql);
      } catch (error) {
        logger.warn(`[DB] Membership backfill statement skipped: ${error?.message || error}`);
      }
    }
  }
};
