
## Voting Power Decoupling (Governance refactor)

**Decision**: Decouple VP from NFT verification tiers.

**Current flow**: Wallet verify → NFT count → Tier → VP
**Target flow**:
- Verification module: Wallet verify → NFT holdings → assigns Discord roles
- Governance module: Discord Role → VP mapping (independent table, admin-configurable)

**Benefits**:
- Give VP to advisors/team/contributors without wallet verify
- Governance works even if verification module is disabled
- Manual role grants still get VP
- Cleaner module separation

**Scope**:
- New DB table: `role_vp_mappings (role_id, voting_power)`
- Admin UI: Governance card gets a "Voting Power Mappings" sub-section
- `proposalService` reads VP from role mappings instead of tier config
- `/verification admin` shows role→VP table separately from tier table

## Base Verified Role (post-verification flat assignment)

**Request**: Assign a role to everyone who completes wallet verification, regardless of NFT holdings.

**Examples**:
- "Verified" role → assigned to all wallet-verified members
- "OG" role → assigned to first 250 verifications (already partially built via ogRoleService)

**Design**:
- New admin setting: `baseVerifiedRoleId` — a role ID assigned to every successfully verified user
- Assigned in `roleService.syncUserDiscordRoles()` after all tier/trait roles are processed
- Independent of NFT count (holding 0 NFTs still gets this role)
- Admin UI: Verification module card gets a "Base Verified Role" dropdown (uses Discord role dropdown)
- Stack with OG role system: OG = first X verifications, Verified = everyone

**Scope**:
- `services/roleService.js`: assign baseVerifiedRoleId in syncUserDiscordRoles()
- `config/settings.js`: add baseVerifiedRoleId to defaults
- `web/public/portal.js`: add dropdown in Verification module settings card
- `web/server.js`: include in settings API

## Remove top-nav server selector (redundant)

**Request**: Remove the "Select server" button + server dropdown from the top navigation bar.
**Reason**: Server context is already handled by the sidebar bottom block (server icon + name + "See all servers →"). The top-nav selector is redundant and clutters the nav.
**Scope**:
- `portal.html` — remove `#navServerSelect` dropdown and "Select server" button from top-nav
- `portal.js` — remove `onNavServerSelect()` wiring and any code that shows/hides these elements
- Keep `#activeGuildBadge` if it serves a purpose, or remove it too
- Ensure server switching still works exclusively through the sidebar bottom block
