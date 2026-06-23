# GuildPilot — Module Guide (Features, Options & Plan Limits)

**Last updated:** 2026-06-23

This document explains every module in the bot: what it does, the options it exposes, and its limits **per plan**. There are **19 modules**.

## Plans at a glance

| Plan | Price (USD/mo) | Positioning |
|---|---|---|
| **Free** (`starter`) | $0 | All core modules enabled **except AI Assistant** |
| **Growth** | $19.99 | Higher limits + X (Twitter) engagement; Telegram Bridge |
| **Pro** | $49.99 | **All** modules incl. AI Assistant + highest limits + advanced branding |
| **Enterprise** | Custom | Unlimited / custom limits, custom commercial terms |

All paid plans offer a **15% annual discount**. A `null` limit below means **unlimited** for that plan.

**Module availability:** Every module is enabled by default on every plan **except AI Assistant**, which is **Free/Growth: off, Pro/Enterprise: on**. Note: limits such as `aiassistant` requests/day = 0 on Free/Growth are what actually gate paid features even where a module flag could be toggled.

> Plan-wide caps: `max_commands` (Free 20 / Growth 40 / Pro 80 / Ent ∞), `max_branding_profiles` (1/1/2/∞), `max_read_only_overrides` (0/1/2/∞). `max_enabled_modules` is uncapped on all current plans.

---

## 1. Verification

**Purpose:** Link Solana wallets to Discord accounts and grant roles based on on-chain holdings.

**What it does:**
- Link multiple Solana wallets per user, proven via **wallet signature** (sign a challenge) or **micro-verification** (tiny SOL self-transfer of a unique amount).
- Auto-counts NFTs and assigns **tier roles** (Associate → Soldato → Capo → Elite → Underboss → Don) and calculates **voting power** used by Governance.
- **Token-gating** (hold ≥ N of an SPL token → role), **trait roles** (specific NFT attributes → role), and an **OG role** system (early-member role with a configurable cap).
- Real holdings via the **Helius DAS API** (`HELIUS_API_KEY` required); falls back to mock data only outside production.

**Commands:** `/verification status | wallets | refresh | quick`; admin: `/verification admin panel | role-config | actions | export-user | remove-user | export-wallets | token-role-add/remove/list | og-view/enable/role/limit/sync`. Web portal: Verification Roles config, `POST /api/admin/roles/traits`.

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Total verification rules | 3 | 12 | 50 | ∞ |
| Tiers | 3 | 8 | 25 | ∞ |
| Trait rules | 3 | 8 | 25 | ∞ |
| Token rules | 3 | 8 | 25 | ∞ |

---

## 2. Governance

**Purpose:** Community DAO proposals with NFT-weighted voting.

**What it does:** Members create proposals (title, description, goal, cost, category); proposals gather **supporters** and auto-promote to voting after enough support; voting power is **weighted by verification tier**; enforces a **25% quorum**, runs **7-day** voting windows with auto-close, and supports proposal comments. Admins can list/cancel and tune settings.

**Commands:** `/governance propose | support | vote`; admin: `/governance admin list | cancel | settings`.

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Active proposals | 3 | 25 | 100 | ∞ |

---

## 3. Treasury

**Purpose:** Monitor on-chain treasury wallet balances and transactions (read-only — never signs/sends).

**What it does:** Watches Solana wallet(s) for **SOL + USDC** balances, refreshes on a configurable interval (default 4h), posts a balance panel, and sends **transaction alerts** (with incoming-only and minimum-SOL-threshold filters) to a chosen channel. Supports multiple tracked wallets.

**Commands:** `/treasury view`; admin: `/treasury admin status | refresh | enable | disable | set-wallet | set-interval | tx-history | tx-alerts`.

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Tracked wallets | 1 | 10 | 50 | ∞ |

> ⚠️ See audit H-1: the primary treasury config is currently global, not per-tenant — fix before multi-tenant launch.

---

## 4. Wallet Tracker

**Purpose:** Track watched wallets' holdings over time.

**What it does:** Add/edit/remove wallet watches, list current holdings, refresh all, and keep **historical holdings snapshots** (NFT/token balances over time).

**Commands:** `/wallet-tracker add | edit | remove | list | holdings | refresh-all`.

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Tracked wallets | 1 | 25 | 200 | ∞ |

---

## 5. Invite Tracker

**Purpose:** Track who invited whom, with leaderboards and exports.

**What it does:** Who-invited-who lookup, leaderboards by period (7d/30d/all-time), invite-link generation buttons, optional NFT-stats overlay on the leaderboard, and CSV export. Includes burst-limit heuristics (default 8 invites / 30 min) to curb invite spam.

**Commands:** `/invites who | leaderboard | panel | export`.

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| History window (days) | 30 | 180 | ∞ | ∞ |
| Leaderboard rows | 10 | 50 | 200 | ∞ |
| CSV export | ✗ | ✓ | ✓ | ✓ |
| Time filters | ✗ | ✓ | ✓ | ✓ |

---

## 6. Minigames

**Purpose:** A 10-game suite plus orchestrated Game Night, all with reaction-based lobbies.

**What it does:** Battle Royale (HP elimination), Higher/Lower, Dice Duel, Reaction Race, Number Guess, Slots, Trivia, Word Scramble, RPS Tournament, Blackjack. **Game Night** runs multiple games in sequence with cross-game scoring (🥇10/🥈7/🥉5/4th3/5th+1) and crowns a champion. All game commands require **Moderator/Admin**.

**Commands:** `/minigames run | help`; per-game `/<game> start | cancel` (and `/battle create|start|cancel|stats`, `/battle admin …`); `/gamenight start | skip | cancel | leaderboard`.

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Enabled games | 3 | 8 | ∞ | ∞ |
| Bounties per battle | 0 | 3 | 3 | ∞ |

> Game order for the per-plan game cap: battle, gamenight, higherlower, diceduel, reactionrace, numberguess, slots, trivia, wordscramble, rps, blackjack — the first *N* are unlocked. Game Night orchestration is effectively **Growth+**.

---

## 7. Missions (Heist)

**Purpose:** Role/NFT-gated cooperative missions with rewards.

**What it does:** Create/view/sign-up for missions with role requirements; **locks NFTs** for participation; multi-slot signups with progress tracking; XP/streetcredit rewards via the Vault progression system. Mission types can tie into other modules (engagement, governance, events). **Disabled by default** — requires explicit per-guild enable.

**Commands:** `/heist view | signup | status`; admin: `/heist admin create | list | cancel`.

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Active missions | 2 | 10 | 50 | ∞ |

---

## 8. Vault

**Purpose:** NFT-locking + XP progression + reward inventory engine that backs Missions.

**What it does:** Lock NFTs for missions; earn XP/streetcredit to climb a **5-rank ladder** (Associate → Soldier → Capo → Underboss → Don); claim from a **reward inventory** with rarity tiers (jackpot/legendary/epic/rare/uncommon) using weight-based random selection; supports **key-tier gating** and per-reward quantity limits. Key spend, claim, and inventory decrement are transactional and idempotent on tx signature.

**Commands:** `/vault` (profile, claim); reward inventory/tier/lock policy via portal admin.

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Reward inventory items | 25 | 100 | 500 | ∞ |

---

## 9. Welcome & Onboarding

**Purpose:** Customizable member welcome and onboarding with optional CAPTCHA.

**What it does:** Welcome messages to channel and/or DM, **multi-step onboarding flows** (embeds + fields), **CAPTCHA** challenge (DM or channel button, 20-min TTL), **auto-roles** on join, optional **welcome image uploads**, template variables (`{user_mention}`, `{server_name}`, `{member_count}`, `{channel:verify}`), and daily analytics (joins, welcomes sent, CAPTCHA attempts/failures).

**Commands:** Portal/admin only (no dedicated slash namespace).

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Auto-roles | 2 | 5 | 20 | ∞ |
| Channel tokens | 1 | 5 | ∞ | ∞ |
| Onboarding step fields | 2 | 5 | 8 | ∞ |
| Image uploads | ✗ | ✓ | ✓ | ✓ |

---

## 10. Ticketing

**Purpose:** Support-ticket system with templates and panels.

**What it does:** Ticket templates with custom fields, panel-based self-service creation, category routing, mention-based resolver/staff roles, close/reopen, and auto-archival. Access governed by Discord permissions.

**Commands:** Portal/admin panel (no dedicated slash namespace).

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Ticket categories | 3 | 12 | 40 | ∞ |

---

## 11. NFT Tracker

**Purpose:** Watch NFT collections and post real-time activity alerts.

**What it does:** Add/remove collection watches; alerts on **mint/sale/list/burn/offer** with event-type emoji badges and per-feed channel/formatting; multi-chain price metadata (Solana, Ethereum, Polygon, …); webhook ingest API for external event sources.

**Commands:** `/nft-tracker collection add | remove | list | feed`.

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Watched collections | 1 | 8 | 40 | ∞ |

---

## 12. Token Tracker

**Purpose:** Monitor SPL token balance changes across tracked wallets.

**What it does:** Add/edit/remove token watch rules; alerts when balances change beyond a threshold (separate epsilons for SOL ~0.00001 and stablecoins ~0.01) with transaction links; durable + transient webhook retry queues for reliability.

**Commands:** `/token-tracker add | edit | remove | list | feed`.

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Tracked tokens | 1 | 8 | 40 | ∞ |

> ⚠️ See audit H-3: add a production MOCK_MODE guard before launch — token gates can be spoofed if mock mode is enabled in prod.

---

## 13. Self-Serve Roles

**Purpose:** Button-based self-assignable role panels.

**What it does:** Create role panels (title/description/channel), add roles, button **claim/unclaim**, optional **single-select** (radio) mode, reordering, and multiple panels per guild. Panel limits enforced by entitlements.

**Commands:** Portal/admin panel (no dedicated slash namespace).

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Role panels | 1 | 8 | 25 | ∞ |

---

## 14. Branding

**Purpose:** White-label the bot's embeds and identity.

**What it does:** Set brand colors, custom footer text, logo/icon URL, bot display name, and **per-module color overrides** (ticketing, self-serve, nfttracker), applied to all module embeds. Falls back to the primary color when a module color isn't set.

**Commands:** Portal/admin panel (no dedicated slash namespace).

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Branding profiles | 1 | 1 | 2 | ∞ |
| Advanced/custom branding | ✗ | ✗ | ✓ | ✓ |

---

## 15. Analytics

**Purpose:** Admin dashboard of server-wide usage and health.

**What it does:** Admin-only portal view (`/api/admin/analytics`) of module usage, user-activity trends, and system health over a configurable window (default 7 days).

**Commands:** Portal/admin panel (no dedicated slash namespace).

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Configurable knobs | — | — | — | — |

> Analytics has no numeric per-plan caps; availability tracks the plan dashboard.

---

## 16. Engagement & Points

**Purpose:** Activity-based points economy with a shop, leaderboards, and X (Twitter) tasks.

**What it does:** Earn points for Discord activity (messages, replies, reactions, game wins, **daily streaks**); browse/redeem a **points shop**; view balance/leaderboard/history; **X provider** integration — link an X account and complete social tasks (follow/like/repost/hashtag tracking); achievements with reward unlocks; admin grant/deduct. Configurable cooldowns and point values.

**Commands:** `/points balance | leaderboard | history | daily | shop | redeem | admin`.

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Shop items | 3 | 25 | 100 | ∞ |
| Discord provider | ✓ | ✓ | ✓ | ✓ |
| X (Twitter) provider | ✗ | ✓ | ✓ | ✓ |

---

## 17. AI Assistant

**Purpose:** AI Q&A and server briefings grounded in your server's knowledge base.

**What it does:** Ask the AI questions in Discord (public or ephemeral, mention or prefix mode); per-user daily limits and token budgets; conversation **memory window**; **knowledge-base ingestion** (docs/PDFs) with embeddings; **moderation/safety** filters (denylists for illegal/fraud/wallet-theft queries + `omni-moderation`); instant **briefing** generation. Providers: OpenAI (`gpt-5.4`) and Gemini (`gemini-2.0-flash`), configurable.

**Commands:** `/aiassistant ask | status | briefing`.

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Module available | ✗ | ✗ | ✓ | ✓ |
| Requests / day | 0 | 0 | 1000 | ∞ |

> **Pro-only.** This is the single module disabled by default on Free/Growth.

---

## 18. Telegram Bridge

**Purpose:** Mirror messages between Discord and Telegram.

**What it does:** One-way or two-way mirroring (`telegram_to_discord`, `discord_to_telegram`, `two_way`) for Telegram groups/supergroups/channels/private chats; **media forwarding** (default 8 MB cap); configurable author attribution and source headers; safe Discord message chunking (~1850 chars). Per-mapping enable/disable.

**Commands:** Portal/admin panel (no dedicated slash namespace).

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Module available | ✓ | ✓ | ✓ | ✓ |
| Sync mappings | 1 | 5 | 25 | ∞ |

> Marketing copy lists Telegram Bridge as a Growth+ headline feature; the code enables it on Free with a 1-mapping cap.

---

## 19. Auto Messages

**Purpose:** Scheduled recurring messages.

**What it does:** Create scheduled message rules on **interval / daily / weekly** schedules; **timezone-aware** (default `Europe/Amsterdam`, valid IANA zones required); text + embed combos with custom colors/footers and template variables; per-rule target channel; weekday selection for weekly mode. Minimum interval **15 minutes**; failure backoff capped at 15 min.

**Commands:** Portal/admin panel (no dedicated slash namespace).

| Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Auto messages | 3 | 10 | 50 | ∞ |

---

## Appendix — Consolidated per-plan limit matrix

| Module · Limit | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|
| Verification · rules / tiers / trait / token | 3/3/3/3 | 12/8/8/8 | 50/25/25/25 | ∞ |
| Governance · active proposals | 3 | 25 | 100 | ∞ |
| Treasury · wallets | 1 | 10 | 50 | ∞ |
| Wallet Tracker · wallets | 1 | 25 | 200 | ∞ |
| Invites · history days / rows / export / filters | 30/10/✗/✗ | 180/50/✓/✓ | ∞/200/✓/✓ | ∞ |
| Minigames · games / bounties | 3/0 | 8/3 | ∞/3 | ∞ |
| Missions (Heist) · active missions | 2 | 10 | 50 | ∞ |
| Vault · reward items | 25 | 100 | 500 | ∞ |
| Welcome · roles/tokens/fields/images | 2/1/2/✗ | 5/5/5/✓ | 20/∞/8/✓ | ∞ |
| Ticketing · categories | 3 | 12 | 40 | ∞ |
| NFT Tracker · collections | 1 | 8 | 40 | ∞ |
| Token Tracker · tokens | 1 | 8 | 40 | ∞ |
| Self-Serve Roles · panels | 1 | 8 | 25 | ∞ |
| Branding · profiles / advanced | 1/✗ | 1/✗ | 2/✓ | ∞/✓ |
| Engagement · shop items / Discord / X | 3/✓/✗ | 25/✓/✓ | 100/✓/✓ | ∞ |
| AI Assistant · available / req-day | ✗/0 | ✗/0 | ✓/1000 | ✓/∞ |
| Telegram Bridge · mappings | 1 | 5 | 25 | ∞ |
| Auto Messages · messages | 3 | 10 | 50 | ∞ |

*∞ = unlimited (`null` in plan config). Source of truth: `config/plans.js`.*
