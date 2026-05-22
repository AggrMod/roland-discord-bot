# V1 Release Signoff Staging Runbook

Last updated: 2026-05-22
Owner: Product + Engineering + Ops
Scope: Full product V1 signoff (all launch modules + Superadmin)

## 1. Goal
This runbook is the operational checklist for final V1 release signoff. It defines exact staging checks, pass/fail criteria, evidence requirements, and go/no-go gates.

Use this together with:
- `docs/V1_MODULE_LAUNCH_CHECKLIST.md` (module status and known hardening items)
- `docs/V1_PLAN_GATING_STRATEGY.md` (plan entitlement model)
- `docs/OPERATIONS.md` (ops/runtime baseline)

## 2. Required Environments
- `staging-clean` tenant: fresh tenant with minimal data.
- `staging-loaded` tenant: high-data tenant with historical activity.
- `superadmin` account.
- `tenant-admin` account.
- `moderator` account.
- `member` account.

## 3. Required Preconditions
1. Latest branch deployed to staging.
2. DB migrations applied and verified.
3. Discord bot online and healthy in both staging guilds.
4. API health checks green.
5. `npm test` passes locally and in CI.
6. Feature toggles for V1 behavior set to release defaults.

## 4. Execution Order (Do Not Skip)
1. Platform gates (auth, tenant context, permissions, plan gating).
2. Superadmin workspace end-to-end.
3. Tenant admin core settings flow.
4. Module-by-module functional pass.
5. Analytics and dashboard truth pass.
6. Billing/payments flow pass.
7. Security, resilience, and failure behavior pass.
8. Final regression + release decision.

## 5. Platform Gates
### 5.1 Auth and Context
- Check: all admin mutations require authenticated user + active tenant context.
- Pass criteria: unauthorized/invalid context requests are blocked with scoped errors; valid requests succeed.
- Evidence: request/response captures for one blocked and one successful action.

### 5.2 Role Separation
- Check: Tenant Admin cannot access Superadmin-only actions/workspaces.
- Pass criteria: UI hides restricted controls and API blocks direct calls.
- Evidence: screenshots + API block response.

### 5.3 Plan Entitlements
- Check: Free/Growth/Pro/Enterprise capabilities match pricing and gate rules.
- Pass criteria: locked features are consistently blocked in UI and API; unlocked features work.
- Evidence: one entitlement matrix capture per plan tier.

## 6. Superadmin Workspace Signoff
### 6.1 Navigation and Workspace Stability
- Check: Overview, Tenants, Billing, Security & Access, Integrations & System.
- Pass criteria: no broken navigation, no blank/cropped panes, no dead tiles.
- Evidence: workspace screenshots desktop + tablet width.

### 6.2 Tenant Operations
- Check: assign plan, apply template, module toggles, branding visibility gating.
- Pass criteria: each action persists, refresh-safe, audit event logged.
- Evidence: before/after state + audit log entry.

### 6.3 Billing Operations
- Check: wallet config, quote preparation, tx submission, queue review flow.
- Pass criteria: pending/approved/rejected states render correctly; errors are actionable.
- Evidence: one complete payment lifecycle trace.

## 7. Tenant Admin Signoff
### 7.1 Admin Surface Policy
- Check: module settings are only accessible through Modules area (not scattered routes).
- Pass criteria: consistent nav policy across all modules.
- Evidence: side menu walkthrough recording.

### 7.2 Branding Availability
- Check: branding appears only when plan allows it.
- Pass criteria: Free locked, Growth/Pro/Enterprise behavior matches entitlement policy.
- Evidence: plan switch captures.

### 7.3 Plans and Billing Visibility
- Check: tenant sees current plan, expiry, payment history, and payment instructions.
- Pass criteria: data is tenant-scoped and accurate.
- Evidence: screenshots and sampled payloads.

## 8. Module-by-Module Signoff
For each module below, execute on both `staging-clean` and `staging-loaded` unless noted.

### 8.1 Welcome & Onboarding
- Validate DM mode and panel mode.
- Validate captcha role add/remove flow.
- Validate welcome is sent only after successful verification when configured.
- Pass criteria: no failed send without surfaced error; analytics counters increment accurately.

### 8.2 Identity & Verification
- Validate wallet challenge/signature flow.
- Validate delegated wallet behavior and revoke effects.
- Validate sync rules with plan limits and edge flags.
- Pass criteria: role sync deterministic, auditable, and plan-safe.

### 8.3 Governance & Voting
- Validate proposal create/vote/close lifecycle.
- Validate channel posting and override behavior.
- Pass criteria: proposals and vote tallies are correct and scoped.

### 8.4 Wallet Tracker
- Validate wallet CRUD, panel posting, live refresh.
- Validate permission failure fallback in restricted channels.
- Pass criteria: no route-level crash; actionable errors returned.

### 8.5 NFT Activity Tracker
- Validate tracked collection CRUD and webhook ingestion.
- Validate burst delivery reliability and duplicate handling.
- Pass criteria: throughput stable, no duplicate spam.

### 8.6 Token Tracker
- Validate tracker CRUD and event ingestion.
- Validate plan limits and clear errors.
- Pass criteria: blocked adds at limit, existing trackers unaffected.

### 8.7 Invite Tracker
- Validate invite attribution and leaderboard.
- Validate anti-cheat signals and CSV export.
- Pass criteria: duplicate join inflation blocked; export complete.

### 8.8 AI Assistant
- Validate plan gating (Free blocked, Pro enabled).
- Validate budget exhaustion and reset messaging.
- Pass criteria: predictable behavior and clear user feedback.

### 8.9 Support Tickets
- Validate ticket creation, category routing, transcript retrieval.
- Validate permission overwrite drift handling.
- Pass criteria: channel permissions converge to expected state.

### 8.10 Engagement Hub
- Validate Discord provider on Free; X provider only on Growth+.
- Validate tasks, achievements, leaderboard, redemption.
- Pass criteria: provider gating and points accounting are consistent.

### 8.11 Minigames
- Validate moderator/admin command permissions.
- Validate session lifecycle under concurrency.
- Validate points payout wiring into engagement ledger.
- Pass criteria: no stale sessions, no duplicate payouts.

### 8.12 Missions
- Validate templates, spawn, resolve, cancel.
- Validate trait/category gate interactions.
- Pass criteria: reward outcomes match configured rules.

### 8.13 Vault (Must Launch)
- Validate full claims lifecycle, milestones, seasons, backfill guardrails.
- Validate social requirement gates before claim finalization.
- Pass criteria: safe ops and deterministic claim enforcement.

### 8.14 Self-Serve Roles
- Validate panel posting, claim/unclaim, stale panel reconciliation.
- Validate role hierarchy and ManageRoles guard behavior.
- Pass criteria: secure toggling only for configured claimable roles.

## 9. Analytics Truth Pass
- Check all dashboard widgets reflect real tenant-scoped numbers.
- Check time range filters (`24h`, `7d`, `30d`) on key analytics surfaces.
- Pass criteria: no placeholder/fake data; values reconcile with source events.
- Evidence: 3 screenshots + one API reconciliation sample per range.

## 10. Billing and Crypto Payment Pass
### 10.1 Tenant Payment UX
- Generate quote for SOL and USDC (monthly and yearly where available).
- Submit tx signature only after quote generation.
- Pass criteria: quote lock window and amount display are correct.

### 10.2 On-chain Validation + Plan Update
- Validate tx signature checks (amount, token, destination, timeframe).
- Validate automatic plan update on successful verification (or explicit manual fallback path).
- Pass criteria: no false positive approval; failed verifications explain why.

### 10.3 Superadmin Billing Controls
- Validate receiving wallet settings in Superadmin.
- Validate queue triage and status changes are audited.
- Pass criteria: all payment actions traceable in audit history.

## 11. Failure and Resilience Pass
- Force API failures on module save actions.
- Force missing Discord permissions for representative modules.
- Force stale tenant selection / missing tenant.
- Pass criteria: scoped error states, no full-panel collapse, recovery path available.

## 12. Evidence Template (Per Module)
- Module:
- Environment: `staging-clean` / `staging-loaded`
- Tester:
- Date:
- Test Cases Executed:
- Result: `PASS` / `FAIL`
- Bugs Logged (IDs):
- Screenshots/Logs:
- Notes:

## 13. Go/No-Go Decision Gates
Release is `GO` only when all are true:
1. `npm test` and release gate pass.
2. Every module has `PASS` in both staging environments.
3. No `P0` or `P1` open bugs.
4. Superadmin billing and tenant billing flows pass end-to-end.
5. Vault module signoff completed by product + ops.

If any gate fails: `NO-GO`, fix, redeploy, and rerun affected sections + final regression.

## 14. Final Signoff Block
- Product Owner: __________________ Date: __________
- Engineering Lead: _______________ Date: __________
- Operations Lead: _________________ Date: __________
- QA Owner: _______________________ Date: __________

Decision: `GO` / `NO-GO`
