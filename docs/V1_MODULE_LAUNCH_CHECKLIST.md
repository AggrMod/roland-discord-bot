# V1 Module Launch Checklist

Last updated: 2026-05-22

Signoff companion:
- Use `docs/V1_RELEASE_SIGNOFF_STAGING.md` as the mandatory final release gate runbook (execution order, pass/fail criteria, and evidence capture).

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
- End-to-end QA for both captcha prompt modes (`dm`, `panel`) with role add/remove flow (automated smoke now covers both prompt paths and verifies deferred-vs-immediate welcome delivery behavior).
- Validate upload behavior on slow networks and very large image optimization fallback (automated guard coverage now verifies oversize image rejection + MIME-type validation).
- Verify analytics counters after real join bursts (automated burst-counter regression now covers high-volume join/welcome/captcha event aggregation in `tests/test-welcome-analytics-bursts.js`).

## 2) Identity & Verification
Status: `HARDEN`

Implemented:
- Verification settings UI + save.
- Role tier/trait/token rules + sync controls and sync status.
- Wallet verification API and challenge/signature flow.

Before signoff:
- High-volume role-sync soak test on production-like guild (automated high-wallet-volume sync regression now exists in `tests/test-verification-high-volume-sync.js` to guard scale-path stability).
- Rule limit UX validation per plan with clear errors (automated verification token-rule limit regression now asserts `limit_exceeded` + user-facing limit message via `tests/test-verification-plan-limits.js`).
- Run staging smoke for token-rule edge behavior (`maxAmount`, `neverRemove`) against live guild roles.
- Validate delegated-wallet evaluation toggle behavior (`includeDelegatedWallets`) in live role-sync runs (automated regression now covers include vs direct-only wallet resolution paths).

## 3) Governance & Voting
Status: `HARDEN`

Implemented:
- VP mappings admin API/UI.
- Proposal lifecycle operations and public proposal APIs.
- Governance settings save flow guarded by active server context.

Before signoff:
- Run staging validation for proposal lifecycle under real plan limits and channels (automated lifecycle + plan-limit enforcement regressions now exist).
- Verify channel override behavior and message posting consistency (automated proposal-channel override regression exists).
- Poll system is explicitly deferred to V2 (governance lifecycle + proposal operations remain V1 scope).

## 4) Wallet Tracker
Status: `HARDEN`

Implemented:
- Wallet management, balances, panel posting, tracker config routes.
- Tenant-scoped dashboard wallet analytics fixed.

Before signoff:
- Run staging smoke for live RPC/webhook polling while admins mutate wallet rows (automated race + scale regression exists).
- Validate channel panel refresh behavior with live Discord permissions/channel changes (automated permission-drift regression now asserts structured forbidden response instead of route-level 500 when channel posting permissions are missing).

## 5) NFT Activity Tracker
Status: `HARDEN`

Implemented:
- Tracked collections CRUD, activity config, events endpoint, webhook ingestion.

Before signoff:
- Run staging smoke for live webhook throughput bursts (automated replay/duplication + multi-collection edge alert + high-volume burst regression now exist: `tests/test-nft-webhook-throughput-burst.js`).
- Validate Discord delivery reliability on restricted/missing permissions channels (automated permission-fallback regression now ensures one blocked channel does not block other eligible alert targets: `tests/test-nft-alert-permission-fallback.js`).

## 6) Token Tracker
Status: `HARDEN`

Implemented:
- Token tracker CRUD + event feeds.
- Dashboard analytics include active rule counts.

Before signoff:
- Run staging smoke for live webhook + RPC ingestion latency under active wallet churn (automated webhook batch aggregation regression exists).
- Confirm plan-limit messaging and block behavior in UI (backend now enforces token cap with `limit_exceeded`; API returns `403` for limit blocks and regression coverage exists in `tests/test-token-tracker-plan-limits.js`).

## 7) Invite Tracker
Status: `HARDEN`

Implemented:
- Summary/settings/events/leaderboard/export/panel endpoints + portal config.
- Anti-cheat invite heuristics (joiner account-age + inviter burst-rate filters).

Before signoff:
- Run staging QA for real Discord reconnect/leave attribution drift under invite churn (automated attribution + duplicate join guard regression exists).
- Validate CSV export behavior on production-like datasets (automated large-export regression exists).

## 8) AI Assistant
Status: `HARDEN`

Implemented:
- Settings, usage, policies, knowledge, personas, role limits, ingestion jobs, suggestions.
- Release-gate smoke test exists.

Before signoff:
- Run staging sanity pass for command + portal behavior with real Free vs Pro tenants (automated module/plan gating regression exists).
- Validate UX copy for daily reset messaging and token-budget exhaustion (automated daily-boundary limit regression exists).

## 9) Support Tickets
Status: `HARDEN`

Implemented:
- Categories, ticket list, transcript, panel, settings, archive/open tabs.
- Tenant safety test exists.

Before signoff:
- Run staging transcript retrieval sanity on very long active tickets (automated large-thread transcript pagination regression exists).
- Validate live Discord channel overwrite behavior after category role changes (automated handler-permission drift resolution regression exists).

## 10) Engagement Hub
Status: `HARDEN`

Implemented:
- Config, providers, sync, leaderboard, shop, monitored accounts, hashtags, tasks, achievements, redemptions.

Before signoff:
- Run a manual tenant-admin vs member-role UX pass across the Engagement tab sections.
- Verify X-provider plan gating UX across all relevant actions (automated gating regression now covers tasks, account linking, monitored accounts, hashtag monitors, and provider ingest).
- Soak-test provider task verification (X follow/like/repost/reply) with real linked accounts in staging (automated verification regression now covers all required action types, duplicate guard behavior, and reward accrual path).

## 11) Minigames
Status: `HARDEN`

Implemented:
- Command suite and battle settings/admin surfaces.

Before signoff:
- Permission matrix QA (moderator/admin use as intended; automated moderator/admin command-gating regression exists).
- Concurrent-session replacement safety now has automated coverage: creating a new Game Night in the same channel clears prior gather timers and avoids stale-session leaks (`tests/test-minigames-session-replace-safety.js`).
- Base concurrent lifecycle load coverage now exists for high session counts (create/add/remove/end across 200 parallel channels) in `tests/test-minigames-concurrent-session-scale.js`.
- Run staging/live Discord soak for most-used games to validate collector behavior under real event pressure.

## 12) Missions
Status: `HARDEN`

Implemented:
- Heist config/categories/collections/templates/missions/resolve/cancel/spawn.
- Release-gate missions flow test exists.

Before signoff:
- Production-like scenario tests for template spawn + resolve consistency (automated spawn/resolve mission flow regression exists).
- Verify trait-bonus + category gate interactions under limits (automated trait gate mode + trait bonus payout regression exists).

## 13) Vault (Must Launch)
Status: `HARDEN` (close to `READY`)

Implemented:
- Full admin config/seasons/rewards/milestones/backfill/claims/audit/health.
- Vault key-tier release-gate test exists.

Before signoff:
- Final operations runbook validation (claim handling and bulk backfill safeguards).
- Mint webhook + manual grant reconciliation check (automated mint-event duplicate/upgrade reconciliation regression exists).
- Bulk backfill operation guardrails now enforce bounded options and explicit live-run confirmation (`confirmation=RUN_BACKFILL` when `dryRun=false`), with regression coverage in `tests/test-vault-backfill-ops-guardrails.js`.

## 14) Self-Serve Roles
Status: `HARDEN`

Implemented:
- Role panels CRUD/posting and role claim config + panel posting route.

Before signoff:
- Verify interaction permissions and stale panel reconciliation (automated interaction permission regression now covers non-claimable role rejection, ManageRoles gating, role hierarchy gating, and add/remove success path via `tests/test-role-claim-interaction-permissions.js`; stale message reconciliation regression already exists).
- Cross-check limits and panel max-size behavior (automated posting guard now blocks >25 enabled role buttons with explicit error).
- Validate stale panel message recovery when source message is deleted (automated repost reconciliation regression now covers stale message fallback + persisted message ID update).

## 15) Superadmin Workspace Hub
Status: `HARDEN`

Implemented:
- Workspace tabs, split tenant/billing model, role separation, billing workflows.
- Recent hardening: server-context guards + superadmin action guards.

Before signoff:
- Final UX pass for overflow/responsiveness in dense tenant/billing states.
- Full action audit for destructive ops + confirmation coverage.
- Validate telemetry for workspace load/save failure markers (automated route regression now asserts telemetry validation + acceptance path via `tests/test-superadmin-workspace-telemetry.js`).

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
Status: `HARDEN`

Why:
- Vault reward unlocks should support social-growth actions (follow/like/repost) to match baseline community growth tooling.

V1 acceptance:
1. Vault rewards can attach optional X task requirements.
2. Task completion is validated and cached with retry-safe checks.
3. Admin UI supports creating/editing/removing social-gated requirements.
4. Redemption flow blocks until requirements are complete and shows clear reasons.

Progress update (2026-05-22):
- Added social requirement parsing for vault reward payloads (`social_requirements` array and legacy `x_task_gate` object support).
- Added verification cache table + migration: `021_vault_social_requirement_checks`.
- Added user command flow:
  - `/vault claims` to list pending claims
  - `/vault verify-social reward_id:<id>` to validate X requirements
- Added claim-finalization gate:
  - Admin claim status update to `claimed`/`fulfilled` is blocked until social requirements are verified.
  - Error payload includes clear pending requirement details.
- Added release-gate regression test: `tests/test-vault-social-gates.js`.
- Added Vault reward modal social requirement editor (add/remove X requirements) and synced it with reward payload JSON, so social gates can be configured without manual JSON editing.

Before signoff:
- Run live X verification smoke on a staging guild with a linked X account.

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






