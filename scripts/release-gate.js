#!/usr/bin/env node

const { spawnSync } = require('child_process');

const checks = [
  { name: 'help-parity', cmd: process.execPath, args: ['scripts/check-help-parity.js'] },
  { name: 'portal-inline-js-safety', cmd: process.execPath, args: ['scripts/check-portal-inline-js-safety.js'] },
  { name: 'db-adhoc-guard', cmd: process.execPath, args: ['scripts/check-db-adhoc-guard.js'] },
  { name: 'tenant-mock-scoping', cmd: process.execPath, args: ['tests/test-tenant-mock-scoping.js'] },
  { name: 'verification-role-safety', cmd: process.execPath, args: ['tests/test-verification-role-safety.js'] },
  { name: 'verification-delegation-toggle', cmd: process.execPath, args: ['tests/test-verification-delegation-toggle.js'] },
  { name: 'verification-high-volume-sync', cmd: process.execPath, args: ['tests/test-verification-high-volume-sync.js'] },
  { name: 'verification-plan-limits', cmd: process.execPath, args: ['tests/test-verification-plan-limits.js'] },
  { name: 'verification-token-rule-edges', cmd: process.execPath, args: ['tests/test-verification-token-rule-edges.js'] },
  { name: 'governance-proposal-lifecycle', cmd: process.execPath, args: ['tests/test-governance-proposal-lifecycle.js'] },
  { name: 'governance-channel-override', cmd: process.execPath, args: ['tests/test-governance-channel-override.js'] },
  { name: 'governance-plan-limits', cmd: process.execPath, args: ['tests/test-governance-plan-limits.js'] },
  { name: 'wallet-tracker-race-and-scale', cmd: process.execPath, args: ['tests/test-wallet-tracker-race-and-scale.js'] },
  { name: 'wallet-panel-permission-drift', cmd: process.execPath, args: ['tests/test-wallet-panel-permission-drift.js'] },
  { name: 'token-webhook-batch-aggregation', cmd: process.execPath, args: ['tests/test-token-webhook-batch-aggregation.js'] },
  { name: 'token-tracker-plan-limits', cmd: process.execPath, args: ['tests/test-token-tracker-plan-limits.js'] },
  { name: 'battle-race-safety', cmd: process.execPath, args: ['tests/test-battle-race-safety.js'] },
  { name: 'minigames-moderator-permissions', cmd: process.execPath, args: ['tests/test-minigames-moderator-permissions.js'] },
  { name: 'minigames-session-replace-safety', cmd: process.execPath, args: ['tests/test-minigames-session-replace-safety.js'] },
  { name: 'minigames-concurrent-session-scale', cmd: process.execPath, args: ['tests/test-minigames-concurrent-session-scale.js'] },
  { name: 'nft-alert-config-scoping', cmd: process.execPath, args: ['tests/test-nft-alert-config-scoping.js'] },
  { name: 'nft-webhook-dedup-and-alerts', cmd: process.execPath, args: ['tests/test-nft-webhook-dedup-and-alerts.js'] },
  { name: 'nft-alert-permission-fallback', cmd: process.execPath, args: ['tests/test-nft-alert-permission-fallback.js'] },
  { name: 'nft-webhook-throughput-burst', cmd: process.execPath, args: ['tests/test-nft-webhook-throughput-burst.js'] },
  { name: 'invite-tracker-attribution-export', cmd: process.execPath, args: ['tests/test-invite-tracker-attribution-export.js'] },
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
  { name: 'vault-social-gates', cmd: process.execPath, args: ['tests/test-vault-social-gates.js'] },
  { name: 'vault-mint-reconciliation', cmd: process.execPath, args: ['tests/test-vault-mint-reconciliation.js'] },
  { name: 'vault-backfill-ops-guardrails', cmd: process.execPath, args: ['tests/test-vault-backfill-ops-guardrails.js'] },
  { name: 'module-refactor', cmd: process.execPath, args: ['tests/test-module-refactor.js'] },
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
    env: process.env,
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


