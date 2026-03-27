# Multi-Tenant Migration

This branch adds the tenant scaffold behind `MULTITENANT_ENABLED`.

## What Changed

- New additive tables: `tenants`, `tenant_modules`, `tenant_branding`, `tenant_limits`
- Guild tenant bootstrap on startup and `guildCreate`
- Command visibility groundwork through module metadata and guild command filtering
- Runtime module gate that is a no-op when `MULTITENANT_ENABLED=false`
- Admin settings responses now include tenant flags for frontend plumbing

## Behavior When Disabled

When `MULTITENANT_ENABLED=false`, the bot continues to use the current global module toggle behavior.

- No tenant-based command filtering is applied
- No runtime module blocking is introduced
- Existing production command behavior remains intact

## Current Scaffold Rules

- Every known guild is represented in `tenants`
- Command modules default to enabled for a new tenant
- Branding and limits rows are created empty for later admin tooling

## Validation

Run:

```bash
node --check index.js
node --check deploy-commands.js
node --check web/server.js
node --check services/tenantService.js
node --check middleware/moduleGate.js
git diff --check
```
