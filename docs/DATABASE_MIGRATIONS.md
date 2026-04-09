# Database Migrations

GuildPilot now uses a versioned migration ledger in SQLite:
- Table: `schema_migrations`
- Baseline legacy schema marker: `v1 (legacy_bootstrap_schema)`
- Structured incremental migrations are loaded from:
  - built-in migrations in `database/db.js` (`STRUCTURED_MIGRATIONS`)
  - file migrations in `database/migrations/*.js` with `{ version, name, up }`

## How It Works
1. Boot initializes core tables/legacy compatibility DDL (idempotent).
2. Baseline migration `v1` is recorded once.
3. Structured + file migrations are merged and applied in version order.
4. Each migration runs in a transaction and is recorded in `schema_migrations`.
5. Startup validates required schema columns and fails fast if critical columns are missing.

## Adding a New Migration
1. Create a new file in `database/migrations`:
   - Example: `005_my_change.js`
2. Export:
   - `version` (unique, increasing integer)
   - `name` (short slug)
   - `up({ db, logger })` function (DDL/DML)
3. Keep migrations idempotent where possible (`CREATE ... IF NOT EXISTS`, tolerant `ALTER TABLE`).
4. Deploy and restart once; migration applies automatically.

## Recent Migrations
- `v4 verification_rule_override_support`
  - Adds `never_remove` support for token verification rules.
  - Adds tenant-level `base_verified_role_id`.
- `v5 nft_alert_config_tenant_scoping`
  - Introduces `nft_activity_alert_configs` with per-tenant (`guild_id`) rows.
  - Migrates legacy global NFT alert config into the new scoped table.
- `v6 add_user_tenant_memberships`
  - Adds `user_tenant_memberships` for tenant-scoped admin verification views/actions.
  - Backfills membership links from tracked wallets, missions, and governance history where possible.
- `v7 tenant_branding_server_profile_fields`
  - Adds tenant branding fields for guild-specific bot profile controls:
    `bot_server_avatar_url`, `bot_server_banner_url`, `bot_server_bio`.

## Operational Notes
- Do not edit or delete previously shipped migration entries.
- Never reuse a migration version number.
- Startup now rejects duplicate migration versions.
- If a migration fails, startup should stop and logs will show the failing migration version/name.
- Use staging first before production rollout.
