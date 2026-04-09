# Hardening Checklist

Manual regression steps for tenant-context and cross-tenant bleed checks:

1. Log in as an admin with access to more than one guild and clear `activeGuildId` from localStorage.
2. Open the portal and confirm tenant-aware admin views show the "select a server" prompt instead of loading data.
3. With `activeGuildId` set, open Admin settings, Roles, Users, and Proposals and confirm requests include `x-guild-id`.
4. Remove `x-guild-id` from a tenant-sensitive request and confirm the server returns `409` with `Select a server to continue`.
5. Switch to a different guild and confirm settings, role config, and dashboard module visibility update without showing prior guild state.
6. Open the superadmin tenant manager and confirm tenant actions target the selected tenant only.
7. Re-run after a restart and confirm the active guild context persists and no stale tenant data bleeds between views.
8. Verification role safety check: confirm role sync/removal only touches roles configured in tenant verification rules, and `never remove` roles are preserved.
9. Battle race check: attempt two rapid lobby creates in one channel and confirm the second is rejected; attempt rapid double-start and confirm only one start succeeds.
10. Command-rate check: spam expensive slash commands (`/verification quick`, `/battle create`, `/minigames run`) and confirm cooldown feedback is returned instead of repeated execution.
11. NFT alert config scope check: set NFT activity alert config in tenant A and tenant B and confirm each guild retains independent `enabled/channel/eventTypes/minSol` values.
12. OG role scope check: set OG role/limit for tenant A and tenant B and confirm updates/disable in one tenant never mutate the other tenant.
13. Ticket scope safety check: in multitenant mode, requests without `x-guild-id` must not read/update ticket categories or panel settings from any other tenant.
14. Portal XSS guard check: dynamic inline `onclick` args in `web/public/portal.js` must pass through `escapeJsString(...)` (validated by `check:release-gate`).
15. Admin user scope check: `/api/admin/users` and `/api/admin/users/:discordId` must only return users present in `user_tenant_memberships` for the active guild.
16. Tenant user removal check: deleting a user from admin users view should remove only that guild membership by default (global delete is superadmin + explicit `scope=global`).
17. Migration discipline check: `scripts/check-db-adhoc-guard.js` must pass to ensure new schema changes are added as forward-only migrations instead of growing legacy ad-hoc DDL in `database/db.js`.
