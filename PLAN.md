### Portal Unification A–Z (Topbar IA + Premium Consistency)

#### Summary
Rework the portal into one consistent layout system across all sections using a **unified topbar** (no left sidebar), a dual-purpose **home page** (marketing + quicklinks), a new **username submenu + Profile page**, and a fully reorganized **superadmin task-tab experience**.  
Implementation scope centers on [portal.html](c:\Users\Roland\OneDrive - Kleermaker\Cartoon Maffia DAO\roland-discord-bot\web\public\portal.html), [portal.js](c:\Users\Roland\OneDrive - Kleermaker\Cartoon Maffia DAO\roland-discord-bot\web\public\portal.js), and [portal-style.css](c:\Users\Roland\OneDrive - Kleermaker\Cartoon Maffia DAO\roland-discord-bot\web\public\portal-style.css).

#### Implementation Changes
- Global shell and navigation:
1. Remove sidebar-driven IA and make topbar the single primary navigation model.
2. Add role-aware topbar links: `Home`, `Servers`, `Help`, `Pricing` (public), plus admin/superadmin entries when allowed.
3. Add username dropdown submenu with `Profile`, `Wallet Verification`, `Privacy`, `Logout`.
4. Keep mobile menu behavior aligned with topbar links and role gating.

- Home page (marketing + quick actions):
1. Keep hero/feature/flow marketing sections and add explicit quicklink cards:
   - `User Panel` (Profile)
   - `Admin Settings` (via Server Selector)
   - `Superadmin` (visible only for superadmins)
2. Add pricing entry points from home and topbar.
3. Keep server-context card visible when a guild is active; keep module hub tile experience for selected server.

- Profile/User settings:
1. Add `section-profile` and make it the user control center.
2. Include account summary + existing wallet management + privacy controls (reuse existing APIs and wallet actions).
3. Keep backward compatibility by mapping legacy dashboard intent to profile/home without breaking existing links.

- Admin/superadmin cleanup:
1. Standardize admin/settings/superadmin section headers, spacing, card hierarchy, and action bars.
2. Redesign superadmin as **task tabs**:
   - `Tenants`
   - `Identity`
   - `Global Ops` (superadmins, chain emojis, micro-verify, AI providers)
   - `Monitoring`
3. Replace superadmin’s giant inline mixed panel with structured tab panels while preserving existing action handlers and IDs used by JS functions.

- Visual system consistency/premium polish:
1. Consolidate duplicate CSS token/theme blocks into one canonical token set.
2. Replace layout-critical inline styles with reusable classes for consistent page rhythm.
3. Normalize section shell patterns so landing, server selector, profile, settings, help, plans, and superadmin share the same visual language.

#### Public/Interface Changes
- Add new portal section key and URL support: `section=profile` (and `/profile` alias route expected).
- Make `plans`/pricing routable from public home/top nav (no server selection required to view).
- Navigation contract changes from sidebar data-nav to topbar/mobile role-aware links.
- Keep existing backend APIs unchanged (`/api/user/me`, wallet actions, privacy opt-out, admin/superadmin endpoints).

#### Test Plan
1. Anonymous user: can open home marketing + pricing + help; no admin controls shown.
2. Authenticated member: username submenu works; profile loads wallet list/privacy toggle; wallet actions still function.
3. Admin (with selected server): quicklink to server selector and settings works; module hub/settings navigation remains coherent.
4. Superadmin: new task-tab superadmin UI loads all domains (Tenants/Identity/Global Ops/Monitoring) with existing actions intact.
5. Server selection gate: tenant-sensitive pages still gate correctly; public pages (`home/help/pricing`) remain accessible.
6. Mobile: topbar/menu parity, dropdown usability, and page layout consistency across home/servers/profile/superadmin.
7. Regression smoke: module tiles, settings tabs, invite tracker, AI assistant, help center, and plan CTAs.

#### Assumptions and Defaults
- No backend schema/API expansion is required for this pass; existing user wallet/privacy APIs are sufficient for Profile v1.
- Legacy `/dashboard` behavior remains backward-compatible via redirect/mapping to the new unified flow.
- `/admin-panel` advanced page remains untouched unless explicitly requested.
- Focus is full portal UI/IA consistency first; deeper feature additions beyond current endpoints are out of scope for this pass.
