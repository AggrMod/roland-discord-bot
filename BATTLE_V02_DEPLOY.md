# Battle v0.2 Deployment Guide

## ✅ Changes Committed & Pushed

Commit: `8635ed3`
Branch: `main`

## 🎯 What Changed

### Core Features
1. **Unlimited Player Lobbies** (default)
   - `max_players` parameter is now optional on `/battle create`
   - If omitted, lobby supports unlimited players (internal cap: 999)
   - If set, enforces that player cap

2. **Role-Gated Entry**
   - New optional `required_role` parameter on `/battle create`
   - Users without the required role:
     - Reaction is removed automatically
     - Optional DM notification (if DMs enabled)
   - Role requirement shown in lobby embed

3. **Rumble Royale-Style Round Feed**
   - Multi-event rounds (2-5 events per round)
   - Event distribution:
     - 60% combat (attacks/crits/eliminations)
     - 20% item finds (HP boosts, damage buffs)
     - 15% flavor events (no mechanical effect)
     - 5% lucky escapes (cheat death once)
   - Round embeds format:
     ```
     ⚔️ Round N
     • Event line 1
     • Event line 2
     • ...
     Players Left: X | Era: Solpranos
     ```

4. **Enhanced Event Variety**
   - 10+ attack lines
   - 4 crit lines
   - 5 death lines
   - 6 item find types (HP boosts + damage buff)
   - 7 flavor lines (cigars, phone calls, etc.)
   - 3 lucky escape lines

## 📋 Deployment Steps

### 1. Pull Latest Code
```bash
cd /path/to/roland-discord-bot
git pull origin main
```

### 2. Run Database Migration
```bash
node database/migrations/001_add_battle_role_gate.js
```

This migration:
- Adds `required_role_id` column to `battle_lobbies` table
- Updates existing open lobbies to unlimited (max_players = 999)

### 3. Redeploy Slash Commands
Commands have been modified, so you need to redeploy:

```bash
# If you have a deploy script:
node deploy-commands.js

# Or manually using Discord Developer Portal
# - Go to your app's Commands section
# - The changes should auto-sync on bot restart
```

### 4. Restart Bot
```bash
pm2 restart roland-bot
# OR
systemctl restart roland-bot
# OR your deployment method
```

### 5. Verify
Create a test battle and check:
- ✅ `/battle create` works without max_players (shows ∞)
- ✅ `/battle create max_players:5` caps at 5 players
- ✅ `/battle create required_role:@SomeRole` shows role requirement
- ✅ Users without required role get reaction removed
- ✅ Battle rounds show multiple events per round
- ✅ Round embeds show "Players Left: X"
- ✅ Item finds, lucky escapes, flavor events appear

## 🔧 Optional Configuration

None required - all features are opt-in via command parameters.

## 🐛 Rollback (if needed)

```bash
git revert 8635ed3
git push origin main
# Restart bot
```

Note: Database migration is additive (adds column), safe to leave in place.

## 📊 Monitoring

Check logs for:
- Battle creation with new params
- Role gate rejections
- Multi-event round generation
- Lucky escape triggers

## 🎮 Usage Examples

```
/battle create
→ Unlimited players, no role requirement

/battle create max_players:8
→ Classic 8-player cap, no role requirement

/battle create required_role:@Made Man
→ Unlimited players, must have "Made Man" role

/battle create max_players:12 required_role:@Capo
→ 12 player cap, must have "Capo" role
```

---

**Deployed By:** Claude  
**Date:** 2026-03-24  
**Version:** Battle v0.2
