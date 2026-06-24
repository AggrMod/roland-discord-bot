# Phase 4 — Remaining Hardening (audit Mediums/Lows + dependencies)

**Part of:** the audit follow-ups beyond the 8 launch blockers.
**Risk:** Low. Flag-gated or additive changes; dependency update is non-breaking
(lockfile only) and verified against the release gate.

---

## M-3 — Content-Security-Policy (flag-gated)

**File:** `web/server.js`

CSP was disabled (`contentSecurityPolicy: false`). Added a flag-gated policy:

- `CSP_MODE` = `off` (default, unchanged) | `report-only` | `enforce`.
- `report-only` emits `Content-Security-Policy-Report-Only` (observe violations,
  never blocks). `enforce` emits `Content-Security-Policy`.
- The portal relies on inline handlers/styles, so `'unsafe-inline'` is permitted
  for script/style — but the policy still restricts script/object/frame
  **sources**, `base-uri`, and `frame-ancestors` (clickjacking).
- Rollout: `report-only` → review reports / tighten directives → `enforce`. A
  longer-term follow-up is to remove inline handlers so `'unsafe-inline'` can be
  dropped.

## L-5 — Logout cookie cleared with matching attributes

**File:** `web/routes/authUser.js`

`res.clearCookie('connect.sid')` omitted the `domain`/`path` the cookie was set
with, so the browser could retain the session cookie when
`SESSION_COOKIE_DOMAIN` is configured. Now logout clears with `path: '/'` and the
configured domain, and the `session.destroy` error is handled.

## L-2 — Module gate fail-closed (flag-gated)

**File:** `services/tenantService.js`

`isModuleEnabled` returned `true` when a guild had no tenant context (fail-open).
In practice `getTenantContext` auto-scaffolds a tenant, so this branch is rarely
hit — but for the DB-error/null edge case it is now gated:
`TENANT_MODULE_GATE_FAIL_CLOSED=true` makes it deny (the safer posture). Default
keeps today's fail-open behavior.

## Dependencies — non-breaking `npm audit fix`

**File:** `package-lock.json` (lockfile only; no direct-dependency changes)

Ran `npm audit fix` (no `--force`). Notable: **discord.js → 14.26.4** (latest
patched 14.x — the safe bump recommended in the audit), plus `express`,
`qs`, and `body-parser` patches. The release gate passes with the updated tree.

**Residual (require major-version work; not done here):**
- One `undici` **high** advisory remains transitively via discord.js — clearing
  it needs a discord.js major (or a vetted `undici` `overrides` entry). Validate
  on staging before applying.
- `@solana/web3.js` → `jayson` → `uuid` **moderate** — the only `npm audit fix
  --force` path downgrades web3.js to 0.0.x (breaking); **do not** auto-apply.

---

## Deliberately deferred (not done — would risk breakage)

- **L-3 (global 6 MB JSON body limit):** welcome/branding image uploads send
  base64 data URIs in the JSON body, so naively tightening the global limit
  would brick uploads. A correct fix needs per-route body limits (small global
  default + large limit only on upload/webhook routes) and a careful audit of
  every large-body route — a focused task of its own.
- **Bearer-token-out-of-URL-fragment (deeper half of C-2):** requires frontend
  changes to deliver the public token via body/`postMessage`; the practical
  exfiltration path is already closed by Fix I.

## New env flags (see `.env.example`)

| Flag | Default | Effect |
|---|---|---|
| `CSP_MODE` | `off` | `off`/`report-only`/`enforce` Content-Security-Policy |
| `TENANT_MODULE_GATE_FAIL_CLOSED` | `false` | deny modules for guilds with no tenant context |

## Verification

- Release gate green and deterministic; changed files lint clean (0 errors).
- Helmet CSP config validated in both `report-only` and `enforce` modes.
- `npm audit fix` lockfile change verified against the full gate.
