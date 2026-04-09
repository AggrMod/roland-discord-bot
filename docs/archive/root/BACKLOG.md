# GuildPilot Backlog

_Last updated: 2026-03-31_

---

## 🔴 Open

### CH1 — EVM Wallet Support
**Priority**: High  
**Details**: Verification and NFT/token tracking for EVM chains (ETH, Base, Polygon, etc.)  
- EVM wallet linking in portal (connect via signature challenge like Solana)
- NFT balance check via Alchemy/Moralis/QuickNode for ERC-721/1155
- Token-gated role assignment for ERC-20 holdings
- OG role support for EVM collections

---

### Portal: Engagement & Points — module toggle + settings panel
**Priority**: High (feature exists but has no portal UI)
**Details**: The `/points` system is live but there's no way to configure or enable/disable it from the portal.

**Module toggle** (Settings → Modules card):
- Enable/disable Engagement module per server (currently always on)
- Wire to `engagementService.getConfig(guildId).enabled` flag

**Settings panel** (new "Engagement" tab or card in Settings):
- Enable/disable toggle
- Points per message (default: 5)
- Points per reaction (default: 2)
- Message cooldown in minutes (default: 60)
- Reaction daily cap (default: 5)
- Save button → `PUT /api/admin/engagement/config`

**Shop admin UI** (sub-section or separate tab):
- List all shop items (id, name, cost, type, stock)
- Add item form: name, cost, type (role/code/custom), role picker, description, quantity (-1 = unlimited)
- Remove item button per row
- API: `GET/POST /api/admin/engagement/shop`, `DELETE /api/admin/engagement/shop/:id`

**Leaderboard view** (read-only tab):
- Paginated top-N list, cached 5 min
- API: `GET /api/admin/engagement/leaderboard`

**Scope**: `web/server.js` (new endpoints), `portal.html`, `portal.js`, `portal-style.css`

---

### Portal: Home page → full marketing/landing page
**Details**:
- Home page hides the left sidebar entirely — full-width commercial layout
- Hero, feature highlights, CTAs (Invite bot / Open Dashboard)
- "Dashboard" button in top nav takes you to server selection
- Sidebar only appears post-server-selection
**Scope**: `portal.html`, `portal.js`, `portal-style.css`

---

### Portal: Server selection tiles — smaller, logo, 3 per row
**Details**:
- Current tiles are too large and sparse
- Each tile: server icon/initials (36–40px) + server name
- Grid: `repeat(3, 1fr)` or `repeat(auto-fill, minmax(180px, 1fr))`
- Compact card height (~70–80px)
**Scope**: `portal.html`, `portal.js`, `portal-style.css`

---

### Portal: Branding settings visible to guild admins
**Details**:
- Currently branding is superadmin-only
- Add "Branding" tab in admin Settings section
- Fields: bot display name, brand emoji, brand color, logo URL, support URL
- New `/api/admin/branding` endpoint (session-scoped to own guild)
**Scope**: `web/server.js`, `portal.html`, `portal.js`

---

### Portal: Remove top-nav server selector (redundant)
**Details**: Server context is already in the sidebar bottom block. Top-nav "Select server" button clutters the nav.  
**Scope**: `portal.html`, `portal.js`

---

### Engagement: Phase 2 — X (Twitter) Integration (E5–E6)
**Details**:
- X OAuth connect flow (link X account to Discord profile in portal)
- X task tracking: repost/reply/quote/follow tracked posts & accounts
- X-based point awards (repost=25pts, quote=40pts, reply=30pts, follow=50pts one-time)
- Anti-abuse: one X account per Discord user, bot account age check (>30 days), cooldowns
- Requires paid X API ($10–25/mo pay-per-use tier recommended)
- npm: `twitter-api-v2`
**DB tables needed**: `social_accounts`, `social_tasks`

---

### Engagement: Phase 3 — Web Portal Leaderboard + Shop Admin UI (E4, E7)
**Details**:
- Full leaderboard tab in portal (paginated, cached 5min)
- Shop admin UI (add/edit/remove items, set quantity, view redemptions)
- Anti-abuse hardening (cooldown visibility, alt-account prevention)

---

### Engagement: E9 — Hashtag Campaign Tasks
**Details**:
- Award points when community members post a configured #hashtag on X
- 7-day rolling scan via X search/recent API
- Dedup by tweet ID

---

### Battle: Custom era support (admin-defined eras)
**Details**:
- Admins can define custom era name, theme description, weapon/ability flavor text via portal
- Custom eras stored per-tenant in DB
- Accessible via Battle settings tab

---

### NFT Tracker: Embed polish & optimization
**Ideas**:
- Show actual NFT name/number (e.g. "Vault Runner #1043") — fetch from Helius DAS or ME metadata
- Floor price alongside listing price + "Listed below floor 🔥" label
- Rarity rank if available
- Seller wallet as clickable Solscan profile link
- Debounce rapid-fire delist/relist events
- Configurable min-price filter per collection (ignore dust listings)
- Poll interval configurable per server (default 5 min)

---

## ✅ Completed

| Item | Commit | Notes |
|------|--------|-------|
| OG role reset fix (multi-tenant settings save) | `f569a94` | |
| OG role always blank in portal (GET/PUT) | `20d93ec`, `3c07eb0` | `og-role.json` as authoritative source |
| Micro-verify: remove browser wallet extension | `dfded10` | Static send card with copy buttons |
| Micro-verify settings persistence | `da8472f`, `0cd5b76` | Dedicated `/api/superadmin/global-settings` endpoint |
| Mobile responsiveness overhaul | `189e506`, `d8c8487`, `bdb4ffa`, `aced2b7` | Landing + portal + superadmin |
| Pricing/plans page (Starter/Growth/Pro) | `fa4c078`, `afa5992` | Bocto competitor callout |
| Higher or Lower card game | `062e213`, `21ab08f` | `/higherlower` |
| Dice Duel | `321e8f5` | `/diceduel` |
| 7 more mini-games | `ee4f2e4` | reactionrace, numberguess, slots, trivia, wordscramble, rps, blackjack |
| Admin/mod permission gate on all game commands | `6f08a79` | checkAdminOrModerator() |
| Pricing + docs update for games | `6f08a79` | Games free; Game Night = Growth+ |
| Game Night orchestrator | `daffe32`, `4b5c8d0` | 9 games, lobby→leaderboard→champion |
| 4 new battle eras | `56a0dd8` | Medieval ⚔️ Cyberpunk 🤖 Wild West 🤠 Space Age 🚀 |
| Role claim buttons fix (Discord) | `f77fa98`, `fb163a7` | Was checking empty static config; now queries DB |
| Engagement & Points System (E1–E3, E7 partial) | `c329409` | `/points` command, message/reaction awards, shop, leaderboard |
| getTenantByGuildId TypeError (log spam) | `1274d00` | Method is getTenant() — 2 callsites fixed |
| N1 — NFT polling fallback | already live | 5-min cron + 30s startup delay; confirmed working |
| N2 — NFT embed polish | earlier | |
| N3 — Buyer identity resolution | earlier | |
| B2 — Settings NFT tracker tab edit button fix | earlier | |
| P1–P4 — Portal UX polish | earlier | |
| C1–C2 — Bot activity status + branding visible | earlier | |
| BT2 — Custom era support (UI) | earlier | |
| SOL distributor script | workspace | Ready to deploy to Roland's server |
