#!/usr/bin/env node

// Fix J (audit C-1): synchronizer CSRF token helpers.

const assert = require('assert');
const { csrfMode, getOrCreateCsrfToken, isCsrfTokenValid } = require('../web/utils/csrf');

function run() {
  // --- Mode parsing (default monitor — safe ship state) ---
  assert.strictEqual(csrfMode({}), 'monitor', 'default mode is monitor');
  assert.strictEqual(csrfMode({ CSRF_MODE: 'OFF' }), 'off', 'off parsed');
  assert.strictEqual(csrfMode({ CSRF_MODE: 'enforce' }), 'enforce', 'enforce parsed');
  assert.strictEqual(csrfMode({ CSRF_MODE: 'nonsense' }), 'monitor', 'unknown falls back to monitor');

  // --- Token mint: stable within a session, unique across sessions ---
  const s1 = {};
  const t1 = getOrCreateCsrfToken(s1);
  assert.ok(t1 && t1.length >= 32, 'token minted with sufficient length');
  assert.strictEqual(getOrCreateCsrfToken(s1), t1, 'token is stable within a session');
  const s2 = {};
  assert.notStrictEqual(getOrCreateCsrfToken(s2), t1, 'token differs across sessions');
  assert.strictEqual(getOrCreateCsrfToken(null), '', 'no session -> empty token');

  // --- Validation ---
  assert.ok(isCsrfTokenValid(t1, t1), 'matching token validates');
  assert.ok(!isCsrfTokenValid(t1, 'wrong'), 'wrong token rejected');
  assert.ok(!isCsrfTokenValid(t1, ''), 'empty provided rejected');
  assert.ok(!isCsrfTokenValid('', t1), 'empty expected rejected');
  assert.ok(!isCsrfTokenValid(t1, `${t1}x`), 'different-length token rejected (no throw)');

  console.log('csrf assertions passed');
}

run();
