# Sprint A Deployment Notes

## Features Implemented

### A) OG Role System
- **Purpose**: Automatically assign an "OG" role to the first X verified users
- **Configurable**: Fully admin-controlled via commands or web panel
- **Deterministic**: Based on verification timestamp (first wallet link)
- **Non-destructive by default**: Won't remove existing OG holders unless explicit full sync

### B) Role Claim Panel
- **Purpose**: Self-serve role management for optional/interest-based roles
- **Interactive**: Button-based UI for claiming/unclaiming roles
- **Admin-controlled**: Admins configure which roles are claimable
- **Safe**: Validates bot permissions and role hierarchy

---

## Command Redeploy Required

**YES** - Two new admin commands added:
- `/og-config` - Manage OG role settings
- `/role-claim` - Manage self-serve role claim panel

**How to deploy:**
```bash
node deploy-commands.js
```

---

## Restart Steps

1. **Stop the bot** (if running):
   ```bash
   pm2 stop guildpilot
   # OR
   pkill -f "node index.js"
   ```

2. **Pull latest code**:
   ```bash
   git pull origin main
   ```

3. **Install dependencies** (if needed):
   ```bash
   npm install
   ```

4. **Deploy commands**:
   ```bash
   node deploy-commands.js
   ```

5. **Start the bot**:
   ```bash
   pm2 start index.js --name guildpilot
   # OR
   node index.js
   ```

---

## Initial Setup Steps

### 1. OG Role Configuration

Run these commands in Discord (admin only):

```
/og-config view
```
View current OG role settings.

```
/og-config role @OGMember
```
Set which role to assign as the OG role.

```
/og-config limit 100
```
Set how many users should receive OG role (first 100 verified users).

```
/og-config enable true
```
Enable the OG role system.

```
/og-config sync
```
Apply OG role to eligible users (does NOT remove from current holders).

```
/og-config sync full:true
```
Full sync: adds to eligible users AND removes from ineligible ones.

### 2. Role Claim Panel Configuration

Run these commands in Discord (admin only):

```
/role-claim add @RoleName label:"Display Label"
```
Add a role to the claimable list (label is optional, defaults to role name).

```
/role-claim list
```
View all configured claimable roles with status.

```
/role-claim panel
```
Post the role claim panel with buttons to the current channel.

```
/role-claim remove @RoleName
```
Remove a role from the claimable list.

### 3. Web Admin Panel (Optional)

OG Role and Role Claim settings are also available in the web admin panel:

- **URL**: `http://localhost:3000/admin` (or your configured WEB_URL)
- **API Endpoints**:
  - `GET /api/admin/og-role/config` - View OG config
  - `PUT /api/admin/og-role/config` - Update OG config
  - `POST /api/admin/og-role/sync` - Trigger sync
  - `GET /api/admin/role-claim/config` - View claimable roles
  - `POST /api/admin/role-claim/add` - Add claimable role
  - `DELETE /api/admin/role-claim/:roleId` - Remove claimable role

---

## How It Works

### OG Role Assignment

1. **Verification**: When a user links their first wallet (via `/verify` or micro-verify), the system checks if OG role is enabled.
2. **Eligibility Check**: Determines if user is in the first X verified users (by timestamp).
3. **Auto-Assignment**: If eligible and slot available, assigns OG role automatically.
4. **Manual Sync**: Admins can run `/og-config sync` to backfill or adjust assignments.

**Key Behavior**:
- OG role is assigned **once** on first verification
- Subsequent verifications do **not** change OG status
- Use `/og-config sync full:true` only when you want to reshuffle (e.g., limit changed)

### Role Claim Panel

1. **Setup**: Admin adds roles to claimable list via `/role-claim add`
2. **Post Panel**: Admin posts panel with buttons via `/role-claim panel`
3. **User Interaction**: Users click buttons to claim/unclaim roles
4. **Toggle**: Clicking a button adds role if not present, removes if present
5. **Feedback**: User receives ephemeral confirmation message

**Safety Features**:
- Bot validates it can manage the role (hierarchy, permissions)
- Only enabled roles appear in panel
- Managed roles (bot-assigned) are rejected
- @everyone role is rejected

---

## Database Changes

**No migrations required** - OG role and role claim configs are stored in JSON files:
- `config/og-role.json` - OG role configuration
- `config/role-claim.json` - Claimable roles list

These files are auto-created on first load.

---

## Testing Checklist

### OG Role
- [ ] `/og-config view` shows default disabled state
- [ ] `/og-config role @TestRole` sets role successfully
- [ ] `/og-config limit 50` sets limit successfully
- [ ] `/og-config enable true` enables system
- [ ] `/og-config sync` applies role to first 50 verified users
- [ ] New user verification auto-assigns OG role if eligible
- [ ] Web admin panel shows OG config correctly

### Role Claim
- [ ] `/role-claim add @TestRole` adds role successfully
- [ ] `/role-claim add @InvalidRole` rejects if bot can't manage
- [ ] `/role-claim list` shows configured roles with status
- [ ] `/role-claim panel` posts interactive panel
- [ ] Clicking button adds role (if not present)
- [ ] Clicking button removes role (if present)
- [ ] `/role-claim remove @TestRole` removes from config
- [ ] Web admin panel shows role claim config correctly

---

## Troubleshooting

### OG Role Not Assigning
1. Check `/og-config view` - is it enabled?
2. Check role is set and bot can manage it (hierarchy)
3. Check user is actually eligible (in first X by timestamp)
4. Check logs for errors during assignment

### Role Claim Buttons Not Working
1. Check role is in claimable list: `/role-claim list`
2. Check bot has ManageRoles permission
3. Check bot's highest role is above the claimable role
4. Check role is not managed by an integration

### OG Role Not Auto-Assigning on Verification
1. Check `GUILD_ID` is set in `.env`
2. Check bot client is initialized (`global.discordClient`)
3. Check verification creates wallet record with timestamp
4. Check logs for "OG role auto-assigned" message

---

## Configuration Files

### `config/og-role.json`
```json
{
  "enabled": false,
  "roleId": null,
  "limit": 100,
  "version": 1
}
```

### `config/role-claim.json`
```json
{
  "claimableRoles": [],
  "version": 1
}
```

---

## API Reference

### OG Role Endpoints

**GET** `/api/admin/og-role/config`
- Returns current OG role configuration with eligibility stats

**PUT** `/api/admin/og-role/config`
- Body: `{ enabled, roleId, limit }`
- Updates OG role configuration

**POST** `/api/admin/og-role/sync`
- Body: `{ fullSync: boolean }`
- Triggers OG role sync

### Role Claim Endpoints

**GET** `/api/admin/role-claim/config`
- Returns claimable roles list with validation status

**POST** `/api/admin/role-claim/add`
- Body: `{ roleId, label }`
- Adds role to claimable list

**DELETE** `/api/admin/role-claim/:roleId`
- Removes role from claimable list

---

## Notes

- OG role uses wallet creation timestamp (first verification) for ranking
- Role claim panel posts a message with buttons (not editable after post)
- OG role sync by default is additive only (use fullSync for removal)
- Role claim buttons have no rate limiting (instant toggle)
- Both systems respect Discord role hierarchy and permissions
- OG role assignment is non-blocking (runs in background via setImmediate)

---

## Author
Sprint A - OG Role + Role Claim Panel
Deployed: 2026-03-25
Commit: Sprint A: configurable OG role system + self-serve role claim panel
