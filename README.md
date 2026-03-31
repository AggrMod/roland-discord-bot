# SOLPRANOS Discord Bot - Phase 1 MVP

Discord bot for the Solpranos NFT ecosystem featuring wallet verification, DAO governance, and heist missions.

## Features

### 🔐 Wallet Verification System
- Link multiple Solana wallets to Discord account
- Automatic NFT counting and tier assignment
- Role-based permissions (Associate → Don)
- Voting power calculation
- OG (Original/early member) role system with configurable limits
- Micro-verification via SOL micro-transfers

### 📡 NFT Activity Tracking
- Watch and monitor specific NFT collections
- Real-time activity alerts (mints, sells, lists, etc.)
- Configurable Discord channel posting with filters
- Event-type emoji badges for visual clarity
- Webhook ingest API for external event sources

### 🗳️ DAO Governance
- Create proposals with community support system
- Weighted voting based on NFT holdings
- Auto-promotion after 4 supporters
- Quorum checking (25% minimum)
- 7-day voting periods with auto-close

### 🎮 Mini-Games Suite (10 games)
> All game commands require **Moderator or Admin** permissions.
> Individual games: **Free**. Game Night orchestration: **Growth+**.

| Game | Command | Type |
|---|---|---|
| ⚔️ Battle Royale | `/battle` | HP-based elimination |
| 🃏 Higher or Lower | `/higherlower` | Card guessing, wrong = out |
| 🎲 Dice Duel | `/diceduel` | Lowest d6 roll eliminated |
| ⚡ Reaction Race | `/reactionrace` | Slowest to react is out |
| 🔢 Number Guess | `/numberguess` | Closest to secret number wins |
| 🎰 Slots | `/slots` | Best spin combo wins |
| ❓ Trivia | `/trivia` | Most correct answers wins |
| 🧩 Word Scramble | `/wordscramble` | First to unscramble wins |
| 🪨 RPS Tournament | `/rps` | Rock-paper-scissors bracket |
| 🎴 Blackjack | `/blackjack` | Beat the dealer |

All games use reaction-based lobbies. Players join by reacting with the game emoji.

### 🎉 Game Night (Growth plan)
Run a full multi-game session in sequence with cross-game scoring.

```
/gamenight start [join_time:90] [games:trivia,slots,rps,diceduel]
/gamenight skip          # host skips current game
/gamenight cancel        # host cancels
/gamenight leaderboard   # mid-session standings
```

**Scoring:** 🥇 1st=10pts · 🥈 2nd=7pts · 🥉 3rd=5pts · 4th=3pts · 5th+=1pt

At the end a champion is crowned with total points across all games.

### 🎯 Heist Mission System
- Role-based mission requirements
- NFT assignment and locking
- Multi-slot missions with progress tracking
- Points-based reward system
- *Currently disabled by default, available for future re-enable*

## 🔧 CRITICAL: Recent Fixes (v1.1.0)

### Portal Login Not Working?
1. **Env vars validation**: Check that these are set correctly in `.env`:
   - `DISCORD_CLIENT_SECRET` (from Discord Developer Portal > OAuth2 > General)
   - `DISCORD_REDIRECT_URI` (must match EXACTLY in Discord Developer Portal > OAuth2 > Redirects)
   - `SESSION_SECRET` (set to a random string, min 32 chars)
2. **Trust proxy fix**: Now automatically enabled in production
3. **Persistent sessions**: Sessions now survive restarts (SQLite-backed)

### Real NFT Verification (Not Mock)
1. Set `HELIUS_API_KEY` in `.env` (get from https://www.helius.dev/)
2. Verify `MOCK_MODE` is NOT set to `true` in `.env` (or set it to `false`)
3. System will fetch real Solana NFTs from mainnet via Helius DAS API
4. Falls back to mock data if Helius is unavailable

### Trait Roles Integration
- **Feature**: Fully wired; configure via web admin panel (`/admin` → Verification Roles)
- **Discord commands**: `/verification admin role-config [view|set-tier|set-trait]` shows status and next steps
- **Web API**: `POST /api/admin/roles/traits` for programmatic trait-role assignment

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables:
   ```bash
   cp .env.example .env
   # CRITICAL: Read .env.example comments and fill in all OAuth vars
   nano .env
   ```

4. Deploy slash commands:
   ```bash
   npm run deploy
   ```

5. Start the bot:
   ```bash
   npm start
   ```

## Environment Variables

### Required
- `DISCORD_TOKEN` - Your Discord bot token
- `CLIENT_ID` - Your Discord application client ID
- `GUILD_ID` - Guild ID for slash command deployment
- `DISCORD_CLIENT_SECRET` - From Discord Developer Portal (CRITICAL for login)
- `DISCORD_REDIRECT_URI` - Must match Discord OAuth2 redirect URL exactly
- `SESSION_SECRET` - Random string for session encryption (min 32 chars)

### Optional but Recommended
- `HELIUS_API_KEY` - For real Solana NFT verification (get from https://www.helius.dev/)
- `NODE_ENV` - Set to `production` for HTTPS-only cookies
- `MOCK_MODE` - Set to `false` to disable mock NFT data (use real Solana NFTs)
- `SOLANA_RPC_URL` - Solana RPC endpoint (default: mainnet-beta)
- `WEB_URL` - Your bot's web URL for redirects (default: http://localhost:3000)

## Commands

### User Commands
- `/verification status` - View your verification status and linked wallets
- `/verification wallets` - View linked wallets and NFT holdings
- `/verification refresh` - Update roles based on current NFT count
- `/verification quick` - Quick micro-verification
- `/battle create/start/cancel/stats` - Battle Royale *(mod/admin only)*
- `/higherlower start/cancel` - 🃏 Higher or Lower *(mod/admin only)*
- `/diceduel start/cancel` - 🎲 Dice Duel *(mod/admin only)*
- `/reactionrace start/cancel` - ⚡ Reaction Race *(mod/admin only)*
- `/numberguess start/cancel` - 🔢 Number Guess *(mod/admin only)*
- `/slots start/cancel` - 🎰 Slots *(mod/admin only)*
- `/trivia start/cancel` - ❓ Trivia *(mod/admin only)*
- `/wordscramble start/cancel` - 🧩 Word Scramble *(mod/admin only)*
- `/rps start/cancel` - 🪨 RPS Tournament *(mod/admin only)*
- `/blackjack start/cancel` - 🎴 Blackjack *(mod/admin only)*
- `/governance propose` - Create a governance proposal
- `/governance support` - Support a draft proposal
- `/governance vote` - Vote on an active proposal

### Admin Commands

#### Verification Admin
- `/verification admin panel` - Post verification panel
- `/verification admin actions list` - Show all verification actions
- `/verification admin actions add` - Add verification action
- `/verification admin actions remove` - Remove verification action
- `/verification admin export-user` - Export user verification data
- `/verification admin remove-user` - Remove user from system
- `/verification admin role-config` - Configure role assignments
- `/verification admin og-view` - View OG role configuration
- `/verification admin og-enable` - Enable/disable OG role system
- `/verification admin og-role` - Set OG role
- `/verification admin og-limit` - Set OG role limit
- `/verification admin og-sync` - Sync OG roles to Discord
- `/verification admin export-wallets` - Export all wallets

#### NFT Activity Tracking Admin
- `/verification admin activity-watch-add` - Add collection to watch
- `/verification admin activity-watch-remove` - Remove watched collection
- `/verification admin activity-watch-list` - List watched collections
- `/verification admin activity-feed` - View recent activity events
- `/verification admin activity-alerts` - Configure auto-post alerts (channel, event types, min SOL price)

#### Governance Admin
- `/governance admin settings` - Configure governance parameters
- `/governance admin list` - View all proposals
- `/governance admin cancel` - Cancel a proposal (emergency)

#### Treasury Admin
- `/treasury admin status` - View treasury status
- `/treasury admin refresh` - Manually refresh balances
- `/treasury admin enable/disable` - Toggle monitoring
- `/treasury admin set-wallet` - Set treasury wallet address
- `/treasury admin set-interval` - Set refresh interval
- `/treasury admin tx-history` - View recent treasury transactions
- `/treasury admin tx-alerts` - Configure auto-post tx alerts (channel, filters)

#### Battle Commands
- `/battle create` - Create a new battle lobby
  - `max_players` (optional) - Set max participants
  - `required_role_1/2/3` (optional) - Require at least ONE of these roles (OR logic)
  - `excluded_role_1/2/3` (optional) - Block users with ANY of these roles (AND logic)
- `/battle start` - Start your open lobby (requires minimum players met)
- `/battle cancel` - Cancel your open lobby
- `/battle stats` - View battle stats and leaderboards

#### Battle Admin
- `/battle admin list` - List all active battles
- `/battle admin force-end` - Force end a battle (emergency)
- `/battle admin settings` - Configure battle parameters

**Role Gating Examples:**
```
# Members only, excluding bots
/battle create max_players:10 required_role_1:@Member excluded_role_1:@Bot

# Multiple required roles (any one is OK)
/battle create max_players:20 required_role_1:@Member required_role_2:@Supporter required_role_3:@Holder

# Multiple excluded roles (users with any are blocked)
/battle create excluded_role_1:@Bot excluded_role_2:@Muted excluded_role_3:@Banned
```

#### System Config
- `/config modules` - View module toggle states
- `/config toggle` - Toggle module on/off
- `/config status` - System status overview

### Governance Commands
- `/governance propose` - Create a new proposal
- `/governance support` - Support a draft proposal
- `/governance vote` - Cast your vote (yes/no/abstain)

### Heist Commands (toggleable, default: disabled)
- `/heist view` - View available missions
- `/heist signup` - Sign up for a mission
- `/heist status` - View your active/completed missions

## Database Schema

The bot uses SQLite with the following tables:
- `users` - Discord user profiles with tier and VP
- `wallets` - Linked wallet addresses
- `proposals` - Governance proposals
- `proposal_supporters` - Draft proposal supporters
- `votes` - Cast votes with VP snapshots
- `missions` - Heist missions
- `mission_participants` - Mission signups with NFT assignments

## Role Tiers

| Tier | NFT Count | Voting Power |
|------|-----------|--------------|
| Associate | 1-2 | 1 |
| Soldato | 3-6 | 3 |
| Capo | 7-14 | 6 |
| Elite | 15-49 | 10 |
| Underboss | 50-149 | 14 |
| Don | 150+ | 18 |

## Mock Mode

For testing without minted NFTs, set `MOCK_MODE=true` in `.env`. This will generate random NFT data for wallet verification.

## Architecture

See [docs/architecture.md](./docs/architecture.md) for detailed system design and workflows.

## Production Deployment

1. Set `MOCK_MODE=false` in production
2. Configure proper Solana RPC endpoint
3. Set up Discord role IDs in `config/roles.json`
4. Deploy commands globally (omit `GUILD_ID`)
5. Run with process manager (PM2, systemd, etc.)

## License

ISC
