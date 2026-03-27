# Hardening Checklist

Manual regression steps for tenant-context and cross-tenant bleed checks:

1. Log in as an admin with access to more than one guild and clear `activeGuildId` from localStorage.
2. Open the portal and confirm tenant-aware admin views show the "select a server" prompt instead of loading data.
3. With `activeGuildId` set, open Admin settings, Roles, Users, and Proposals and confirm requests include `x-guild-id`.
4. Remove `x-guild-id` from a tenant-sensitive request and confirm the server returns `409` with `Select a server to continue`.
5. Switch to a different guild and confirm settings, role config, and dashboard module visibility update without showing prior guild state.
6. Open the superadmin tenant manager and confirm tenant actions target the selected tenant only.
7. Re-run after a restart and confirm the active guild context persists and no stale tenant data bleeds between views.
