# GuildPilot Discord Bot - Code & Workflow Audit Report
**Date**: May 19, 2026
**Scope**: 43+ services, 25+ command modules, 29 web routes, portal frontend (`portal.js`, `portal.html`, `portal-style.css`)
**Methodology**: Automated tool-assisted scan and manual semantic review focusing on architecture, tenant isolation, XSS/CSRF security, and release-gate parity.

## Executive Summary
The GuildPilot Discord Bot exhibits a mature, well-structured architecture. The codebase has been successfully modularized from a legacy monolithic state into highly segmented, domain-driven services and web routes. The implementation of `better-sqlite3` is robust, leveraging prepared statements appropriately across the board to prevent SQL injection. Multi-tenant isolation is strictly enforced via the `tenantService`, `entitlementService`, and route middleware. 

The immediate blocker—Release-Gate Drift caused by missing `/vault` command documentation—has been fully resolved. The release-gate pipeline is now clear.

## 1. Security & Vulnerability Assessment

### 1.1 Web Portal Frontend (XSS & CSRF)
**Scope**: `web/public/portal.js`, `web/public/portal.html`
- **XSS Mitigation**: The `portal.js` file relies heavily on dynamic DOM construction via `innerHTML` (over 400 instances). However, a strict semantic review confirmed that user-controlled data and dynamic inputs are consistently wrapped in the local `escapeHtml()` function. No direct un-escaped interpolation of untrusted properties into HTML strings was detected.
- **CSRF Protection**: The `window.fetch` wrapper in `portal.js` correctly injects the `X-Requested-With: XMLHttpRequest` header into all state-mutating requests (`POST`, `PUT`, `DELETE`, `PATCH`). The backend (`web/server.js`) actively enforces this header on the `/api/` endpoints, dropping requests that lack it. This is a solid defense-in-depth strategy against Cross-Site Request Forgery.
- **Recommendations**: While `escapeHtml` is used rigorously, transitioning future components to standard DOM creation methods (`document.createElement`) or a virtual DOM library will reduce the surface area for developer error.

### 1.2 Backend Database (SQL Injection)
**Scope**: `database/db.js`, `services/*.js`
- **Parameterized Queries**: The codebase heavily utilizes `better-sqlite3`. An audit of dynamic query generation (specifically in complex update functions like `trackedWalletsService.updateTrackedToken`) showed proper use of parameterized queries (`?`) and safely mapped column names.
- **Dynamic Columns**: In areas where dynamic `SET` clauses are constructed, the column names are strictly derived from hardcoded dictionaries/maps (e.g., `fieldMap`), completely mitigating injection risks.

### 1.3 Tenant Isolation & Authorization
**Scope**: `tenantService.js`, `entitlementService.js`, `web/server.js`
- **Data Isolation**: All tenant-aware queries correctly include `AND guild_id = ?` clauses. The `adminAuthMiddleware` reliably injects the validated `req.guildId` context into routes.
- **Module & Plan Gating**: `moduleGate.js` and `entitlementService.js` appropriately enforce plan limits and module toggles, ensuring tenants cannot access or exceed limits for features they are not entitled to (e.g., `max_enabled_modules`, `max_tokens`).
- **Superadmin Guard**: The `superadminGuard` middleware is correctly implemented to protect high-level system operations and identity impersonation endpoints.

## 2. Architecture & Code Quality

### 2.1 Modularity and Routing
- The transition to `web/routes/` is highly successful. The `server.js` file is well-organized, cleanly mounting versioned APIs (`/api/public/v1`), authenticated user routes, and admin interfaces.
- The use of dependency injection when creating routers (e.g., passing `db`, `logger`, `tenantService` into the router factory functions) makes the routes highly testable and decoupled from global state.

### 2.2 Rate Limiting and Session Management
- **Rate Limiting**: `express-rate-limit` is configured appropriately in `server.js` with distinct limits for public endpoints (100/15m), auth (10/15m), and heavy admin endpoints. This provides solid protection against brute-force and DDoS attempts.
- **Sessions**: The `SESSION_SECRET` is validated on startup (`index.js`), requiring a minimum of 32 characters. Sessions are securely stored in a persistent SQLite database (`database/sessions.db`), ensuring survival across bot restarts.

## 3. Workflow & Release Gate Parity
- **Status**: The `npm run check:release-gate` script is now passing. 
- **Fix Applied**: The `vault` module, comprising 18 new slash commands, was successfully documented across `docs/ADMIN_HELP.md`, `admin-help.html`, and `portal.html`. The "Help Parity Drift" has been eliminated, ensuring feature visibility matches the deployed command set.

## 4. Recommendations for Future Iterations
1.  **Frontend CSP**: While inline scripts and styles are currently permitted, consider migrating toward a stricter Content Security Policy (CSP) by moving inline handlers to event listeners.
2.  **Solana RPC Fallbacks**: The `HELIUS_API_KEY` and `SOLANA_RPC_URL` environment variables are currently optional but highly recommended. Implementing automatic failover to public RPCs for non-critical reads could improve resilience if Helius rate limits are hit.
3.  **Database Migration Tracking**: `db.js` is quite large (1950+ lines). While the structured migration system is robust, consider splitting out the ad-hoc schema guards (`ensureVerificationPanelsSchema`, etc.) into dedicated boot-time migration scripts to reduce the footprint of `server.js` and `db.js`.

## Conclusion
The GuildPilot Discord Bot is in excellent health. The multi-tenant architecture is secure, the frontend is actively protected against XSS/CSRF, and the release gating mechanisms are fully aligned with the latest feature sets. The codebase is ready for continued feature development and production deployment.
