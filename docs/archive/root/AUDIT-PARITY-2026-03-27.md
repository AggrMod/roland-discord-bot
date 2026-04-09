# Parity And Documentation Audit

Date: 2026-03-27
Scope: Web Admin UI, slash commands, and HTTP API surface for `/home/tjdot/roland-discord-bot`

## Summary

Overall status: partial parity with strong coverage for verification, governance, and treasury, plus intentional gaps for battle, heist, and advanced admin tooling.

This audit also refreshed the portal docs in `web/public/portal.js` and tightened the portal treasury renderers so they accept the current v1 response envelope.

## Parity Matrix

| Feature | Web Admin UI | Slash Commands | API Endpoints | Status |
|---|---|---|---|---|
| Verification | Full portal coverage for wallet linking, verification, OG admin controls, and activity alerts | Full coverage via `/verification` plus deprecated `/og-config` | Full coverage via `/api/verify/*`, `/api/micro-verify/*`, `/api/user/*`, and admin verification routes | Green |
| Governance | Full portal coverage for proposal workflow, voting, and admin moderation | Full coverage via `/governance` plus standalone `/propose`, `/support`, `/vote` | Full coverage via public, user, and admin governance routes | Green |
| Treasury | Full portal coverage for public balances, treasury admin controls, and transaction history | Full coverage via `/treasury` | Full coverage via public v1 + legacy aliases and admin treasury routes | Green, but mixed legacy/v1 surface |
| Battle | Help/docs only; no dedicated battle admin screen | Full slash command surface | No HTTP API for battle operations | Intentional gap |
| Heist | Portal documents the module and shows it when enabled, but it is disabled by default | Full slash command surface, gated by module flag | No HTTP API for heist operations | Intentional gap |
| Config / Module Toggles | Admin UI exposes module and system controls | `/config` | Admin config endpoints only | Partial, admin-only |
| Role Claim / Self-Serve Roles | Full UI for claimable roles | No direct slash-command equivalent | Admin role-claim endpoints only | Intentional web-only admin surface |
| NFT Activity / Tracker | Full UI for tracker and alert config | Verification admin subcommands cover watchlist and alerts | Public v1 activity feed plus admin tracker config | Green, with split responsibilities |
| Ticketing | Full UI for ticket categories, panels, and transcripts | No direct slash-command equivalent | Admin ticketing endpoints only | Intentional web-only admin surface |
| Analytics | Full UI for analytics dashboard | No direct slash-command equivalent | No dedicated public analytics API | Intentional web-only admin surface |
| API Reference | Documents the live public/session surface | N/A | Mirrors the live API contract and auth flow | Updated in this pass |

## Top Findings

1. `web/public/portal.js` now documents the active command surface correctly, including the standalone governance aliases `/propose`, `/support`, and `/vote`.
   - Status: resolved in this audit.
   - Evidence: `loadAdminHelpView()` now renders the grouped commands plus the aliases, and it calls out `/og-config` as deprecated.

2. The deprecated `/og-config` command is still registered and executes a deprecation notice before forwarding to the newer OG workflow.
   - Status: open deprecation debt.
   - Evidence: `commands/admin/ogConfig.js`.

3. The portal API reference previously documented older flat public routes only.
   - Status: resolved in this audit.
   - Evidence: `loadApiRefView()` now documents canonical `/api/public/v1/*` routes, the standard envelope, and the legacy aliases.

4. Public API usage is still mixed between canonical v1 routes and legacy aliases.
   - Status: intentional compatibility gap.
   - Evidence: portal governance views still use `/api/public/proposals/*`, while treasury views now use `/api/public/v1/treasury` and `/api/public/v1/treasury/transactions`.

5. The portal treasury views were previously reading shapes that did not match the v1 envelope.
   - Status: resolved in this audit.
   - Evidence: `loadTreasuryPublicView()` and `loadTreasuryTransactions()` now accept both envelope and legacy shapes.

6. Battle remains slash-command-only from an API perspective.
   - Status: intentional gap.
   - Evidence: `commands/battle/battle.js` has no matching `web/server.js` API routes.

7. Heist remains feature-flagged and slash-command-only from an API perspective.
   - Status: intentional gap.
   - Evidence: `commands/heist/heist.js` is guarded by the module flag, with no HTTP endpoints.

8. Advanced admin surfaces are intentionally web-only.
   - Status: intentional gap.
   - Evidence: ticketing, analytics, self-serve roles, role claim, voting power, and several NFT admin tools are exposed in the portal UI and `/api/admin/*` routes, but not as slash commands.

9. The API Reference intentionally stays focused on public/session routes rather than the full admin surface.
   - Status: intentional scope limit.
   - Evidence: admin endpoints exist in `web/server.js`, but the reference section only documents the public integration surface.

10. Separate docs surfaces can drift.
    - Status: open documentation risk.
    - Evidence: `web/public/portal.js` now matches current behavior, but `web/public/portal.html` and `web/public/admin-help.html` are separate static docs surfaces that can diverge over time.

## Action Items

1. Decide whether `/og-config` should be removed entirely or kept until dependent operators have migrated.
2. Decide whether the legacy `/api/public/*` aliases should keep an explicit sunset date, or remain indefinitely for compatibility.
3. If `web/public/portal.html` and `web/public/admin-help.html` stay user-facing, sync them to the same canonical command/API wording as `web/public/portal.js`.
4. Consider whether the admin-only HTTP routes deserve a separate internal reference page, since they are already heavily used by the portal UI.

## Notes

- The portal public treasury widgets now parse the v1 envelope correctly.
- The canonical public API docs now point at `/api/public/v1/*`, which matches the current code path used by the portal.
- The audit treats battle, heist, and advanced admin tooling as intentional gaps rather than defects because they are either web-only, module-flagged, or intentionally not exposed as public HTTP APIs.
