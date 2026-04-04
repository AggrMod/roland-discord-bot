# Portal Unification Plan (Superadmin + User)

## Scope
Unify the current user portal and superadmin experience into one intuitive flow without changing bot functionality.

## Initialized Page Inventory

### Core sections
- `landing`
- `dashboard`
- `servers`
- `governance`
- `wallets`
- `heist`
- `nft-activity`
- `battle`
- `engagement`
- `self-serve-roles`
- `ticketing`
- `treasury`
- `help`
- `admin`
- `plans`
- `settings`

### Admin cards
- `stats`, `users`, `proposals`, `settings`
- `superadmin`, `monitor`
- `voting power`, `NFT tracker`, `self-serve roles`
- `analytics`, `help`, `activity`, `roles`
- `API reference`, `ticketing`, `engagement`

### Settings tabs
- `general`, `governance`, `verification`, `branding`
- `treasury`, `nfttracker`, `battle`, `heist`
- `selfserve`, `ticketing`, `engagement`

## Current UX Gaps
- Mixed mental model: section navigation, settings tabs, and admin cards feel like separate apps.
- Legacy path drift (`/admin-panel`) and portal path (`/?section=admin`) create operator confusion.
- Discoverability issues: tenant/server context and module gating are not always obvious before users click.
- Information hierarchy is inconsistent between normal admin and superadmin.

## Target UX Principles
- One shell, one navigation language, one set of interaction patterns.
- Tenant context always visible and always explicit.
- Every page answers: what this does, what context it uses, what action to take next.
- Role-aware progressive disclosure (member < admin < superadmin), not separate experiences.

## Proposed Information Architecture

### Primary nav
- Home
- Modules
- Operations
- Settings
- Help

### Context rail (persistent)
- Active server
- Plan
- Enabled modules
- Environment status

### Admin mode inside same shell
- Toggle into "Admin Workspace" (no hard page switch)
- Superadmin tools appear as additional panes, not a separate app

## Phased Rollout

### Phase 1: Foundation (no behavior change)
1. Centralize page/view registry (sections, admin cards, settings tabs).
2. Normalize route entry points so direct links always resolve to portal shell.
3. Standardize empty/loading/error states per page type.

### Phase 2: Navigation + Layout
1. Merge duplicate patterns into one reusable layout system:
   - page header
   - context banner
   - action bar
   - content card grid
2. Replace mixed admin/settings jumps with a single "workspace" pattern.
3. Add breadcrumbs: `Home / Server / Area / Page`.

### Phase 3: Clarity + Guidance
1. Add page-level onboarding hints (first-use tips, required permissions, next action).
2. Add unified command/help drawer linked to current page context.
3. Add validation hints before save actions.

### Phase 4: Polish + Performance
1. Improve perceived speed with lazy-load skeletons and optimistic UI for safe actions.
2. Improve mobile spacing, typography hierarchy, and interaction targets.
3. Add UX telemetry for drop-offs and failed admin flows.

## Success Criteria
- New admin can configure a module in under 2 minutes without docs.
- Superadmin can audit tenant status in one path without context loss.
- No dead links or section mismatch from direct URLs.
- Fewer support tickets for "where is X setting?" and "wrong server context".