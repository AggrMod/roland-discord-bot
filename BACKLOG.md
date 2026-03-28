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
