// Fix I (audit C-2, H-6): allowed return-origin resolution, extracted so the
// security-relevant logic is unit-testable. The allowlist is built from
// operator-configured origins, never from a spoofable request header (unless an
// operator explicitly opts in via PUBLIC_WEB_TRUST_REQUEST_ORIGIN).

function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).origin;
  } catch (_error) {
    try {
      return new URL(`https://${raw}`).origin;
    } catch (_error2) {
      return '';
    }
  }
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getConfiguredWebOrigins(env = process.env) {
  const raw = [
    env.PUBLIC_WEB_BASE_URL,
    env.WEB_URL,
    ...parseList(env.WEB_URL_ALIASES),
    ...parseList(env.PUBLIC_WEB_ALLOWED_RETURN_ORIGINS),
  ];
  return Array.from(new Set(raw.map(normalizeOrigin).filter(Boolean)));
}

function trustRequestOriginEnabled(env = process.env) {
  return String(env.PUBLIC_WEB_TRUST_REQUEST_ORIGIN || '').trim().toLowerCase() === 'true';
}

function buildAllowedReturnOrigins(env = process.env, requestOrigin = '') {
  const configured = getConfiguredWebOrigins(env);
  const defaults = ['https://the-solpranos.com', 'https://www.the-solpranos.com']
    .map(normalizeOrigin)
    .filter(Boolean);
  const optional = trustRequestOriginEnabled(env)
    ? [normalizeOrigin(requestOrigin)].filter(Boolean)
    : [];
  return Array.from(new Set([...configured, ...defaults, ...optional]));
}

function isReturnOriginAllowed(rawReturnTo, allowedOrigins) {
  try {
    const parsed = new URL(String(rawReturnTo || '').trim());
    return allowedOrigins.includes(parsed.origin);
  } catch (_error) {
    return false;
  }
}

module.exports = {
  normalizeOrigin,
  getConfiguredWebOrigins,
  trustRequestOriginEnabled,
  buildAllowedReturnOrigins,
  isReturnOriginAllowed,
};
