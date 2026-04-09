# ENV Migration Guide (Tenant-First)

This project has moved from env-driven feature configuration to tenant-driven configuration.

## Keep in `.env` (platform/runtime only)
- `DISCORD_TOKEN`
- `CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI`
- `SESSION_SECRET`
- `WEB_PORT`
- `WEB_URL`
- `NODE_ENV`
- `GUILD_ID` (fallback bootstrap)
- `MULTITENANT_ENABLED`
- `SUPERADMIN_DISCORD_ID` / `SUPERADMIN_DISCORD_IDS`
- `ENTITLEMENT_WEBHOOK_SECRET`
- `SOLANA_RPC_URL`
- `HELIUS_API_KEY`
- `HELIUS_RPS`
- `MOCK_MODE` (global fallback only)

## Moved to tenant DB config (Superadmin/Admin UI)
- Module toggles (governance, verification, ticketing, treasury, etc.)
- Branding (display name, emoji, color, logo, support URL)
- Plan assignment and limits
- Mock data ON/OFF per tenant
- Governance channels and thresholds
- Ticket categories/panels
- Verification tiers/trait rules
- Voting power mappings

## Deprecated env-style feature config (do not re-add)
- Per-feature channel IDs in env
- Per-tenant role/tier config in env/files
- Per-tenant verification/ticket/governance behavior in env

## Read priority
1. Tenant DB config (authoritative)
2. Platform defaults
3. Env fallback (runtime/platform only)
