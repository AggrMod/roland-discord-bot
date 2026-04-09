# Deploy Notes: Solmate-Style Verification Commands

**Date:** 2026-03-24  
**Feature:** Solmate-style `/verification` command aliases

## Overview

Added Solmate-style command UX on top of the existing role-config engine while maintaining full backward compatibility. The new `/verification` command provides a familiar, streamlined interface for verification management.

## What Changed

### New Files
- `commands/admin/verification.js` - New Solmate-style verification command
- `config/collections.json` - Collection-based verification config

### Modified Files
- `services/roleService.js` - Added collection management methods
- `services/walletService.js` - Added `removeAllWallets()` method
- `README.md` - Updated command documentation

### New Commands

#### `/verification` Command Structure
```
/verification create
  → Create verification panel in channel

/verification exportuser <user>
  → Export verified user data

/verification removeuser <user> <confirm>
  → Remove user from verification system (admin only)

/verification actions list
  → List all verification actions (collections, tiers, traits)

/verification actions addcollection
  → Add collection-based verification action
  → Parameters: collection_id, name, role, [update_authority], [creator]

/verification actions addtoken <type>
  → Add trait or tier-based action
  → Type: trait | tier
  → Trait params: trait_type, trait_value, role
  → Tier params: tier_name, min_nfts, max_nfts, voting_power, role

/verification actions remove <type> <identifier>
  → Remove action by type and identifier
  → Type: collection | trait | tier
  → Identifier format:
      - collection: collection_id
      - trait: trait_type:trait_value
      - tier: tier_name
```

### Backend Enhancements

**roleService.js:**
- Added `collectionsConfig` support
- `loadConfigs()` now loads collections.json
- `saveCollectionsConfig()` persists collection changes
- `getCollectionsSummary()` returns collection status
- `addCollection()`, `editCollection()`, `deleteCollection()` CRUD operations

**walletService.js:**
- `removeAllWallets(discordId)` - Cleanup method for user removal

### Backward Compatibility

**PRESERVED:**
- All existing `/role-config` commands remain functional
- All existing `/verify-panel` functionality
- Current tier and trait role logic unchanged
- Database schema unchanged

**COEXISTENCE:**
- Both `/verification` and `/role-config` work side-by-side
- `/verification actions` is recommended for most use cases
- `/role-config` remains for advanced/granular control

## Deployment Steps

### 1. Redeploy Commands
```bash
cd /tmp/roland-discord-bot
npm run deploy
```

Expected output:
```
✅ Successfully reloaded X application (/) commands.
📋 Registered commands:
  • /verification: Manage verification system (Solmate-style UX)
  • /role-config: Manage role configuration and mappings (Admin only)
  ...
```

### 2. Restart Bot
```bash
# If using PM2:
pm2 restart roland-discord-bot

# Or if using systemd:
sudo systemctl restart guildpilot

# Or manual:
npm start
```

### 3. Verify in Discord
Test the new commands:
```
/verification create
/verification actions list
/verification actions addcollection collection_id:"test-collection" name:"Test NFTs" role:@TestRole
/verification actions remove type:collection identifier:"test-collection"
```

## Usage Examples

### Add Collection-Based Verification
```
/verification actions addcollection
  collection_id: "mad-lads-collection"
  name: "Mad Lads"
  role: @MadLadsHolder
  update_authority: <optional_address>
```

### Add Trait-Based Role
```
/verification actions addtoken
  type: trait
  trait_type: "Background"
  trait_value: "City Skyline"
  role: @CitySkyline
```

### Add NFT Tier
```
/verification actions addtoken
  type: tier
  tier_name: "Whale"
  min_nfts: 100
  max_nfts: 499
  voting_power: 15
  role: @Whale
```

### Export User Data
```
/verification exportuser user:@username
```

### Remove User (with confirmation)
```
/verification removeuser user:@username confirm:true
```

## Data Model

### collections.json Schema
```json
{
  "collections": [
    {
      "id": "unique-collection-id",
      "name": "Display Name",
      "updateAuthority": "optional_solana_address",
      "firstVerifiedCreator": "optional_creator_address",
      "roleId": "discord_role_id",
      "enabled": true,
      "description": "Collection description"
    }
  ]
}
```

## Testing Checklist

- [x] `/verification create` posts panel ✓
- [x] `/verification actions list` shows all actions ✓
- [x] `/verification actions addcollection` creates collection ✓
- [x] `/verification actions addtoken type:trait` creates trait ✓
- [x] `/verification actions addtoken type:tier` creates tier ✓
- [x] `/verification actions remove` deletes actions ✓
- [x] `/verification exportuser` exports data ✓
- [x] `/verification removeuser` removes user with confirmation ✓
- [x] `/role-config` still works (backward compat) ✓
- [x] Syntax validation passed ✓
- [x] Command deployment successful ✓

## Notes

- **Recommended UX:** Use `/verification` for standard operations
- **Advanced control:** Use `/role-config` for granular tier/trait editing
- **Collection verification:** Frontend NFT service integration needed for on-chain validation
- **Permissions:** All verification commands require Administrator permission
- **Safe defaults:** Collections created with `enabled: true`, can be toggled via future edit command

## Next Steps (Optional Enhancements)

1. Add `/verification actions editcollection` for collection updates
2. Implement on-chain collection validation in nftService
3. Add collection-based role sync to `syncUserDiscordRoles()`
4. Create dashboard view for verification metrics
5. Add audit log for verification actions

## Rollback Plan

If issues occur:

1. Remove verification command:
   ```bash
   rm commands/admin/verification.js
   npm run deploy
   ```

2. Revert service changes:
   ```bash
   git checkout services/roleService.js services/walletService.js
   ```

3. Restart bot

All existing `/role-config` functionality will remain intact.
