# Free-Tier Safe Mode

This branch includes a scaffold for safe tenant-scoped operation without changing the existing production path.

## Safe Mode Guarantees

- `MULTITENANT_ENABLED=false` keeps current behavior unchanged
- Module gating is bypassed when tenant mode is off
- Command deployment keeps the current global workflow when tenant mode is off
- Settings responses only gain extra fields; no existing fields are removed

## Intended Future Use

The tenant tables are ready for future free-tier controls such as:

- per-tenant module enablement
- per-tenant branding
- per-tenant limits
- read-only managed tenant states

## Operational Notes

- Tenant rows are created automatically for the configured guild on startup
- Guild join events will bootstrap tenant records automatically
- Disabled tenant modules are hidden from guild command sync when tenant mode is enabled

## Recommended Launch Check

Before turning `MULTITENANT_ENABLED=true` on a live deployment, verify:

- the current guild tenant exists
- the command sync output matches the expected module set
- the admin settings API exposes tenant flags
- slash command execution still works for enabled modules
