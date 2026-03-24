# SOLPRANOS Discord Bot - Phase 1 MVP

Discord bot for the Solpranos NFT ecosystem featuring wallet verification, DAO governance, and heist missions.

## Features

### 🔐 Wallet Verification System
- Link multiple Solana wallets to Discord account
- Automatic NFT counting and tier assignment
- Role-based permissions (Associate → Don)
- Voting power calculation

### 🗳️ DAO Governance
- Create proposals with community support system
- Weighted voting based on NFT holdings
- Auto-promotion after 4 supporters
- Quorum checking (25% minimum)
- 7-day voting periods with auto-close

### 🎯 Heist Mission System
- Role-based mission requirements
- NFT assignment and locking
- Multi-slot missions with progress tracking
- Points-based reward system

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

### Verification Commands
- `/verify <wallet>` - Link your Solana wallet
- `/wallet-list` - View linked wallets and NFT holdings
- `/refresh-roles` - Update roles based on current NFT count

### Admin: Verification Management (Family Style)
Primary command interface for managing verification with Solpranos flair:

**Panel Creation:**
- `/verification create` - Post a verification panel (with optional customization: title, description, color, footer, thumbnail, image)

**Actions Management:**
- `/verification actions list` - Show all verification actions and role assignments
- `/verification actions addcollection role:<role> collection:<name> [amount:1] [traitname] [traitvalue]` - Assign role for NFT collection holders
- `/verification actions addtoken role:<role> token:<name> [amount:1]` - Assign role for SPL token holders
- `/verification actions remove role:<role> type:<collection/token/trait> [identifier]` - Remove verification action by role + context

**Member Management:**
- `/verification exportuser user:<@user>` - Export a member's verification data
- `/verification removeuser user:<@user> confirm:true` - Remove member from Family (cannot be undone)

**Examples:**
```
/verification create title:"Join the Family" color:#8B0000
/verification actions addcollection role:@Soldato collection:solpranos-main amount:3
/verification actions addcollection role:@Hitman collection:solpranos-main traitname:Role traitvalue:The Hitman
/verification actions addtoken role:@Whale token:$BRUNO amount:100000
/verification actions remove role:@Soldato type:collection identifier:solpranos-main
```

### Admin: Advanced Role Configuration (Power Users)
Advanced interface for granular role mapping control:
- `/role-config list` - View detailed role configuration with voting power
- `/role-config add-tier/edit-tier/delete-tier` - Fine-tune NFT tier thresholds and voting power
- `/role-config add-trait/edit-trait/delete-trait` - Manage trait-to-role mappings directly
- `/role-config sync [user]` - Force role re-sync for one or all members

💡 **Tip:** Most admins should use `/verification actions` for day-to-day management. Use `/role-config` only when you need advanced control over tier mechanics or voting power.

### Governance Commands
- `/propose <title> <description>` - Create a new proposal
- `/support <proposal-id>` - Support a draft proposal
- `/vote <proposal-id> <choice>` - Cast your vote (yes/no/abstain)

### Heist Commands
- `/heist-view` - View available missions
- `/heist-signup <mission-id>` - Sign up for a mission
- `/heist-status` - View your active/completed missions

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
