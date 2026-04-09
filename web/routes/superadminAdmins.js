const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createSuperadminAdminsRouter({
  superadminGuard,
  superadminService,
  logger,
}) {
  const router = express.Router();

  router.get('/admins', superadminGuard, (req, res) => {
    try {
      res.json(toSuccessResponse({
        superadmins: superadminService.listSuperadmins(),
      }));
    } catch (error) {
      logger.error('Error fetching superadmins:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/admins', superadminGuard, (req, res) => {
    try {
      const { userId } = req.body || {};
      if (!userId || !String(userId).trim()) {
        return res.status(400).json(toErrorResponse('userId is required', 'VALIDATION_ERROR'));
      }

      const result = superadminService.addSuperadmin(userId, req.session.discordUser.id);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to add superadmin', 'VALIDATION_ERROR', null, result));
      }

      res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error adding superadmin:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/admins/:userId', superadminGuard, (req, res) => {
    try {
      const result = superadminService.removeSuperadmin(req.params.userId, req.session.discordUser.id);
      if (!result.success) {
        const status = result.message === 'Cannot remove root superadmins' ? 403 : 400;
        const code = status === 403 ? 'FORBIDDEN' : 'VALIDATION_ERROR';
        return res.status(status).json(toErrorResponse(result.message || 'Failed to remove superadmin', code, null, result));
      }

      res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error removing superadmin:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createSuperadminAdminsRouter;
