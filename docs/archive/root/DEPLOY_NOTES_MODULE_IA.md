# Deployment Notes - Module IA Refactor

**Version**: 2.0 (Module-First Architecture)  
**Date**: March 25, 2026  
**Branch**: `module-ia-refactor`  
**Status**: ✅ READY TO DEPLOY

---

## Summary

Complete module-first command architecture refactor with toggleable modules. All commands reorganized by module with user/admin subgroups. Backward compatibility maintained via legacy aliases.

---

## What Changed

### ✅ New Command Structure

All commands now organized by module:

- **`/verification`** - User commands + admin subgroup
- **`/governance`** - User commands + admin subgroup
- **`/treasury`** - User commands + admin subgroup
- **`/battle`** - User commands + admin subgroup
- **`/heist`** - User commands + admin subgroup (disabled by default)
- **`/config`** - System configuration (admin only)

### ✅ Module Toggles System

New persistent module toggles (`config/module-toggles.json`):

- `verificationEnabled` (default: `true`)
- `governanceEnabled` (default: `true`)
- `treasuryEnabled` (default: `true`)
- `battleEnabled` (default: `true`)
- `heistEnabled` (default: **`false`** - disabled)

Control via `/config toggle`.

### ✅ Guard Middleware

New `utils/moduleGuard.js`:

- Checks if modules are enabled before execution
- Handles admin permission checks
- Returns friendly "business closed" messages when disabled

### ✅ Legacy Aliases

Backward compatibility for:

- `/verify` → deprecation warning → use `/verification status`
- `/propose` → deprecation warning → use `/governance propose`
- `/support` → deprecation warning → use `/governance support`
- `/vote` → deprecation warning → use `/governance vote`

Aliases will be removed in **Sprint B** after usage monitoring.

### ✅ Scheduler Integration

All background jobs now check module state before running:

- Vote check interval (governance)
- Role resync scheduler (verification)
- Treasury refresh (treasury)
- Micro-verify cleanup (verification)

When a module is disabled, its schedulers skip execution.

### ✅ Documentation

New `docs/COMMAND_ARCHITECTURE.md`:

- Full command inventory
- Old → new mapping
- Module toggle behavior
- Migration timeline

---

## Deployment Steps

### 1. Pre-Deployment

```bash
# Verify sanity tests pass
cd /tmp/roland-discord-bot
node test-module-refactor.js

# Expected output: ✅ ALL TESTS PASSED!
```

### 2. Deploy Slash Commands

**CRITICAL**: You **must** redeploy slash commands for the new structure to work.

```bash
node deploy-commands.js
```

Expected output:
```
Successfully registered X application commands
```

### 3. Restart Bot

Stop and restart the bot process:

```bash
# If using PM2:
pm2 restart guildpilot

# If using systemd:
sudo systemctl restart guildpilot

# If manual:
# Stop old process (Ctrl+C or kill)
node index.js
```

### 4. Verify Module States

After restart, test in Discord:

```
/config modules
```

Expected:
- ✅ Verification: Enabled
- ✅ Governance: Enabled
- ✅ Treasury: Enabled
- ✅ Battle: Enabled
- ❌ Heist: Disabled

### 5. Test New Commands

Test each module:

```
/verification status
/governance propose title:"Test" description:"Test"
/treasury view
/battle stats
/config toggle module:heist enabled:true
/heist view
```

### 6. Test Legacy Aliases

```
/verify
```

Expected: ⚠️ deprecation warning + works

---

## Migration Notes

### For Operators

- **All old admin commands moved** into module admin subgroups
- Use `/verification admin panel` instead of `/verify-panel`
- Use `/treasury admin status` instead of `/treasury status`
- Use `/governance admin list` to see all proposals

### For Users

- **Most common commands have aliases** (see deprecation warnings)
- Update Discord autocomplete habits to new structure
- `/verification status` replaces `/verify`
- `/governance propose` replaces `/propose`

### Database

- **No database migrations required** - all existing data compatible
- New table: `module_toggles` (auto-created)

### Portal/Web Integration

If web portal exists, update:

- Check module states before showing sections
- Hide disabled modules from navigation
- Show toggle status in admin view

---

## Rollback Plan

If issues arise:

1. **Stop the bot**
2. **Restore old command files**:
   ```bash
   cd /tmp/roland-discord-bot/commands
   find . -name "*.OLD" -exec sh -c 'mv "$1" "${1%.OLD}"' _ {} \;
   ```
3. **Redeploy old commands**:
   ```bash
   node deploy-commands.js
   ```
4. **Restart bot**

---

## Module Toggle Behavior

### When a module is **enabled**:

✅ Commands work normally  
✅ Portal sections visible  
✅ Background schedulers run  
✅ Events/notifications active

### When a module is **disabled**:

❌ Commands return: *"The [Module] business is closed right now. Talk to the Don if you need access."*  
🚫 Portal sections hidden  
⏸️ Background schedulers paused  
🔕 No events/notifications

---

## Post-Deployment Monitoring

### Week 1: Command Migration Complete

✅ **Legacy commands removed** - All backward compatibility aliases have been removed. Users must use the new module-first command structure.

### Module Health Check

```
/config status
```

Check:
- Bot uptime
- Memory usage
- Active modules
- Command count

---

## Known Issues

### None at deployment

All tests passing. No breaking changes to existing functionality.

---

## Next Steps (Sprint B)

1. **Add in-app role config UI** (currently edit JSON)
2. **Portal module integration** (hide disabled sections)
3. **Advanced admin settings** (edit quorum, support threshold via commands)
4. **Module analytics** (usage tracking per module)

---

## Testing Checklist

- [x] Module toggles load correctly
- [x] Module guard middleware works
- [x] All new commands load
- [x] Legacy aliases show deprecation warnings
- [x] Old commands renamed to .OLD
- [x] Documentation complete
- [x] Schedulers check module state
- [x] Commands execute correctly
- [x] Admin checks work
- [x] Module disabled messages display

---

## Files Changed

### New Files

- `config/module-toggles.json`
- `utils/moduleGuard.js`
- `commands/verification/verification.js`
- `commands/governance/governance.js`
- `commands/treasury/treasury.js`
- `commands/battle/battle.js` (refactored)
- `commands/heist/heist.js`
- `commands/config/config.js`
- `docs/COMMAND_ARCHITECTURE.md`
- `test-module-refactor.js`

### Modified Files

- `index.js` (added module guard checks to schedulers)
- `services/treasuryService.js` (added module guard check)

### Renamed Files (to .OLD)

All old command files in:
- `commands/verification/` (verify.js, microVerify.js, refreshRoles.js, walletList.js)
- `commands/governance/` (propose.js, support.js, vote.js)
- `commands/heist/` (view.js, signup.js, status.js)
- `commands/admin/` (all admin command files)

---

## Success Criteria

✅ All commands load without errors  
✅ Module toggles work (`/config toggle`)  
✅ Disabled modules return friendly messages  
✅ Schedulers respect module state  
✅ Legacy aliases show deprecation warnings  
✅ No database corruption  
✅ Existing features work as before

---

## Support

For issues:
1. Check logs: `tail -f logs/bot.log`
2. Verify module states: `/config modules`
3. Test command deployment: `node deploy-commands.js`
4. Restart bot if needed

---

**Deployment approved for production.**

*— Sprint A Module IA Refactor, March 25 2026*
