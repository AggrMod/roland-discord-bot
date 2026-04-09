const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createUserAdminCheckRouter({
  logger,
  resolveAdminGuildAccess,
}) {
  const router = express.Router();

  router.get('/api/user/is-admin', async (req, res) => {
    if (!req.session?.discordUser) {
      return res.json(toSuccessResponse({ isAdmin: false }));
    }

    try {
      const access = await resolveAdminGuildAccess(req, { allowFallback: false });
      if (!access.ok) {
        return res.status(access.status).json(toErrorResponse(access.message, 'FORBIDDEN', null, { isAdmin: false }));
      }

      return res.json(toSuccessResponse({ isAdmin: true }));
    } catch (routeError) {
      logger.error('Admin check error:', routeError);
      return res.json(toErrorResponse('Internal server error', 'INTERNAL_ERROR', null, { isAdmin: false }));
    }
  });

  return router;
}

module.exports = createUserAdminCheckRouter;
