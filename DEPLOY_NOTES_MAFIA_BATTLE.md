# Mafia Battle v0.1 - Deployment Notes

## 🎯 What Was Built

Discord-native battle system with reaction-based lobby join flow:

### Features Implemented
1. **`/battle create [max_players]`** - Creates lobby embed with ⚔️ reaction
2. **Reaction Join/Leave** - Users join by reacting, leave by un-reacting
3. **`/battle start`** - Creator starts turn-based combat simulation
4. **`/battle stats [user]`** - View battle record
5. **`/battle cancel`** - Creator cancels open lobby

### Battle Mechanics
- Each player: 100 HP
- Damage: 10-30 per round, 20% crit chance (40-50 damage)
- Random attacker/defender each round
- Last alive wins
- Mafia-themed flavor text ("sleeps with the fishes", "concrete shoes", etc.)

### Data Persistence
Three new SQLite tables:
- `battle_lobbies` - Active/completed lobbies
- `battle_participants` - Player state (HP, damage dealt)
- `battle_stats` - Win/loss records per user

## 📦 Files Changed

**New Files:**
- `database/battleDb.js` - Battle table schemas
- `services/battleService.js` - Battle logic + flavor text
- `commands/battle/battle.js` - Command handler with subcommands

**Modified:**
- `index.js` - Added `GuildMessageReactions` intent, `Partials`, reaction event handlers

## 🚀 Deployment Steps

### 1. Pull Latest Code
```bash
cd /path/to/roland-discord-bot
git pull
```

### 2. Install Dependencies (if needed)
```bash
npm install
# (no new deps required, uses existing discord.js + better-sqlite3)
```

### 3. Deploy Commands
```bash
node deploy-commands.js
# Registers /battle with Discord API (instant if GUILD_ID set, up to 1hr global)
```

### 4. Restart Bot
```bash
pm2 restart guildpilot
# OR: systemctl restart guildpilot
# OR: kill + relaunch with your preferred process manager
```

### 5. Verify
Test in Discord:
```
/battle create
(React with ⚔️ to join)
/battle start
/battle stats
```

## ⚙️ Configuration

**No new env vars required.**

Uses existing:
- `DISCORD_TOKEN`
- `CLIENT_ID`
- `GUILD_ID` (optional, for faster command deployment)

**Default Settings:**
- Min players: 2
- Max players: 8 (configurable per lobby)
- Battle rounds: Auto-batched every 3 rounds to reduce spam

## 🔧 Technical Notes

### Intents Added
- `GatewayIntentBits.GuildMessageReactions`
- `Partials.Message`, `Partials.Channel`, `Partials.Reaction`

### Reaction Handling
- Automatically updates lobby embed when users join/leave
- Prevents bots from joining
- Enforces max player limits
- Removes invalid reactions (lobby full, already started)

### Combat Simulation
- Fully server-side (no client input after start)
- Deterministic with RNG for variety
- Updates DB in real-time (HP, damage, alive status)
- Posts results in batches (3 rounds at a time) to avoid spam

### Database
- Uses existing `guildpilot.db`
- Safe `CREATE TABLE IF NOT EXISTS` migrations
- Indexed by `lobby_id`, `user_id`, `status`

## 🎮 User Flow

1. Creator: `/battle create` → Lobby embed appears with ⚔️
2. Players: React with ⚔️ to join
3. Embed auto-updates with participant list
4. Creator: `/battle start` when ready (min 2 players)
5. Bot simulates combat, posts round-by-round narration
6. Winner announced, stats updated
7. View record with `/battle stats`

## 🛡️ Safety & Compatibility

- ✅ Backward compatible (no changes to existing commands)
- ✅ Heist system untouched
- ✅ No breaking changes to database schema
- ✅ Safe to deploy alongside existing features
- ✅ Graceful error handling (lobby not found, already started, etc.)

## 📊 Post-Deployment

After restart, verify:
- Bot logs show "Battle tables initialized successfully"
- `/battle` command autocompletes in Discord
- Reactions trigger join/leave events
- Combat simulation completes without errors
- Stats persist across battles

## 🐛 Troubleshooting

**Command not showing:**
- Re-run `node deploy-commands.js`
- Wait up to 1 hour if deployed globally
- Check `CLIENT_ID` and `GUILD_ID` in `.env`

**Reactions not working:**
- Verify bot has `Add Reactions` permission in channel
- Check logs for "Failed to add reaction" errors
- Ensure intents are enabled in Discord Developer Portal

**Database errors:**
- Run `sqlite3 database/guildpilot.db ".tables"` to verify tables exist
- Check file permissions on `guildpilot.db`

## 📝 Future Enhancements (Not in v0.1)

Ideas for future iterations:
- Betting/rewards system
- Power-ups (brass knuckles, tommy gun, etc.)
- Team battles (Family vs Family)
- Leaderboard rankings
- Custom duel challenges
- Integration with NFT holdings for bonuses

---

**Version:** 0.1  
**Commit:** `Mafia Battle v0.1: reaction-join lobby, turn combat, winner + stats`  
**Date:** 2026-03-24  
**Status:** ✅ Ready for deployment
