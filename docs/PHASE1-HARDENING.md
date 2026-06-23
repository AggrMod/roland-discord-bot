# Phase 1 — Additive Hardening (Fixes A, B, C)

**Part of:** `REMEDIATION-PLAN.md` Phase 1.
**Risk:** Low. These only change behavior under misconfiguration or abuse;
normal operation is unchanged. All new limits are env-tunable and generous.

---

## Fix A — tokenService production MOCK guard (audit H-3)

**Files:** `services/tokenService.js`, `tests/test-token-mock-prod-guard.js`

Mirrors the guard `nftService` already had. Previously, if `MOCK_MODE=true`
(or a tenant's `mockDataEnabled`) were ever set in production, `tokenService`
returned **fabricated random balances**, so every token-amount gate passed for
everyone. Now:

- **Load-time:** in production with `MOCK_MODE` on and no explicit opt-in, the
  service throws at startup (fail fast, loud).
- **Runtime:** in production without opt-in, the mock path returns `[]` (no
  holdings) instead of fabricated balances, and logs once per guild.
- **Escape hatch:** `ALLOW_MOCK_IN_PROD=true` (same flag nftService uses) to
  deliberately allow mock in a prod-like environment.

Behavior outside production is unchanged.

---

## Fix B — Webhook rate-limit + replay + batch cap (audit M-2, M-4)

**Files:** `web/routes/webhookGuards.js` (new), `web/server.js`,
`web/routes/activityWebhooks.js`, `web/routes/vaultWebhooks.js`,
`tests/test-webhook-guards.js`

The public webhook endpoints (`/api/webhooks/*`, `/api/billing/webhook/*`) had
no rate limiting. Added, all generous and env-tunable:

- **Rate limiter** on both webhook prefixes (by IP).
- **Replay short-circuit** on `/api/webhooks/*`: a best-effort, fail-open,
  in-memory cache that 200s an identical repeated request within a short window
  instead of redoing work. Durable idempotency still lives in the DB
  (`tx_signature` / `payload_hash`); this is defense-in-depth only.
- **Batch-size cap** in the activity + vault handlers (the vault handler
  processes events synchronously in a loop), returning `413` past the cap.

The billing webhook gets the rate limiter only — it already has its own durable
replay/idempotency and a richer duplicate response, so the in-memory guard is
intentionally not layered on top of it.

---

## Fix C — PII log masking + per-user rate limit (audit L-1, M-7)

**Files:** `utils/mask.js` (new), `web/routes/userWalletVerification.js`,
`services/walletService.js`, `services/microVerifyService.js`, `web/server.js`,
`tests/test-mask.js`

- **Masking:** identity-linkage log lines (Discord ID → wallet, and the
  micro-verify completion line) now mask the wallet to `first4...last4` and the
  signature to a short prefix, matching `treasuryService.maskAddress`. Pure
  on-chain-only lines (signatures without identity) are left intact for
  debugging. No private keys/secrets were ever logged.
- **Per-user limiter** on authenticated `/api/user/*` routes, keyed per Discord
  user (falls back to IP), generous default so portal polling and multi-call
  page loads are never throttled.

---

## New env flags (all optional; safe defaults)

| Flag | Default | Effect |
|---|---|---|
| `ALLOW_MOCK_IN_PROD` | unset (off) | Allow MOCK_MODE/tenant-mock in production (nft + token). |
| `WEBHOOK_RATE_MAX` | `600` | Max webhook requests per window (per IP). |
| `WEBHOOK_RATE_WINDOW_MS` | `60000` | Webhook rate-limit window. |
| `WEBHOOK_REPLAY_WINDOW_MS` | `60000` | Replay short-circuit window. |
| `WEBHOOK_MAX_BATCH` | `500` | Max events per webhook request. `0` = unlimited. |
| `USER_RATE_MAX` | `240` | Max `/api/user/*` requests per minute per user. |

## Rollback levers (no redeploy needed)

| If… | Do |
|---|---|
| A legitimate provider gets rate-limited | raise `WEBHOOK_RATE_MAX` (and/or `USER_RATE_MAX`) and restart |
| A large legitimate batch is rejected (413) | raise or disable `WEBHOOK_MAX_BATCH` (`0`) |
| A prod-like env legitimately needs mock | set `ALLOW_MOCK_IN_PROD=true` |
| Anything misbehaves | `git revert` the Phase 1 commit (each fix is additive and isolated) |

## Verification

- Release gate green and deterministic across repeated runs, with three new
  checks: `token-mock-prod-guard`, `webhook-guards`, `mask`.
- Changed files lint clean (no new errors).
- `guildpilot.db` untouched by the gate.

## Next

Phase 2 (tenant isolation + entitlements): module-identity enforcement,
treasury per-tenant config, vault webhook per-tenant secret. These involve an
additive migration and monitor-before-enforce flags — higher care, separate PR.
