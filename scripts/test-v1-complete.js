#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const testsDir = path.join(repoRoot, 'tests');
const reportsDir = path.join(repoRoot, 'reports');

function run(name, cmd, args) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(cmd, args, { cwd: repoRoot, shell: false, encoding: 'utf8', env: process.env });
  const finishedAt = new Date().toISOString();
  return {
    name,
    cmd: [cmd, ...args].join(' '),
    startedAt,
    finishedAt,
    exitCode: result.status,
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

const runs = [];

runs.push(run('release-gate', process.execPath, ['scripts/release-gate.js']));

const testFiles = fs.readdirSync(testsDir)
  .filter((entry) => entry.endsWith('.js'))
  .sort((a, b) => a.localeCompare(b));

const coveredByReleaseGate = new Set(
  (fs.readFileSync(path.join(repoRoot, 'scripts', 'release-gate.js'), 'utf8').match(/tests\/[\w.-]+\.js/g) || [])
    .map((value) => value.replace(/^tests\//, ''))
);

for (const file of testFiles) {
  if (coveredByReleaseGate.has(file)) continue;
  runs.push(run(`extra:${file}`, process.execPath, [path.join('tests', file)]));
}

const startedAt = runs[0]?.startedAt || new Date().toISOString();
const endedAt = new Date().toISOString();
const failed = runs.filter((row) => !row.ok);

fs.mkdirSync(reportsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[T:.]/g, '-');
const reportPath = path.join(reportsDir, `v1-full-test-report-${stamp}.json`);

const report = {
  startedAt,
  endedAt,
  totalRuns: runs.length,
  passedRuns: runs.length - failed.length,
  failedRuns: failed.length,
  runs,
};

fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

console.log(`[v1-full-test] report written: ${reportPath}`);
console.log(`[v1-full-test] total=${report.totalRuns} passed=${report.passedRuns} failed=${report.failedRuns}`);

if (failed.length > 0) {
  console.error('[v1-full-test] failing runs:');
  failed.forEach((row) => console.error(`- ${row.name} (exit ${row.exitCode})`));
  process.exit(1);
}
