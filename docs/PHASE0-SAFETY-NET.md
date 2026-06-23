# Phase 0 — Safety Net (Backup / Restore / Rollback Runbook)

**Part of:** `REMEDIATION-PLAN.md` Phase 0.
**Status:** Implemented. No product behavior changed.

This is the seatbelt for every later remediation step. It establishes a
**deterministic CI gate**, **verified backups**, and a **memorized rollback
procedure** so that any single remediation step can be undone fast.

---

## 1. What Phase 0 changed (and didn't)

| Change | File | Risk |
|---|---|---|
| Release gate gives each check its own throwaway SQLite DB | `scripts/release-gate.js` | none — test-only |
| Governance lifecycle test made self-contained (adds non-voting electorate) | `tests/test-governance-proposal-lifecycle.js` | none — test-only |
| CI workflow: release-gate required; lint/audit informational | `.github/workflows/ci.yml` | none — additive |
| Ignore root `backups/` | `.gitignore` | none |

**No product/runtime code was touched.** The bot behaves identically.

### Why the gate was flaky (now fixed)
`database/db.js` opens `DATABASE_PATH || database/guildpilot.db` at load. The
gate ran every check in a child process but shared one on-disk DB, so a check
could pass or fail depending on rows left by an earlier check. The gate now
sets a unique `DATABASE_PATH` per check (in an OS temp dir, auto-cleaned), so
checks are fully isolated. Side benefit: the gate no longer writes to the
developer's `guildpilot.db` at all.

> The isolation immediately surfaced a real latent issue: the governance
> lifecycle test only passed because *other* tests had left voter rows behind.
> With one electorate of two voters, both voting = 100% of VP, which correctly
> trips the ">50% voted" early auto-close before the repeat-vote assertion.
> The test now seeds a realistic non-voting electorate; the product logic was
> correct and unchanged.

---

## 2. Backup procedure (run before EVERY remediation deploy)

```bash
# Consistent online snapshot (safe while the bot is running)
bash scripts/backup_db.sh
# → backups/guildpilot_YYYYMMDD_HHMMSS.db
```

The script uses SQLite's `.backup()` API (not a file copy), so it is safe
against a live WAL-mode database. Backups land in `backups/` (git-ignored).
Retention: 14 days (`RETENTION_DAYS`).

### Verify the backup is restorable (do this — an unverified backup is a guess)

```bash
BK=$(ls -t backups/guildpilot_*.db | head -1)
python3 -c "import sqlite3; c=sqlite3.connect('$BK'); \
  print('integrity:', c.execute('PRAGMA integrity_check').fetchone()[0]); \
  print('tables:',    c.execute(\"SELECT count(*) FROM sqlite_master WHERE type='table'\").fetchone()[0])"
# Expect: integrity: ok   tables: ~117
```

A verified run on the current DB returns `integrity: ok` and 117 tables.

---

## 3. Restore procedure (if a migration corrupts/loses data)

```bash
bash scripts/restore_db.sh backups/guildpilot_YYYYMMDD_HHMMSS.db
# Prompts for confirmation (type RESTORE) and first copies the CURRENT db to
# backups/pre-restore/ so a restore is itself reversible.
```

After restore, restart the bot (see §4).

---

## 4. Rollback runbook (memorize this)

Two independent levers — use whichever fits the failure:

### Lever A — Feature flag (fastest; for the flagged Phase 1–3 fixes)
Every risky fix is gated by an env var that defaults to today's behavior. To
disable a misbehaving fix, set its flag to `off`/`monitor` and restart — **no
code change, no redeploy**:

```bash
# example shapes (defined per-fix in REMEDIATION-PLAN.md)
#   CSRF_MODE=monitor
#   MODULE_IDENTITY_ENFORCE=off
#   VAULT_WEBHOOK_ENFORCE_GUILD_MATCH=monitor
pm2 restart ecosystem.config.cjs --update-env
```

### Lever B — Code revert
```bash
git revert <pr-merge-commit>      # reverts one isolated fix
git push
# redeploy + restart
pm2 restart ecosystem.config.cjs
```

### If data was touched
Restore the pre-deploy backup (§3), then restart.

### Verify health after any rollback
```bash
bash scripts/healthcheck.sh        # existing health probe
pm2 status                         # process up, not restart-looping
```

---

## 5. CI gate (what now protects every change)

`.github/workflows/ci.yml` runs on every PR and every push to `main`:

- **`release-gate` — REQUIRED.** Must be green to merge. Now deterministic.
- **`lint` — informational.** Non-blocking; current baseline has browser-global
  false-positives in `tools/qa-signoff-collab/public/app.js` (not under the
  ESLint browser override). Clean up separately, then promote to required.
- **`audit` — informational.** Non-blocking; transitive-dependency CVEs tracked
  in the audit report. Promote to required after the dependency pass.

**Recommended:** in GitHub branch protection, mark **`Release gate (required)`**
as a required status check for `main` and the remediation branches.

---

## 6. Definition of done for Phase 0

- [x] Release gate deterministic (verified: 4 consecutive clean green runs).
- [x] Gate no longer mutates the developer/prod `guildpilot.db`.
- [x] CI workflow added (release-gate required; lint/audit informational).
- [x] Backup verified restorable (`integrity: ok`, 117 tables).
- [x] Restore + rollback runbook documented.
- [ ] **Operator action:** enable the required status check in branch
      protection, and confirm a staging environment exists before Phase 1.

Once the operator items are done, it is safe to begin **Phase 1** (the additive,
low-risk fixes: tokenService MOCK guard, webhook hardening, log masking).
