const superadminService = require('../services/superadminService');

function superadminGuard(req, res, next) {
  const userId = req.session?.discordUser?.id;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }

  if (!superadminService.isSuperadmin(userId)) {
    return res.status(403).json({ success: false, message: 'Superadmin access required' });
  }

  const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE']).has(req.method);
  const recentAuthWindowMs = Math.max(5 * 60 * 1000, Number(process.env.SUPERADMIN_RECENT_AUTH_MS || 30 * 60 * 1000));
  const authenticatedAt = Number(req.session?.discordUser?.authenticatedAt || 0);
  if (mutating && (authenticatedAt <= 0 || Date.now() - authenticatedAt > recentAuthWindowMs)) {
    return res.status(403).json({
      success: false,
      message: 'Recent authentication is required for this superadmin action',
      error: { code: 'REAUTH_REQUIRED', message: 'Sign in again before changing superadmin settings.' },
    });
  }

  return next();
}

module.exports = superadminGuard;
