# V1 Plan Clarity Strategy (Free / Growth / Pro)

## Goal
Make plan differences explicit everywhere in product UX and keep them stable by using a single backend source of truth.

## Competitor Pattern Review
- MEE6 separates subscriptions by capability bundles (server premium vs AI vs personal perks), which creates clear package boundaries but can confuse users when features are split across products.
- Dyno docs explicitly mark premium-only features with dedicated visual states (gold premium boxes), reducing ambiguity inside module docs.
- Common successful pattern: one canonical plan definition, reused across dashboard, billing, and help surfaces.

## V1 Decisions
- Internal key remains `starter`, but user-facing label is `Free`.
- `config/plans.js` is the canonical source for:
  - plan labels
  - billing amounts
  - marketing tagline
  - Free/Growth/Pro feature rows
- Portal and Superadmin must consume catalog API responses rather than hardcoded labels/cards.

## Implementation
1. Added centralized marketing catalog in [`config/plans.js`](/c:/Users/Roland/OneDrive%20-%20Kleermaker/Cartoon%20Maffia%20DAO/roland-discord-bot/config/plans.js) via `PLAN_MARKETING` + `getPlanCatalog()`.
2. Added public catalog endpoint `GET /api/plans/catalog` in [`web/routes/authUser.js`](/c:/Users/Roland/OneDrive%20-%20Kleermaker/Cartoon%20Maffia%20DAO/roland-discord-bot/web/routes/authUser.js).
3. Updated Superadmin workspace plan feed to use the same catalog in [`web/routes/superadminTenantOps.js`](/c:/Users/Roland/OneDrive%20-%20Kleermaker/Cartoon%20Maffia%20DAO/roland-discord-bot/web/routes/superadminTenantOps.js).
4. Replaced hardcoded plan cards in portal JS with API-driven rendering in [`web/public/portal.js`](/c:/Users/Roland/OneDrive%20-%20Kleermaker/Cartoon%20Maffia%20DAO/roland-discord-bot/web/public/portal.js).

## Why This Prevents Overwrite Drift
- There is now one authoritative plan matrix in backend config.
- Frontend plan UX is fetched from API, so ad-hoc frontend edits cannot silently diverge from entitlement rules.
- Superadmin and tenant-facing plan labels now resolve from the same source.

## Follow-up (Post-V1)
- Add an automated test asserting `/api/plans/catalog` remains aligned with billing and entitlement presets.
- Move public pricing page cards to catalog-driven rendering as well, so marketing site matches portal automatically.
