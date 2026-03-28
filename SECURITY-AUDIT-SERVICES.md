# Security Audit Report: services/

**Auditor:** Claude Opus 4.6 (1M context)
**Date:** 2026-03-28
**Scope:** All 15 files in `/home/tjdot/roland-discord-bot/services/*.js`
**Files audited:** missionService.js, ogRoleService.js, microVerifyService.js, vpService.js, walletService.js, roleClaimService.js, battleService.js, nftActivityService.js, treasuryService.js, proposalService.js, superadminService.js, ticketService.js, nftService.js, roleService.js, tenantService.js

---

## Summary

| Category | Count | Severity |
|---|---|---|
| SQL Injection | 0 confirmed, 5 fragile patterns | Low |
| Missing Input Validation | 13 findings | Medium-High |
| Race Conditions (TOCTOU) | 6 findings | Critical |
| Missing Transactions | 10 findings | High |
| N+1 Query Patterns | 6 findings | Medium |
| Unbounded Queries | 14 findings | Medium |
| Error Handling Gaps | 9 findings | Medium |
| Memory / Caching | 5 findings | Low |
| Hardcoded Values | 10 findings | Low |
| Dead Code | 11 findings | Low |
| Type Coercion Bugs | 0 findings | N/A |
| Missing Null Checks | 4 findings | Medium |

---

## 1. SQL Injection

**No traditional SQL injection found.** All files use parameterized queries consistently.

### Fragile Dynamic SQL Patterns (safe today, brittle)

| File | Line | Code | Risk |
|---|---|---|---|
| `nftActivityService.js` | 31 | `` `UPDATE ... SET ${updates.join(', ')} WHERE id = ?` `` | Column names from hardcoded conditionals (lines 24-27). Safe but fragile. |
| `nftActivityService.js` | 110 | `` `UPDATE ... SET ${setClauses.join(', ')} WHERE id = ?` `` | Column names from `fieldMap` allowlist (lines 89-98). Safe but fragile. |
| `treasuryService.js` | 157 | `` `UPDATE treasury_config SET ${updates.join(', ')} WHERE id = ?` `` | Column names from hardcoded conditionals. Safe. |
| `ticketService.js` | 172 | `` `UPDATE ticket_categories SET ${fields.join(', ')} WHERE id = ?` `` | Column names hardcoded. Safe. |
| `ticketService.js` | 595-612 | Dynamic WHERE clause construction in `getAllTickets()` | All values parameterized. Safe. |

---

## 2. Missing Input Validation

### High Severity

| File | Line | Function | Issue |
|---|---|---|---|
| `walletService.js` | 5-39 | `linkWallet()` | `walletAddress` not validated as valid Solana base58. Any string accepted. |
| `microVerifyService.js` | 49-68 | `updateConfig()` | Modifies `process.env` directly. Values not validated (e.g., TTL could be set to negative or non-numeric). |
| `proposalService.js` | 213 | `castVote()` | `choice` parameter not validated against `['yes', 'no', 'abstain']`. Any string stored. |
| `tenantService.js` | 480 | `setTenantModule()` | `moduleKey` not validated against `ALL_MODULE_KEYS`. Arbitrary keys can be inserted into `tenant_modules`. |

### Medium Severity

| File | Line | Function | Issue |
|---|---|---|---|
| `missionService.js` | 12-19 | `createMission()` | No validation on `title`, `description`, `totalSlots`, `rewardPoints`. Negative values accepted. |
| `missionService.js` | 83-127 | `signupForMission()` | `nftMint`, `nftName`, `walletAddress` not checked for empty/null. |
| `proposalService.js` | 55-73 | `createProposal()` | No length validation on `title`/`description`. Extremely long strings stored. |
| `battleService.js` | 303 | `createLobby()` | `minPlayers`/`maxPlayers` not validated for sane ranges (0, -1 accepted). |
| `nftActivityService.js` | 161 | `ingestEvent()` | No schema validation or size limit on raw event payload stored as JSON. |
| `ogRoleService.js` | 66 | `setRole()` | `roleId` not validated as valid Discord snowflake. |
| `roleService.js` | 97 | `addRoleVPMapping()` | `votingPower` not validated as positive integer. |
| `superadminService.js` | 69 | `addSuperadmin()` | `userId` trimmed but not validated as 17-20 digit Discord snowflake. |
| `ticketService.js` | 280 | `createTicket()` | `templateResponses` stored as JSON without size limit. |

---

## 3. Race Conditions (TOCTOU) -- CRITICAL

### 3.1 Mission Signup (missionService.js:83-127)
```js
// Line 94: Check slots
if (mission.filled_slots >= mission.total_slots) { ... }
// Line 98: Check existing participant
const existing = db.prepare('SELECT * ...').get(missionId, participantId);
// Line 106: Insert participant
db.prepare('INSERT INTO mission_participants ...').run(...);
// Line 112: Increment counter
db.prepare('UPDATE missions SET filled_slots = filled_slots + 1 ...').run(missionId);
```
**Impact:** Two concurrent signups can both pass the slot check and both insert, exceeding `total_slots`.

### 3.2 Wallet Linking (walletService.js:5-39)
```js
// Line 13: Check wallet exists
const existingWallet = db.prepare('SELECT * FROM wallets WHERE wallet_address = ?').get(walletAddress);
// Line 26: Insert wallet
db.prepare('INSERT INTO wallets ...').run(discordId, walletAddress, isPrimary);
```
**Impact:** Concurrent calls with same wallet can both pass existence check and link to different users.

### 3.3 Ticket Number Generation (ticketService.js:269-278)
```js
// Line 270: Read current value
const row = db.prepare('SELECT value FROM ticket_sequences WHERE name = ?').get('ticket');
// Line 276: Write incremented value
db.prepare('UPDATE ticket_sequences SET value = ? WHERE name = ?').run(next, 'ticket');
```
**Impact:** Concurrent ticket creation generates duplicate ticket numbers.

### 3.4 Proposal ID Generation (proposalService.js:48-50)
```js
const count = db.prepare('SELECT COUNT(*) as count FROM proposals').get().count;
return `P-${String(count + 1).padStart(3, '0')}`;
```
**Impact:** COUNT-based ID generation collides on concurrent creates and after deletions.

### 3.5 Mission ID Generation (missionService.js:7-10)
Same COUNT-based pattern as above. Same issues.

### 3.6 Micro-Verify Amount Collision (microVerifyService.js:99-111)
```js
// Generate amount, check collision, then insert -- gap between check and insert
do {
  amount = this.generateUniqueAmount();
  const collision = db.prepare('SELECT id ... WHERE assigned_amount = ?').get(amount);
  if (!collision) break;
} while (attempts < 10);
db.prepare('INSERT INTO user_verify_amounts ...').run(discordId, username, amount);
```
**Impact:** Two concurrent users could receive identical verification amounts, causing wrong wallet to be linked.

### 3.7 Wallet Favorite Setting (walletService.js:109-129)
```js
// Line 119: Unset all favorites
db.prepare('UPDATE wallets SET is_favorite = 0 WHERE discord_id = ?').run(discordId);
// Line 122: Set new favorite
db.prepare('UPDATE wallets SET is_favorite = 1 WHERE discord_id = ? AND wallet_address = ?').run(...);
```
**Impact:** Concurrent calls could leave user with zero or multiple favorites.

---

## 4. Missing Database Transactions

| File | Lines | Function | Operations That Should Be Atomic |
|---|---|---|---|
| `missionService.js` | 106-119 | `signupForMission()` | INSERT participant + UPDATE filled_slots + UPDATE status |
| `walletService.js` | 5-39 | `linkWallet()` | INSERT user + SELECT wallet + INSERT wallet |
| `microVerifyService.js` | 269-303 | `verifyRequest()` | UPDATE request status + linkWallet() |
| `proposalService.js` | 237-263 | `castVote()` | INSERT/UPDATE vote + updateProposalTally() + checkAutoClose() |
| `proposalService.js` | 485-519 | `closeVote()` | UPDATE status + Discord posting (partial) |
| `ticketService.js` | 269-278 | `_nextTicketNumber()` | SELECT + UPDATE sequence |
| `battleService.js` | 474-487 | `cancelBattle()` | UPDATE lobby status + DELETE participants |
| `battleService.js` | 489-743 | `simulateBattle()` | Dozens of UPDATE statements during simulation |
| `tenantService.js` | 98-178 | `ensureTenant()` | 6+ INSERT/UPDATE across tenants, modules, branding, limits |
| `tenantService.js` | 384-446 | `applyPlanBundle()` | UPDATE tenants + loop INSERT tenant_modules + INSERT tenant_limits |

---

## 5. N+1 Query / API Call Patterns

| File | Lines | Function | Issue |
|---|---|---|---|
| `nftService.js` | 156-163 | `countNFTsForWallets()` | Loops through wallets, calling `getNFTsForWallet()` (Helius API) per wallet |
| `nftService.js` | 165-171 | `getAllNFTsForWallets()` | Same loop pattern, one API call per wallet |
| `roleService.js` | 419-448 | `getAllVerifiedUsers()` | Calls `walletService.getLinkedWallets(member.id)` per guild member |
| `ogRoleService.js` | 190-203 | `syncRoles()` | Calls `guild.members.fetch()` per eligible user in a loop |
| `battleService.js` | 728-732 | Post-simulation stats | `updateStats()` called per participant (SELECT + INSERT/UPDATE each) |
| `tenantService.js` | 293-300 | `listTenants()` | `buildTenantShape()` per row executes 3 additional queries (branding, limits, modules) |

---

## 6. Unbounded Queries (Missing LIMIT)

| File | Line | Query |
|---|---|---|
| `missionService.js` | 44 | `SELECT * FROM missions WHERE status = ?` |
| `missionService.js` | 131 | `SELECT m.*, mp.* ... WHERE mp.participant_id = ?` |
| `missionService.js` | 153 | `SELECT * FROM mission_participants WHERE mission_id = ?` |
| `proposalService.js` | 179 | `SELECT * FROM users WHERE total_nfts > 0` |
| `proposalService.js` | 182 | `SELECT * FROM role_vp_mappings` |
| `proposalService.js` | 523 | `getActiveProposals()` -- no LIMIT |
| `proposalService.js` | 527 | `getConcludedProposals()` -- no LIMIT |
| `proposalService.js` | 700-705 | `SELECT * FROM proposals WHERE status = 'draft' AND created_at < ?` |
| `ticketService.js` | 583 | `getOpenTickets()` -- no LIMIT |
| `ticketService.js` | 587 | `getTicketsByUser()` -- no LIMIT |
| `ticketService.js` | 591 | `getTicketsByCategory()` -- no LIMIT |
| `ticketService.js` | 595-612 | `getAllTickets()` -- no LIMIT |
| `roleService.js` | 440-442 | `SELECT * FROM users WHERE total_nfts > 0` |
| `tenantService.js` | 281-291 | `listTenants()` -- no LIMIT |

---

## 7. Error Handling Gaps

| File | Line | Issue |
|---|---|---|
| `ogRoleService.js` | 15 | `fs.existsSync()` + `fs.readFileSync()` TOCTOU: file could be deleted between check and read |
| `roleClaimService.js` | 14 | Same `existsSync` + `readFileSync` TOCTOU |
| `microVerifyService.js` | 431 | `global.discordClient` accessed without initialization guarantee |
| `treasuryService.js` | 427 | `global.discordClient` accessed without initialization guarantee |
| `nftActivityService.js` | 240 | `global.discordClient` accessed without initialization guarantee |
| `battleService.js` | 714 | If 100-round safety break triggers with >1 player, `alivePlayers[0]` used as "winner" arbitrarily |
| `walletService.js` | 10-26 | If wallet INSERT throws, user record created on line 10 becomes orphaned |
| `ticketService.js` | 555-563 | `deleteTicket()`: if `channel.delete()` throws, ticket already marked 'deleted' in DB |
| `proposalService.js` | 48-50 | `generateProposalId()` will produce duplicate IDs if proposals are deleted |

---

## 8. Memory / Unbounded Caching

| File | Line | Issue |
|---|---|---|
| `ogRoleService.js` | 10 | `this.config` loaded once at construction, never refreshed on external file changes |
| `roleClaimService.js` | 9 | `this.config` loaded once, cached forever |
| `roleService.js` | 8-10 | `traitRolesConfig`, `tiersConfig`, `collectionsConfig` cached in memory indefinitely |
| `nftService.js` | 10-11 | `_heliusQueue` promise chain grows indefinitely (resolved promises should be GC'd but pattern is suboptimal) |
| `battleService.js` | 492-700 | `rounds` array accumulates all round data in memory. With 100 rounds, this could be large |

---

## 9. Hardcoded Values

| File | Line | Value | Recommendation |
|---|---|---|---|
| `treasuryService.js` | 7 | `USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'` | Make configurable via env var for devnet/testnet |
| `proposalService.js` | 8-15 | `DEFAULT_TIER_VP` hardcoded tier names and VP values | Move to config file |
| `microVerifyService.js` | 17 | `'https://api.mainnet-beta.solana.com'` fallback RPC | Already env-configurable, but fallback is mainnet |
| `nftService.js` | 26 | Same hardcoded RPC fallback | Same |
| `treasuryService.js` | 6 | Same hardcoded RPC fallback | Same |
| `ogRoleService.js` | 24 | Default limit `100`, version `1` | Minor, acceptable defaults |
| `battleService.js` | 710 | Safety break at `roundNum > 100` | Consider making configurable |
| `battleService.js` | 391 | `max_players < 999` magic number for "unlimited" | Use `Infinity` or a constant |
| `ticketService.js` | 59 | `_fetchAllMessages` limit `500` | Consider making configurable |
| `nftActivityService.js` | 294 | Max 100 events in `listEvents()` | Minor, reasonable cap |

---

## 10. Dead Code

### Exported functions never called from outside their own service file:

| File | Line | Function | Evidence |
|---|---|---|---|
| `battleService.js` | 779-818 | `getRandomAttackLine()`, `getRandomCritLine()`, `getRandomDeathLine()`, `getRandomTauntLine()`, `getRandomTrashTalkLine()`, `getRandomDodgeLine()`, `getRandomComebackLine()`, `getRandomFlavorLine()`, `getRandomLuckyEscapeLine()` | Only referenced within `battleService.js` itself (in `simulateBattle`), never imported externally. These public getter methods are dead -- the simulation uses the arrays directly. |
| `vpService.js` | 31-33 | `getTotalVPInSystem()` | Not called from any non-.OLD file |
| `vpService.js` | 35-38 | `meetsQuorum()` | Not called from any non-.OLD file (proposalService implements its own quorum check) |

### Legacy compatibility methods:

| File | Line | Function | Notes |
|---|---|---|---|
| `proposalService.js` | 77-79 | `createProposalLegacy()` | Called from `commands/verification/verification.js` -- still in use |
| `roleService.js` | 365-390 | `assignDiscordRole()` | Called from `commands/verification/verification.js` -- still in use |
| `roleService.js` | 395-414 | `removeAllTierRoles()` | Called from `commands/verification/verification.js` -- still in use |

---

## 11. Type Coercion Bugs

**No loose equality (`==`) found anywhere in the services directory.** All comparisons use strict equality (`===`). This is good.

However, there are implicit type coercion risks:

| File | Line | Issue |
|---|---|---|
| `treasuryService.js` | 320 | `config.enabled === 1` -- works correctly since SQLite stores booleans as integers |
| `proposalService.js` | 444-446 | `v.vp` from SQL SUM could be `null` if no votes of that type exist. Assigned directly to `yesVP`/`noVP`/`abstainVP`. Should default to `0`. |
| `nftActivityService.js` | 229 | `cfg.enabled !== 1` -- relies on SQLite integer representation. Correct but brittle. |

---

## 12. Missing Null/Undefined Checks

| File | Line | Issue |
|---|---|---|
| `proposalService.js` | 460-467 | `checkAutoClose()` uses `proposal.yes_vp + proposal.no_vp + proposal.abstain_vp` without null checks. If any are NULL from DB, result is `NaN`. |
| `proposalService.js` | 490 | `closeVote()` same issue: `proposal.yes_vp + proposal.no_vp + proposal.abstain_vp` without null guards |
| `vpService.js` | 44 | `hasVotePassed()`: `yesVP / (yesVP + noVP)` divides by zero if both are 0 (abstainVP > 0 but yesVP and noVP both 0). Returns `NaN`, not `false`. |
| `missionService.js` | 117 | `updatedMission.filled_slots` could be undefined if `getMission` returns null (e.g., DB error). No null check on `updatedMission`. |

---

## Recommendations (Priority Order)

### P0 -- Critical (fix immediately)
1. **Wrap multi-step writes in transactions** -- especially `signupForMission`, `linkWallet`, `_nextTicketNumber`, `castVote`, `cancelBattle`, `simulateBattle`, `ensureTenant`, `applyPlanBundle`
2. **Replace COUNT-based ID generation** with auto-increment or UUID for `generateProposalId()` and `generateMissionId()`
3. **Validate wallet addresses** in `linkWallet()` before storing
4. **Validate vote choice** in `castVote()` against allowed values

### P1 -- High (fix soon)
5. Add input validation for all user-facing parameters (lengths, types, ranges)
6. Add LIMIT clauses to all unbounded queries (especially `getAllTickets`, `getActiveProposals`, `getConcludedProposals`, `listTenants`)
7. Validate `moduleKey` against `ALL_MODULE_KEYS` in `setTenantModule()`
8. Add null guards for VP arithmetic in proposalService

### P2 -- Medium (address in next sprint)
9. Batch N+1 patterns where possible (especially `getAllVerifiedUsers`, `listTenants`)
10. Remove dead code (9 unused `getRandomXxxLine()` methods in battleService, unused vpService methods)
11. Replace `global.discordClient` pattern with proper dependency injection

### P3 -- Low (backlog)
12. Make hardcoded values configurable (USDC_MINT, DEFAULT_TIER_VP, RPC fallbacks)
13. Replace `existsSync` + `readFileSync` with try/catch around `readFileSync` directly
14. Add config cache invalidation or file watching for ogRoleService, roleClaimService, roleService
