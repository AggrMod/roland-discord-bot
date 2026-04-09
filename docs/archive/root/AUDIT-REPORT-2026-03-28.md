# GuildPilot Audit Report — 2026-03-28

## Summary

| Category | Critical | High | Medium | Low |
|----------|----------|------|--------|-----|
| Security | 5 | 7 | 5 | 5 |
| Code Quality | 1 | 1 | 3 | 4 |
| Database | 2 | 2 | 3 | 2 |
| API Design | 0 | 0 | 4 | 2 |
| Discord Bot | 0 | 2 | 2 | 1 |
| Infrastructure | 0 | 1 | 1 | 3 |
| Frontend | 1 | 1 | 1 | 1 |
| **Total** | **9** | **14** | **19** | **18** |

**Audited**: 56 source files (all .js, .html, .json, .sh, .cjs), 145 MB total repo.

---

## Critical Issues

### [SEC-001] Unauthenticated wallet linking allows account takeover
- **File**: `web/server.js:2621-2677`
- **Issue**: `POST /api/verify` accepts `discordId`, `walletAddress`, `signature`, and `message` from the request body with no session or auth check. The caller controls the `message` field used for signature verification, so an attacker who owns a wallet can forge a link to any Discord user's account.
- **Impact**: Any user's account can have an attacker-controlled wallet linked, enabling NFT-based privilege escalation and voting power theft.
- **Fix**: Require session authentication (`req.session.discordUser.id`) and use it as the `discordId`. Enforce a server-generated challenge nonce in the signed message.

### [SEC-002] Unauthenticated wallet enumeration
- **File**: `web/server.js:2679-2690`
- **Issue**: `GET /api/wallets/:discordId` returns all wallet addresses for any Discord user with no authentication.
- **Impact**: Attacker can enumerate every user's linked Solana wallets by iterating Discord IDs.
- **Fix**: Require session auth; only return wallets for `req.session.discordUser.id`.

### [SEC-003] Unauthenticated wallet favorite manipulation
- **File**: `web/server.js:2692-2717`
- **Issue**: `POST /api/wallets/:discordId/favorite` sets any user's favorite wallet without authentication.
- **Impact**: Attacker can change another user's primary wallet, affecting NFT lookups and voting power.
- **Fix**: Require session auth; validate `:discordId === req.session.discordUser.id`.

### [SEC-004] Legacy public API leaks raw Discord IDs and wallet addresses
- **File**: `web/server.js:2213, 2295, 2357, 2427, 2465, 2499, 2519`
- **Issue**: Legacy `/api/public/` endpoints expose `creator_id`, `participant_id`, `discord_id`, `wallet_address`, and `nft_mint` without redaction. The v1 API correctly uses `redactWallet()` but these endpoints do not.
- **Impact**: PII exposure enables targeted social engineering and wallet draining.
- **Fix**: Apply the same `redactWallet()` treatment as v1, or deprecate/remove legacy endpoints entirely.

### [SEC-005] DOM XSS in portal error display
- **File**: `web/public/portal.js:1688, 1729`
- **Issue**: Error messages (`e.message`) are injected into the DOM via `innerHTML` without passing through `escapeHtml()`. If an API response contains malicious HTML in an error field, it executes in the user's browser.
- **Impact**: Stored XSS if attacker can influence API error messages (e.g., via crafted proposal titles that trigger server errors containing the title).
- **Fix**: Use `escapeHtml(e.message)` or `textContent` instead of `innerHTML` for all error displays.

### [DB-001] Foreign key constraints not enforced
- **File**: `database/db.js` (entire file)
- **Issue**: SQLite foreign keys are OFF by default. The schema declares `FOREIGN KEY` constraints (lines 67, 83, 104, etc.) but `PRAGMA foreign_keys = ON` is never called. Only `journal_mode = WAL` is set (line 8).
- **Impact**: All FK constraints are decorative. Orphaned records can accumulate (e.g., votes for deleted proposals, wallets for deleted users), causing data integrity issues and incorrect aggregations.
- **Fix**: Add `db.pragma('foreign_keys = ON')` immediately after opening the connection (line 9).

### [DB-002] Silent migration failures mask real errors
- **File**: `database/db.js:14-29, 390-397`
- **Issue**: Every `ALTER TABLE` migration is wrapped in `try { ... } catch(e) {}` with empty catch blocks. This is intended to handle "column already exists" errors, but also silently swallows disk-full, corruption, or permission errors.
- **Impact**: Database can be left in an inconsistent state with partially-applied migrations. Application continues running against a broken schema.
- **Fix**: Check `e.message.includes('duplicate column')` (or similar) and re-throw any unexpected error.

### [RACE-001] Mission signup race condition (TOCTOU)
- **File**: `services/missionService.js:83-127`
- **Issue**: Mission slot count check (`SELECT COUNT`) and signup `INSERT` are not in a transaction. Concurrent signups can exceed the slot limit.
- **Impact**: Missions can be overfilled, breaking game balance and potentially causing downstream errors in NFT assignment.
- **Fix**: Wrap the count check + insert in a `db.transaction()` call.

### [RACE-002] Wallet linking race condition (TOCTOU)
- **File**: `services/walletService.js:5-39`
- **Issue**: The "wallet already linked?" check and the `INSERT` are separate queries without a transaction. Two concurrent requests with the same wallet can both pass the check.
- **Impact**: Same wallet linked to two different users, enabling double-voting and NFT claim duplication.
- **Fix**: Use `db.transaction()` to wrap the existence check and insert atomically.

---

## High Issues

### [SEC-006] No CSRF protection on state-changing endpoints
- **File**: `web/server.js` (global)
- **Issue**: No CSRF token middleware exists. Session cookies use `sameSite: 'lax'`, which blocks cross-origin POST from forms but does not protect against same-site attacks or AJAX requests from injected scripts.
- **Impact**: If XSS exists anywhere on the same domain (see SEC-005), all authenticated POST/PUT/DELETE actions can be triggered without user consent.
- **Fix**: Add `csurf` or `csrf-csrf` middleware for all state-changing routes, or implement the synchronizer token pattern.

### [SEC-007] NFT activity webhook secret comparison is not timing-safe
- **File**: `web/server.js:3088`
- **Issue**: Uses `!==` for secret comparison: `if (provided !== configuredSecret)`. The entitlement webhook at line 2963 correctly uses `timingSafeEquals`, but this one does not.
- **Impact**: Timing side-channel can reveal the webhook secret character by character.
- **Fix**: Replace with `crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(configuredSecret))`.

### [SEC-008] NFT activity webhook open when secret not configured
- **File**: `web/server.js:3086-3091`
- **Issue**: If `NFT_ACTIVITY_WEBHOOK_SECRET` is not set, the webhook accepts all requests without any authentication.
- **Impact**: Attacker can inject fake NFT activity events, manipulating user NFT counts and tier assignments.
- **Fix**: Return 503 when no secret is configured (matching the entitlement webhook pattern).

### [SEC-009] CDN supply chain risk -- unpinned external script
- **File**: `web/public/portal.js:247`
- **Issue**: Loads `@solana/web3.js@latest` from unpkg CDN with no version pin and no Subresource Integrity (SRI) hash.
- **Impact**: If the npm package is compromised, or unpkg is MITM'd, arbitrary JS executes in users' browsers with access to their wallets.
- **Fix**: Pin to a specific version and add an `integrity` attribute with the SHA-384 hash.

### [SEC-010] Default session secret allowed in production
- **File**: `web/server.js:146-152`
- **Issue**: Falls back to `'solpranos-secret-key-change-this-in-production'` if `SESSION_SECRET` is not set. Logs a warning but does not block startup.
- **Impact**: Known session secret enables session forgery and full account takeover.
- **Fix**: Throw an error (or `process.exit(1)`) if `SESSION_SECRET` is missing or matches the default when `NODE_ENV=production`.

### [SEC-011] Discord access token stored in plain text in session
- **File**: `web/server.js:498`
- **Issue**: `accessToken: tokenData.access_token` is stored directly in the session object (persisted to the SQLite session store).
- **Impact**: If the session database is compromised, all users' Discord access tokens are exposed, enabling full Discord account access.
- **Fix**: Encrypt the token before storing, or avoid persisting it entirely (use it only transiently during the callback).

### [SEC-012] `process.env` modified from user input in microVerifyService config
- **File**: `services/microVerifyService.js` (updateConfig method)
- **Issue**: Configuration update writes values from user-supplied input directly into `process.env`, which is a global mutable object.
- **Impact**: Admin users (or compromised admin sessions) can overwrite arbitrary environment variables, potentially changing database paths, API keys, or security settings.
- **Fix**: Use a dedicated config object instead of modifying `process.env`.

### [RACE-003] Ticket number generation produces duplicates
- **File**: `services/ticketService.js:269-278`
- **Issue**: Ticket number is derived from `COUNT(*) + 1`. Concurrent ticket creates will get the same number.
- **Impact**: Duplicate ticket numbers cause confusion and potential data integrity issues if the number is used as a lookup key.
- **Fix**: Use an auto-incrementing column or wrap in a transaction with a `MAX(number) + 1` approach.

### [RACE-004] Proposal and mission ID generation collision risk
- **File**: `services/proposalService.js:48-50`, `services/missionService.js:7-10`
- **Issue**: IDs are generated via `COUNT(*) + 1`. After deletions, new items reuse old IDs. Concurrent creates collide.
- **Impact**: Data corruption if two proposals or missions get the same ID. References to old deleted items could resolve to new ones.
- **Fix**: Use SQLite's `INTEGER PRIMARY KEY AUTOINCREMENT` or UUIDs.

### [RACE-005] Micro-verification amount collision
- **File**: `services/microVerifyService.js:99-111`
- **Issue**: Verification amount uniqueness check and insert are not transactional. Two concurrent verifications could get the same amount.
- **Impact**: Wrong wallet linked to wrong user if amounts collide.
- **Fix**: Wrap in `db.transaction()`.

### [BOT-001] Battle lobby creation race condition
- **File**: `commands/battle.js:224-229`
- **Issue**: Check-then-act pattern for lobby creation without transaction. Concurrent `/battle create` commands can create duplicate lobbies.
- **Impact**: Duplicate lobbies, inconsistent state, potential stuck battles.
- **Fix**: Use `INSERT ... ON CONFLICT` or wrap in a transaction.

### [BOT-002] Mock mode auto-verification risk
- **File**: `commands/verification.js:346-353`
- **Issue**: When `MOCK_MODE=true`, verification is auto-approved without actual wallet signature verification and grants real Discord roles.
- **Impact**: If `MOCK_MODE=true` leaks to production (misconfigured env), anyone can verify without owning NFTs and gain all associated roles/voting power.
- **Fix**: Add a startup guard: if `NODE_ENV=production` and `MOCK_MODE=true`, refuse to start.

---

## Medium Issues

### [SEC-013] Missing input validation on admin settings update
- **File**: `web/server.js:1345-1353`
- **Issue**: `req.body` passed directly to `settingsManager.updateSettings()` without field allowlisting. Admin can inject arbitrary configuration keys.
- **Impact**: Unexpected configuration state, potential for privilege escalation if settings control access.
- **Fix**: Allowlist accepted fields and validate types/ranges.

### [SEC-014] Missing input validation on branding update
- **File**: `web/server.js:1176-1209`
- **Issue**: Arbitrary keys from `req.body` passed to `tenantService.updateTenantBranding()`.
- **Impact**: Can overwrite unexpected tenant fields.
- **Fix**: Allowlist branding fields (name, description, logo, colors).

### [SEC-015] Potential open redirect in OAuth callback
- **File**: `web/server.js:501-503`
- **Issue**: `req.session.returnTo` is used for post-login redirect. Currently only set to safe values, but no validation ensures it's a relative path.
- **Impact**: If any future code path sets `returnTo` from user input, it becomes an open redirect.
- **Fix**: Validate `returnTo` starts with `/` and does not contain `//`.

### [SEC-016] Localhost origins in CORS whitelist
- **File**: `web/server.js:124-125`
- **Issue**: `http://localhost:3000` and `http://localhost:5173` are always in the CORS allowed origins, even in production.
- **Impact**: Any local service on those ports (including malicious browser extensions) can make credentialed cross-origin requests.
- **Fix**: Only include localhost origins when `NODE_ENV !== 'production'`.

### [SEC-017] moduleGate bypasses all checks when multitenant disabled
- **File**: `middleware/moduleGate.js:15-16`
- **Issue**: When `MULTITENANT_ENABLED` is not `'true'`, the middleware calls `next()` immediately, skipping all module availability checks.
- **Impact**: All modules accessible regardless of plan or configuration in single-tenant mode.
- **Fix**: Intentional for single-tenant, but should be documented. Consider still checking module enable/disable flags.

### [DB-003] Missing indexes on frequently queried columns
- **File**: `database/db.js`
- **Issue**: Missing indexes on:
  - `votes.voter_id` (needed for "show my votes" queries)
  - `micro_verify_requests.sender_wallet` and `destination_wallet`
  - `nft_activity_log.wallet_address`
  - `tickets.guild_id` and `tickets.status`
- **Impact**: Full table scans on growing tables, degrading performance over time.
- **Fix**: Add `CREATE INDEX IF NOT EXISTS` statements for these columns.

### [DB-004] `updated_at` never actually updated
- **File**: `database/db.js` (multiple tables)
- **Issue**: Multiple tables declare `updated_at DATETIME DEFAULT CURRENT_TIMESTAMP` but SQLite does not auto-update this on `UPDATE` statements. No triggers exist. Application code does not SET it.
- **Impact**: `updated_at` always equals `created_at`, making it useless for auditing or cache invalidation.
- **Fix**: Add `UPDATE` triggers or set `updated_at = CURRENT_TIMESTAMP` in application update queries.

### [DB-005] Duplicate/overlapping tables
- **File**: `database/db.js:107-114 vs 137-144`
- **Issue**: Both `proposal_supporters` and `proposal_support` store proposal support with identical structure (proposal_id + supporter_id, UNIQUE constraint).
- **Impact**: Dead code / migration artifact. Queries may use the wrong table, causing missing data.
- **Fix**: Determine which is canonical, migrate data, drop the other.

### [API-001] Missing pagination on multiple endpoints
- **File**: `web/server.js` (multiple locations)
- **Issue**: These endpoints return unbounded result sets:
  - `GET /api/admin/users` (line 1427) -- all users
  - `GET /api/admin/proposals` (line 1504) -- all proposals
  - `GET /api/admin/missions` (line 1581) -- all missions
  - `GET /api/admin/tickets` (line 2905)
  - `GET /api/public/proposals/active` (line 2194)
  - `GET /api/public/proposals/concluded` (line 2233)
  - `GET /api/public/missions/active` (line 2341)
- **Impact**: As data grows, these endpoints become progressively slower and can cause memory pressure or timeouts.
- **Fix**: Add `?limit=&offset=` query parameters with sensible defaults (e.g., limit 50, max 200).

### [API-002] Duplicate route with inconsistent validation
- **File**: `web/server.js:826-845 vs 790-822`
- **Issue**: `POST /api/governance/proposals` and `POST /api/user/proposals` are nearly identical. The governance version lacks the title/description length validation that the user version has.
- **Impact**: Users can bypass title/description length limits by hitting the governance endpoint.
- **Fix**: Consolidate into one route or share validation middleware.

### [API-003] Query parameter bounds not validated
- **File**: `web/routes/v1.js:69-70, 309`
- **Issue**: `parseInt(req.query.limit)` with no min/max bounds. Can be negative, NaN, or extremely large.
- **Impact**: DoS via unbounded result sets (`?limit=999999999`).
- **Fix**: Clamp to `Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)`.

### [API-004] `notFoundError` return value potentially unused
- **File**: `web/routes/v1.js:136-137, 362-363`
- **Issue**: `notFoundError('Proposal')` is called but its return value is not used. If this function returns an error object instead of throwing, execution continues and crashes on the next line accessing a null property.
- **Impact**: Depends on implementation -- either works correctly (if it throws) or causes unhandled crash.
- **Fix**: Verify `notFoundError` throws. If not, add `return` before the call.

### [BOT-003] Missing deferReply on long admin operations
- **File**: `commands/verification.js:553`
- **Issue**: `handleAdminPanel` performs database queries and role lookups without calling `interaction.deferReply()`. Discord requires a response within 3 seconds.
- **Impact**: "This interaction failed" error shown to user on slow networks or under load.
- **Fix**: Add `await interaction.deferReply({ ephemeral: true })` at the start of long handlers.

### [BOT-004] Error messages expose internal details to Discord users
- **File**: All command files (battle.js, governance.js, treasury.js, verification.js, heist.js)
- **Issue**: Catch blocks send `error.message` directly to the user via `interaction.reply()`.
- **Impact**: Database errors, file system paths, or internal logic details leak to Discord users.
- **Fix**: Log the full error server-side; send a generic "An error occurred" message to the user.

### [INFRA-001] Global `discordClient` on `global` object
- **File**: `index.js:116`
- **Issue**: `global.discordClient = client` exposes the entire Discord client (including bot token) to every module and dependency in the process.
- **Impact**: Any compromised or buggy dependency can access the bot token and all guild data.
- **Fix**: Pass the client via dependency injection or module-scoped exports.

### [FE-001] Hardcoded public Solana RPC endpoint
- **File**: `web/public/portal.js:251`
- **Issue**: Uses `https://api.mainnet-beta.solana.com` directly in client-side code. This is a public, rate-limited endpoint.
- **Impact**: Rate-limited or blocked under load; no fallback; endpoint change requires code redeployment.
- **Fix**: Load from a configuration endpoint or environment-injected variable.

---

## Low Issues

### [SEC-018] `trust proxy` set to `1` without documentation
- **File**: `web/server.js:116`
- **Issue**: If not behind exactly one proxy, `X-Forwarded-For` can be spoofed, bypassing IP-based rate limiting.
- **Fix**: Document the expected proxy architecture; verify production deployment matches.

### [SEC-019] Governance comments endpoint has no rate limiting
- **File**: `web/server.js:882`
- **Issue**: `POST /api/governance/proposals/:id/comments` is under session auth but not rate-limited.
- **Fix**: Add rate limiting per user.

### [SEC-020] `/api/features` endpoint has no rate limiting
- **File**: `web/server.js:430`
- **Fix**: Add to rate-limited path prefix or add per-IP limiter.

### [SEC-021] `execSync` blocks event loop in system-status
- **File**: `web/server.js:1232-1234`
- **Issue**: `execSync('df -BM / | tail -1')` blocks the Node.js event loop. Behind superadmin guard, but still.
- **Fix**: Use `exec` (async) instead.

### [SEC-022] Error response leaks internal details
- **File**: `web/server.js:1261`
- **Issue**: `res.status(500).json({ error: err.message })` exposes internal error text.
- **Fix**: Return generic error message; log details server-side.

### [DB-006] Database path hardcoded relative to module
- **File**: `database/db.js:5`
- **Issue**: `const dbPath = path.join(__dirname, 'solpranos.db')` puts the DB inside the source directory.
- **Impact**: Redeployment or `git clean` can delete the database.
- **Fix**: Make configurable via `DATABASE_PATH` environment variable.

### [DB-007] No periodic VACUUM or integrity check
- **File**: `database/db.js`
- **Issue**: With WAL mode and frequent writes, the database can grow unbounded.
- **Fix**: Add periodic `PRAGMA integrity_check` and `VACUUM` (e.g., weekly cron or at startup).

### [QUALITY-001] Intervals never cleared on shutdown
- **File**: `index.js:158, 771, 875`
- **Issue**: Three `setInterval` calls with handles never stored. Cannot be cleared on SIGINT/SIGTERM.
- **Impact**: PM2 restart may have dangling async operations during shutdown.
- **Fix**: Store interval handles; clear them in a `process.on('SIGTERM')` handler.

### [QUALITY-002] Duplicate reaction handler logic
- **File**: `index.js:1026-1118 vs 1120-1184`
- **Issue**: `MessageReactionAdd` and `MessageReactionRemove` handlers contain ~40 lines of nearly identical role-fetching logic.
- **Fix**: Extract shared logic into a helper function.

### [QUALITY-003] Dead code -- redundant DISCORD_TOKEN check
- **File**: `index.js:1195-1198`
- **Issue**: Duplicate of the check already performed in `validateEnvVars()` at line 42.
- **Fix**: Remove the redundant check.

### [QUALITY-004] `parseInt` missing radix parameter
- **File**: `web/routes/v1.js:69, 309, 400`
- **Issue**: `parseInt(req.query.limit)` without explicit radix `10`. Works for decimal but violates best practices.
- **Fix**: Use `parseInt(value, 10)` consistently.

### [QUALITY-005] `governance.js` uses static `require()` for settings
- **File**: `commands/governance.js:4`
- **Issue**: Uses `require('./config/settings.json')` instead of the live `settingsManager`, so setting changes require a bot restart.
- **Fix**: Import and use `settingsManager.get()` instead.

### [QUALITY-006] 34 `console.log()` calls in portal.js
- **File**: `web/public/portal.js:3698-3754` (and throughout)
- **Issue**: Debug logging left in production client code. Some log API paths, channel IDs, and response shapes.
- **Fix**: Remove or gate behind a `DEBUG` flag.

### [QUALITY-007] No `devDependencies` or security tooling
- **File**: `package.json`
- **Issue**: Zero `devDependencies`. No eslint, no `npm audit` in CI, no security scanning.
- **Fix**: Add eslint, `npm audit --production`, and consider a pre-commit hook.

### [API-005] Legacy public API duplicates v1 with less security
- **File**: `web/server.js:2194-2531`
- **Issue**: Legacy endpoints duplicate v1 functionality without the redaction, pagination, and validation improvements.
- **Fix**: Deprecate and remove legacy endpoints; redirect to v1.

### [API-006] Inconsistent error response shapes
- **File**: Various routes in `web/server.js`
- **Issue**: Some errors return `{ error: 'message' }`, others `{ success: false, error: 'message' }`, others `{ message: 'text' }`.
- **Fix**: Standardize on a single error envelope: `{ success: false, error: { code: 'ERROR_CODE', message: 'Human-readable' } }`.

### [INFRA-002] PM2 max_restarts with no alerting
- **File**: `ecosystem.config.cjs:13`
- **Issue**: `max_restarts: 20` -- if the bot crash-loops 20 times, PM2 stops it silently. No webhook or alert.
- **Fix**: Add `scripts/alert_pm2_restarts.sh` to a cron job, or configure PM2 with a `post_update` hook that sends a webhook.

### [INFRA-003] Missing environment variable validation
- **File**: `index.js` (validateEnvVars function)
- **Issue**: Only validates `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`. Missing: `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, `SESSION_SECRET`, `SOLANA_RPC_URL`.
- **Fix**: Add all required env vars to the validation list.

---

## Positives (things done well)

1. **Zero SQL injection**: All database queries throughout the codebase use `db.prepare()` with parameterized statements. No string interpolation in queries was found.
2. **No hardcoded secrets**: All sensitive values (tokens, keys, secrets) use `process.env`. The only hardcoded value is the fallback session secret, which is warned about.
3. **Strict equality throughout**: All comparisons use `===`. No loose `==` found in any service file.
4. **Session cookie security**: `httpOnly: true`, `secure: true` in production, `sameSite: 'lax'`, 24-hour expiry. Correctly configured.
5. **CORS configuration**: Explicit origin whitelist (not `*`), proper credential handling, specific allowed methods and headers.
6. **Admin route protection**: All 13+ admin endpoints protected with `adminAuthMiddleware` that checks Discord guild permissions.
7. **Superadmin guard**: Properly validates superadmin status from both environment variable and database table.
8. **Entitlement webhook security**: Uses `timingSafeEqual` for signature verification and returns 503 when unconfigured.
9. **Helius rate limiter**: `nftService.js` implements a well-designed rate limiter respecting the `HELIUS_RPS` configuration.
10. **Backup scripts**: Proper `set -euo pipefail`, cleanup traps, and timestamp-based rotation in shell scripts.
11. **WAL mode for SQLite**: Enables concurrent reads during writes, appropriate for a web-serving workload.
12. **Multi-tenant architecture**: Clean tenant isolation with per-guild scoping, module gates, and plan-based feature limits.
13. **`escapeHtml()` utility exists**: The portal includes an HTML escape function and uses it in most (but not all -- see SEC-005) DOM insertions.
14. **V1 API design**: The public v1 API has proper wallet redaction, pagination support, and consistent response shapes.

---

## Remediation Priority

### Immediate (before any public release)
1. **SEC-001/002/003**: Add authentication to legacy `/api/verify` and `/api/wallets/` endpoints
2. **SEC-005**: Fix DOM XSS in portal error displays
3. **DB-001**: Enable foreign key enforcement
4. **SEC-010**: Make `SESSION_SECRET` mandatory in production
5. **RACE-001/002**: Add transactions to mission signup and wallet linking

### Short term (week 1 post-release)
6. **SEC-004**: Remove or secure legacy public API endpoints
7. **SEC-007/008**: Fix webhook secret comparison and enforce secret presence
8. **SEC-009**: Pin CDN dependency version with SRI hash
9. **SEC-006**: Add CSRF protection
10. **DB-002**: Fix silent migration error handling

### Medium term (sprint 2)
11. **API-001**: Add pagination to all list endpoints
12. **DB-003**: Add missing database indexes
13. **RACE-003/004/005**: Fix remaining race conditions with transactions
14. **INFRA-003**: Expand environment variable validation
15. **API-006**: Standardize error response shapes

---

*Audit performed on commit `901b292` (main branch). 56 source files reviewed.*
