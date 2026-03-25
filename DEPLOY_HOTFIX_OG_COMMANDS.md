# OG Commands Hotfix - Deployment Guide

**Commit:** `516426b` - Hotfix: expose OG role controls under verification admin commands

## What Changed

### ✅ Added: OG Controls Under Verification Admin
OG role management is now properly exposed under `/verification admin og-*` subcommands:

- `/verification admin og-view` - View OG configuration and eligible members
- `/verification admin og-enable <enabled>` - Enable/disable the OG role system
- `/verification admin og-role <role>` - Set the OG role to assign
- `/verification admin og-limit <count>` - Set the number of OG slots (first X verified users)
- `/verification admin og-sync [full]` - Sync OG role to eligible users

### ✅ Legacy Command Support
The old `/og-config` command is kept as an alias with deprecation notices:
- Still fully functional
- Shows deprecation warning directing users to new location
- All subcommands work as before but log "(legacy command)"

### 🔧 Technical Details
- Wired to existing `ogRoleService.js` (no logic duplication)
- All handlers properly integrated into verification command module
- Command schema validated and registered successfully
- No ordering validation errors

## Deploy Steps

### 1. Pull Latest Code
```bash
cd /path/to/roland-discord-bot
git pull origin main
```

### 2. Redeploy Commands (Register Updated Schema)
```bash
node deploy-commands.js
```

**Expected output:**
```
[INFO] Loaded command: verification
✅ Successfully reloaded application (/) commands.
```

### 3. Restart Bot
```bash
# If using PM2:
pm2 restart roland-discord-bot

# If using systemd:
sudo systemctl restart roland-discord-bot

# If running manually:
# Stop current process (Ctrl+C)
# Then restart:
node index.js
```

### 4. Verify Commands
In Discord, test the new command structure:
```
/verification admin og-view
```

You should see the OG configuration panel with eligible members.

## Migration Path for Users

### Old Commands → New Commands
| Old Command | New Command |
|------------|-------------|
| `/og-config view` | `/verification admin og-view` |
| `/og-config enable` | `/verification admin og-enable` |
| `/og-config role` | `/verification admin og-role` |
| `/og-config limit` | `/verification admin og-limit` |
| `/og-config sync` | `/verification admin og-sync` |

### Deprecation Timeline
- **Now:** Both commands work (old shows deprecation warning)
- **Future:** Old command may be removed after user adoption period

## Testing Checklist

- [ ] Commands deploy without errors
- [ ] `/verification admin og-view` shows current OG config
- [ ] `/verification admin og-enable true` enables OG system
- [ ] `/verification admin og-role @RoleName` sets the OG role
- [ ] `/verification admin og-limit 100` sets the limit
- [ ] `/verification admin og-sync` syncs roles to eligible users
- [ ] Legacy `/og-config view` still works (with deprecation notice)
- [ ] No console errors in bot logs

## Rollback Plan

If issues occur:
```bash
git revert 516426b
node deploy-commands.js
pm2 restart roland-discord-bot
```

## Notes
- All OG logic remains in `services/ogRoleService.js` (unchanged)
- No database schema changes required
- Backward compatible with existing OG configurations
- User experience improved: OG controls now logically grouped under verification
