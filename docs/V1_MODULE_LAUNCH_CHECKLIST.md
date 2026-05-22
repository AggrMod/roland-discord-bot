# V1 Module Launch Checklist

Last updated: 2026-05-22

Legend:
- `READY` = implementation appears complete and covered by existing tests/smokes.
- `HARDEN` = mostly complete but still needs focused launch QA and edge-case checks.
- `FINISH` = notable gaps still need implementation/validation before V1 signoff.

## 1) Welcome & Onboarding
Status: `HARDEN`

Implemented:
- Tenant-scoped settings, presets, test send, captcha panel posting, asset upload, analytics endpoints.
- Admin/server-context guards in load/save/actions.

Before signoff:
- End-to-end QA for both captcha prompt modes (`dm`, `panel`) with role add/remove flow.
- Validate upload behavior on slow networks and very large image optimization fallback.
- Verify analytics counters after real join bursts.

## 2) Identity & Verification
Status: `HARDEN`

Implemented:
- Verification settings UI + save.
- Role tier/trait/token rules + sync controls and sync status.
- Wallet verification API and challenge/signature flow.

Before signoff:
- High-volume role-sync soak test on production-like guild.
- Rule limit UX validation per plan with clear errors.
- Verify token rule edge cases (`maxAmount`, `neverRemove`) with regression script.

## 3) Governance & Voting
Status: `HARDEN`

Implemented:
- VP mappings admin API/UI.
- Proposal lifecycle operations and public proposal APIs.
- Governance settings save flow guarded by active server context.

Before signoff:
- End-to-end proposal lifecycle script (support -> vote -> conclude) under plan limits.
- Verify channel override behavior and message posting consistency.
- Decide if poll system is V1 scope or explicitly deferred.

## 4) Wallet Tracker
Status: `HARDEN`

Implemented:
- Wallet management, balances, panel posting, tracker config routes.
- Tenant-scoped dashboard wallet analytics fixed.

Before signoff:
- Verify wallet add/edit/remove race handling during polling.
- Validate table/panel rendering for large wallet sets.

## 5) NFT Activity Tracker
Status: `HARDEN`

Implemented:
- Tracked collections CRUD, activity config, events endpoint, webhook ingestion.

Before signoff:
- Webhook replay/duplication stress test.
- Alert delivery verification for multiple collections and edge metadata payloads.

## 6) Token Tracker
Status: `HARDEN`

Implemented:
- Token tracker CRUD + event feeds.
- Dashboard analytics include active rule counts.

Before signoff:
- Validate token event ingestion and role-gating update latency.
- Confirm plan-limit messaging and block behavior in UI.

## 7) Invite Tracker
Status: `HARDEN`

Implemented:
- Summary/settings/events/leaderboard/export/panel endpoints + portal config.

Before signoff:
- Invite attribution correctness QA (joins, leaves, edge reconnects).
- CSV export sanity checks on large datasets.

## 8) AI Assistant
Status: `HARDEN`

Implemented:
- Settings, usage, policies, knowledge, personas, role limits, ingestion jobs, suggestions.
- Release-gate smoke test exists.

Before signoff:
- Plan-gating verification (Pro lock) in both command and UI paths.
- Usage/token budget UX validation for daily reset boundaries.

## 9) Support Tickets
Status: `HARDEN`

Implemented:
- Categories, ticket list, transcript, panel, settings, archive/open tabs.
- Tenant safety test exists.

Before signoff:
- Full transcript retrieval QA for large threads.
- Category permission drift checks after role changes.

## 10) Engagement Hub
Status: `FINISH`

Implemented:
- Config, providers, sync, leaderboard, shop, monitored accounts, hashtags, tasks, achievements, redemptions.

Before signoff:
- Consolidate duplicated portal section loaders (currently multiple repeated load/save blocks).
- Verify X-provider plan gating UX across all relevant actions.
- Add focused regression tests for provider-linked actions.

## 11) Minigames
Status: `HARDEN`

Implemented:
- Command suite and battle settings/admin surfaces.

Before signoff:
- Permission matrix QA (moderator/admin use as intended).
- Load test concurrent sessions for the most-used games.

## 12) Missions
Status: `HARDEN`

Implemented:
- Heist config/categories/collections/templates/missions/resolve/cancel/spawn.
- Release-gate missions flow test exists.

Before signoff:
- Production-like scenario tests for template spawn + resolve consistency.
- Verify trait-bonus + category gate interactions under limits.

## 13) Vault (Must Launch)
Status: `HARDEN` (close to `READY`)

Implemented:
- Full admin config/seasons/rewards/milestones/backfill/claims/audit/health.
- Vault key-tier release-gate test exists.

Before signoff:
- Final operations runbook validation (claim handling and bulk backfill safeguards).
- Mint webhook + manual grant reconciliation check.

## 14) Self-Serve Roles
Status: `HARDEN`

Implemented:
- Role panels CRUD/posting and role claim config + panel posting route.

Before signoff:
- Verify interaction permissions and stale panel reconciliation.
- Cross-check limits and panel max-size behavior.

## 15) Superadmin Workspace Hub
Status: `HARDEN`

Implemented:
- Workspace tabs, split tenant/billing model, role separation, billing workflows.
- Recent hardening: server-context guards + superadmin action guards.

Before signoff:
- Final UX pass for overflow/responsiveness in dense tenant/billing states.
- Full action audit for destructive ops + confirmation coverage.
- Validate telemetry for workspace load/save failure markers.

## Cross-Module V1 Signoff Gates (must pass)
1. All release-gate tests green (`npm test`).
2. Module dashboard analytics show real tenant-scoped values (no placeholders).
3. Plan entitlements verified in UI + API for Free/Growth/Pro/Enterprise.
4. All admin mutations require explicit role + active tenant context where applicable.
5. End-to-end smoke pass per module on a clean tenant and a high-data tenant.

## Competitive Parity Blockers (Critical)
These are high-priority launch items for parity with established Web3 community tooling.

### 1) Identity / Verification: Cold Wallet Delegation
Priority: `P0`  
Status: `READY`

Why:
- High-value holders should be able to prove ownership without linking vault wallets directly to Discord identity.

V1 acceptance:
1. Delegate-wallet flow exists in portal and API.
2. Verification rules can optionally evaluate delegated wallets (with explicit toggle).
3. Audit trail logs delegation create/revoke events.
4. Role sync correctly removes access when delegation is revoked or expires.

Progress update (2026-05-22):
- Added `wallet_delegations` schema + migration (`v18_wallet_delegation_support`).
- Verification wallet resolver now includes active delegated cold wallets in tenant scope.
- Added authenticated delegation endpoints:
  - `GET /api/wallets/:discordId/delegations`
  - `POST /api/wallets/:discordId/delegations`
  - `DELETE /api/wallets/:discordId/delegations/:coldWalletAddress`
- Added release-gate test: `tests/test-wallet-delegation.js`.
- Added portal delegation UX in profile/wallet sections (add + revoke + visibility).
- Added delegation audit writes into `superadmin_identity_audit_logs`.
- Added automatic delegation revocation when delegate wallet is removed.

### 2) Vault: X (Twitter) Social Task Gates
Priority: `P0`  
Status: `NOT STARTED`

Why:
- Vault reward unlocks should support social-growth actions (follow/like/repost) to match baseline community growth tooling.

V1 acceptance:
1. Vault rewards can attach optional X task requirements.
2. Task completion is validated and cached with retry-safe checks.
3. Admin UI supports creating/editing/removing social-gated requirements.
4. Redemption flow blocks until requirements are complete and shows clear reasons.

### 3) Engagement + Minigames: Unified Economy + Daily Streak
Priority: `P0`  
Status: `READY`

Why:
- Engagement loop is weaker if game wins do not consistently feed points/rewards and daily habit triggers are missing.

V1 acceptance:
1. Minigame win events write into engagement points ledger.
2. Configurable per-game rewards (base + multiplier/bonus rules).
3. `/daily` (or equivalent) streak command with anti-abuse cooldown and streak state.
4. Streak and game rewards appear in engagement history and leaderboards.

Progress update (2026-05-22):
- Added `engagement_daily_streaks` table + migration (`019_engagement_daily_streaks`).
- Added `/points daily` reward claim flow with 24h cooldown, streak progression, and best-streak tracking.
- Added `daily_streak` ledger action writes via engagement service.
- Wired minigame reward payouts into engagement ledger for:
  - `trivia`, `slots`, `rps`, `blackjack`, `numberguess`, `wordscramble`, `higherlower`, `reactionrace`, `diceduel`
  - `gamenight` (top placements at session end)
- Added tenant-configurable reward knobs in engagement config:
  - `daily_reward_points`, `daily_streak_bonus`, `daily_streak_cap`
  - `minigame_reward_first`, `minigame_reward_second`, `minigame_reward_third`
- Added release-gate test: `tests/test-engagement-streak-and-minigame-rewards.js`.
