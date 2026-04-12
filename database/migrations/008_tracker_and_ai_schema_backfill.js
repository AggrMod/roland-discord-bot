module.exports = {
  version: 8,
  name: 'tracker_and_ai_schema_backfill',
  up: ({ db, logger }) => {
    const tolerantExec = (sql) => {
      try {
        db.exec(sql);
      } catch (error) {
        const message = String(error?.message || '').toLowerCase();
        const ignorable = message.includes('duplicate column name')
          || message.includes('already exists')
          || message.includes('no such table')
          || message.includes('no such column');
        if (!ignorable) throw error;
      }
    };

    // Invite tracker backfill + indexes
    tolerantExec('ALTER TABLE invite_tracker_settings ADD COLUMN required_join_role_id TEXT');
    tolerantExec('ALTER TABLE invite_tracker_settings ADD COLUMN panel_channel_id TEXT');
    tolerantExec('ALTER TABLE invite_tracker_settings ADD COLUMN panel_message_id TEXT');
    tolerantExec('ALTER TABLE invite_tracker_settings ADD COLUMN panel_period_days INTEGER');
    tolerantExec('ALTER TABLE invite_tracker_settings ADD COLUMN panel_limit INTEGER DEFAULT 10');
    tolerantExec('ALTER TABLE invite_tracker_settings ADD COLUMN panel_enable_create_link INTEGER DEFAULT 1');
    tolerantExec('ALTER TABLE invite_tracker_settings ADD COLUMN include_verification_stats INTEGER DEFAULT 0');
    tolerantExec("ALTER TABLE invite_tracker_settings ADD COLUMN excluded_codes TEXT DEFAULT '[]'");
    tolerantExec("ALTER TABLE invite_tracker_settings ADD COLUMN panel_sort_by TEXT DEFAULT 'invites'");
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_invite_tracker_settings_guild ON invite_tracker_settings(guild_id)');

    tolerantExec('ALTER TABLE invite_tracker_user_codes ADD COLUMN owner_username TEXT');
    tolerantExec('ALTER TABLE invite_tracker_user_codes ADD COLUMN channel_id TEXT');
    tolerantExec('ALTER TABLE invite_tracker_user_codes ADD COLUMN active INTEGER DEFAULT 1');
    tolerantExec('ALTER TABLE invite_tracker_user_codes ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_invite_tracker_user_codes_guild_owner ON invite_tracker_user_codes(guild_id, owner_user_id)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_invite_tracker_user_codes_guild_code ON invite_tracker_user_codes(guild_id, invite_code)');

    // Keep first attribution row per joined member before applying unique index.
    tolerantExec(`
      DELETE FROM invite_events
      WHERE id NOT IN (
        SELECT MIN(id)
        FROM invite_events
        GROUP BY guild_id, joined_user_id
      )
    `);
    tolerantExec('CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_events_guild_joined_unique ON invite_events(guild_id, joined_user_id)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_invite_events_guild_joined_at ON invite_events(guild_id, joined_at DESC)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_invite_events_guild_inviter ON invite_events(guild_id, inviter_user_id)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_invite_events_guild_joined_user ON invite_events(guild_id, joined_user_id)');

    // Token verification/tracker backfill + indexes
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_token_role_rules_guild ON token_role_rules(guild_id)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_token_role_rules_mint ON token_role_rules(token_mint)');
    tolerantExec('ALTER TABLE token_role_rules ADD COLUMN never_remove INTEGER DEFAULT 0');

    tolerantExec('CREATE INDEX IF NOT EXISTS idx_tracked_tokens_guild ON tracked_tokens(guild_id)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_tracked_tokens_mint ON tracked_tokens(token_mint)');
    tolerantExec('ALTER TABLE tracked_tokens ADD COLUMN alert_buys INTEGER DEFAULT 1');
    tolerantExec('ALTER TABLE tracked_tokens ADD COLUMN alert_sells INTEGER DEFAULT 1');
    tolerantExec('ALTER TABLE tracked_tokens ADD COLUMN alert_transfers INTEGER DEFAULT 0');
    tolerantExec('ALTER TABLE tracked_tokens ADD COLUMN min_alert_amount REAL DEFAULT 0');
    tolerantExec('ALTER TABLE tracked_tokens ADD COLUMN alert_channel_id TEXT');
    tolerantExec("ALTER TABLE tracked_tokens ADD COLUMN alert_channel_ids TEXT DEFAULT '[]'");

    tolerantExec('ALTER TABLE tracked_wallets ADD COLUMN token_last_signature TEXT');
    tolerantExec('ALTER TABLE tracked_wallets ADD COLUMN token_last_checked_at DATETIME');

    tolerantExec('CREATE INDEX IF NOT EXISTS idx_tracked_token_events_guild_time ON tracked_token_events(guild_id, event_time)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_tracked_token_events_wallet_time ON tracked_token_events(wallet_id, event_time)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_tracked_token_events_mint_time ON tracked_token_events(token_mint, event_time)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_tracked_token_retry_due ON tracked_token_webhook_retry_queue(next_attempt_at)');

    // AI assistant usage/knowledge indexes
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_ai_assistant_settings_guild ON ai_assistant_tenant_settings(guild_id)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_ai_assistant_usage_guild_time ON ai_assistant_usage_events(guild_id, created_at DESC)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_ai_assistant_usage_user_time ON ai_assistant_usage_events(user_id, created_at DESC)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_ai_assistant_usage_guild_channel_time ON ai_assistant_usage_events(guild_id, channel_id, created_at DESC)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_ai_assistant_knowledge_guild_enabled ON ai_assistant_knowledge_docs(guild_id, enabled)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_ai_assistant_knowledge_guild_updated ON ai_assistant_knowledge_docs(guild_id, updated_at DESC)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_ai_assistant_knowledge_guild_stale ON ai_assistant_knowledge_docs(guild_id, stale, updated_at DESC)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_ai_assistant_channel_policy_guild_mode ON ai_assistant_channel_policies(guild_id, mode)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_ai_assistant_personas_guild_scope ON ai_assistant_personas(guild_id, scope, enabled)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_ai_assistant_memory_entries_guild_user_time ON ai_assistant_memory_entries(guild_id, user_id, created_at DESC)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_ai_assistant_ingestion_jobs_guild_status ON ai_assistant_ingestion_jobs(guild_id, status, created_at DESC)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_ai_assistant_action_suggestions_guild_status ON ai_assistant_action_suggestions(guild_id, status, created_at DESC)');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_ai_assistant_role_limits_guild_role ON ai_assistant_role_limits(guild_id, role_id)');

    logger.log('[DB] Migration v8 ensured invite tracker, token tracker, and AI assistant backfill schema');
  },
};
