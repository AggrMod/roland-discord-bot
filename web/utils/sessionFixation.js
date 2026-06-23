// Fix G (audit H-5): session-fixation protection helpers, extracted so the
// security-relevant logic is unit-testable.

// Enabled by default. Kill switch: SESSION_FIXATION_PROTECTION=off|false|0.
function sessionFixationProtectionEnabled() {
  const raw = String(process.env.SESSION_FIXATION_PROTECTION ?? 'on').trim().toLowerCase();
  return !(raw === 'off' || raw === 'false' || raw === '0' || raw === 'disabled');
}

// Regenerate the session id (new, empty session) before establishing the
// authenticated user. No-op when disabled or when the session has no
// regenerate() (e.g. a stub session), so callers can always await it safely.
function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    if (!sessionFixationProtectionEnabled() || !req || !req.session || typeof req.session.regenerate !== 'function') {
      resolve();
      return;
    }
    req.session.regenerate((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

module.exports = { sessionFixationProtectionEnabled, regenerateSession };
