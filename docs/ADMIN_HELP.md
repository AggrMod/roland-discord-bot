# Admin Help (Live Command Reference)

> **Permission note:** All game & mini-game commands require **Admin or Moderator** permissions.
> Moderator = any member with Administrator, Manage Server, Manage Messages, Moderate Members, or Kick Members permission.

---

## Verification
- `/verification status`
- `/verification wallets`
- `/verification refresh`
- `/verification quick`
- Admin: `/verification admin panel|export-user|remove-user|export-wallets|token-role-add|token-role-remove|token-role-list|role-config|actions|og-view|og-enable|og-role|og-limit|og-sync`

## Governance
- `/governance propose`
- `/governance support`
- `/governance vote`
- Admin: `/governance admin list|cancel|settings`

## Treasury
- `/treasury view`
- Admin: `/treasury admin status|refresh|enable|disable|set-wallet|set-interval|tx-history|tx-alerts`

---

## Battle ⚔️
> **Admin/Mod only**

- `/battle create` — Create battle lobby (optional: role gating, max players)
- `/battle start` — Start your open lobby (requires min players)
- `/battle cancel` — Cancel your open lobby
- `/battle stats` — Show battle stats and leaderboards
- Admin: `/battle admin list|force-end|settings`

### Role Gating (Optional)
When creating a lobby, you can gate participation:

**Required Roles (ANY Logic):**
- `required_role_1`, `required_role_2`, `required_role_3`
- User must have **at least ONE** of these roles to join

**Excluded Roles (NONE Logic):**
- `excluded_role_1`, `excluded_role_2`, `excluded_role_3`
- User **cannot have ANY** of these roles

**Example:**
```
/battle create max_players:10 required_role_1:@Member excluded_role_1:@Muted
```

**Elite Four Mode (Auto):** Activates when 4 players remain — all reset to 100 HP, increased drama.

---

## Mini-Games 🎮
> **Admin/Mod only to start** — Anyone can join by reacting
> Individual games: **free on all plans**
> Game Night (multi-game sessions): **Growth plan minimum**

### 🃏 Higher or Lower
- `/higherlower start [join_time]` — Card game: is the next card higher or lower?
- `/higherlower cancel` — Cancel lobby (host only)
- Players react ⬆️ (Higher) or ⬇️ (Lower) each round. Wrong guess = eliminated. Last player wins.
- Ace = highest card (14). Ties = everyone survives.

### 🎲 Dice Duel
- `/diceduel start [join_time]` — Everyone rolls a d6 each round. Lowest roll is eliminated.
- `/diceduel cancel` — Cancel lobby (host only)
- Ties at the bottom → tiebreaker roll. Last player standing wins.

### ⚡ Reaction Race
- `/reactionrace start [join_time]` — React ⚡ as fast as possible each round. Slowest is eliminated.
- `/reactionrace cancel` — Cancel lobby (host only)
- Random delay before GO signal. Last to react (or doesn't react) is eliminated.

### 🔢 Number Guess
- `/numberguess start [join_time]` — Type a number 1–100 in chat. Closest to the secret number wins the round.
- `/numberguess cancel` — Cancel lobby (host only)
- 3 rounds. Most points accumulated wins overall.

### 🎰 Slots
- `/slots start [join_time]` — Everyone spins simultaneously. Highest combo wins.
- `/slots cancel` — Cancel lobby (host only)
- Combos: 3-of-a-kind 💎 > 3-of-a-kind 🍒 > pairs > mixed. Ties = shared win.

### ❓ Trivia
- `/trivia start [join_time]` — 5 questions from a 30-item bank. React 🇦🇧🇨🇩 to answer.
- `/trivia cancel` — Cancel lobby (host only)
- 20 seconds per question. Most correct answers wins.

### 🧩 Word Scramble
- `/wordscramble start [join_time]` — Unscramble the word by typing it in chat. First correct answer wins the round.
- `/wordscramble cancel` — Cancel lobby (host only)
- 5 rounds, 30 seconds each. Most rounds won wins.

### 🪨 RPS Tournament
- `/rps start [join_time]` — Rock Paper Scissors bracket tournament.
- `/rps cancel` — Cancel lobby (host only)
- Random bracket matchups each round. React 🪨✂️📄. Loser eliminated. Ties → both survive and re-match. Last one wins.

### 🎴 Blackjack
- `/blackjack start [join_time]` — Everyone plays against the dealer. Get closest to 21 without busting.
- `/blackjack cancel` — Cancel lobby (host only)
- React 👆 Hit or ✋ Stand. Ace = 11 or 1. Dealer hits until 17+. All who beat the dealer win.

---

## Game Night 🎮
> **Admin/Mod only · Growth plan required**
> Runs multiple games in sequence with a shared leaderboard across all games.

### Commands
- `/gamenight start [games] [join_time]` — Start a Game Night lobby
  - `games` (optional): comma-separated keys, e.g. `diceduel,trivia,slots` (default: all 9)
  - `join_time` (optional): 30–180s gather window (default 90s)
- `/gamenight skip` — Skip the current game (host only)
- `/gamenight cancel` — Cancel the session (host only)
- `/gamenight games` — List all valid game keys

### Scoring (per game)
| Place | Points |
|---|---|
| 🥇 1st | 10 pts |
| 🥈 2nd | 7 pts |
| 🥉 3rd | 5 pts |
| 4th | 3 pts |
| 5th+ | 1 pt |

### Available Games
| Key | Game | Type |
|---|---|---|
| `diceduel` | 🎲 Dice Duel | Lowest roll eliminated |
| `higherlower` | 🃏 Higher or Lower | Wrong guess = out |
| `reactionrace` | ⚡ Reaction Race | Slowest to react is out |
| `numberguess` | 🔢 Number Guess | Closest to secret number |
| `slots` | 🎰 Slots | Best spin combo |
| `trivia` | ❓ Trivia | Most correct answers |
| `wordscramble` | 🧩 Word Scramble | First to unscramble |
| `rps` | 🪨 RPS Tournament | Bracket elimination |
| `blackjack` | 🎴 Blackjack | Beat the dealer |

### How It Works
1. `/gamenight start` posts a lobby — players react 🎉 to join
2. After gather time, games run sequentially
3. Each game runs compressed (no lobby phase — players already set)
4. Points awarded per placement after each game
5. Leaderboard shown between games
6. Champion crowned at the end with final standings


---

## Game Night 🎉
> **Admin/Mod only** · **Growth plan minimum**
> Orchestrates all 9 mini-games in sequence, tracking cross-game scores and crowning a champion.

- `/gamenight start [join_time] [games]` — Open lobby. React 🎉 to join. Starts in 90s (configurable 30–180s).
  - `games` = optional comma-separated list, e.g. `trivia,slots,diceduel` (default: all 9)
- `/gamenight skip` — Skip the current game (host only)
- `/gamenight cancel` — Cancel the lobby or running session (host only)
- `/gamenight leaderboard` — Show current standings mid-session

**Scoring per game:**
| Place | Points |
|---|---|
| 🥇 1st | 10 pts |
| 🥈 2nd | 7 pts |
| 🥉 3rd | 5 pts |
| 4th | 3 pts |
| 5th+ | 1 pt |

**Game lineup:** Dice Duel → Higher or Lower → Reaction Race → Number Guess → Slots → Trivia → Word Scramble → RPS → Blackjack (or your custom order)

---

## Heist 🎯
- `/heist view|signup|status`
- Admin: `/heist admin create|list|cancel`
- Note: module disabled by default.

---

## Config ⚙️
- `/config modules` — View all module toggle states
- `/config toggle` — Toggle a module on or off (verification/governance/treasury/battle/heist)
- `/config status` — System status overview (uptime, memory, guilds)

---

## Plans Summary

| Feature | Starter (Free) | Growth ($19.99/mo) | Pro ($49.99/mo) | Enterprise (Contact) |
|---|---|---|---|---|
| Verification | Yes | Yes | Yes | Custom |
| Governance | Yes | Yes | Yes | Custom |
| Treasury | Yes | Yes | Yes | Custom |
| NFT/Token/Wallet Trackers | Limited | Expanded | High limits | Custom |
| Minigames | Limited | Expanded | All | Custom |
| Branding & White-label | Basic | Enhanced | Advanced | Custom |
| Multi-server coverage | Single server | Single server | Single server | Multi-server |

> Yearly billing applies a 15% discount.

