# Database Migrations

GuildPilot now uses a versioned migration ledger in SQLite:
- Table: `schema_migrations`
- Baseline legacy schema marker: `v1 (legacy_bootstrap_schema)`
- Structured incremental migrations are defined in `database/db.js`.

## How It Works
1. Boot initializes core tables/legacy compatibility DDL (idempotent).
2. Baseline migration `v1` is recorded once.
3. Structured migrations (`STRUCTURED_MIGRATIONS`) are applied in version order.
4. Each migration runs in a transaction and is recorded in `schema_migrations`.

## Adding a New Migration
1. Open `database/db.js`.
2. Add a new entry to `STRUCTURED_MIGRATIONS` with:
   - `version` (unique, increasing integer)
   - `name` (short slug)
   - `up` function (DDL/DML)
3. Keep migrations idempotent where possible (`CREATE ... IF NOT EXISTS`, tolerant `ALTER TABLE`).
4. Deploy and restart the bot once; migration applies automatically.

## Operational Notes
- Do not edit or delete previously shipped migration entries.
- Never reuse a migration version number.
- If a migration fails, startup should stop and logs will show the failing migration version/name.
- Use staging first before production rollout.
