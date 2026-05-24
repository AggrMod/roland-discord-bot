#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const matrixPath = path.join(repoRoot, 'config', 'test-coverage-matrix.json');

const raw = fs.readFileSync(matrixPath, 'utf8');
const matrix = JSON.parse(raw);

if (!Array.isArray(matrix.requiredCapabilities) || matrix.requiredCapabilities.length === 0) {
  console.error('[coverage-matrix] requiredCapabilities is empty.');
  process.exit(1);
}

const errors = [];

for (const capability of matrix.requiredCapabilities) {
  const id = String(capability.id || '').trim();
  const label = String(capability.label || id || 'capability').trim();
  const tests = Array.isArray(capability.tests) ? capability.tests : [];

  if (!id) {
    errors.push('Capability entry missing id.');
    continue;
  }
  if (tests.length === 0) {
    errors.push(`[${id}] has no tests listed.`);
    continue;
  }

  for (const testPath of tests) {
    const rel = String(testPath || '').trim();
    if (!rel) {
      errors.push(`[${id}] contains empty test path.`);
      continue;
    }
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) {
      errors.push(`[${id}] missing file: ${rel}`);
    }
  }

  console.log(`[coverage-matrix] OK: ${label} -> ${tests.length} mapped tests`);
}

if (errors.length) {
  console.error('\n[coverage-matrix] FAILED');
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log('\n[coverage-matrix] All required capabilities are mapped to existing tests.');
