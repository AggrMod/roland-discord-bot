# GuildPilot — Security & Technical Launch-Readiness Audit

**Date:** 2026-06-23
**Scope:** Full bot + multi-tenant web portal, API, billing, blockchain integration, and module entitlements
**Codebase:** `roland-discord-bot` (Node.js / Express / discord.js 14 / better-sqlite3 / Solana web3.js)
**Method:** Manual source review (auth, access control, crypto, webhooks, secrets), dependency audit (`npm audit`), lint pass, and execution of the release-gate test suite (68 test files).

---

## 1. Executive Summary & Verdict

> **Verdict: NOT ready for an unconditional, paid public launch yet. It is, however, close, and suitable for a closed/invite-only beta with trusted servers while the items below are fixed.**

The product is genuinely impressive in scope and engineering quality. The architecture is sound, the core cryptographic primitives (ed25519 signature verification, timing-safe secret comparison) are implemented **correctly**, webhook authentication fails closed, and the vault/claim/spend money-adjacent paths are properly transactional. There is a real test suite (68 files) and it passes on clean runs.

However, the audit found **a small number of genuine multi-tenant isolation and entitlement-integrity defects**, plus several **authentication-hardening gaps**, that should not ship to paying customers across mutually-untrusting tenants. None are catastrophic in isolation, but collectively they mean a determined or even careless tenant admin could affect other tenants, spoof token-gated roles under a misconfiguration, or obtain paid functionality without paying.

**Bottom line:** Plan for a focused ~1–2 week remediation pass on the items in §3 (Critical/High) before charging money and exposing webhooks to the public internet. The Medium/Low items can follow as fast-follows.

### Severity tally

| Severity | Count | Examples |
|---|---|---|
| Critical | 2 | CSRF is header-only (no real tokens); OAuth token delivered in redirect fragment with header-spoofable origin allowlist |
| High | 6 | Cross-tenant treasury-config write; vault-webhook cross-tenant forgery; tokenService has no prod MOCK guard; challenge message not bound to wallet/Discord ID; session fixation; `X-Forwarded-Host` trust |
| Medium | 7 | Plan module-identity bypass; webhook replay/rate-limit gaps; no CSP; nonce not strictly one-time; micro-verify sender attribution |
| Low | 8 | Verbose PII logging; body-limit too broad; `isModuleEnabled` fails open; secure-cookie override; etc. |
| Process / hygiene | — | Committed `*.diff`/debug/`sigs.json` clutter; flaky release gate; dependency CVEs |

---

## 2. What's Done Right (don't break these)

These are strong, correctly-implemented controls observed during the review:

- **Cryptography:** ed25519 wallet-signature verification is correct (`bs58` decode + `nacl.sign.detached.verify`, `web/server.js:1544`). All secret/signature comparisons use `crypto.timingSafeEqual` behind a length-guarded helper (`web/server.js:119`).
- **OAuth state:** Both portal and public OAuth flows use signed, expiring HMAC-SHA256 state tokens with constant-time verification (`web/routes/authUser.js`).
- **Admin authorization core:** `resolveAdminGuildAccess` verifies the requesting user against **live Discord permissions for the specific guild** in the `x-guild-id` header, plus a bot-presence check — applied consistently with `allowFallback:false` across `/api/admin/*`. This is the correct (auth → per-guild ownership → bot-installed) chain.
- **No SQL injection found.** All dynamic SQL builds only column names from fixed allowlists; every value is bound with `?` placeholders. `db.exec` is used only for static DDL.
- **Webhook auth fails closed:** missing configured secret → 503; bad secret → 401; timing-safe comparison throughout.
- **Billing webhook** has correct replay/idempotency via `payload_hash` + UNIQUE constraint.
- **Money-adjacent vault paths** (key spend, reward claim, inventory decrement, mint ingest) are transactional and idempotent on `tx_signature`.
- **Treasury never holds keys or signs** — it is read-only on-chain balance monitoring.
- **Session basics:** `httpOnly`, `sameSite=lax`, `secure:auto` in prod, persistent store with expiry sweep, session secret enforced ≥32 chars at startup.
- **No live secrets committed** — all secrets are env-driven; `.env`/`*.db` are correctly untracked.
- **NFT service degrades safely** (serves stale cache / empty + `degraded` flags on provider outage rather than fabricating holdings) and guards `MOCK_MODE` in production.

---

## 3. Findings (prioritized)

### CRITICAL

**C-1 — CSRF protection is header-only; the `csrf-csrf` dependency is not wired up.**
The only CSRF control on mutating `/api` routes is requiring an `X-Requested-With: XMLHttpRequest` header (`web/server.js:363`). `/api/csrf-token` returns an empty stub; there is no synchronizer/double-submit token validated anywhere. With `sameSite=lax` cookies plus a broad credentialed CORS allowlist, this is below standard for a multi-tenant admin SaaS — any XSS on an allowed origin (no CSP exists, see M-3) escalates to full authenticated API access.
*Fix:* Implement real CSRF tokens (the dependency is already installed), validate on every mutating route, keep the header check as defense-in-depth.

**C-2 — Public OAuth bearer token is delivered in a redirect URL fragment, with a header-spoofable origin allowlist.**
The public OAuth callback mints an 8-hour bearer token and redirects it in the URL fragment to a `returnTo` origin (`web/routes/authUser.js`). The allowed-origin set is derived in part from `getRequestOrigin`, which trusts the client-supplied `X-Forwarded-Host` header. An attacker spoofing that header can add their origin to the allowlist and exfiltrate a victim's freshly-minted token. Even absent spoofing, putting bearer tokens in URLs leaks them into history/referer/proxy logs.
*Fix:* Never derive allowed origins from request headers (use a static configured allowlist). Don't put bearer tokens in URLs — return in JSON body or via `postMessage` to a known origin; shorten TTL.

### HIGH

**H-1 — Cross-tenant treasury config write (multi-tenant isolation break). _Confirmed._**
`treasury_config` is a **single global row** (`CHECK (id = 1)`, `services/treasuryService.js:33`). The admin routes `GET/PUT /api/admin/treasury` call `getAdminSummary()` / `updateConfig()` **without `req.guildId`** (`web/routes/adminTrackers.js:114,128`). A properly-authenticated admin of *Guild A* who edits treasury settings overwrites the wallet address, alert channel, and thresholds for **every tenant**. The `treasury_wallets` table is guild-scoped, but the primary config is not.
*Fix:* Add `guild_id` to `treasury_config` and thread `req.guildId` through `getAdminSummary`/`updateConfig`, matching the wallet-list functions that already scope by guild.

**H-2 — Vault mint webhook allows cross-tenant event forgery via a shared global secret. _Confirmed._**
`web/routes/vaultWebhooks.js` authenticates with one secret that falls back to the same value as the activity/token webhooks (`VAULT_MINT_WEBHOOK_SECRET || TRACKED_TOKEN_WEBHOOK_SECRET || NFT_ACTIVITY_WEBHOOK_SECRET`). The target tenant is taken from attacker-controlled `event.guildId` / `?guildId` / `x-guild-id` and trusted directly. Anyone holding the one shared secret can grant vault keys / reward eligibility to a user in **any** tenant.
*Fix:* Per-tenant webhook secrets (or guild-scoped HMAC) and reject events whose `guildId` doesn't match the authenticating key. Stop the secret fallback chain.

**H-3 — `tokenService` has no production MOCK_MODE guard; token-gated roles are spoofable under misconfiguration. _Confirmed._**
`nftService` correctly refuses to serve mock data in production, but `services/tokenService.js:7,49` returns `getMockTokenBalances()` (random balances) whenever `MOCK_MODE=true` or a tenant has `mockDataEnabled`, with **no `NODE_ENV` / `ALLOW_MOCK_IN_PROD` guard**. A single misconfiguration makes every token-amount gate pass for everyone.
*Fix:* Mirror nftService's production guards in tokenService (throw at startup, suppress mock output in prod).

**H-4 — Wallet-ownership challenge message is not bound to the wallet address or Discord ID. _Confirmed._**
The signed challenge is `"<brand> Wallet Verification\nUser: <username>\nNonce: <nonce>"` (`web/routes/userWalletVerification.js:59`). It binds a **mutable username** and nonce, but not the wallet being claimed nor the Discord ID. The wallet address is submitted separately and unbound. The proof therefore asserts "someone signed this string," not "this user controls *this* wallet for *this* action."
*Fix:* Include the canonical wallet address and Discord ID in the signed message; reconstruct and compare server-side.

**H-5 — No session regeneration on login (session fixation).**
On successful OAuth the code sets `req.session.discordUser` without calling `req.session.regenerate()` (`web/routes/authUser.js`). Several pre-login flows write to the session (`returnTo`, `xOAuth`) and force a cookie before auth, opening a fixation window.
*Fix:* `req.session.regenerate()` immediately before establishing the authenticated user, on both Discord and X callbacks.

**H-6 — Origin/redirect derivation trusts client `X-Forwarded-Host` / `X-Forwarded-Proto`.**
`getRequestOrigin` reads forwarded headers directly rather than relying on Express's `trust proxy`-vetted values, and this origin feeds OAuth redirect URIs and allowlists (root cause of C-2).
*Fix:* Use `req.hostname`/`req.protocol` (gated by `trust proxy`) or a hardcoded canonical base URL; ensure the reverse proxy overwrites inbound `X-Forwarded-Host`.

### MEDIUM

**M-1 — Plan enforcement checks module *count*, not module *identity*. _Confirmed._**
`tenantService.setTenantModule` only enforces `max_enabled_modules` (which is `null`/uncapped on **every** current plan) and never checks whether the module is included in the tenant's plan. A free-plan admin can enable a paid-only module (e.g. `aiassistant`) directly via the admin API. (Practical impact is partly limited because per-feature limits like `aiassistant.max_requests_per_day=0` still gate usage — but the entitlement model should not depend on that.)
*Fix:* In `setTenantModule`, reject enabling any module where `getPlanPreset(plan).modules[key] !== true` unless a superadmin override exists.

**M-2 — Activity & vault webhooks lack replay protection.** Billing does it right; NFT/token-activity and vault webhooks have no timestamp/nonce/idempotency at the HTTP layer (vault dedupes on `tx_signature` in the DB, which mitigates duplicate grants).
**M-3 — No Content-Security-Policy.** `helmet({ contentSecurityPolicy: false })`. Any portal XSS executes unconstrained and defeats the C-1 header defense. Ship a CSP (report-only first).
**M-4 — No rate limiting on webhook endpoints.** `/api/webhooks/*` and `/api/billing/webhook/*` have no limiter and accept up to 6 MB / batched arrays processed synchronously (vault). DoS/amplification surface.
**M-5 — Verification nonce is not strictly one-time.** Replay protection relies on session state + 5-min TTL; the failure path doesn't consume the challenge, allowing repeated attempts against one nonce within the window. (ed25519 makes forging infeasible, so impact is low.)
**M-6 — Micro-verify sender attribution assumes `staticAccountKeys[0]`.** (`services/microVerifyService.js:666`) Not guaranteed to be the funding signer for versioned/multisig txs; could attribute the wrong wallet.
**M-7 — No rate limiting on authenticated `/api/user/*` mutating routes** (wallet add/remove, role toggle, engagement redeem).

### LOW

- **L-1 — Verbose PII logging:** full wallet addresses + tx signatures logged next to Discord IDs at info level (deanonymizes users). `treasuryService` masks; the identity routes do not — inconsistent. Mask them.
- **L-2 — `isModuleEnabled` fails open** when tenant context is missing (returns `true`). Default to deny in multi-tenant mode.
- **L-3 — Global 6 MB JSON body limit** applies to all routes, not just webhooks. Tighten the default.
- **L-4 — `SESSION_COOKIE_SECURE` can be forced `false` in production** with no guardrail.
- **L-5 — Logout `clearCookie` omits the cookie options** used to set it; browser may retain the cookie if a cookie domain is configured.
- **L-6 — `getValidDiscordAccessToken` treats tokens with no expiry as valid forever.**
- **L-7 — No base58/`PublicKey` validation of the wallet address before storage** (fail-safe today because downstream lookups skip invalid addresses).
- **L-8 — `ingestMintEvent` persists the entire raw webhook payload** indefinitely (data-retention review).

---

## 4. Dependency Audit (`npm audit`)

`npm audit` reports vulnerabilities, several **High**, all in transitive dependencies:

| Package (path) | Severity | Note |
|---|---|---|
| `undici` (via discord.js → @discordjs/rest/ws) | **High** | HTTP header injection / response-queue poisoning / DoS. Fix requires bumping discord.js. |
| `ws` (transitive) | **High** | DoS. |
| `qs` / `body-parser` / `express` | Moderate | `qs.stringify` DoS. `npm audit fix` available (non-breaking). |
| `ip-address` (via express-rate-limit) | Moderate | XSS in unused HTML methods. `npm audit fix` available. |
| `uuid` (via @solana/web3.js → jayson) | Moderate | Buffer bounds check. Fix is a breaking web3.js downgrade — do **not** auto-fix. |

*Action:* Run `npm audit fix` for the non-breaking moderates now. Schedule a discord.js minor/patch bump to clear the `undici`/`ws` High items (the safe-fix would force discord.js 13 — **don't**; instead upgrade to the latest patched 14.x). The Solana `uuid` issue is low real-world risk; track it rather than force-downgrading web3.js.

---

## 5. Test Suite & CI Status

- **68 test files** exist with a `test-coverage-matrix.json` mapping capabilities → tests, and a `release-gate.js` runner. Good QA discipline.
- **All 68 tests pass when run individually.**
- The **release gate is non-deterministic**: a clean first run failed on `governance-proposal-lifecycle` ("repeat vote should be accepted as a vote update" — the proposal had auto-closed before the repeat vote due to shared DB state from prior tests), then passed on two subsequent runs. This is **test-isolation flakiness** (sequential tests share database state), not necessarily a product bug, but it will cause intermittent red CI and erode trust in the gate.
- *Action:* Give each test a fresh isolated database (per-file temp DB or reset between steps) so the gate is deterministic. Wire the gate into CI as a required check.
- No CI workflow config was found in the repo — add one (lint + audit + release-gate on every PR).

---

## 6. Repository Hygiene (process)

The repo root carries substantial committed clutter that should not ship:

- **25 `*.diff` / `*.txt` dumps** (e.g. `all_changes.diff` 301 KB, `codex_diff.txt` 622 KB, `claude_codex_changes.diff` 615 KB), plus `debug_*.js`, `scratch_query.js`, `status.txt`, `git_log.txt`, and `config/settings.json`.
- These are **listed in `.gitignore` but already tracked** — `.gitignore` has no effect on tracked files, creating a false sense of safety (a dev pasting a secret into a `*.diff` expecting it to be ignored would commit it).
- `sigs.json` (143 KB) is ~hundreds of **real Solana transaction signatures** (verification/treasury scan history). These are public on-chain data — *not* a credential leak — but they expose the project's on-chain wallet transaction graph and verification cadence.
- **No live secrets** were found in any committed file (grepped the large dumps for tokens/keys — clean). The two grep hits were dummy test placeholders.

*Action (before launch):* `git rm --cached` the diff/txt dumps, debug scripts, `sigs.json`, and `config/settings.json`; commit the removal; confirm `git ls-files` is clean. If any *historical* commit ever contained a real secret, also rewrite history (`git filter-repo`).

---

## 7. Prioritized Remediation Roadmap

**Blockers — fix before charging customers / public webhook exposure:**
1. H-1 cross-tenant treasury config (isolation)
2. H-2 vault-webhook cross-tenant forgery + per-tenant secrets
3. H-3 tokenService production MOCK guard
4. C-1 real CSRF tokens
5. C-2 / H-6 stop trusting `X-Forwarded-Host`; don't put bearer tokens in URLs
6. H-4 bind challenge message to wallet + Discord ID
7. H-5 session regeneration on login
8. M-1 enforce module identity against plan

**Fast-follow (harden before scale):**
9. M-2/M-4 webhook replay + rate limiting; M-3 CSP; M-5/M-6 nonce + micro-verify attribution; M-7 user-route rate limits
10. Repo cleanup (§6); deterministic release gate + CI (§5); `npm audit fix` + discord.js patch bump (§4)

**Backlog:** all Low items (§3).

---

## 8. Honest Closing Assessment

This is a well-built, feature-rich platform with a competent security baseline — the hard cryptographic and authorization fundamentals are right, which is the part most projects get wrong. The gaps that remain are the kind that surface specifically in a **multi-tenant, money-handling** context: tenant isolation on a couple of shared resources, entitlement integrity, and OAuth/CSRF hardening. They are concrete, well-understood, and fixable in a focused sprint.

I would **not** flip this to a paid, open public launch today. I **would** be comfortable running an invite-only beta with a handful of trusted servers now, in parallel with the §3 Critical/High remediation, and converting to general availability once those are closed and the release gate is deterministic in CI.
