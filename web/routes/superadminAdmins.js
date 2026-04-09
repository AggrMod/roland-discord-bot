const express = require('express');

function createSuperadminAdminsRouter({
  superadminGuard,
  superadminService,
  logger,
}) {
  const router = express.Router();

  router.get('/admins', superadminGuard, (req, res) => {
    try {
      res.json({
        success: true,
        superadmins: superadminService.listSuperadmins(),
      });
    } catch (error) {
      logger.error('Error fetching superadmins:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  router.post('/admins', superadminGuard, (req, res) => {
    try {
      const { userId } = req.body || {};
      if (!userId || !String(userId).trim()) {
        return res.status(400).json({ success: false, message: 'userId is required' });
      }

      const result = superadminService.addSuperadmin(userId, req.session.discordUser.id);
      if (!result.success) {
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (error) {
      logger.error('Error adding superadmin:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  router.delete('/admins/:userId', superadminGuard, (req, res) => {
    try {
      const result = superadminService.removeSuperadmin(req.params.userId, req.session.discordUser.id);
      if (!result.success) {
        const status = result.message === 'Cannot remove root superadmins' ? 403 : 400;
        return res.status(status).json(result);
      }

      res.json(result);
    } catch (error) {
      logger.error('Error removing superadmin:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  return router;
}

module.exports = createSuperadminAdminsRouter;
