#!/usr/bin/env node

// Fix I (audit C-2, H-6): allowed return-origin resolution must not trust the
// request-derived origin (X-Forwarded-Host) by default.

const assert = require('assert');
const {
  buildAllowedReturnOrigins,
  isReturnOriginAllowed,
  getConfiguredWebOrigins,
} = require('../web/utils/returnOrigin');

function run() {
  const attackerOrigin = 'https://attacker.example';

  // --- Default: request-derived origin is NOT trusted ---
  let env = { WEB_URL: 'https://app.guildpilot.test' };
  let allowed = buildAllowedReturnOrigins(env, attackerOrigin);
  assert.ok(allowed.includes('https://app.guildpilot.test'), 'configured WEB_URL origin is allowed');
  assert.ok(!allowed.includes(attackerOrigin), 'spoofed request origin is NOT auto-allowed (the C-2 fix)');
  assert.ok(!isReturnOriginAllowed(`${attackerOrigin}/steal`, allowed), 'attacker returnTo is rejected');
  assert.ok(isReturnOriginAllowed('https://app.guildpilot.test/app', allowed), 'configured returnTo is accepted');

  // --- Aliases + explicit allowlist are honored ---
  env = {
    WEB_URL: 'https://app.guildpilot.test',
    WEB_URL_ALIASES: 'https://old.guildpilot.test, https://www.guildpilot.test',
    PUBLIC_WEB_ALLOWED_RETURN_ORIGINS: 'https://partner.example',
  };
  allowed = buildAllowedReturnOrigins(env, attackerOrigin);
  for (const o of ['https://app.guildpilot.test', 'https://old.guildpilot.test', 'https://www.guildpilot.test', 'https://partner.example']) {
    assert.ok(allowed.includes(o), `configured origin ${o} is allowed`);
  }
  assert.ok(!allowed.includes(attackerOrigin), 'still no request-origin trust with aliases configured');

  // --- Escape hatch: explicit opt-in re-adds the request origin ---
  env = { WEB_URL: 'https://app.guildpilot.test', PUBLIC_WEB_TRUST_REQUEST_ORIGIN: 'true' };
  allowed = buildAllowedReturnOrigins(env, attackerOrigin);
  assert.ok(allowed.includes(attackerOrigin), 'opt-in restores legacy request-origin trust');

  // --- Static defaults always present ---
  allowed = buildAllowedReturnOrigins({}, '');
  assert.ok(allowed.includes('https://the-solpranos.com'), 'static default origin present');

  // --- getConfiguredWebOrigins reflects config order/dedup ---
  const origins = getConfiguredWebOrigins({ WEB_URL: 'https://a.test', WEB_URL_ALIASES: 'https://a.test, https://b.test' });
  assert.deepStrictEqual(origins, ['https://a.test', 'https://b.test'], 'dedups and normalizes configured origins');

  console.log('return origin assertions passed');
}

run();
