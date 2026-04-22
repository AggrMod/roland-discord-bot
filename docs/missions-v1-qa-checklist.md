# Missions v1 QA Checklist

## Scope
- Module: `heist` (displayed as `Missions` or branded label)
- Surfaces:
- Discord slash/panel
- Portal admin (`/portal` Missions section)
- Public web APIs (`/api/public/v1/heist/*`)
- Admin APIs (`/api/admin/heist/*`)

## Environment Prep
1. Ensure migration `v10 heist_v1_foundation` is applied.
2. Verify module toggle:
- `tenant_modules.module_key = 'heist'` is enabled for target guild.
3. Configure at least one channel in Missions settings:
- Mission feed/log channels
- Vault log channel (if ticketing is disabled)
4. Ensure test users have linked wallets and NFTs.

## Core Flow
1. Create template in portal admin.
2. Spawn mission manually (`Spawn Now`) and verify mission appears in:
- portal available missions
- Discord board/panel
3. Join mission from Discord and/or web.
4. Verify lock behavior:
- same NFT cannot be joined in second active mission.
5. Resolve mission and verify:
- mission status updates
- rewards credited to profile
- locks removed

## Ownership / Failure Rules
1. Start co-op mission with two users.
2. Remove one participant NFT ownership before resolution.
3. Resolve and verify:
- affected slot fails with `nft_no_longer_owned`
- unaffected slot still succeeds
- mission can still complete when at least one slot succeeds

## Vault / Streetcredit
1. Add vault item with stock `1`.
2. Redeem once:
- streetcredit deducted once
- redemption record created
3. Redeem second time:
- fails as out-of-stock
- no extra deduction
4. Update redemption status in portal admin:
- pending -> completed/cancelled/failed
- DB row updates and metadata note persists

## Admin Controls
1. Save Missions config values and reload page:
- values persist
2. Save ladder values and reload:
- rank rows persist
3. Add/remove trait bonus rules:
- list updates correctly
4. Add/remove vault items:
- list updates correctly

## API Smoke
1. `GET /api/public/v1/heist/meta`
2. `GET /api/public/v1/heist/missions/active`
3. `POST /api/public/v1/heist/missions/:id/join`
4. `GET /api/public/v1/heist/vault/items`
5. `POST /api/public/v1/heist/vault/redeem`
6. `GET /api/admin/heist/vault/redemptions`
7. `PUT /api/admin/heist/vault/redemptions/:id`

## Automated Local Test
- Run:
```bash
node tests/test-heist-v1-flow.js
```
- Expected:
- `Heist v1 flow assertions passed`
