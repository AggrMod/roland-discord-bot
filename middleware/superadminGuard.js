const superadminService = require('../services/superadminService');

function superadminGuard(req, res, next) {
  const userId = req.session?.discordUser?.id;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }

  if (!superadminService.isSuperadmin(userId)) {
    return res.status(403).json({ success: false, message: 'Superadmin access required' });
  }

  return next();
}

module.exports = superadminGuard;
