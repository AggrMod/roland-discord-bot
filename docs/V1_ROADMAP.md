# Reconciled GuildPilot V1 Launch Roadmap

This roadmap bridges live codebase verification with external audit recommendations into one source of truth for the **V1 Production Release**.

---

## 1. Launch Blockers Status (Pre-Flight Checks)

| Blocker Identified | Status | Actions Taken / Reconciliations |
| :--- | :---: | :--- |
| **Vault Parity Drift** (Failing Release Gate) | **FIXED** | `/vault` subcommands were synchronized across `docs/ADMIN_HELP.md`, `admin-help.html`, and `portal.html`. Release gate checks are green. |
| **No Unified Test Script** (`npm test` missing) | **FIXED** | Added `"test": "node scripts/release-gate.js"` to `package.json` for local and CI runs. |
| **Missions/Heist rollout state** (Disabled by default) | **FIXED (PUBLIC BETA)** | `heistService` remains tenant-controlled, but baseline module defaults are now enabled for Public Beta rollout in V1. |
| **Stale Public API Docs** (`API_PUBLIC_V1.md`) | **VERIFIED** | Public routes in `web/routes/v1.js` match the documented payload shapes. |

---

## 2. Missing Core Modules for V1

To ensure GuildPilot can fully replace competitor stacks out-of-the-box, these modules are recommended for V1.

### A. Welcome & Onboarding Configurator
- **Goal**: Provide a clean first-impression experience for new server joins.
- **V1 Features**:
  - Customizable welcome channel, text, and embed templates via Web Portal.
  - Auto-assign default roles on join.
  - CAPTCHA gate against automated raid accounts.

#### Progress Update (2026-05-20)
- **Status**: **CORE IMPLEMENTED**
- **Completed in production code**:
  - Welcome module is tenant-scoped with isolated `guildMemberAdd` handling.
  - Tenant settings CRUD and admin API endpoints implemented.
  - Portal routing/gating stabilized for Welcome module.
  - Channel/role dropdown selectors added.
  - Dynamic template parsing with `{channel:slug}` -> clickable `<#id>` resolution.
  - Test welcome endpoint with explicit delivery errors.
  - Embed color normalization fixed (hex -> Discord integer).
  - DB-backed uploaded image assets and selection pipeline.
  - Upload hardening: larger body limit, resilient non-JSON handling, auto-compress client upload flow.
  - Preset-driven builder added.
  - Plan-based gates for branding fields and advanced image behavior.
  - CAPTCHA verification endpoint and role grant wiring added.
  - CAPTCHA verification web flow separated from wallet verification flow.
  - Turnstile reliability fixes (load timing + required headers).
  - One-click `Restore Default` welcome preset added.
  - Configurable CAPTCHA delivery mode:
    - Direct Message
    - Verification Panel in Channel
  - Configurable role removal on CAPTCHA success.
  - In-channel verification panel posting added.
  - Split channels:
    - `Welcome channel` for post-verify welcome announcements.
    - `Verification channel` for CAPTCHA onboarding flow.
  - Panel-first mode: welcome announcement deferred until CAPTCHA success.
- **Open polish items before V1 freeze**:
  - Upload progress indicator + file type/size helper text.
  - E2E welcome smoke test (`save -> test -> join simulation -> captcha pass role grant`).
  - Onboarding analytics counters (joins, sent, failed, DM delivered, CAPTCHA passed).
  - Optional temporary onboarding-role quick-setting shortcut.

### B. Lite Moderation & Anti-Raid Essentials
- **Goal**: Keep servers secure without needing secondary moderation bots.
- **V1 Features**:
  - `/kick`, `/ban`, `/timeout`, `/purge`
  - Join throttling for raid spikes
  - Basic keyword auto-censor filter
- **Status (2026-05-20)**: **IMPLEMENTED**
  - Delivered as `/moderation` namespace with:
    - `/moderation kick|ban|timeout|purge`
    - `/moderation settings-view|settings-raid|settings-keywords|keyword-add|keyword-remove|keyword-list`
  - Join-throttle anti-raid action pipeline is active on `GuildMemberAdd`.
  - Keyword filter auto-delete/warn pipeline is active on `MessageCreate`.

### C. Web Portal Audit Log UI
- **Goal**: Let admins view who changed what.
- **V1 Features**:
  - Backend already writes to `tenant_audit_logs` via `tenantService.js`.
  - Portal needs a dedicated "Audit Log" tile with chronological change feed.
- **Status (2026-05-20)**: **IMPLEMENTED**
  - Admin activity view now reads from live tenant audit logs via `/api/admin/activity`.
  - Superadmin workspace telemetry endpoint added for load/save failure observability.

---

## 3. Module-by-Module Refinement Recommendations

### Identity & Verification
- Cold wallet delegation revoked from V1 after security review; only directly linked wallets may grant access.

### Governance / Voting
- Add token-weighted presets and schedule reminder command support.

### Trackers (NFT / Token / Wallet)
- Harden public webhook ingest payload size/validation in `v1.js`.
- Add USD-value whale threshold support using public price feeds.

### Invite Tracker
- Add account-age heuristics (for example ignore invites from accounts newer than 48 hours).

### AI Assistant
- Ensure graceful fallback behavior when provider keys are invalid or rate-limited.

### Support Tickets
- Add AI-suggested replies using the assistant knowledge base.

### Engagement Hub / Minigames
- Add public web leaderboard and daily claim command (`/daily`).

### Self-Serve Roles
- Move from button-matrix configs to Discord select-menu based configs.

---

## Next Steps
1. Welcome hardening: E2E smoke test + analytics counters + upload UX polish.
2. Vault must-launch focus: final readiness pass for permissions, edge cases, and operations.
3. Missions/Heist Public Beta monitor: review adoption, error rates, and operator feedback after launch week.

### Vault Readiness Update (2026-05-20)
- Vault key-tier behavior test (`tests/test-vault-key-tiers.js`) is now enforced in the release gate (`scripts/release-gate.js`).
- This promotes Vault key distribution logic to a required V1 pre-release check instead of optional local validation.
