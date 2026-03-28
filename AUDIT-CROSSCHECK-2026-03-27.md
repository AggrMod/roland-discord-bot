# AUDIT-CROSSCHECK-2026-03-27

## Scope

Crosscheck of:
- Slash commands in `commands/**`
- Web admin/user flows in `web/public/portal.js` and `web/public/portal.html`
- API endpoints in `web/server.js`
- Shared services called from both command and web paths:
  - `proposalService`
  - `roleService`
  - `ticketService`
  - `tenantService`
  - `treasuryService`
  - `nftService` / `nftActivityService`

## Parity Matrix

| Feature | Web support | Command support | API support | Mismatch |
| --- | --- | --- | --- | --- |
| Governance proposal creation | Yes. Portal proposal form and public API entry points support title/description plus optional category/cost indications. | Yes. `/governance propose` accepts `title`, `description`, optional `category`, and optional `cost`. | Yes. `POST /api/user/proposals` and `POST /api/governance/proposals` accept `title`, `description`, optional `category`, optional `costIndication`. | Fixed portal/help stale assumptions about proposal fields. |
| Verification trait role config | Yes. Portal role-management UI handles trait role CRUD. | Partial. `/verification admin role-config` supports `view`, `set_trait`, `remove_trait`; `set_tier` is intentionally a placeholder. | Yes. `POST /api/admin/roles/traits` and related role endpoints back the portal flow. | Intentional gap: tier-role CRUD remains portal-managed, not command-managed. |
| NFT activity watchlist | Yes. Portal admin collections UI adds/removes watched collections. | Yes. `/verification admin activity-watch-add`, `activity-watch-remove`, `activity-watch-list`, `activity-feed`. | Yes. `/api/admin/nft-tracker/collections` and `/api/public/v1/nft/activity`. | Fixed portal collection add/remove wiring to the real admin collection API. |
| NFT activity alerts | Yes. Portal alert modal now edits the NFT activity config. | Yes. `/verification admin activity-alerts` uses `enabled`, `channel`, `types`, `min_sol`. | Yes. `PUT /api/admin/nft-activity/config`. | Fixed portal modal stale endpoint and request shape. |
| Treasury monitoring/config | Yes. Portal treasury modal and treasury dashboard are wired to admin treasury summary/config endpoints. | Yes. `/treasury view`, `/treasury admin status`, `/refresh`, `/set-wallet`, `/set-interval`, `/tx-alerts`. | Yes. `/api/public/treasury`, `/api/admin/treasury`, `PUT /api/admin/treasury/config`, `POST /api/admin/treasury/refresh`. | Fixed portal treasury config field/endpoint mismatch. |
| Ticketing admin flows | Yes. Portal ticket categories/panels/archive are wired to ticket APIs. | No command surface found in `commands/**`. | Yes. `/api/admin/tickets/*` routes exist for categories, panel, ticket list, and transcripts. | Intentional gap: ticketing is web/API-only at present. |
| Tenant/module gating | Yes. Web admin routes already resolve tenant-scoped module state. | Yes. Slash commands now respect tenant-scoped module enablement through `moduleGuard`. | Yes. Admin routes use tenant-aware resolution and module flags. | Fixed command-side gate fallback to tenant-scoped module state. |

## Fixed Mismatches

1. `web/public/portal.js`
   - Redirected the NFT activity alert modal from the dead `POST /api/admin/activity/alerts` path to `PUT /api/admin/nft-activity/config`.
   - Aligned the payload with the server contract: `enabled`, `channelId`, `eventTypes`, `minSol`.

2. `web/public/portal.js`
   - Aligned treasury config UI with `PUT /api/admin/treasury/config`.
   - Added the missing watch-channel and alert controls that the API already supports.

3. `web/public/portal.js`
   - Aligned NFT watchlist management with `POST /api/admin/nft-tracker/collections` and `DELETE /api/admin/nft-tracker/collections/:id`.
   - Removed stale assumptions about a single collection key string being the only accepted shape.

4. `utils/moduleGuard.js`
   - Made command gating tenant-aware.
   - When multitenant mode is enabled and a guild is present, command execution now respects `tenantService.isModuleEnabled(guildId, moduleName)` instead of only the global toggle.

5. `web/public/portal.js`, `web/public/portal.html`, `web/public/admin-help.html`
   - Updated help text for governance proposal creation to mention optional `category` and `cost` / `costIndication`.
   - Updated role-config help to reflect that tier-role CRUD is portal-managed.
   - Updated API reference text to match the current proposal payload.

6. `web/public/portal.js`
   - Fixed treasury dashboard rendering to consume the admin treasury summary shape returned by the server.

## Remaining Intentional Gaps

1. `set_tier` in `/verification admin role-config`
   - The command exists, but tier role CRUD is intentionally not implemented there.
   - Portal remains the canonical place for tier-role management.

2. Ticketing command surface
   - The portal and API expose full ticketing admin flows.
   - There is no matching slash command surface in `commands/**`.
   - This is currently a web/API-only feature set.

3. Legacy duplicate portal helpers
   - `web/public/portal.js` still contains legacy helper definitions that were renamed to avoid shadowing the active helpers.
   - This is not a runtime mismatch after the rename, but it is technical debt that should be cleaned in a follow-up pass.

4. API alias breadth
   - Some legacy public/governance aliases remain for compatibility.
   - They are intentionally retained and should not be collapsed without a migration plan.

## Regression Test Checklist

- Verify `/governance propose` in Discord with:
  - required `title` and `description`
  - optional `category`
  - optional `cost`
- Verify portal proposal creation sends the same fields and renders the same help text.
- Verify `/verification admin role-config`:
  - `view` returns the current trait-role config
  - `set_trait` and `remove_trait` still work
  - `set_tier` remains a documented portal-managed gap
- Verify NFT activity watchlist management in portal:
  - add collection
  - remove collection
  - refresh list
- Verify NFT activity alert config in portal:
  - enable alerts
  - set channel
  - set event types
  - save config
- Verify `/verification admin activity-alerts` still updates the same persisted config.
- Verify treasury portal config:
  - wallet address
  - refresh interval
  - watch channel
  - tx alerts enabled/disabled
  - incoming-only flag
  - minimum SOL threshold
- Verify `/treasury admin tx-alerts` and `/api/admin/treasury/config` stay in sync.
- Verify module gating in multitenant mode:
  - command disabled in one guild is still available in another guild when the tenant module is enabled
  - fallback to global toggle works when tenant lookup fails
- Verify `git diff --check` and `node --check` on all touched JS files remain clean.

## Notes

- The parity fixes were focused on high-impact behavior mismatches, not on flattening every legacy alias.
- The server-side API contracts were already the source of truth for treasury, governance, NFT activity, and ticketing; the portal was the stale side in the mismatches fixed here.
