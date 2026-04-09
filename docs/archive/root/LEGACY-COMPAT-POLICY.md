# Legacy Compatibility Policy

## Purpose
Keep existing integrations stable while transitioning to canonical routes/commands.

## Public API
- Canonical surface: `/api/public/v1/*`
- Legacy compatibility aliases: `/api/public/*`

### Sunset Policy
- Legacy aliases remain available until all known consumers have migrated.
- Before removal:
  1. Add deprecation notice to admin docs and API reference
  2. Announce migration window (recommended: 30-60 days)
  3. Monitor usage and confirm no active consumers depend on legacy aliases

## Command Aliases
- Canonical governance group: `/governance ...`
- Legacy aliases still supported: `/propose`, `/support`, `/vote`
- Deprecated OG alias: `/og-config` (use `/verification admin og-*`)

### Alias Retirement Policy
- Keep aliases while users still rely on them.
- Mark deprecated in docs before removal.
- Remove only after a communicated migration window.

## Owner
Project maintainers (Roland team)
