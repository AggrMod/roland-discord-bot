# Phase 3 — Auth-Path Hardening (Fixes G, H, I, J)

**Part of:** `REMEDIATION-PLAN.md` Phase 3.
**Risk:** This is the highest-risk tier — it touches the login/session/CSRF path
every request flows through. Mitigations: the security-critical logic is
extracted into unit-tested utils; the two request-path changes (origin trust,
CSRF) are **flag-gated and default to safe states**; CSRF ships in **monitor**
(logs, never blocks). **Test the full OAuth round-trip on staging before prod.**

---

## Fix G — Session regeneration on login (audit H-5)

**Files:** `web/utils/sessionFixation.js` (new), `web/routes/authUser.js`,
`tests/test-session-fixation.js`

The Discord login callback set `req.session.discordUser` on the **existing**
session id, so a pre-login id (e.g. one created while storing `returnTo`) could
be promoted to an authenticated session (fixation). Now the callback captures
`returnTo`, calls `req.session.regenerate()` to get a fresh id, then establishes
the user. Only affects **new logins**; existing sessions are untouched.

- Enabled by default. Kill switch: `SESSION_FIXATION_PROTECTION=off`.
- A regenerate error is propagated so login fails closed rather than continuing
  on a non-regenerated session.

---

## Fix H — Verification challenge binding + one-time nonce (audit H-4, M-5)

**Files:** `web/utils/verifyChallenge.js` (new), `web/routes/userWalletVerification.js`,
`web/public/portal.js`, `tests/test-verify-challenge-binding.js`

The signed challenge bound only a mutable username + nonce, not the wallet or
Discord ID, and the nonce wasn't strictly single-use. Now:

- The challenge message includes **Discord ID + the specific wallet** (the
  frontend signs the server-returned message verbatim, and now sends its wallet
  to `/api/verify/challenge`). At verify time the submitted wallet must match
  the wallet the challenge was bound to.
- The challenge is **consumed on the first attempt** regardless of outcome
  (one-time nonce), on both the primary and legacy verify routes.
- **Backward compatible:** an old cached client that doesn't send a wallet gets
  the legacy unbound message and still works (no flag needed).

---

## Fix I — Stop trusting `X-Forwarded-Host` for return origins (audit C-2, H-6)

**Files:** `web/utils/returnOrigin.js` (new), `web/routes/authUser.js`,
`tests/test-return-origin.js`

The public OAuth flow mints a bearer token and delivers it in the redirect
fragment to a `returnTo` origin. The allowed-origin set **auto-included the
request-derived origin** (from spoofable `X-Forwarded-Host`), so an attacker
could allowlist their own origin and exfiltrate the token. Now the allowlist is
built only from operator-configured origins (`WEB_URL` / `WEB_URL_ALIASES` /
`PUBLIC_WEB_ALLOWED_RETURN_ORIGINS` / `PUBLIC_WEB_BASE_URL`) plus static
defaults; the public Discord redirect URI prefers the configured canonical
origin over request headers.

- Escape hatch (insecure, default off): `PUBLIC_WEB_TRUST_REQUEST_ORIGIN=true`.
- **Behavior is unchanged in production when `WEB_URL` is set** (the request
  origin in prod already equals `WEB_URL`) — it is simply no longer spoofable.
- Note: moving the bearer token out of the URL fragment entirely is a follow-up
  requiring further frontend work; closing the allowlist + header trust removes
  the practical exfiltration path.

---

## Fix J — Real CSRF synchronizer tokens (audit C-1)

**Files:** `web/utils/csrf.js` (new), `web/server.js`, `tests/test-csrf.js`

CSRF protection was header-only (`X-Requested-With`); the `csrf-csrf` dep was
unused and `/api/csrf-token` returned an empty stub. Now `/api/csrf-token`
mints a real per-session token, and mutating `/api` requests are validated
against it. **The frontend was already wired** (`portal.js` fetches the token
and its global `fetch` wrapper attaches `x-csrf-token` on every mutation), so
this is a server-only change.

- Rollout flag `CSRF_MODE` = `off` | `monitor` (default) | `enforce`.
  - `monitor`: validate + **log** mismatches, never block (X-Requested-With is
    still the live defense). This is the safe ship state.
  - `enforce`: reject mutating **cookie-authenticated** requests without a valid
    token. Bearer/public-API and unauthenticated requests are not gated (not
    CSRF-exploitable).
- Roll out: deploy at `monitor`, confirm logs are clean (all clients carry the
  token after the portal cache busts), then flip to `enforce`.

---

## New env flags (all optional; safe defaults — see `.env.example`)

| Flag | Default | Effect |
|---|---|---|
| `SESSION_FIXATION_PROTECTION` | `on` | regenerate session id on login (Fix G) |
| `PUBLIC_WEB_TRUST_REQUEST_ORIGIN` | `false` | re-allow request-derived return origin (Fix I) |
| `PUBLIC_WEB_BASE_URL` | unset | explicit canonical base origin (Fix I) |
| `CSRF_MODE` | `monitor` | `off`/`monitor`/`enforce` CSRF tokens (Fix J) |

## Rollback levers (no redeploy)

| If… | Do |
|---|---|
| Login breaks after Fix G | `SESSION_FIXATION_PROTECTION=off` + restart |
| Legitimate returnTo rejected | add the domain to `WEB_URL_ALIASES`/`PUBLIC_WEB_ALLOWED_RETURN_ORIGINS`, or `PUBLIC_WEB_TRUST_REQUEST_ORIGIN=true` |
| Portal mutations 403 after CSRF enforce | `CSRF_MODE=monitor` (or `off`) + restart |
| Wallet verification breaks | revert the Fix H frontend change (old client → legacy unbound path) |
| Anything else | `git revert` the Phase 3 commit (no schema change) |

## Verification

- Release gate green and deterministic across repeated runs, with four new
  checks: `session-fixation`, `verify-challenge-binding`, `return-origin`,
  `csrf`.
- Changed files lint clean (0 errors). `guildpilot.db` untouched by the gate.

## Recommended rollout order (staging first)

1. Deploy at defaults: Fix G active, Fix H active (backward compatible), Fix I
   active (unchanged when `WEB_URL` set), Fix J in `monitor`.
2. **Run the full Discord OAuth login round-trip on staging** (incl. a spoofed
   `X-Forwarded-Host` to confirm it is ignored) and a wallet verification.
3. Watch `[csrf] MONITOR` logs until clean, then `CSRF_MODE=enforce`.
