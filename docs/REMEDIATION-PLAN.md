# GuildPilot — Vulnerability Remediation Runbook (Anti-Brick Edition)

**Companion to:** `LAUNCH-READINESS-AUDIT-2026-06-23.md`
**Goal:** Close the launch blockers **without breaking the running bot.**
**Date:** 2026-06-23

---

## 0. Guiding principles — how we avoid bricking it

These rules apply to **every** change below. If a fix can't follow these, it doesn't ship.

1. **Default-to-old-behavior feature flags.** Every risky change is gated by an env var that, when unset, behaves *exactly* like today. Prod can flip a fix on/off **without a redeploy or code rollback** (PM2 reads env on restart). Flags use a 3-state rollout: `off` → `monitor` (log what *would* happen, change nothing) → `enforce`.
2. **Additive migrations only.** Never drop/rename a column or table. Add new columns with safe defaults, **backfill**, dual-read (new value if present, else old), and only retire the old path in a later, separate release. The repo already uses numbered migrations in `database/migrations/` tracked in `schema_migrations` — follow that pattern.
3. **One blocker = one small PR.** No big-bang. Each PR is independently reviewable, testable, deployable, and revertable. A bad fix reverts in seconds without touching the others.
4. **Monitor before enforce.** Anything in the auth/login/CSRF path ships in `monitor` mode first. We watch logs/metrics until we're certain ~100% of legitimate traffic would pass, *then* flip to `enforce`.
5. **Staging first, always.** Reproduce prod config on staging, run the full login + verify + admin smoke flow, *then* prod. Never test these on prod.
6. **Backup + verified restore before any migration.** Use `scripts/backup_db.sh`; confirm `scripts/restore_db.sh` actually restores a copy. The bot also auto-backs-up hourly (`DB_BACKUP_ENABLED`), but take a manual, labeled snapshot per release.
7. **CI gate is real.** Before touching code, make the release gate deterministic (it's currently flaky) and require it green on every PR. This is our single biggest anti-brick investment — it's the seatbelt for everything after.
8. **Instant rollback runbook.** Each deploy has a known-good prior PM2 release/commit. Rollback = `git revert <pr>` + restart, or flip the feature flag to `off`. Document the exact command per fix.

---

## Phase 0 — Safety net (do this FIRST, ship nothing risky yet)

| Step | Action | Why |
|---|---|---|
| 0.1 | Stand up / verify a **staging** environment mirroring prod env vars + a copy of the prod DB. | Nothing below is tested on prod. |
| 0.2 | **Make the release gate deterministic.** Fix test isolation (per-file temp DB or reset between steps) so `governance-proposal-lifecycle` etc. don't fail on shared state. | A flaky gate can't protect you; it also masks real regressions. |
| 0.3 | Add a **CI workflow** (lint + `npm audit` + release-gate) required on every PR to the feature branch and `main`. | Every fix below is then automatically gated. |
| 0.4 | Take a **manual labeled DB backup** and **test a restore** into a throwaway path. | Pre-migration insurance. |
| 0.5 | Write the **1-page rollback runbook** (PM2 restart, prior commit hash, flag kill-switches). | So a 2am rollback is muscle memory, not improvisation. |

> Phase 0 changes **no product behavior**. It only adds determinism, CI, and backups. Zero brick risk.

---

## Phase 1 — Additive, near-zero-risk fixes (build confidence)

These don't change behavior under *normal* operation; they only activate on misconfig/abuse. Ship them first.

### Fix A — `tokenService` production MOCK guard (audit H-3)
- **Files:** `services/tokenService.js` (lines ~7, ~49).
- **Change:** Mirror `nftService`'s guard. At construction, if `NODE_ENV==='production' && MOCK_MODE && !ALLOW_MOCK_IN_PROD` → throw (or hard-disable mock output). In `getWalletTokenBalances`, suppress mock and return `[]`/degraded in production unless `ALLOW_MOCK_IN_PROD` is set.
- **Brick risk:** **Very low.** Only changes behavior when `MOCK_MODE`/tenant mock is on — which must never be on in prod anyway.
- **Safety:** Gate the escape hatch with `ALLOW_MOCK_IN_PROD` (same flag nftService uses) so a deliberate staging-in-prod test is still possible.
- **Test:** Unit test: prod + mock → throws/empty; prod + `ALLOW_MOCK_IN_PROD` → mock allowed; non-prod → mock allowed.
- **Rollback:** Revert the PR; behavior returns to current.

### Fix B — Webhook hardening: rate limit + replay protection (audit M-2, M-4)
- **Files:** `web/server.js` (limiter mounts), `web/routes/activityWebhooks.js`, `web/routes/vaultWebhooks.js`.
- **Change:** (1) Mount a dedicated rate limiter on `/api/webhooks/*`. (2) Add an idempotency/replay check (timestamp window + dedupe key) like billing already has; vault already dedupes on `tx_signature`, so this mainly adds a short replay window + caps array length per request.
- **Brick risk:** **Low.** Legit providers send within limits; pick generous thresholds and a wide replay window initially, tighten later.
- **Safety:** Make limits env-tunable (`WEBHOOK_RATE_MAX`, `WEBHOOK_REPLAY_WINDOW_SEC`); set generously at first.
- **Test:** Replay same payload → second is no-op; flood → 429 after threshold; normal batch → unaffected.
- **Rollback:** Revert; or raise limits to effectively-unlimited via env.

### Fix C — PII logging masks + user-route rate limits (audit L-1, M-7)
- **Files:** identity routes/services that log full wallet+sig; `web/server.js` for `/api/user/*` limiter.
- **Change:** Reuse `treasuryService.maskAddress` for wallet/sig in info logs; add a per-user limiter to mutating `/api/user/*` routes.
- **Brick risk:** **Very low.** Logging cosmetic; user-limiter thresholds set generous.
- **Test:** Logs show masked values; rapid redeem/toggle eventually 429s; normal usage fine.

---

## Phase 2 — Tenant isolation & entitlements (additive migrations + dry-run)

### Fix D — Enforce module **identity** against plan (audit M-1)
- **File:** `services/tenantService.js` → `setTenantModule` (~632).
- **Change:** When enabling a module, reject if `getPlanPreset(plan).modules[key] !== true` **unless** a superadmin override/entitlement exists.
- **Brick risk:** **Medium** — the trap is **grandfathered tenants**: a server that *already* has a now-disallowed module enabled must not break.
- **Safety (critical):**
  - Only check on the **enable transition**; never disturb already-enabled rows.
  - Honor existing **superadmin override** and `tenant_limits`/entitlement overrides — superadmins can still force-enable.
  - Ship in **`monitor` mode first** (`MODULE_IDENTITY_ENFORCE=monitor`): log "would block tenant X enabling Y" for a week. Review the logs. If no legitimate tenant is affected, flip to `enforce`.
- **Test:** Free tenant enabling `aiassistant` → blocked (enforce) / logged (monitor); superadmin override → allowed; already-enabled module stays enabled.
- **Rollback:** Flag → `off`.

### Fix E — Treasury config **per-tenant** (audit H-1)
- **Files:** migration in `database/migrations/`, `services/treasuryService.js`, `web/routes/adminTrackers.js` (~114, ~128).
- **The danger:** `treasury_config` is one global row (`CHECK(id=1)`). A naive change can wipe the **currently-live** server's treasury monitoring.
- **Change (phased, additive):**
  1. **Migration:** add `guild_id` column (nullable). Create the new per-guild row by **backfilling the existing global row to `GUILD_ID`** (the current primary guild). Add a unique index on `guild_id`. **Do not** drop the old row or the `id=1` row yet.
  2. **Dual-read:** `getConfig(guildId)` returns the per-guild row if present, **else falls back to the legacy global row** (so nothing breaks during transition).
  3. **Write path:** thread `req.guildId` through `getAdminSummary`/`updateConfig`; writes go to the per-guild row.
  4. Later release: once all active tenants have per-guild rows, retire the global fallback.
- **Brick risk:** **Medium** — fully mitigated by backfill + dual-read. The live guild keeps its exact config.
- **Safety:** Backup first (Phase 0.4). Run migration on staging-with-prod-copy and confirm the existing treasury still reports the same balances/alerts.
- **Test:** Existing guild's treasury unchanged post-migration; Guild A edits no longer affect Guild B.
- **Rollback:** Migration is additive (column + row), so reverting code falls back to reading the global row; no data lost.

### Fix F — Vault webhook per-tenant secret + guild binding (audit H-2)
- **File:** `web/routes/vaultWebhooks.js` (+ provisioning of per-tenant secrets).
- **The danger:** Switching to per-tenant secrets can instantly **stop vault mints** if the live Helius webhook still sends the global secret.
- **Change (phased):**
  1. First ship **replay + rate limit** (covered in Fix B) — pure hardening, no auth change.
  2. Add **optional per-tenant secret**: if a per-guild secret is configured, require it **and** that `event.guildId` matches that secret's guild. If not configured, **keep the existing global-secret path working** (back-compat).
  3. Add `VAULT_WEBHOOK_ENFORCE_GUILD_MATCH=monitor|enforce`: in `monitor`, log mismatches but still process; flip to `enforce` once per-tenant secrets are provisioned for active vault tenants.
  4. Stop the silent secret **fallback chain** (`VAULT → TOKEN → NFT secret`) — require an explicit vault secret, but only after confirming it's set in prod env.
- **Brick risk:** **Medium** — mitigated by keeping the global path until per-tenant keys exist, and monitor-mode for the guild-match enforcement.
- **Test:** Forged `guildId` with global secret → blocked in enforce, logged in monitor; legit per-tenant event → processed; existing global integration → still works until cutover.
- **Rollback:** Flag → `off`/`monitor`.

---

## Phase 3 — Auth hardening (HIGHEST brick risk — monitor-mode mandatory)

> These touch the login/session/CSRF path that **every** request uses. Do them **last**, one at a time, each fully baked on staging, each in monitor-before-enforce mode. This is where bricking actually happens, so it gets the most caution.

### Fix G — Session regeneration on login (audit H-5)
- **Files:** `web/routes/authUser.js` (Discord + X callbacks).
- **Change:** Call `req.session.regenerate()` **then** set `discordUser` inside the callback, copying `returnTo` across; handle the regenerate error path.
- **Brick risk:** **Medium** — the trap is dropping the just-set user (race) and logging people out. Done correctly it only affects **new logins** (existing sessions untouched).
- **Safety:** Implement exactly as regenerate→set→save chained in callbacks; smoke-test full login on staging (incl. the X-link flow) before prod.
- **Test:** Login round-trip works; pre-login session id ≠ post-login id; `returnTo` still honored; existing sessions remain valid.
- **Rollback:** Revert the PR (no schema change).

### Fix H — Bind verification challenge to wallet + Discord ID (audit H-4)
- **Files:** `web/routes/userWalletVerification.js` (`/api/verify/challenge`, `/api/verify/signature`), portal frontend signing UI (`web/public/portal.js`).
- **Key insight (low-risk path):** The server already **stores the exact challenge message** and verifies the submitted signature against that stored string. The frontend signs **whatever message the server returns**. So changing the message *content* is transparent to the client — **as long as the client signs the server-provided message verbatim** (verify this in `portal.js` first).
- **Change:**
  1. Have the client send the `walletAddress` to `/api/verify/challenge` (small frontend change).
  2. Server builds the stored message to include canonical wallet address + Discord ID + nonce + issued-at, e.g. `...\nDiscord ID: <id>\nWallet: <addr>\nNonce: <n>\nIssued: <ts>`.
  3. Verify against the stored message (already happens).
  4. **Transition safety:** for a short window, if the client still hits `/challenge` without a wallet, fall back to the old message format so in-flight/old clients don't break; remove the fallback after the frontend is deployed.
  5. Make the nonce **strictly one-time** (consume on first verify attempt regardless of outcome — fixes M-5 too).
- **Brick risk:** **Low–Medium** if the frontend signs the server message as-is; the only required client change is sending the wallet to `/challenge`.
- **Test:** New verify flow links the correct wallet; replaying a nonce fails; old-format fallback works during transition; cross-user signature reuse fails.
- **Rollback:** Revert; keep old-format acceptance until frontend reverts too.

### Fix I — Stop trusting `X-Forwarded-Host`; don't put bearer tokens in URLs (audit C-2, H-6)
- **Files:** `web/server.js` (`getRequestOrigin`, `resolveOAuthRedirectUri`), `web/routes/authUser.js` (public callback, return-origin allowlist).
- **The danger:** OAuth `redirect_uri` must match the Discord-registered URI **exactly** — get this wrong and **login breaks for everyone.**
- **Change (phased):**
  1. **Origin from config, not headers:** compute origin from `WEB_URL`/a new `PUBLIC_WEB_BASE_URL` + `WEB_URL_ALIASES` (these env vars already exist), with the request-header path kept **only as a fallback when env is unset**. Since prod already sets `WEB_URL`, behavior is unchanged but no longer header-spoofable.
  2. **Static return-origin allowlist:** build the allowed-return-origin set from configured origins only; remove the `getRequestOrigin`-derived entry.
  3. **Token delivery:** stop putting the bearer token in the redirect fragment. Deliver via JSON body or `postMessage` to a known origin. This needs frontend cooperation → **phase it separately and last**; shorten token TTL as an interim mitigation.
- **Brick risk:** **Medium–High** — entirely about the OAuth redirect URI. Mitigated by using already-set `WEB_URL` (no behavior change) and testing the **full real Discord login round-trip on staging** against the actual Discord app's registered redirect URIs before prod.
- **Test:** Login works end-to-end on staging with spoofed `X-Forwarded-Host` (now ignored); allowlist no longer accepts attacker origin; token no longer appears in URL.
- **Rollback:** Revert; `WEB_URL` fallback preserves login.

### Fix J — Real CSRF tokens (audit C-1) — **the one most likely to brick the portal**
- **Files:** `web/server.js` (wire `csrf-csrf`, real `/api/csrf-token`), `web/public/portal.js` (fetch + attach token), keep webhook exemptions.
- **The danger:** If you require CSRF tokens before the frontend sends them, **every admin/portal mutation 403s** — total portal lockout.
- **Change (strict monitor→enforce):**
  1. Implement real double-submit/synchronizer tokens; `/api/csrf-token` returns a real token.
  2. Update `portal.js` to fetch the token and attach it (header) on every mutating request.
  3. Deploy with `CSRF_MODE=monitor`: middleware **logs** missing/invalid tokens but **does not reject** (the existing `X-Requested-With` check stays as the live defense).
  4. Watch logs until ~100% of mutating requests carry valid tokens (i.e., all clients have the new `portal.js`). Account for cached JS — bust the cache.
  5. Flip `CSRF_MODE=enforce`. Keep `X-Requested-With` as defense-in-depth.
- **Brick risk:** **High if rushed; Low if you respect monitor mode.** The flag is the kill switch — flip back to `monitor` instantly if 403s spike.
- **Test:** With new `portal.js`, all admin actions work in enforce; stripping the token → 403 in enforce, logged in monitor; webhooks unaffected.
- **Rollback:** `CSRF_MODE=monitor` (or `off`) via env — no redeploy needed.

---

## Sequencing & risk summary

| # | Fix | Audit ID | Brick risk | Rollout mode | Needs migration? | Needs frontend change? |
|---|---|---|---|---|---|---|
| 0 | Safety net (CI, backups, deterministic gate) | — | none | — | no | no |
| A | tokenService MOCK guard | H-3 | very low | flag escape-hatch | no | no |
| B | Webhook rate-limit + replay | M-2/M-4 | low | env-tunable | no | no |
| C | Log masking + user rate limits | L-1/M-7 | very low | direct | no | no |
| D | Module identity vs plan | M-1 | medium | monitor→enforce | no | no |
| E | Treasury per-tenant config | H-1 | medium | additive + dual-read | **yes (additive)** | no |
| F | Vault webhook per-tenant secret | H-2 | medium | back-compat + monitor | maybe (secrets store) | no |
| G | Session regeneration | H-5 | medium | new-logins-only | no | no |
| H | Challenge binding + 1-time nonce | H-4/M-5 | low–med | transition fallback | no | small (send wallet) |
| I | Static origin / no token-in-URL | C-2/H-6 | med–high | WEB_URL fallback | no | yes (token delivery) |
| J | Real CSRF tokens | C-1 | **high** | **monitor→enforce** | no | yes (attach token) |

**Recommended order:** 0 → A,B,C (parallel, safe) → D → E → F → G → H → I → J. Auth path (G–J) strictly serial, one prod deploy each, with bake time between.

---

## The "it's on fire" kill switches (memorize these)

| Symptom | Immediate action |
|---|---|
| Portal admin actions 403-ing after CSRF deploy | `CSRF_MODE=monitor` (or `off`) + restart |
| Nobody can log in after auth deploy | Revert Fix I PR; confirm `WEB_URL` set; restart |
| Vault mints stopped | `VAULT_WEBHOOK_ENFORCE_GUILD_MATCH=monitor`; confirm webhook secret env |
| A tenant lost a module they had | Fix D is monitor-only by design; if enforce, `MODULE_IDENTITY_ENFORCE=off` |
| Treasury showing wrong/empty data | Code reads legacy global row via dual-read; revert Fix E code (migration is additive, data intact) |
| Anything weird | PM2 restart to prior commit; restore last labeled DB backup if data touched |

---

## What this plan deliberately does NOT do

- **No big-bang refactor.** Each fix is surgical and isolated.
- **No destructive migrations.** Columns/tables are only added, never dropped or renamed, until a much later cleanup pass.
- **No forced dependency jumps.** `npm audit fix` for non-breaking moderates only; the discord.js `undici`/`ws` High items get a *patched 14.x* bump tested on staging — **never** the `audit fix --force` that downgrades to discord.js 13 or web3.js 0.0.3.
- **No auth enforcement without a monitor period** and a flag kill-switch.

Follow this and the worst realistic outcome of any single step is "flip a flag / revert one small PR," not "bot is bricked."
