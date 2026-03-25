# Admin Help (Live Command Reference)

This file mirrors the current module-first command set.

## Verification
- `/verification status`
- `/verification wallets`
- `/verification refresh`
- `/verification quick`
- Admin: `/verification admin panel|export-user|remove-user|export-wallets|role-config|actions|og-view|og-enable|og-role|og-limit|og-sync|activity-watch-add|activity-watch-remove|activity-watch-list|activity-feed|activity-alerts`

## Governance
- `/governance propose`
- `/governance support`
- `/governance vote`
- Admin: `/governance admin list|cancel|settings`

## Treasury
- `/treasury view`
- Admin: `/treasury admin status|refresh|enable|disable|set-wallet|set-interval|tx-history|tx-alerts`

## Battle

### Commands
- `/battle create` — Create battle lobby (optional: role gating, max players) **[Admins/Mods only]**
- `/battle start` — Start your open lobby (requires min players) **[Admins/Mods only]**
- `/battle cancel` — Cancel your open lobby (updates lobby message + removes reactions)
- `/battle stats` — Show battle stats and leaderboards
- Admin: `/battle admin list|force-end|settings`

### Role Gating (Optional)
When creating a lobby, you can gate participation:

**Required Roles (ANY Logic):**
- `required_role_1`, `required_role_2`, `required_role_3`
- User must have **at least ONE** of these roles to join
- If not met: user is blocked with DM notification

**Excluded Roles (NONE Logic):**
- `excluded_role_1`, `excluded_role_2`, `excluded_role_3`
- User **cannot have ANY** of these roles
- If found: reaction removed, user sent DM

**Example:**
```
/battle create max_players:10 required_role_1:@Member required_role_2:@Supporter excluded_role_1:@Bot excluded_role_2:@Muted
```

Users with @Member OR @Supporter can join, but NOT @Bot or @Muted holders.

**Channel Rule:**
- Only one active battle per channel at a time (`open` or `in_progress`).

**Elite Four Mode (Auto):**
- Activates when 4 players remain
- All 4 reset to 100 HP
- Lucky escapes/revivals disabled
- Increased combat intensity + narrative drama

## Heist
- `/heist view|signup|status`
- Admin: `/heist admin create|list|cancel`
- Note: module disabled by default.

## Config
- `/config modules`
- `/config toggle`
- `/config status`
