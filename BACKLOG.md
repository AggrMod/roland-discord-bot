## Remove top-nav server selector (redundant)

**Request**: Remove the "Select server" button + server dropdown from the top navigation bar.
**Reason**: Server context is already handled by the sidebar bottom block (server icon + name + "See all servers →"). The top-nav selector is redundant and clutters the nav.
**Scope**:
- `portal.html` — remove `#navServerSelect` dropdown and "Select server" button from top-nav
- `portal.js` — remove `onNavServerSelect()` wiring and any code that shows/hides these elements
- Keep `#activeGuildBadge` if it serves a purpose, or remove it too
- Ensure server switching still works exclusively through the sidebar bottom block

## Home page = full commercial/marketing page

**Request**: Transform the Home page into a proper public-facing marketing/landing page, similar to Solmate's homepage.
**Details**:
- Home page hides the left sidebar entirely — full-width commercial layout
- Add a top-nav button next to "Home" (e.g. "Dashboard" or "Go to Bot") that takes you to server selection
- Left sidebar only appears when user is in bot management or profile sections (post-server-selection)
- Home page content: hero section, feature highlights, CTAs (Invite bot, Open Dashboard)
**Scope**:
- `portal.html` — toggle sidebar visibility based on current section
- `portal.js` — hide sidebar on `section-landing`, show on all other sections
- `portal-style.css` — full-width layout mode when sidebar is hidden

## Server selection tiles: smaller + server logo + 3 per row

**Request**: In the server selection / "See all servers" view, make the server cards smaller and add the server icon/logo to each tile. Show 3 tiles per row.
**Details**:
- Current tiles are too large and sparse
- Each tile should show: server icon/initials (36-40px) + server name
- Grid: `repeat(3, 1fr)` or `repeat(auto-fill, minmax(180px, 1fr))`
- Compact card height (~70-80px)
**Scope**:
- `portal.html` — server card HTML in managed/unmanaged server lists
- `portal.js` — `loadServerAccess()` renders server cards
- `portal-style.css` — server card sizing

## Bot activity status — configurable per tenant

**Request**: Replace hardcoded "The Commission" bot activity status with the tenant's display name from branding settings, falling back to a generic default.
**Details**:
- Bot activity should show tenant branding name (e.g. "Serving The Solpranos") or generic "Serving your community"
- Configurable per server via the Branding settings panel (bot_display_name field)
**Scope**:
- Search and replace hardcoded "The Commission" in `index.js` or wherever bot presence is set
- Pull from tenant branding config if available

## Battle: more built-in eras + custom era support

**Request**: Expand the battle system with more historical/thematic eras, and allow server admins to create custom eras via the branding/settings panel.
**Details**:
- Add more built-in eras (beyond current set — e.g. Medieval, Cyberpunk, Wild West, Space Age, etc.)
- Custom eras: admin can define era name, theme description, weapon/ability flavor text
- Custom eras stored per-tenant in DB
- Accessible via Branding or Battle settings tab

## Branding as a visible module/settings section

**Request**: Branding settings (bot display name, logo, colors, emoji, support URL) should be visible to server admins in their Settings panel — not just superadmins.
**Details**:
- Currently branding is only editable in the superadmin tenant panel
- Add a "Branding" tab or card in the admin Settings section (`section-settings`)
- Fields: bot display name, brand emoji, brand color, logo URL, support URL
- Writes to the same `tenant_branding` table via a new `/api/admin/branding` endpoint (session-scoped to own guild)

## BUG: Settings not visible to admins without superadmin rights

**Priority**: High — blocks all non-superadmin guild admins from configuring their server
**Details**:
- Regular guild admins (Discord server owners/admins) can log in but Settings tab content doesn't load or is inaccessible
- Only the superadmin (SUPERADMIN_DISCORD_ID in .env) can see full settings
- Need to audit `adminAuthMiddleware` and settings endpoint auth — regular admins should be able to manage their own server settings
**Scope**:
- `web/server.js` — verify `adminAuthMiddleware` resolves guild admin correctly
- `portal.js` — verify `isAdmin` is set for guild owners/admins, not just superadmin

## NFT Tracker: polling fallback for collection activity (replaces pure webhook approach)

**Problem**: Helius webhooks fire when a watched address appears in a transaction. Magic Eden/Tensor listing transactions reference the individual NFT mint, not the verified collection address — so collection-level webhooks never trigger for listings.

**Solution**: Add a polling cron alongside the existing webhook:
- Every 5 minutes, call Helius DAS `GET /v0/addresses/{collection}/transactions?type=NFT_LISTING,NFT_SALE` for each tracked collection
- Deduplicate by `tx_signature` against `nft_activity_events` table (already have the column)
- Process new events through existing `ingestEvent()` → `maybeSendAlert()` pipeline
- Webhook stays as fast path; polling is the reliable fallback

**Helius endpoint**: `POST https://api.helius.xyz/v0/addresses/{address}/transactions?api-key={key}` with `{ "types": ["NFT_LISTING", "NFT_SALE", "NFT_MINT"] }`
**Scope**: New cron in `index.js` + `nftActivityService.pollCollectionActivity()` method

## NFT Tracker: embed polish & optimization

**Request**: Improve the Discord alert embed quality and UX
**Ideas**:
- Show the actual NFT name/number (e.g. "Vault Runner #1043") instead of shortened mint address — fetch from Helius DAS or ME metadata
- Show floor price alongside listing price (context for whether it's a good deal)
- Add rarity rank if available
- Seller wallet as a clickable Solscan profile link
- Smarter price display: show "Listed below floor 🔥" or "Above floor" label
- Debounce rapid-fire delist/relist events (don't spam if someone relists quickly)
- Configurable min-price filter per collection (ignore dust listings)
- Poll interval configurable per server (default 5 min)

## NFT Tracker: buyer identity resolution

**Request**: When an NFT sale/mint alert fires, check if the buyer's wallet address exists in the verification table. If it does, resolve to their Discord username and:
- Show Discord username in the embed instead of shortened wallet address
- Tag the user in the alert message: "🎉 Congrats <@userId> on your new Vault Runner!"
- Fall back to shortened wallet address if wallet not linked to any Discord account
**Data source**: `verified_wallets` (or equivalent) table — join on `wallet_address = buyer_wallet`
**Scope**: Only applies to `sale` and `mint` event types (not list/delist)
