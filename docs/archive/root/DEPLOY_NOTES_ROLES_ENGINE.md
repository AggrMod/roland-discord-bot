# Role Engine Deployment Notes

## Summary
Implemented comprehensive Discord role synchronization system with:
1. ✅ Real Discord role assignment based on NFT holdings (tier roles)
2. ✅ Automatic 4-hour wallet resync scheduler with role updates
3. ✅ Trait-based Discord role assignment (configurable NFT trait → Discord role mapping)
4. ✅ Admin visibility commands and API endpoints for role configuration
5. ✅ Graceful handling of missing role IDs (no crashes)
6. ✅ Smart diff-based role changes (no churn - only applies needed changes)

## New Features

### 1. **Real Discord Role Sync**
- Automatically assigns Discord roles based on NFT tier holdings
- Assigns Discord roles based on NFT traits (e.g., "The Hitman", "The Driver")
- Only applies role changes when needed (diff-based, prevents role churn)
- Fetches actual holdings from wallets and computes tier + voting power
- Updates both database records AND Discord roles in one flow

### 2. **4-Hour Resync Scheduler**
- Runs every 4 hours to keep roles synchronized with actual holdings
- Also runs once on bot startup (with 1-minute delay for stability)
- Processes all verified users in the system
- Includes rate limiting (500ms delay between users) to avoid Discord API limits
- Comprehensive logging for each resync cycle with stats

### 3. **Trait-Role Mapping**
- Configure Discord roles for specific NFT traits via `config/trait-roles.json`
- Currently configured for NFT "Role" traits: The Hitman, The Accountant, etc.
- Easily extensible to other trait types (Rarity, Background, etc.)
- If a user holds an NFT with a trait, they get the corresponding Discord role
- Automatically removes trait roles when NFTs are sold/transferred

### 4. **Admin Tools**
- New `/role-config view` command: View all tier and trait role mappings
- New `/role-config sync @user` command: Manually trigger role sync for a specific user
- New API endpoint: `GET /api/admin/roles/config` - Returns role configuration summary
- Shows which roles are configured vs. missing with clear visual indicators

### 5. **Graceful Handling**
- Missing role IDs in config → Skip gracefully with warning (no crashes)
- Missing guild members → Log warning and continue with other users
- API rate limits → Built-in delays between operations
- All errors logged but don't stop the resync process

## Files Changed

### New Files
- `config/trait-roles.json` - Trait-to-Discord-role mapping configuration
- `commands/admin/roleConfig.js` - Admin command for viewing/managing role config

### Modified Files
- `services/roleService.js` - Complete rewrite with comprehensive role sync logic
- `services/nftService.js` - Added trait extraction utilities
- `index.js` - Added 4-hour resync scheduler
- `web/server.js` - Added `/api/admin/roles/config` endpoint
- `.env.example` - Added GUILD_ID requirement and documentation

## Configuration Required

### 1. **Environment Variables (.env)**

**REQUIRED:**
```env
GUILD_ID=your_discord_guild_id_here
```
This is **required** for the role resync scheduler to work. Without it, the scheduler will skip execution with a warning.

**OPTIONAL:**
```env
ROLE_RESYNC_ENABLED=true  # Default: true
```
Set to `false` to disable the automatic resync scheduler (not recommended).

### 2. **Tier Role Configuration (config/roles.json)**

Add Discord role IDs to each tier:
```json
{
  "tiers": [
    {
      "name": "Associate",
      "minNFTs": 1,
      "maxNFTs": 2,
      "votingPower": 1,
      "roleId": "1234567890123456789"  // <-- Add your Discord role ID here
    },
    ...
  ]
}
```

**How to get Discord role IDs:**
1. Enable Developer Mode in Discord (User Settings → Advanced → Developer Mode)
2. Right-click the role in Server Settings → Roles
3. Click "Copy ID"
4. Paste into `roleId` field

### 3. **Trait Role Configuration (config/trait-roles.json)**

Add Discord role IDs for each trait you want to map:
```json
{
  "traitRoles": [
    {
      "trait_type": "Role",
      "trait_value": "The Hitman",
      "roleId": "1234567890123456789",  // <-- Add your Discord role ID here
      "description": "Members holding NFTs with The Hitman role"
    },
    ...
  ]
}
```

**Notes:**
- `trait_type` must match the attribute name in your NFT metadata
- `trait_value` must exactly match the trait value (case-sensitive)
- Set `roleId` to `null` to disable a specific trait role (will be skipped gracefully)
- You can add additional trait types (Rarity, Background, etc.) by adding more objects

### 4. **Create Discord Roles**

Before configuring role IDs, you need to create the roles in Discord:

1. Go to Server Settings → Roles
2. Create roles for each tier: Associate, Soldato, Capo, Elite, Underboss, Don
3. Create roles for each trait you want to assign (The Hitman, The Driver, etc.)
4. Set appropriate permissions and colors
5. **IMPORTANT:** Ensure the bot's role is HIGHER than all managed roles in the role hierarchy
6. Copy each role ID and add to the config files

## Deployment Steps

### 1. **Update Environment Variables**
```bash
# Edit your .env file
nano .env

# Add GUILD_ID (REQUIRED)
GUILD_ID=your_actual_guild_id_here
```

### 2. **Configure Role IDs**
```bash
# Edit tier roles
nano config/roles.json

# Edit trait roles
nano config/trait-roles.json

# Add Discord role IDs to both files
```

### 3. **Verify Bot Permissions**
Ensure your bot has these permissions in Discord:
- `Manage Roles` - Required to assign/remove roles
- `View Server Members` - Required to fetch member objects
- Bot role must be HIGHER in hierarchy than all managed roles

### 4. **Deploy the New Commands**
```bash
# Deploy slash commands (includes new /role-config command)
node deploy-commands.js
```

### 5. **Restart the Bot**
```bash
# Stop the bot (if running)
pm2 stop discord-bot

# Start the bot
pm2 start index.js --name discord-bot

# Or restart if already running
pm2 restart discord-bot

# View logs
pm2 logs discord-bot
```

### 6. **Verify Scheduler Started**
Check logs for these messages:
```
⏰ Role resync scheduler started (runs every 4 hours + on startup)
🚀 Running initial role resync (startup)...
🔄 Starting role resync cycle...
📊 Found X verified users to resync
✅ Role resync complete: X synced, 0 errors, X roles added, X roles removed (X.Xs)
```

### 7. **Test Role Sync**

**Option A: Wait for automatic sync (1 minute after startup)**
- The scheduler will automatically run once on startup
- Check logs for the "Role resync complete" message

**Option B: Manual sync for a user**
```
/role-config sync @username
```
This will immediately sync roles for the specified user and show a report.

### 8. **View Role Configuration**
```
/role-config view
```
Shows all tier and trait role mappings with status indicators:
- ✅ = Role ID configured
- ❌ = Role ID missing (will be skipped)

## Monitoring

### Log Messages to Watch For

**Success:**
```
✅ Role resync complete: 25 synced, 0 errors, 12 roles added, 3 roles removed (15.3s)
Added tier role Capo to username#1234
Added trait role The Hitman to username#1234
```

**Warnings (non-critical):**
```
⚠️ GUILD_ID not configured, skipping role resync
⚠️ Guild 1234567890 not found, skipping role resync
Tier Elite has no roleId configured
```

**Errors (investigate):**
```
❌ Error in role resync cycle: [error details]
Error syncing Discord roles for 123456789: [error details]
```

### API Endpoint for Monitoring

```bash
# Check role configuration (requires admin authentication)
curl -X GET https://your-bot-domain.com/api/admin/roles/config \
  -H "Cookie: your-session-cookie"
```

Returns:
```json
{
  "success": true,
  "config": {
    "tiers": [
      {
        "name": "Associate",
        "minNFTs": 1,
        "maxNFTs": 2,
        "votingPower": 1,
        "roleId": "1234567890",
        "configured": true
      },
      ...
    ],
    "traitRoles": [
      {
        "trait": "Role: The Hitman",
        "roleId": "9876543210",
        "configured": true,
        "description": "Members holding NFTs with The Hitman role"
      },
      ...
    ]
  }
}
```

## Rollback Plan

If issues arise, you can disable the role sync:

### Option 1: Disable Scheduler Only
```bash
# Add to .env
ROLE_RESYNC_ENABLED=false

# Restart bot
pm2 restart discord-bot
```

### Option 2: Revert to Previous Version
```bash
# Check previous commit
git log --oneline

# Revert this commit
git revert eb1ae32

# Deploy
git push origin main
pm2 restart discord-bot
```

### Option 3: Clear All Role IDs (Soft Disable)
```bash
# Set all roleId values to null in config files
# The system will skip all role assignments but continue to track holdings
```

## Troubleshooting

### Issue: Roles not being assigned

**Check:**
1. GUILD_ID is set in .env
2. Role IDs are configured in config files
3. Bot has "Manage Roles" permission
4. Bot's role is higher than managed roles in hierarchy
5. Check logs for error messages

**Test manually:**
```
/role-config sync @user
```

### Issue: Rate limit errors

**Solution:**
The bot already has 500ms delays between users. If you still hit rate limits:
1. Check if other bots are also managing roles
2. Reduce frequency of manual `/role-config sync` commands
3. Consider increasing delay in `index.js` scheduler (change 500ms to 1000ms)

### Issue: Resync not running

**Check:**
1. GUILD_ID is set correctly
2. Bot has restarted since config changes
3. Check logs for "Role resync scheduler started" message
4. Check for warnings: "GUILD_ID not configured"

**Force manual sync:**
```
/role-config sync @user
```

### Issue: Wrong roles assigned

**Check:**
1. User's wallet holdings in database match reality
2. Tier thresholds in `config/roles.json` are correct
3. NFT metadata has correct trait attributes
4. Run `/verify` command to refresh holdings

## Next Steps (Optional Enhancements)

### 1. **Add More Trait Types**
Edit `config/trait-roles.json` to add roles for:
- Rarity (Common, Rare, Legendary)
- Background types
- Outfit styles
- Any other NFT attributes

### 2. **Adjust Resync Frequency**
In `index.js`, change:
```javascript
const RESYNC_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
```
To your preferred interval (e.g., 2 hours = `2 * 60 * 60 * 1000`)

### 3. **Add Webhook Notifications**
Enhance the resync function to send a summary to a Discord channel when complete.

### 4. **Role History Tracking**
Add database table to track role changes over time for audit purposes.

## Support

For issues or questions:
1. Check logs: `pm2 logs discord-bot`
2. Review this document
3. Test with `/role-config sync @user` for immediate feedback
4. Check Discord bot permissions
5. Verify GUILD_ID and role IDs in config files

---

**Deployment completed:** [Current Date]
**Git commit:** `eb1ae32`
**Deployed by:** [Your Name]
