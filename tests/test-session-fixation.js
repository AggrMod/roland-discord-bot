#!/usr/bin/env node

// Fix G (audit H-5): session regeneration on login.

const assert = require('assert');

function freshModule() {
  delete require.cache[require.resolve('../web/utils/sessionFixation')];
  return require('../web/utils/sessionFixation');
}

// A fake express session whose regenerate() swaps in a brand-new id, mirroring
// express-session semantics closely enough to assert behavior.
function makeReq(initialId) {
  let id = initialId;
  let regenerateCalls = 0;
  return {
    get regenerateCalls() { return regenerateCalls; },
    get id() { return id; },
    session: {
      regenerate(cb) {
        regenerateCalls += 1;
        id = `regenerated-${Math.random().toString(36).slice(2)}`;
        cb(null);
      },
    },
  };
}

async function run() {
  // --- Flag parsing ---
  delete process.env.SESSION_FIXATION_PROTECTION;
  let m = freshModule();
  assert.strictEqual(m.sessionFixationProtectionEnabled(), true, 'enabled by default');

  for (const off of ['off', 'false', '0', 'disabled', 'OFF']) {
    process.env.SESSION_FIXATION_PROTECTION = off;
    m = freshModule();
    assert.strictEqual(m.sessionFixationProtectionEnabled(), false, `disabled for "${off}"`);
  }
  process.env.SESSION_FIXATION_PROTECTION = 'on';
  m = freshModule();
  assert.strictEqual(m.sessionFixationProtectionEnabled(), true, 'enabled for "on"');

  // --- Enabled: regenerate is invoked and the id changes ---
  delete process.env.SESSION_FIXATION_PROTECTION;
  m = freshModule();
  let req = makeReq('pre-login-id');
  const before = req.id;
  await m.regenerateSession(req);
  assert.strictEqual(req.regenerateCalls, 1, 'regenerate called once when enabled');
  assert.notStrictEqual(req.id, before, 'session id changes after regenerate');

  // --- Disabled: regenerate is NOT invoked (kill switch) ---
  process.env.SESSION_FIXATION_PROTECTION = 'off';
  m = freshModule();
  req = makeReq('pre-login-id');
  await m.regenerateSession(req);
  assert.strictEqual(req.regenerateCalls, 0, 'regenerate skipped when disabled');
  assert.strictEqual(req.id, 'pre-login-id', 'session id unchanged when disabled');

  // --- Safe no-op when session lacks regenerate() ---
  delete process.env.SESSION_FIXATION_PROTECTION;
  m = freshModule();
  await m.regenerateSession({ session: {} }); // must resolve, not throw
  await m.regenerateSession({}); // no session at all
  await m.regenerateSession(null); // no req

  // --- Rejects when the store errors ---
  m = freshModule();
  let rejected = false;
  try {
    await m.regenerateSession({ session: { regenerate: (cb) => cb(new Error('store down')) } });
  } catch (e) {
    rejected = /store down/.test(e.message);
  }
  assert.ok(rejected, 'propagates a regenerate error so login fails closed');

  delete process.env.SESSION_FIXATION_PROTECTION;
  console.log('session fixation assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
