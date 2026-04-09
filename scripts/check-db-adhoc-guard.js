#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const DB_FILE = path.resolve(__dirname, '..', 'database', 'db.js');
const BASELINE_TRY_EXEC_COUNT = 92;

const content = fs.readFileSync(DB_FILE, 'utf8');
const adhocExecCount = (content.match(/try\s*\{\s*db\.exec\(/g) || []).length;

if (process.env.ALLOW_DB_ADHOC_GROWTH === 'true') {
  console.log(`[db-adhoc-guard] BYPASS enabled. Current try{db.exec(...)} count=${adhocExecCount}`);
  process.exit(0);
}

if (adhocExecCount > BASELINE_TRY_EXEC_COUNT) {
  console.error(
    `[db-adhoc-guard] FAIL: detected ${adhocExecCount} try{db.exec(...)} ad-hoc mutations in database/db.js (baseline ${BASELINE_TRY_EXEC_COUNT}).\n` +
    'Add a forward-only file migration in database/migrations/ instead of expanding legacy bootstrap mutations.'
  );
  process.exit(1);
}

console.log(`[db-adhoc-guard] OK: ad-hoc mutation count=${adhocExecCount} (baseline ${BASELINE_TRY_EXEC_COUNT})`);
