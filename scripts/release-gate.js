#!/usr/bin/env node

const { spawnSync } = require('child_process');

const checks = [
  { name: 'help-parity', cmd: process.execPath, args: ['scripts/check-help-parity.js'] },
  { name: 'portal-inline-js-safety', cmd: process.execPath, args: ['scripts/check-portal-inline-js-safety.js'] },
  { name: 'db-adhoc-guard', cmd: process.execPath, args: ['scripts/check-db-adhoc-guard.js'] },
  { name: 'tenant-mock-scoping', cmd: process.execPath, args: ['tests/test-tenant-mock-scoping.js'] },
  { name: 'verification-role-safety', cmd: process.execPath, args: ['tests/test-verification-role-safety.js'] },
  { name: 'battle-race-safety', cmd: process.execPath, args: ['tests/test-battle-race-safety.js'] },
  { name: 'nft-alert-config-scoping', cmd: process.execPath, args: ['tests/test-nft-alert-config-scoping.js'] },
  { name: 'og-role-tenant-scoping', cmd: process.execPath, args: ['tests/test-og-role-tenant-scoping.js'] },
  { name: 'ticket-tenant-safety', cmd: process.execPath, args: ['tests/test-ticket-tenant-safety.js'] },
  { name: 'admin-user-tenant-scoping', cmd: process.execPath, args: ['tests/test-admin-user-tenant-scoping.js'] },
  { name: 'module-refactor', cmd: process.execPath, args: ['tests/test-module-refactor.js'] },
  { name: 'micro-verify', cmd: process.execPath, args: ['tests/test-micro-verify.js'] },
  { name: 'missions-v1-flow', cmd: process.execPath, args: ['tests/test-heist-v1-flow.js'] },
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
