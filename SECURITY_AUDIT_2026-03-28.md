# Security Audit Report - 2026-03-28

Auditor: Automated Claude Code Security Audit
Scope: Commands, Frontend, Middleware, Utilities, Scripts, Config

---

## CRITICAL FINDINGS

### 1. DOM XSS via unescaped innerHTML (portal.js)

**Severity: HIGH**

Several `innerHTML` assignments inject `e.message` or `error.message` without `escapeHtml()`. If an attacker can control the error message (e.g., a crafted API response), script can be injected.

- **portal.js:1688** - `content.innerHTML = \`...Error loading treasury: ${e.message}...\``
- **portal.js:1729** - `content.innerHTML = \`...Error loading transactions...\`` (no escapeHtml)
- **portal.js:1794** - `container.innerHTML = '...Error loading wallet data...'` (hardcoded, safe, but inconsistent)
- **portal.js:207** - `showError('Verification failed: ' + (error.message || 'Unknown error'))` -- if `showError` uses innerHTML internally, this is injectable
- **portal.js:291** - Same pattern for micro-tx verification error

**Recommendation:** Always wrap user/server-derived strings in `escapeHtml()` before innerHTML assignment. Audit every innerHTML call that includes `${...}` interpolation without escapeHtml.

### 2. Hardcoded Solana RPC Endpoint (portal.js)

**Severity: MEDIUM**

- **portal.js:251** - `new Connection('https://api.mainnet-beta.solana.com', 'confirmed')`

This is the public Solana RPC which has rate limits. Should be configurable via environment or server-side proxy to avoid rate-limiting and to hide RPC provider from client.

### 3. CDN Script Loaded Without Integrity Hash (portal.js)

**Severity: MEDIUM**

- **portal.js:247** - `await loadScript('https://unpkg.com/@solana/web3.js@latest/lib/index.iife.min.js')`

Loading `@latest` from unpkg with no SRI (subresource integrity) hash. A supply chain compromise of unpkg or @solana/web3.js would allow arbitrary code execution on the portal page. Should pin a specific version and add an `integrity` attribute.

---

## HIGH FINDINGS

### 4. Settings Debug console.log Statements Leaking Internal State (portal.js)

**Severity: MEDIUM-HIGH**

- **portal.js:3698** - `console.log(\`[Settings] Channel select ps_${id} in DOM:\`, !!sel)`
- **portal.js:3701** - `console.log('[Settings] Fetching /api/admin/discord/channels...')`
- **portal.js:3703** - `console.log('[Settings] Channels response status:', channelsRes.status, channelsRes.ok)`
- **portal.js:3706** - `console.log('[Settings] Channels response:', channelsJson.success, 'count:', ...)`
- **portal.js:3727** - `console.log('[Settings] Channel groups:', Object.keys(grouped).length, ...)`
- **portal.js:3751** - `console.log(\`[Settings] Set ps_${id} selected value:\`, s[id], ...)`
- **portal.js:3754** - `console.log('[Settings] Channel dropdowns populated successfully')`

These leak API response structure, channel IDs, and internal DOM state to the browser console. An attacker inspecting the console sees internal API paths and response shapes.

**Recommendation:** Remove or gate behind a debug flag (e.g., `if (window.__DEBUG)`) before production.

### 5. Race Condition: Battle Lobby Creation (battle.js)

**Severity: MEDIUM-HIGH**

- **battle.js:224-229** - Check-then-act pattern: queries for existing lobby, then creates a new one. Between the SELECT and the INSERT, another user could create a lobby in the same channel, resulting in duplicate active battles. SQLite's single-writer lock mitigates this partially, but the JS code does not use a transaction.

**Recommendation:** Wrap the check + insert in a single SQLite transaction, or use an INSERT with a WHERE NOT EXISTS clause.

### 6. Mock Mode Auto-Registration in Production (verification.js)

**Severity: MEDIUM-HIGH**

- **verification.js:346-353** - If `MOCK_MODE=true` is accidentally left enabled, any user who runs `/verification status` gets auto-verified with a random mock wallet and assigned real Discord roles. There is no guard preventing this in production.

**Recommendation:** Add startup warning or refuse to start if `MOCK_MODE=true` and `NODE_ENV=production`.

---

## MEDIUM FINDINGS

### 7. Error Messages Expose Internal Details to Discord Users

- **heist.js:144** - `content: \`Something went wrong: ${error.message}\``
- **treasury.js:158** - Same pattern
- **battle.js:183** - Same pattern
- **governance.js:153** - Same pattern
- **verification.js:323** - Same pattern

All command error handlers send `error.message` directly to the user. Internal errors (DB errors, service crashes) could leak table names, file paths, or stack traces to Discord.

**Recommendation:** Log the full error server-side, return a generic "An error occurred" message to the user.

### 8. Governance Settings Imported from Static JSON (governance.js)

**Severity: MEDIUM**

- **governance.js:4** - `const settings = require('../../config/settings.json')`

This imports settings at module load time. If settings.json is updated at runtime (e.g., via the admin panel), the cached `require()` value will not reflect changes until the process restarts. Other commands use `settingsManager` (a live service) instead.

**Recommendation:** Replace with `settingsManager.getSetting(...)` for consistent runtime behavior.

### 9. Missing Wallet Address Validation (treasury.js)

**Severity: MEDIUM**

- **treasury.js:293** - `const address = interaction.options.getString('address')` -- The raw string is passed to `treasuryService.updateConfig({ solanaWallet: address })` with no Solana address format validation in the command handler itself. Validation may exist in the service, but defense-in-depth requires validation at the input boundary.

**Recommendation:** Use `isValidSolanaAddress()` from `utils/collectionResolver.js` before passing to the service.

### 10. Admin Panel handleAdminPanel Does Not Defer Reply (verification.js)

**Severity: MEDIUM**

- **verification.js:553-592** - `handleAdminPanel` sends a message to the channel and then calls `interaction.reply()`, but does NOT call `deferReply()` first. If `channel.send()` takes more than 3 seconds (e.g., slow API, rate limit), the interaction will timeout and the user gets "This interaction failed."

**Recommendation:** Add `await interaction.deferReply({ ephemeral: true })` at the start, then use `editReply`.

### 11. Superadmin Guard Missing CSRF Protection (middleware/superadminGuard.js)

**Severity: MEDIUM**

- **superadminGuard.js:1-17** - Relies solely on `req.session?.discordUser?.id` for authentication. There is no CSRF token validation. State-changing POST requests from the admin panel (tenant updates, user deletion) could be triggered by a malicious page if the admin has an active session.

**Recommendation:** Add CSRF token middleware (e.g., `csurf` or custom header check like `X-Requested-With`).

### 12. moduleGate Bypasses When Multitenant is Disabled (middleware/moduleGate.js)

**Severity: LOW-MEDIUM**

- **moduleGate.js:15-16** - If `tenantService.isMultitenantEnabled()` returns false, the gate returns `true` for everything regardless of module toggle state. This means in single-tenant mode, the middleware never blocks anything -- the blocking falls to `moduleGuard.js` in the command layer only. Web API routes using `moduleGate` alone would be unprotected.

**Recommendation:** Ensure moduleGate also checks the global toggle when multitenant is off, or document this as intended.

---

## LOW FINDINGS

### 13. Logger Has No Log Level Gating (utils/logger.js)

- **logger.js:1-23** - All log levels (debug, info, warn, error) always emit to stdout/stderr. In production, debug logs should be suppressed.

### 14. OG Config Has Dummy Role ID (config/og-role.json)

- **og-role.json:3** - `"roleId": "r1"` -- This looks like a placeholder/test value, not a real Discord snowflake. If the OG system is enabled, it will try to assign a nonexistent role.

### 15. Dead Code: Legacy ogConfig.js Command (commands/admin/ogConfig.js)

- **ogConfig.js:1-216** - Entire file is marked DEPRECATED (line 7). Still registered as a command, consuming a slash command slot and adding maintenance burden. The functionality is duplicated in verification.js admin subcommands.

**Recommendation:** Remove after confirming no users depend on it.

### 16. Voting Power Table in Help Docs Inconsistent with Config (portal.html)

- **portal.html:674-698** - Help section shows Associate=1VP, Soldier=2VP (2-4 NFTs), Capo=3VP (5-9), etc.
- **config/settings.json** and **config/roles.json** - Shows Associate=1VP (1-2 NFTs), Soldato=3VP (3-6 NFTs), Capo=6VP (7-14 NFTs), etc.

The help documentation is out of date with the actual tier configuration.

### 17. Swallowed Errors on Silent .catch(() => null) (portal.js)

- **portal.js:1100, 1102, 1110, 1112, 2952, 4047-4049, 5391-5392, 5709-5710**

Multiple fetch calls silently swallow errors with `.catch(() => null)`. While some of these are intentional fallbacks, they make debugging production issues harder. Network failures, 500 errors, and auth failures all disappear silently.

### 18. No Rate Limiting on Slash Commands

None of the command files implement cooldowns. Discord has built-in rate limits, but application-level abuse (e.g., spamming `/verification refresh` to trigger API calls) is not guarded.

### 19. Backup Script Retention Uses find -mtime (scripts/backup_db.sh)

- **backup_db.sh:31** - `find "$BACKUP_DIR" -maxdepth 1 -type f -name 'solpranos_*.db' -mtime +"$RETENTION_DAYS" -delete`

Correct usage, but no error handling if the find/delete fails. Also, `RETENTION_DAYS` from env is used directly in the find command without validation that it's a number.

### 20. Restore Script Path Injection Risk (scripts/restore_db.sh)

- **restore_db.sh:13** - `BACKUP_FILE="$1"` is used directly in `cp "$BACKUP_FILE" "$DB_PATH"`. While the script is interactive (requires typing "RESTORE"), the file path is not validated. A path like `../../etc/passwd` would be accepted.

**Recommendation:** Validate that `$1` exists within the expected backup directory.

---

## INFORMATIONAL

### Config Files (No Sensitive Data Found)
- `config/collections.json` - Clean, no secrets
- `config/roles.json` - Clean, role definitions only
- `config/module-toggles.json` - Clean, boolean toggles
- `config/settings.json` - Clean, governance/battle tuning params
- `config/trait-roles.json` - Clean, trait mappings with null roleIds
- `config/og-role.json` - Placeholder roleId "r1" (see finding #14)
- `config/role-claim.json` - Clean, empty array

### Scripts (Generally Well-Written)
- `scripts/healthcheck.sh` - Good: uses temp files, traps cleanup, validates responses
- `scripts/alert_pm2_restarts.sh` - Good: proper error handling
- `scripts/api-sanity-check.js` - Good: checks for sensitive data leaks in API responses
- `scripts/backup_db.sh` - Good: uses set -euo pipefail, Python sqlite backup API

### Positive Patterns Observed
- All slash commands properly defer replies (except handleAdminPanel)
- Admin commands consistently check permissions via moduleGuard.checkAdmin()
- Error handlers in commands properly check deferred/replied state before responding
- Frontend uses escapeHtml() in most innerHTML assignments
- API response utility has built-in sanitize() for sensitive fields
- Wallet addresses are redacted in user-facing embeds (export-user)
- Treasury view hides wallet address from public users

---

## Summary

| Severity | Count |
|----------|-------|
| Critical/High | 3 |
| High | 3 |
| Medium | 6 |
| Low | 8 |
| **Total** | **20** |

**Top 3 priorities:**
1. Fix innerHTML XSS vectors in portal.js (findings #1)
2. Pin CDN dependency version with SRI hash (finding #3)
3. Add CSRF protection to admin API routes (finding #11)
