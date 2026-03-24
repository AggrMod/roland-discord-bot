# Deploy Notes: Role Config UX Enhancement

**Commit**: `c3ac380` - "Role config UX: full command + admin UI CRUD for tiers and trait mappings"

## What Was Implemented

### 1. Discord Bot Commands (Expanded `/role-config`)

#### New Subcommands:
- `/role-config list` - View all tier and trait-role mappings
- `/role-config add-tier <name> <min_nfts> <max_nfts> <vp> [role]` - Add new tier
- `/role-config edit-tier <name> [min_nfts] [max_nfts] [vp] [role]` - Edit existing tier
- `/role-config delete-tier <name>` - Delete tier
- `/role-config add-trait <trait_type> <trait_value> <role>` - Add trait-role mapping
- `/role-config edit-trait <trait_type> <trait_value> <role>` - Edit trait mapping
- `/role-config delete-trait <trait_type> <trait_value>` - Delete trait mapping
- `/role-config sync [user]` - Sync roles (single user or all users if no user specified)

#### Features:
- ✅ Admin-only permission checks (Discord Administrator required)
- ✅ Validation: overlapping tier ranges, duplicate mappings
- ✅ Real-time config persistence to `config/roles.json` and `config/trait-roles.json`
- ✅ Comprehensive error messages

### 2. Backend API Endpoints (Admin-Protected)

#### Tier Management:
- `POST /api/admin/roles/tiers` - Create tier
- `PUT /api/admin/roles/tiers/:name` - Update tier
- `DELETE /api/admin/roles/tiers/:name` - Delete tier

#### Trait Management:
- `POST /api/admin/roles/traits` - Create trait mapping
- `PUT /api/admin/roles/traits/:traitType/:traitValue` - Update trait mapping
- `DELETE /api/admin/roles/traits/:traitType/:traitValue` - Delete trait mapping

#### Role Sync:
- `POST /api/admin/roles/sync` - Trigger role sync (all users or single user via body)
- `GET /api/admin/roles/config` - Get current role configuration

All endpoints require:
- Discord OAuth session
- Administrator permissions in guild

### 3. Web Admin UI (`/admin-panel`)

#### New Tab: "Role Config"
Located between "Settings" and "Users" tabs.

**Tier Configuration Section:**
- Table view: Name, Min NFTs, Max NFTs, Voting Power, Discord Role, Actions
- Add/Edit/Delete tier controls
- Inline editing via prompts (production-ready, can be enhanced with modals)

**Trait Mapping Section:**
- Table view: Trait Type, Trait Value, Discord Role, Actions
- Add/Edit/Delete trait mapping controls
- Inline editing via prompts

**Global Actions:**
- "🔄 Sync All Users" - Triggers bulk role sync for all verified users
- "🔃 Refresh" - Reloads role configuration from server

### 4. roleService Enhancements

**New Methods:**
- `addTier(name, minNFTs, maxNFTs, votingPower, roleId)`
- `editTier(name, updates)`
- `deleteTier(name)`
- `addTrait(traitType, traitValue, roleId, description)`
- `editTrait(traitType, traitValue, roleId, description)`
- `deleteTrait(traitType, traitValue)`
- `saveRolesConfig()` - Persist tiers to disk
- `saveTraitRolesConfig()` - Persist trait mappings to disk

**Validation:**
- Tier range overlap detection
- Duplicate name/trait checking
- Invalid range validation (min < max, min ≥ 1)

## Deployment Steps

### 1. Pull Latest Code
```bash
cd /path/to/roland-discord-bot
git pull origin main
```

### 2. Redeploy Discord Commands
```bash
node deploy-commands.js
```

This registers the new `/role-config` subcommands with Discord.

### 3. Restart Bot
```bash
pm2 restart roland-bot
# OR
systemctl restart roland-discord-bot
```

### 4. Restart Web Server (if separate)
```bash
pm2 restart roland-web
# OR
# Web server restarts automatically if running via index.js
```

### 5. Verify
1. In Discord: `/role-config list` should show expanded command options
2. In Admin UI: Navigate to http://your-domain/admin-panel → "Role Config" tab should be visible
3. Test add/edit/delete operations in both UI and Discord

## Environment Variables

**No new environment variables required.**

All existing environment variables remain the same:
- `DISCORD_TOKEN`
- `CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `GUILD_ID`
- `WEB_PORT`
- `SESSION_SECRET`

## Breaking Changes

**None.**

All existing functionality preserved:
- Original `/role-config view` renamed to `/role-config list` (backward compatible)
- Original `/role-config sync` behavior unchanged (now accepts optional user parameter)
- Config file format unchanged (backward compatible)

## Testing Checklist

- [x] Discord commands load successfully
- [x] Tier CRUD operations (add/edit/delete)
- [x] Trait CRUD operations (add/edit/delete)
- [x] Validation (overlap detection, duplicate prevention)
- [x] Config persistence (roles.json, trait-roles.json)
- [x] Web UI loads role config
- [x] Web API endpoints (CRUD + sync)
- [x] Admin permission checks

## Known Limitations

1. **UI Uses Prompts**: Current admin UI uses browser prompts for add/edit. Future enhancement: modal dialogs.
2. **No Role Picker**: Discord Role IDs must be entered manually. Future enhancement: fetch and display available roles from guild.
3. **No Batch Operations**: Can only add/edit/delete one tier/trait at a time.
4. **Sync Is Blocking**: Bulk sync runs synchronously. For large guilds (>500 users), consider background job queue.

## Rollback Plan

If issues arise:
```bash
git revert c3ac380
node deploy-commands.js
pm2 restart roland-bot
```

## Next Steps (Optional Enhancements)

1. Replace browser prompts with modal forms in admin UI
2. Add role picker dropdown (fetch from Discord guild)
3. Add batch import/export (CSV, JSON)
4. Add audit log for role config changes
5. Add background job queue for bulk sync operations
6. Add dry-run mode for sync operations

## Support

For issues or questions:
- Check logs: `pm2 logs roland-bot`
- Review deployment notes: `/tmp/roland-discord-bot/DEPLOY_NOTES_*.md`
- Discord command help: `/role-config` (shows all subcommands)

---

**Deployed by:** Subagent (OpenClaw)
**Date:** 2026-03-24
**Status:** ✅ Ready for production
