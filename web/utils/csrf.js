const crypto = require('crypto');

// Fix J (audit C-1): real synchronizer CSRF tokens. Rollout is
// monitor-before-enforce so the portal can never be locked out:
//   off     - no token check (legacy X-Requested-With only)
//   monitor - check token, LOG mismatches, but do not block (default)
//   enforce - reject mutating cookie-auth requests without a valid token
function csrfMode(env = process.env) {
  const raw = String(env.CSRF_MODE || 'monitor').trim().toLowerCase();
  return ['off', 'monitor', 'enforce'].includes(raw) ? raw : 'monitor';
}

// Mint-on-demand, stored in the session so it is per-user and unguessable.
function getOrCreateCsrfToken(session) {
  if (!session) return '';
  if (!session.csrfToken) {
    session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return session.csrfToken;
}

function isCsrfTokenValid(expected, provided) {
  const e = String(expected || '');
  const p = String(provided || '');
  if (!e || !p || e.length !== p.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(e), Buffer.from(p));
  } catch (_error) {
    return false;
  }
}

module.exports = { csrfMode, getOrCreateCsrfToken, isCsrfTokenValid };
