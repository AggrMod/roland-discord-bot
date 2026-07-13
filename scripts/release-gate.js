#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each check runs in its own child process AND its own throwaway SQLite
// database, so checks can never see each other's rows. This is what makes the
// gate deterministic: previously every check shared ./database/guildpilot.db
// (because database/db.js opens DATABASE_PATH || guildpilot.db at load), so a
// check's outcome could depend on data left behind by an earlier check.
//
// Tests that set their own DATABASE_PATH internally simply override the value
// we pass; they were already isolated and are unaffected.
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guildpilot-release-gate-'));

function cleanupRunRoot() {
  try {
    fs.rmSync(runRoot, { recursive: true, force: true });
  } catch (_error) {
    // best-effort cleanup; a leftover temp dir never affects correctness
  }
}

process.on('exit', cleanupRunRoot);

const checks = [
  { name: 'help-parity', cmd: process.execPath, args: ['scripts/check-help-parity.js'] },
  { name: 'coverage-matrix', cmd: process.execPath, args: ['scripts/check-test-coverage-matrix.js'] },
  { name: 'portal-inline-js-safety', cmd: process.execPath, args: ['scripts/check-portal-inline-js-safety.js'] },
  { name: 'db-adhoc-guard', cmd: process.execPath, args: ['scripts/check-db-adhoc-guard.js'] },
  { name: 'tenant-mock-scoping', cmd: process.execPath, args: ['tests/test-tenant-mock-scoping.js'] },
  { name: 'verification-role-safety', cmd: process.execPath, args: ['tests/test-verification-role-safety.js'] },
  { name: 'verification-role-config-validation', cmd: process.execPath, args: ['tests/test-verification-role-config-validation.js'] },
  { name: 'verification-delegation-toggle', cmd: process.execPath, args: ['tests/test-verification-delegation-toggle.js'] },
  { name: 'verification-high-volume-sync', cmd: process.execPath, args: ['tests/test-verification-high-volume-sync.js'] },
  { name: 'verification-plan-limits', cmd: process.execPath, args: ['tests/test-verification-plan-limits.js'] },
  { name: 'verification-token-rule-edges', cmd: process.execPath, args: ['tests/test-verification-token-rule-edges.js'] },
  { name: 'governance-proposal-lifecycle', cmd: process.execPath, args: ['tests/test-governance-proposal-lifecycle.js'] },
  { name: 'governance-cancel-behavior', cmd: process.execPath, args: ['tests/test-governance-cancel-behavior.js'] },
  { name: 'governance-channel-override', cmd: process.execPath, args: ['tests/test-governance-channel-override.js'] },
  { name: 'governance-plan-limits', cmd: process.execPath, args: ['tests/test-governance-plan-limits.js'] },
  { name: 'wallet-tracker-race-and-scale', cmd: process.execPath, args: ['tests/test-wallet-tracker-race-and-scale.js'] },
  { name: 'wallet-tracker-command-dispatch', cmd: process.execPath, args: ['tests/test-wallet-tracker-command-dispatch.js'] },
  { name: 'wallet-panel-permission-drift', cmd: process.execPath, args: ['tests/test-wallet-panel-permission-drift.js'] },
  { name: 'token-webhook-batch-aggregation', cmd: process.execPath, args: ['tests/test-token-webhook-batch-aggregation.js'] },
  { name: 'token-tracker-plan-limits', cmd: process.execPath, args: ['tests/test-token-tracker-plan-limits.js'] },
  { name: 'token-mock-prod-guard', cmd: process.execPath, args: ['tests/test-token-mock-prod-guard.js'] },
  { name: 'treasury-tx-alert-validation', cmd: process.execPath, args: ['tests/test-treasury-tx-alert-validation.js'] },
  { name: 'treasury-per-tenant', cmd: process.execPath, args: ['tests/test-treasury-per-tenant.js'] },
  { name: 'battle-race-safety', cmd: process.execPath, args: ['tests/test-battle-race-safety.js'] },
  { name: 'points-command-guards', cmd: process.execPath, args: ['tests/test-points-command-guards.js'] },
  { name: 'minigames-router', cmd: process.execPath, args: ['tests/test-minigames-router.js'] },
  { name: 'heist-command-gating', cmd: process.execPath, args: ['tests/test-heist-command-gating.js'] },
  { name: 'minigames-moderator-permissions', cmd: process.execPath, args: ['tests/test-minigames-moderator-permissions.js'] },
  { name: 'minigames-session-replace-safety', cmd: process.execPath, args: ['tests/test-minigames-session-replace-safety.js'] },
  { name: 'minigames-concurrent-session-scale', cmd: process.execPath, args: ['tests/test-minigames-concurrent-session-scale.js'] },
  { name: 'config-command-dispatch', cmd: process.execPath, args: ['tests/test-config-command-dispatch.js'] },
  { name: 'moderation-command-dispatch', cmd: process.execPath, args: ['tests/test-moderation-command-dispatch.js'] },
  { name: 'nft-alert-config-scoping', cmd: process.execPath, args: ['tests/test-nft-alert-config-scoping.js'] },
  { name: 'nft-webhook-dedup-and-alerts', cmd: process.execPath, args: ['tests/test-nft-webhook-dedup-and-alerts.js'] },
  { name: 'webhook-guards', cmd: process.execPath, args: ['tests/test-webhook-guards.js'] },
  { name: 'vault-webhook-guild-binding', cmd: process.execPath, args: ['tests/test-vault-webhook-guild-binding.js'] },
  { name: 'mask', cmd: process.execPath, args: ['tests/test-mask.js'] },
  { name: 'module-identity-gate', cmd: process.execPath, args: ['tests/test-module-identity-gate.js'] },
  { name: 'nft-alert-permission-fallback', cmd: process.execPath, args: ['tests/test-nft-alert-permission-fallback.js'] },
  { name: 'nft-webhook-throughput-burst', cmd: process.execPath, args: ['tests/test-nft-webhook-throughput-burst.js'] },
  { name: 'invite-tracker-attribution-export', cmd: process.execPath, args: ['tests/test-invite-tracker-attribution-export.js'] },
  { name: 'invites-command-dispatch', cmd: process.execPath, args: ['tests/test-invites-command-dispatch.js'] },
  { name: 'invite-tracker-anticheat', cmd: process.execPath, args: ['tests/test-invite-tracker-anticheat.js'] },
  { name: 'og-role-tenant-scoping', cmd: process.execPath, args: ['tests/test-og-role-tenant-scoping.js'] },
  { name: 'ticket-tenant-safety', cmd: process.execPath, args: ['tests/test-ticket-tenant-safety.js'] },
  { name: 'ticket-transcript-permission-drift', cmd: process.execPath, args: ['tests/test-ticket-transcript-permission-drift.js'] },
  { name: 'role-panel-post-limit', cmd: process.execPath, args: ['tests/test-role-panel-post-limit.js'] },
  { name: 'role-panel-stale-reconcile', cmd: process.execPath, args: ['tests/test-role-panel-stale-reconcile.js'] },
  { name: 'role-claim-interaction-permissions', cmd: process.execPath, args: ['tests/test-role-claim-interaction-permissions.js'] },
  { name: 'admin-user-tenant-scoping', cmd: process.execPath, args: ['tests/test-admin-user-tenant-scoping.js'] },
  { name: 'superadmin-workspace-telemetry', cmd: process.execPath, args: ['tests/test-superadmin-workspace-telemetry.js'] },
  { name: 'wallet-delegation', cmd: process.execPath, args: ['tests/test-wallet-delegation.js'] },
  { name: 'engagement-streak-and-minigame-rewards', cmd: process.execPath, args: ['tests/test-engagement-streak-and-minigame-rewards.js'] },
  { name: 'engagement-provider-flows', cmd: process.execPath, args: ['tests/test-engagement-provider-flows.js'] },
  { name: 'aiassistant-command-gating-dispatch', cmd: process.execPath, args: ['tests/test-aiassistant-command-gating-dispatch.js'] },
  { name: 'vault-social-gates', cmd: process.execPath, args: ['tests/test-vault-social-gates.js'] },
  { name: 'vault-mint-reconciliation', cmd: process.execPath, args: ['tests/test-vault-mint-reconciliation.js'] },
  { name: 'vault-backfill-ops-guardrails', cmd: process.execPath, args: ['tests/test-vault-backfill-ops-guardrails.js'] },
  { name: 'vault-onchain-payment-verification', cmd: process.execPath, args: ['tests/test-vault-onchain-payment-verification.js'] },
  { name: 'vault-win-odds', cmd: process.execPath, args: ['tests/test-vault-win-odds.js'] },
  { name: 'module-refactor', cmd: process.execPath, args: ['tests/test-module-refactor.js'] },
  { name: 'guild-guard-foundation', cmd: process.execPath, args: ['tests/test-guild-guard-foundation.js'] },
  { name: 'micro-verify', cmd: process.execPath, args: ['tests/test-micro-verify.js'] },
  { name: 'missions-v1-flow', cmd: process.execPath, args: ['tests/test-heist-v1-flow.js'] },
  { name: 'missions-trait-gates-bonuses', cmd: process.execPath, args: ['tests/test-heist-trait-gates-bonuses.js'] },
  { name: 'vault-key-tiers', cmd: process.execPath, args: ['tests/test-vault-key-tiers.js'] },
  { name: 'welcome-onboarding-smoke', cmd: process.execPath, args: ['tests/test-welcome-onboarding-smoke.js'] },
  { name: 'welcome-analytics-bursts', cmd: process.execPath, args: ['tests/test-welcome-analytics-bursts.js'] },
  { name: 'welcome-image-upload-limits', cmd: process.execPath, args: ['tests/test-welcome-image-upload-limits.js'] },
  { name: 'ai-assistant-smoke', cmd: process.execPath, args: ['scripts/ai-assistant-smoke.js'] },
];

let failed = false;

for (const check of checks) {
  process.stdout.write(`\n[release-gate] Running ${check.name}...\n`);
  const result = spawnSync(check.cmd, check.args, {
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      // Fresh, isolated database file per check.
      DATABASE_PATH: path.join(runRoot, `${check.name}.db`),
      // Never run the hourly backup service against the throwaway DB.
      DB_BACKUP_ENABLED: 'false',
      DB_BACKUP_ON_STARTUP: 'false',
    },
  });
  if (result.status !== 0) {
    failed = true;
    process.stdout.write(`[release-gate] FAILED: ${check.name} (exit ${result.status})\n`);
    break;
  }
  process.stdout.write(`[release-gate] OK: ${check.name}\n`);
}

if (failed) {
  process.exit(1);
}

process.stdout.write('\n[release-gate] All checks passed.\n');


