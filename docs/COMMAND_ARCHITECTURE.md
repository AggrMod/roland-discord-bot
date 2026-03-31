# Command Architecture - Module-First Refactor

**Version**: 2.0 (Module-First)  
**Date**: March 25, 2026  
**Status**: Pre-Launch Refactor

## Executive Summary

This document outlines the new module-first command architecture for the GuildPilot Discord bot. All commands are now organized by functional module with user/admin subcommand groups, and all modules are toggleable.

---

## Module Structure Overview

```
/verification (user commands + admin subgroup)
/governance (user commands + admin subgroup)
/treasury (user commands + admin subgroup)
/battle (user commands + admin subgroup)
/heist (toggleable, default: disabled)
/config (system-wide admin controls)
```

---

## Command Inventory & Migration Map

### 1. VERIFICATION MODULE

**Module Toggle**: `verificationEnabled` (default: `true`)

#### User Commands (namespace: `/verification`)

| Old Command | New Command | Notes |
|------------|-------------|-------|
| `/verify` | `/verification status` | Renamed for clarity |
| `/wallet-list` | `/verification wallets` | Shortened name |
| `/refresh-roles` | `/verification refresh` | Simplified |
| `/micro-verify` | `/verification quick` | Clearer UX name |

**New structure**:
```
/verification status          - View verification status (old: /verify)
/verification wallets         - List linked wallets (old: /wallet-list)
/verification refresh         - Refresh roles (old: /refresh-roles)
/verification quick           - Quick micro-verification (old: /micro-verify)
```

#### Admin Commands (namespace: `/verification admin`)

| Old Command | New Command | Notes |
|------------|-------------|-------|
| `/verification create` | `/verification admin panel` | Clearer action name |
| `/verification exportuser` | `/verification admin export-user` | Keep similar |
| `/verification removeuser` | `/verification admin remove-user` | Keep similar |
| `/verification actions *` | `/verification admin actions *` | Move to admin namespace |
| `/verify-panel` | `/verification admin panel` | Consolidated |
| `/role-config` | `/verification admin role-config` | Consolidated |
| `/og-config` | `/verification admin og-config` | Consolidated |
| `/role-claim` | `/verification admin role-claim` | Consolidated |
| `/micro-verify-config` | `/verification admin micro-config` | Consolidated |
| `/export-wallets` | `/verification admin export-wallets` | Consolidated |

**New admin structure**:
```
/verification admin panel             - Post verification panel
/verification admin export-user       - Export user data
/verification admin remove-user       - Remove user from system
/verification admin actions list      - List verification actions
/verification admin actions add       - Add collection/token/trait action
/verification admin actions remove    - Remove verification action
/verification admin role-config       - Configure role assignments
/verification admin og-config         - Configure OG roles
/verification admin role-claim        - Manual role claim panel
/verification admin micro-config      - Configure micro-verification
/verification admin export-wallets    - Export all wallets
```

---

### 2. GOVERNANCE MODULE

**Module Toggle**: `governanceEnabled` (default: `true`)

#### User Commands (namespace: `/governance`)

| Old Command | New Command | Notes |
|------------|-------------|-------|
| `/propose` | `/governance propose` | Module-scoped |
| `/support` | `/governance support` | Module-scoped |
| `/vote` | `/governance vote` | Module-scoped |

**New structure**:
```
/governance propose           - Create new proposal
/governance support           - Support a draft proposal
/governance vote              - Vote on active proposal
```

#### Admin Commands (namespace: `/governance admin`)

| Old Command | New Command | Notes |
|------------|-------------|-------|
| `/settings` (governance parts) | `/governance admin settings` | Consolidated |
| N/A | `/governance admin list` | New: list all proposals |
| N/A | `/governance admin cancel` | New: cancel a proposal |

**New admin structure**:
```
/governance admin settings    - Configure governance settings
/governance admin list        - View all proposals (any status)
/governance admin cancel      - Cancel a proposal (emergency)
```

---

### 3. TREASURY MODULE

**Module Toggle**: `treasuryEnabled` (default: `true`)

#### User Commands (namespace: `/treasury`)

| Old Command | New Command | Notes |
|------------|-------------|-------|
| N/A | `/treasury view` | New: public treasury view |

**New structure**:
```
/treasury view                - View treasury balances (public read-only)
```

#### Admin Commands (namespace: `/treasury admin`)

| Old Command | New Command | Notes |
|------------|-------------|-------|
| `/treasury status` | `/treasury admin status` | Full admin view |
| `/treasury refresh` | `/treasury admin refresh` | Manual refresh |
| `/treasury enable` | `/treasury admin enable` | Toggle monitoring |
| `/treasury disable` | `/treasury admin disable` | Toggle monitoring |
| `/treasury set-wallet` | `/treasury admin set-wallet` | Configuration |
| `/treasury set-interval` | `/treasury admin set-interval` | Configuration |

**New admin structure**:
```
/treasury admin status        - View treasury status
/treasury admin refresh       - Manually refresh balances
/treasury admin enable        - Enable monitoring
/treasury admin disable       - Disable monitoring
/treasury admin set-wallet    - Set treasury wallet address
/treasury admin set-interval  - Set refresh interval
```

---

### 4. MINI-GAMES MODULE

**Module Toggle**: `battleEnabled` (default: `true`)
**Permission Gate**: All game commands require Moderator or Admin (ManageGuild, ManageMessages, ModerateMembers, or KickMembers).
**Plan Requirement**: Individual games = Starter (Free). Game Night = Growth+.

#### Commands

| Command | Game | Description |
|---|---|---|
| `/battle create/start/cancel/stats` | ⚔️ Battle Royale | HP-based lobby, role gating, Elite Four mode |
| `/higherlower start/cancel` | 🃏 Higher or Lower | Guess higher/lower, wrong = eliminated |
| `/diceduel start/cancel` | 🎲 Dice Duel | Lowest d6 roll eliminated each round |
| `/reactionrace start/cancel` | ⚡ Reaction Race | Last to react is eliminated each round |
| `/numberguess start/cancel` | 🔢 Number Guess | 3 rounds, closest to secret number wins |
| `/slots start/cancel` | 🎰 Slots | Simultaneous spins, best combo wins |
| `/trivia start/cancel` | ❓ Trivia | 5 Qs, react 🇦🇧🇨🇩, most correct wins |
| `/wordscramble start/cancel` | 🧩 Word Scramble | Type unscrambled word first, 5 rounds |
| `/rps start/cancel` | 🪨 RPS Tournament | Bracket; react 🪨✂️📄 per matchup |
| `/blackjack start/cancel` | 🎴 Blackjack | Beat dealer; 👆 hit / ✋ stand per turn |

All games:
- React with game emoji to join lobby (join window: 10–120s configurable)
- Require minimum 2 players to start
- Gate on `battleEnabled` module toggle
- Self-register with `services/gameRegistry.js` for lobby join routing

#### Admin Commands (namespace: `/battle admin`)

| Command | Description |
|---|---|
| `/battle admin list` | List all active battles |
| `/battle admin force-end` | Force end a battle (emergency) |
| `/battle admin settings` | Configure battle parameters |

```
/battle admin list            - List all active battles
/battle admin force-end       - Force end a battle (emergency)
/battle admin settings        - Configure battle parameters
```

---

### 5. HEIST MODULE

**Module Toggle**: `heistEnabled` (default: `false` - disabled)

#### User Commands (namespace: `/heist`)

| Old Command | New Command | Notes |
|------------|-------------|-------|
| `/heist-view` | `/heist view` | Renamed for consistency |
| `/heist-signup` | `/heist signup` | Renamed for consistency |
| `/heist-status` | `/heist status` | Renamed for consistency |

**New structure**:
```
/heist view                   - View available missions
/heist signup                 - Sign up for mission
/heist status                 - View your mission status
```

#### Admin Commands (namespace: `/heist admin`)

| Old Command | New Command | Notes |
|------------|-------------|-------|
| N/A | `/heist admin create` | New: create mission |
| N/A | `/heist admin list` | New: list all missions |
| N/A | `/heist admin cancel` | New: cancel mission |

**New admin structure**:
```
/heist admin create           - Create new heist mission
/heist admin list             - List all missions (any status)
/heist admin cancel           - Cancel a mission
```

---

### 6. CONFIG MODULE (System-Wide)

**New top-level admin commands for system configuration**

| Command | Description |
|---------|-------------|
| `/config modules` | View all module toggle states |
| `/config toggle` | Toggle a module on/off |
| `/config status` | System health & status |

**New structure**:
```
/config modules               - View module toggle states
/config toggle                - Toggle module on/off
/config status                - System status overview
```

---

## Module Toggle System

### Toggle Behavior

When a module is **disabled**:
1. ❌ All module commands return: `"This module is currently disabled. Contact an admin for access."`
2. 🚫 Portal sections for that module are hidden
3. ⏸️ Background jobs/schedulers for that module are paused
4. 🔕 No events/notifications from that module

When a module is **enabled**:
1. ✅ All commands function normally
2. 👁️ Portal sections visible
3. ▶️ Background jobs active
4. 🔔 Events/notifications active

### Persistent Storage

Module toggles stored in: `config/module-toggles.json`

```json
{
  "verificationEnabled": true,
  "governanceEnabled": true,
  "treasuryEnabled": true,
  "battleEnabled": true,
  "heistEnabled": false
}
```

---

## Implementation Notes

### Guard Middleware

All commands protected by:
1. **Module enabled check** (automatic)
2. **Admin check** (for admin subgroups)
3. **Voting power check** (for governance)
4. **Verification check** (for most user commands)

### Portal Integration

Portal navigation updated:
- Only show enabled modules
- Hide disabled module sections entirely
- Show toggle status in admin view

### Scheduler Integration

Services check module state before executing:
```javascript
if (!isModuleEnabled('governance')) {
  logger.log('Governance module disabled, skipping vote check');
  return;
}
```

---

## Deployment Checklist

- [ ] Redeploy slash commands (`node deploy-commands.js`)
- [ ] Restart bot process
- [ ] Verify module toggles in `/config modules`
- [ ] Test each module on/off behavior
- [ ] Check portal reflects module states
- [ ] Test admin guards
- [ ] Verify schedulers respect module state

---

## Solpranos Branding

All user-facing messages maintain Solpranos/mafia theming:
- "The Family" for community
- "Made member" for verified users
- "Associate" for unverified
- "Commission" for governance
- "Treasury" for funds
- "Battle" for competition
- "Heist" for missions

Module disabled message (with Solpranos flavor):
```
🚫 The [Module] business is closed right now. 
   Talk to the Don if you need access.
```

---

**End of Command Architecture Document**
