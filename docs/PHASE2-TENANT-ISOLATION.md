# Phase 2 — Tenant Isolation & Entitlements (Fixes D, E, F)

**Part of:** `REMEDIATION-PLAN.md` Phase 2.
**Risk:** Medium — touches entitlements, an additive DB migration, and webhook
auth. **Every change is gated by a flag that defaults to today's behavior**, so
merging/deploying this changes nothing until an operator opts in. Roll out
monitor-before-enforce, on staging first.

---

## Fix D — Module-identity enforcement vs plan (audit M-1)

**Files:** `services/tenantService.js` (`setTenantModule`),
`web/routes/superadminTenantOps.js`, `services/monetizationTemplateService.js`,
`tests/test-module-identity-gate.js`

A tenant could enable a module its plan doesn't include (e.g. a free tenant
turning on `aiassistant`) because `setTenantModule` only checked the module
*count*, never module *identity*. Added a plan-identity gate:

- Gate runs only on the **enable** transition and **never disturbs an
  already-enabled (grandfathered) module**.
- Operator/superadmin callers pass `{ bypassPlanGate: true }` (superadmin tenant
  ops, monetization template apply/restore) so they can still grant any module.
- **Rollout flag `MODULE_IDENTITY_ENFORCE`** = `off` (default, no change) →
  `monitor` (logs "would block …", changes nothing) → `enforce` (returns
  `module_not_in_plan`). Review monitor logs to confirm no legitimate tenant is
  affected before enforcing.

---

## Fix E — Treasury config per-tenant (audit H-1)

**Files:** `database/migrations/025_treasury_config_per_guild.js` (new),
`services/treasuryService.js`, `web/routes/adminTrackers.js`,
`commands/treasury/treasury.js`, `web/routes/v1.js`,
`tests/test-treasury-per-tenant.js`

The treasury used a **single global config row** (`CHECK(id=1)`), and the admin
read/write path passed no `guildId` — so one tenant's admin editing treasury
settings overwrote **every** tenant's wallet/alerts. Because the legacy table
can't hold multiple rows, per-guild config lives in an additive
`treasury_config_guild` table.

- **Migration** adds the table and **backfills the existing global row to the
  primary `GUILD_ID`**, so the currently-live deployment keeps its exact
  settings. Lazy backfill on first per-guild access covers any gaps.
- `getConfig` / `updateConfig` / `getAdminSummary` / `getSummary` /
  `getRecentTransactions` / `fetchBalances` / `checkAndSendTxAlerts` /
  `postOrUpdateWatchPanel` now accept an optional `guildId`. Admin routes,
  slash commands, and the public API thread it through.
- The scheduler iterates per-guild configs when enabled.
- **Rollout flag `TREASURY_PER_TENANT`** = `false` (default): every method
  targets the legacy global row **exactly as before** (byte-identical SQL).
  `true`: config is isolated per guild. The legacy global row is never touched
  by per-guild writes.

---

## Fix F — Vault webhook per-guild secret + guild-match (audit H-2)

**Files:** `web/routes/vaultWebhooks.js`,
`tests/test-vault-webhook-guild-binding.js` (Phase 1 already added the rate
limit + replay to this endpoint)

The vault webhook authenticated with **one shared global secret** (falling back
to the token/nft secret) while the target guild was fully attacker-controlled —
so any holder of that secret could grant rewards to **any** guild.

- **Per-guild secrets:** `VAULT_WEBHOOK_SECRET_<GUILD_ID>` binds authorization to
  a specific guild.
- **Guild-match:** an authenticated request may only write to its own guild;
  events naming a different guild are rejected.
- **Rollout flag `VAULT_WEBHOOK_ENFORCE_GUILD_MATCH`** = `off` (default, legacy
  global-secret auth, event guild trusted) → `monitor` (legacy auth still works,
  logs what enforce would reject) → `enforce` (require the target guild's own
  secret; reject foreign-guild events; reject guilds with no per-guild secret).

Operator workflow: set a `VAULT_WEBHOOK_SECRET_<guild>` per vault tenant and
point each Helius webhook at it + its `guildId`, run `monitor` and watch logs,
then flip to `enforce`.

---

## New env flags (all optional; safe defaults — see `.env.example`)

| Flag | Default | Effect |
|---|---|---|
| `MODULE_IDENTITY_ENFORCE` | `off` | `off`/`monitor`/`enforce` plan-module gate |
| `TREASURY_PER_TENANT` | `false` | per-guild treasury config |
| `VAULT_WEBHOOK_ENFORCE_GUILD_MATCH` | `off` | `off`/`monitor`/`enforce` vault webhook guild binding |
| `VAULT_WEBHOOK_SECRET_<GUILD_ID>` | unset | per-guild vault webhook secret |

## Rollback levers (no redeploy)

| If… | Do |
|---|---|
| A tenant lost a module after enabling Fix D | `MODULE_IDENTITY_ENFORCE=monitor` (or `off`) + restart |
| Treasury shows wrong/empty data | `TREASURY_PER_TENANT=false` + restart (legacy global row intact; migration is additive) |
| Vault mints stopped | `VAULT_WEBHOOK_ENFORCE_GUILD_MATCH=monitor` (or `off`) + restart |
| Anything else | `git revert` the Phase 2 commit; the migration is additive (no data loss) |

## Verification

- Release gate green and deterministic across repeated runs, with three new
  checks: `module-identity-gate`, `treasury-per-tenant`,
  `vault-webhook-guild-binding`.
- Existing treasury tests still pass; changed files lint clean (0 errors).
- `guildpilot.db` untouched by the gate.

## Recommended rollout order (per fix, on staging first)

1. Deploy with all three flags at their defaults (no behavior change).
2. `MODULE_IDENTITY_ENFORCE=monitor` → review logs (~days) → `enforce`.
3. `TREASURY_PER_TENANT=true` on staging → verify each guild's treasury →
   production (the primary guild keeps its config via backfill).
4. Provision `VAULT_WEBHOOK_SECRET_<guild>` per vault tenant →
   `VAULT_WEBHOOK_ENFORCE_GUILD_MATCH=monitor` → review → `enforce`.
