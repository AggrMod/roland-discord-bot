#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const reportsDir = path.join(repoRoot, 'reports');

const PLAN_SEQUENCE = [
  {
    plan: 'starter',
    label: 'Free',
    checks: [
      ['tests/test-plan-preset-policy.js'],
      ['tests/test-verification-plan-limits.js'],
      ['tests/test-governance-plan-limits.js'],
      ['tests/test-token-tracker-plan-limits.js'],
      ['tests/test-engagement-provider-flows.js'],
    ],
  },
  {
    plan: 'growth',
    label: 'Growth',
    checks: [
      ['tests/test-plan-preset-policy.js'],
      ['tests/test-engagement-provider-flows.js'],
      ['tests/test-invite-tracker-attribution-export.js'],
      ['tests/test-wallet-tracker-race-and-scale.js'],
    ],
  },
  {
    plan: 'pro',
    label: 'Pro',
    checks: [
      ['tests/test-plan-preset-policy.js'],
      ['scripts/ai-assistant-smoke.js'],
      ['tests/test-vault-social-gates.js'],
      ['tests/test-vault-backfill-ops-guardrails.js'],
      ['tests/test-superadmin-workspace-telemetry.js'],
    ],
  },
];

function runCheck(args, env = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    shell: false,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    cmd: `${process.execPath} ${args.join(' ')}`,
    exitCode: result.status,
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

const startedAt = new Date().toISOString();
const report = {
  startedAt,
  finishedAt: '',
  sequence: [],
  ok: true,
};

for (const stage of PLAN_SEQUENCE) {
  const stageResult = {
    plan: stage.plan,
    label: stage.label,
    startedAt: new Date().toISOString(),
    checks: [],
    ok: true,
  };

  console.log(`\n[plan-sequence] Stage: ${stage.label} (${stage.plan})`);

  for (const checkArgs of stage.checks) {
    const result = runCheck(checkArgs, { QA_TEST_PLAN_STAGE: stage.plan });
    stageResult.checks.push(result);
    console.log(`[plan-sequence] ${result.ok ? 'OK' : 'FAIL'} ${checkArgs.join(' ')}`);
    if (!result.ok) {
      stageResult.ok = false;
      report.ok = false;
      break;
    }
  }

  stageResult.finishedAt = new Date().toISOString();
  report.sequence.push(stageResult);
  if (!stageResult.ok) {
    break;
  }
}

report.finishedAt = new Date().toISOString();

fs.mkdirSync(reportsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[T:.]/g, '-');
const reportPath = path.join(reportsDir, `v1-plan-sequence-${stamp}.json`);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

console.log(`\n[plan-sequence] report written: ${reportPath}`);

if (!report.ok) {
  process.exit(1);
}
