# Guild Pilot Discord Bot - Phase 1 MVP

Discord bot for the Guild Pilot NFT ecosystem featuring wallet verification, DAO governance, and heist missions.

## Features

### ðŸ” Wallet Verification System
- Link multiple Solana wallets to Discord account
- Automatic NFT counting and tier assignment
- Role-based permissions (Associate â†’ Don)
- Voting power calculation
- OG (Original/early member) role system with configurable limits
- Micro-verification via SOL micro-transfers

### ðŸ“¡ NFT Activity Tracking
- Watch and monitor specific NFT collections
- Real-time activity alerts (mints, sells, lists, etc.)
- Configurable Discord channel posting with filters
- Event-type emoji badges for visual clarity
- Webhook ingest API for external event sources

### ðŸ—³ï¸ DAO Governance
- Create proposals with community support system
- Weighted voting based on NFT holdings
- Auto-promotion after 4 supporters
- Quorum checking (25% minimum)
- 7-day voting periods with auto-close

### ðŸŽ® Mini-Games Suite (10 games)
> All game commands require **Moderator or Admin** permissions.
> Individual games: **Free**. Game Night orchestration: **Growth+**.

| Game | Command | Type |
|---|---|---|
| âš”ï¸ Battle Royale | `/battle` | HP-based elimination |
| ðŸƒ Higher or Lower | `/higherlower` | Card guessing, wrong = out |
| ðŸŽ² Dice Duel | `/diceduel` | Lowest d6 roll eliminated |
| âš¡ Reaction Race | `/reactionrace` | Slowest to react is out |
| ðŸ”¢ Number Guess | `/numberguess` | Closest to secret number wins |
| ðŸŽ° Slots | `/slots` | Best spin combo wins |
| â“ Trivia | `/trivia` | Most correct answers wins |
| ðŸ§© Word Scramble | `/wordscramble` | First to unscramble wins |
| ðŸª¨ RPS Tournament | `/rps` | Rock-paper-scissors bracket |
| ðŸŽ´ Blackjack | `/blackjack` | Beat the dealer |

All games use reaction-based lobbies. Players join by reacting with the game emoji.

### ðŸŽ‰ Game Night (Growth plan)
Run a full multi-game session in sequence with cross-game scoring.

```
/gamenight start [join_time:90] [games:trivia,slots,rps,diceduel]
/gamenight skip          # host skips current game
/gamenight cancel        # host cancels
/gamenight leaderboard   # mid-session standings
```

**Scoring:** ðŸ¥‡ 1st=10pts Â· ðŸ¥ˆ 2nd=7pts Â· ðŸ¥‰ 3rd=5pts Â· 4th=3pts Â· 5th+=1pt

At the end a champion is crowned with total points across all games.

### ðŸŽ¯ Heist Mission System
- Role-based mission requirements
- NFT assignment and locking
- Multi-slot missions with progress tracking
- Points-based reward system
- *Currently disabled by default, available for future re-enable*

## ðŸ”§ CRITICAL: Recent Fixes (v1.1.0)

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
- **Feature**: Fully wired; configure via web admin panel (`/admin` â†’ Verification Roles)
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

## Schema Migrations

- Database schema changes are tracked in `schema_migrations`.
- See [`docs/DATABASE_MIGRATIONS.md`](docs/DATABASE_MIGRATIONS.md) for migration/version workflow.

## Environment Variables

### Required
- `DISCORD_TOKEN` - Your Discord bot token
- `CLIENT_ID` - Your Discord application client ID
- `GUILD_ID` - Guild ID for slash command deployment
- `DISCORD_CLIENT_SECRET` - From Discord Developer Portal (CRITICAL for login)
- `DISCORD_REDIRECT_URI` - Must match Discord OAuth2 redirect URL exactly
- `DISCORD_REDIRECT_URIS` - Optional comma-separated additional callback URLs (for zero-downtime domain migration)
- `SESSION_SECRET` - Random string for session encryption (min 32 chars)

### Optional but Recommended
- `HELIUS_API_KEY` - For real Solana NFT verification (get from https://www.helius.dev/)
- `NODE_ENV` - Set to `production` for HTTPS-only cookies
- `MOCK_MODE` - Set to `false` to disable mock NFT data (use real Solana NFTs)
- `SOLANA_RPC_URL` - Solana RPC endpoint (default: mainnet-beta)
- `WEB_URL` - Your bot's web URL for redirects (default: http://localhost:3000)
- `WEB_URL_ALIASES` - Optional comma-separated extra web origins to keep old URLs working during migration

## Commands

### Verification
- `/verification status`, `/verification wallets`, `/verification refresh`, `/verification quick`
- `/verification admin panel`, `/verification admin role-config`, `/verification admin actions`
- `/verification admin export-user`, `/verification admin remove-user`, `/verification admin export-wallets`
- `/verification admin token-role-add`, `/verification admin token-role-remove`, `/verification admin token-role-list`
- `/verification admin og-view`, `/verification admin og-enable`, `/verification admin og-role`, `/verification admin og-limit`, `/verification admin og-sync`

### Governance
- `/governance propose`, `/governance support`, `/governance vote`
- `/governance admin list`, `/governance admin cancel`, `/governance admin settings`

### Treasury
- `/treasury view`
- `/treasury admin status`, `/treasury admin refresh`
- `/treasury admin enable`, `/treasury admin disable`
- `/treasury admin set-wallet`, `/treasury admin set-interval`
- `/treasury admin tx-history`, `/treasury admin tx-alerts`

### Wallet Tracker
- `/wallet-tracker add`, `/wallet-tracker edit`, `/wallet-tracker remove`
- `/wallet-tracker list`, `/wallet-tracker holdings`, `/wallet-tracker refresh-all`

### NFT Tracker
- `/nft-tracker collection add`, `/nft-tracker collection remove`
- `/nft-tracker collection list`, `/nft-tracker collection feed`

### Token Tracker
- `/token-tracker add`, `/token-tracker edit`, `/token-tracker remove`
- `/token-tracker list`, `/token-tracker feed`

### Invite Tracker
- `/invites who`, `/invites leaderboard`, `/invites panel`, `/invites export`

### AI Assistant
- `/aiassistant ask`, `/aiassistant status`, `/aiassistant briefing`

### Engagement
- `/points balance`, `/points leaderboard`, `/points history`
- `/points shop`, `/points redeem`, `/points admin`

### Minigames
- `/minigames run`, `/minigames help`
- `/battle create`, `/battle start`, `/battle cancel`, `/battle stats`
- `/battle admin list`, `/battle admin force-end`, `/battle admin settings`
- `/higherlower start`, `/higherlower cancel`
- `/diceduel start`, `/diceduel cancel`
- `/reactionrace start`, `/reactionrace cancel`
- `/numberguess start`, `/numberguess cancel`
- `/slots start`, `/slots cancel`
- `/trivia start`, `/trivia cancel`
- `/wordscramble start`, `/wordscramble cancel`
- `/rps start`, `/rps cancel`
- `/blackjack start`, `/blackjack cancel`
- `/gamenight start`, `/gamenight skip`, `/gamenight cancel`, `/gamenight leaderboard`

### Missions (Heist)
- `/heist view`, `/heist signup`, `/heist status`
- `/heist admin create`, `/heist admin list`, `/heist admin cancel`

### System Config
- `/config modules`, `/config toggle`, `/config status`

### Portal-Managed Modules (No Dedicated Slash Namespace)
- Ticketing, Self-Serve Roles, and Branding are primarily configured through portal/admin views.

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
3. Set up Discord role IDs in tenant Verification settings (stored in `config/settings.json` defaults + tenant DB config)
4. Deploy commands globally (omit `GUILD_ID`)
5. Run with process manager (PM2, systemd, etc.)

## License

ISC
