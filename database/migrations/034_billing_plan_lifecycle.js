function hasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .some(column => String(column.name || '').toLowerCase() === String(columnName).toLowerCase());
}

module.exports = {
  version: 34,
  name: 'billing_plan_lifecycle',
  up: ({ db, logger }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tenant_plan_contracts (
        tenant_id INTEGER PRIMARY KEY,
        base_plan_key TEXT NOT NULL DEFAULT 'starter',
        custom_plan_json TEXT,
        quoted_monthly_usd REAL,
        billing_interval TEXT,
        assignment_source TEXT NOT NULL DEFAULT 'system',
        pilot_plan_key TEXT,
        pilot_started_at DATETIME,
        pilot_ends_at DATETIME,
        pilot_status TEXT,
        pilot_assigned_by TEXT,
        pilot_note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tenant_plan_contracts_pilot_end
        ON tenant_plan_contracts(pilot_status, pilot_ends_at);
      CREATE INDEX IF NOT EXISTS idx_tenant_plan_contracts_base_plan
        ON tenant_plan_contracts(base_plan_key);
    `);

    if (!hasColumn(db, 'crypto_payment_receipts', 'custom_plan_json')) {
      db.exec('ALTER TABLE crypto_payment_receipts ADD COLUMN custom_plan_json TEXT');
    }
    if (!hasColumn(db, 'crypto_payment_receipts', 'quote_usd_amount')) {
      db.exec('ALTER TABLE crypto_payment_receipts ADD COLUMN quote_usd_amount REAL');
    }
    if (!hasColumn(db, 'crypto_payment_receipts', 'pricing_reason')) {
      db.exec('ALTER TABLE crypto_payment_receipts ADD COLUMN pricing_reason TEXT');
    }

    db.exec(`
      INSERT OR IGNORE INTO tenant_plan_contracts (
        tenant_id,
        base_plan_key,
        billing_interval,
        assignment_source
      )
      SELECT
        t.id,
        COALESCE(NULLIF(LOWER(t.plan_key), ''), 'starter'),
        tb.billing_interval,
        'migration'
      FROM tenants t
      LEFT JOIN tenant_billing tb ON tb.tenant_id = t.id;
    `);

    logger.log('[DB] Migration v34 added custom-plan contracts, pilot lifecycle, and quote snapshots');
  },
};
