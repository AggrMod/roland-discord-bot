# Production Readiness Audit Report

**Date:** 2026-03-27
**Codebase:** roland-discord-bot

---

## 1. PRODUCTION READINESS

### CRITICAL

| # | Issue | Location | Details |
|---|-------|----------|---------|
| 1 | **No rate limiting on public endpoints** | `web/server.js`, `web/routes/v1.js` | No `express-rate-limit` middleware. Verification endpoints (`/api/verify/*`, `/api/micro-verify/request`) are exposed to brute force. Only service-level rate limiting exists in `microVerifyService.js`. |
| 2 | **Query param validation missing bounds** | `web/routes/v1.js:69-70,313` | `parseInt(req.query.limit)` with no min/max bounds. Can be negative or NaN. Some endpoints (lines 228, 252) do this correctly — others don't. |
| 3 | **In-memory session store** | `web/server.js:56` | Sessions lost on restart. Not viable for multi-instance. TODO comment acknowledges this. |

### HIGH

| # | Issue | Location | Details |
|---|-------|----------|---------|
| 4 | **Incomplete env var validation** | `index.js` (validateEnvVars) | Only checks `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`. Missing: `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, `SESSION_SECRET` — all required for OAuth/sessions to work. |
| 5 | **Session secret has insecure default** | `web/server.js:58` | Falls back to `'solpranos-secret-key-change-this-in-production'`. Code logs a warning but doesn't prevent startup. |
| 6 | **Discord access token stored in session** | `web/server.js:179` | `req.session.discordUser.accessToken` persisted. Should be cleared after initial use if not needed for ongoing OAuth operations. |

### MEDIUM

| # | Issue | Location | Details |
|---|-------|----------|---------|
| 7 | **34 console.log() calls in portal.js** | `web/public/portal.js` | Client-side code — acceptable but should be guarded behind a DEBUG flag or removed for production. |
| 8 | **Path param existence not validated** | `web/routes/v1.js:136,366,446` | `req.params.id` used directly. Parameterized queries prevent SQLi, but invalid IDs should return 404 not pass through. |

### WHAT'S DONE WELL

- **SQL injection prevention**: All queries use `db.prepare()` with parameterized statements — excellent throughout.
- **Admin route protection**: `adminAuthMiddleware` covers all 13 admin endpoints with Discord permission checks.
- **No leaked error internals**: All error responses return generic messages; stack traces logged server-side only.
- **No hardcoded secrets**: Everything uses `process.env`.
- **XSS prevention**: No dangerous `innerHTML` usage. API responses use `redactWallet()`.
- **Session cookies**: `httpOnly: true`, `secure: true` in prod, `sameSite: 'lax'`, 24h expiry.
- **CORS**: Explicit domain whitelist, proper credential handling.
- **Webhook auth**: NFT activity webhook validates `NFT_ACTIVITY_WEBHOOK_SECRET` header.
- **Async error handling**: `asyncHandler` wrapper on routes, try/catch in Discord event handlers.

### TODOs/FIXMEs Found

| Location | Comment |
|----------|---------|
| `web/server.js:56` | "TODO: Add persistent SQLite store later if needed" |

---

## 2. DOCUMENTATION ACCURACY (Commands Tab)

**Location:** `web/public/portal.js` lines 1278-1325

### Commands Listed in Portal That DON'T EXIST in Code

| Portal Command | Status | Notes |
|----------------|--------|-------|
| `/mission join` | **DOES NOT EXIST** | Should be `/heist`. No mission command file exists. |
| `/mission status` | **DOES NOT EXIST** | See above |
| `/mission list` | **DOES NOT EXIST** | See above |
| `/roles claim` | **DOES NOT EXIST** | No roles command file in commands/ |
| `/admin users` | **DOES NOT EXIST** | No standalone admin command exists |
| `/admin sync` | **DOES NOT EXIST** | Admin functions are in other commands |
| `/admin settings` | **DOES NOT EXIST** | See above |

### Commands That EXIST in Code But Are MISSING from Portal

| Command | File | Notes |
|---------|------|-------|
| `/config` | `commands/config/config.js` | Subcommands: `modules`, `toggle`, `settings`. Completely undocumented. |
| `/heist` | `commands/heist/heist.js` | Portal incorrectly calls it `/mission`. Real subcommands: `view`, `signup`, `status`, `admin create`, `admin list`, `admin cancel` |
| `/og-config` | `commands/admin/ogConfig.js` | Deprecated (redirects to `/verification admin og-*`) but still registered |

### Commands with INACCURATE Descriptions

| Command | Issue |
|---------|-------|
| `/battle` | Portal shows one simple subcommand. Actual code has: `create`, `start`, `cancel`, `stats` with options like `max_players`, `required_role_1/2/3`, `excluded_role_1/2/3` |
| `/governance propose` | Portal lists `duration` as a required option — **this parameter does not exist in code** (`governance.js:19-26`). Only `title` and `description` exist. |
| `/verification` | Portal lists only `verify` and `status`. Code has 4 subcommands: `status`, `wallets`, `refresh`, `quick` |
| `/treasury` | Portal lists `balance` and `transactions`. Actual user command is `view`. Entire admin subgroup (`status`, `refresh`, `enable`, `disable`, `set-wallet`, `set-interval`, `tx-history`, `tx-alerts`) is undocumented. |

### Summary Matrix

| Command | In Code? | In Portal? | Accurate? |
|---------|----------|------------|-----------|
| `/battle` | Yes | Yes | **No** — oversimplified |
| `/governance` | Yes | Yes | **No** — phantom `duration` param |
| `/heist` | Yes | No (called `/mission`) | N/A |
| `/treasury` | Yes | Yes | **No** — wrong subcommand names, missing admin cmds |
| `/verification` | Yes | Yes | **No** — incomplete subcommands |
| `/config` | Yes | No | N/A |
| `/og-config` | Yes (deprecated) | No | N/A |
| `/mission` | **No** | Yes | **No** — doesn't exist |
| `/roles` | **No** | Yes | **No** — doesn't exist |
| `/admin` | **No** | Yes | **No** — doesn't exist |

---

## 3. RECOMMENDED FIX PRIORITY

### Immediate (before production)
1. Add `express-rate-limit` middleware to public and auth endpoints
2. Fix query param validation (add bounds checking on limit/offset)
3. Expand env var validation to cover OAuth-required variables
4. Fail startup if `SESSION_SECRET` is the default value in production

### Short-term
5. Implement persistent session store (SQLite or Redis)
6. Update Commands tab in portal.js to match actual slash commands
7. Remove phantom commands (`/mission`, `/roles`, `/admin`) from portal
8. Add `/config` and `/heist` documentation to portal
9. Clear Discord access token from session after OAuth callback

### Housekeeping
10. Guard or remove `console.log` calls in portal.js
11. Add path param format validation (return 404 for invalid IDs)
12. Unregister deprecated `/og-config` command via deploy-commands.js
