# Admin Help (Live Command Reference)

This file is the source-of-truth command reference for the current production command surface.

## Command Taxonomy
- Canonical module commands: `/verification`, `/governance`, `/treasury`, `/wallet-tracker`, `/nft-tracker`, `/token-tracker`, `/points`, `/heist`, `/config`.
- Minigames currently run through dedicated commands (`/battle`, `/higherlower`, `/diceduel`, `/reactionrace`, `/numberguess`, `/slots`, `/trivia`, `/wordscramble`, `/rps`, `/blackjack`, `/gamenight`) and are mapped to the `minigames` module entitlement.

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

## Wallet Tracker
- `/wallet-tracker add`
- `/wallet-tracker remove`
- `/wallet-tracker list`
- `/wallet-tracker edit`
- `/wallet-tracker holdings`
- `/wallet-tracker refresh-all`

## NFT Tracker
- `/nft-tracker collection add`
- `/nft-tracker collection remove`
- `/nft-tracker collection list`
- `/nft-tracker collection feed`

## Token Tracker
- `/token-tracker add`
- `/token-tracker edit`
- `/token-tracker remove`
- `/token-tracker list`
- `/token-tracker feed`

## Points (Engagement)
- `/points balance`
- `/points leaderboard`
- `/points history`
- `/points shop`
- `/points redeem`
- `/points admin`

## Minigames
- Battle: `/battle create|start|cancel|stats` and `/battle admin list|force-end|settings`
- Arcade commands: `/higherlower start|cancel`, `/diceduel start|cancel`, `/reactionrace start|cancel`, `/numberguess start|cancel`, `/slots start|cancel`, `/trivia start|cancel`, `/wordscramble start|cancel`, `/rps start|cancel`, `/blackjack start|cancel`
- Game Night: `/gamenight start|skip|cancel|leaderboard`

## Missions (Heist)
- `/heist view|signup|status`
- Admin: `/heist admin create|list|cancel`

## Config
- `/config modules`
- `/config toggle`
- `/config status`

## Web Portal-Only Management
These are intentionally managed in the portal (`/admin`, `/?section=settings`, `/?section=admin`) and not full slash-command flows:
- Ticketing categories/panel controls
- Role panel builder UI
- Branding editor
- Billing plan/renewal management
- Superadmin tenant templates and overrides

## Plan Summary
- Starter: free per server
- Growth: $19.99 per server
- Pro: $49.99 per server
- Enterprise: contact team (multi-server/custom)
- Yearly billing: 15% discount
- Plan model: features stay available across plans; plan upgrades raise module limits/capacity.
