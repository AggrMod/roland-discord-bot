const { doubleCsrf } = require('csrf-csrf');

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

function normalizeOrigin(value) {
  try {
    return new URL(String(value || '').trim()).origin;
  } catch (_error) {
    return '';
  }
}

function createCsrfProtection({ secret, isProduction = false, allowedOrigins = [], toErrorResponse }) {
  const csrfSecret = String(secret || '').trim();
  if (csrfSecret.length < 32) {
    throw new Error('CSRF protection requires a secret of at least 32 characters');
  }

  const allowed = new Set((allowedOrigins || []).map(normalizeOrigin).filter(Boolean));
  const cookieName = isProduction ? '__Host-gp.csrf' : 'gp.csrf';
  const { generateCsrfToken, doubleCsrfProtection } = doubleCsrf({
    getSecret: () => csrfSecret,
    getSessionIdentifier: (req) => String(req.sessionID || ''),
    cookieName,
    cookieOptions: {
      httpOnly: true,
      sameSite: 'lax',
      secure: !!isProduction,
      path: '/',
    },
    getCsrfTokenFromRequest: (req) => String(req.headers['x-csrf-token'] || '').trim(),
  });

  const issueToken = (req, res) => {
    const token = generateCsrfToken(req, res);
    return res.json({ success: true, token, data: { token } });
  };

  const protectMutations = (req, res, next) => {
    if (!MUTATING_METHODS.has(req.method)) return next();

    const pathName = String(req.path || '');
    const hasSecretAuth = !!req.headers['x-webhook-secret'] || !!req.headers['x-entitlement-secret'];
    if (pathName.startsWith('/webhooks/') || hasSecretAuth) return next();

    const requestOrigin = normalizeOrigin(req.headers.origin || req.headers.referer);
    if (requestOrigin && !allowed.has(requestOrigin)) {
      return res.status(403).json(toErrorResponse('Request origin is not allowed', 'FORBIDDEN'));
    }
    if (isProduction && !requestOrigin) {
      return res.status(403).json(toErrorResponse('Request origin is required', 'FORBIDDEN'));
    }

    const requestedWith = String(req.headers['x-requested-with'] || '').trim().toLowerCase();
    if (requestedWith !== 'xmlhttprequest') {
      return res.status(403).json(toErrorResponse('Missing or invalid X-Requested-With header', 'FORBIDDEN'));
    }

    return doubleCsrfProtection(req, res, (error) => {
      if (error) {
        return res.status(403).json(toErrorResponse('Missing or invalid CSRF token', 'FORBIDDEN'));
      }
      return next();
    });
  };

  return { issueToken, protectMutations, cookieName };
}

module.exports = { createCsrfProtection, normalizeOrigin };
