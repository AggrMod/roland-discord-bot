module.exports = {
  version: 31,
  name: 'webhook_event_inbox',
  up: ({ db, logger }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_event_inbox (
        inbox_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_inbox_pending
        ON webhook_event_inbox(status, next_attempt_at, created_at);
    `);
    logger.log('[DB] Migration v31 added the durable webhook event inbox');
  }
};
