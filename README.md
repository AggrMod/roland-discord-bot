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

### ⚔️ Battle Lobbies
- Create and join battle lobbies with community members
- **Multi-role gating**: Require any of up to 3 roles (OR logic)
- **Role exclusion**: Block users with any of up to 3 roles (AND logic)
- Reaction-based joining (⚔️ emoji)
- Configurable max players and minimum thresholds
- Real-time participant tracking and lobby updates

### 🎯 Heist Mission System
- Role-based mission requirements
- NFT assignment and locking
- Multi-slot missions with progress tracking
- Points-based reward system
- *Currently disabled by default, available for future re-enable*

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with your bot token and client ID
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

- `DISCORD_TOKEN` - Your Discord bot token
- `CLIENT_ID` - Your Discord application client ID
- `GUILD_ID` - (Optional) Guild ID for testing (faster command deployment)
- `MOCK_MODE` - Set to `true` to use mock NFT data (no blockchain queries)
- `SOLANA_RPC_URL` - Solana RPC endpoint (default: mainnet-beta)

## Commands

### User Commands
- `/verification status` - View your verification status and linked wallets
- `/verification wallets` - View linked wallets and NFT holdings
- `/verification refresh` - Update roles based on current NFT count
- `/verification quick` - Quick micro-verification
- `/battle create` - Create a battle lobby with optional role gating
- `/battle start` - Start your open battle lobby
- `/battle cancel` - Cancel your open battle lobby
- `/battle stats` - View battle statistics and leaderboards
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
