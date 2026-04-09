const express = require('express');

function createSuperadminIdentityRouter({
  superadminGuard,
  superadminIdentityService,
  logger,
}) {
  const router = express.Router();

  router.get('/users', superadminGuard, (req, res) => {
    try {
      const q = req.query.q || '';
      const limit = req.query.limit;
      const offset = req.query.offset;
      const result = superadminIdentityService.listProfiles({ q, limit, offset });
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('Error listing superadmin identity users:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  router.get('/users/:discordId', superadminGuard, (req, res) => {
    try {
      const profile = superadminIdentityService.getProfile(req.params.discordId);
      if (!profile) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      res.json({ success: true, profile });
    } catch (error) {
      logger.error('Error getting superadmin identity profile:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  router.put('/users/:discordId/flags', superadminGuard, (req, res) => {
    try {
      const result = superadminIdentityService.setFlags({
        discordId: req.params.discordId,
        trustedIdentity: req.body?.trustedIdentity,
        manualVerified: req.body?.manualVerified,
        notes: req.body?.notes,
        username: req.body?.username,
        actorId: req.session?.discordUser?.id || null,
      });
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (error) {
      logger.error('Error updating superadmin identity flags:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  router.post('/users/:discordId/wallets', superadminGuard, (req, res) => {
    try {
      const result = superadminIdentityService.linkWallet({
        discordId: req.params.discordId,
        walletAddress: req.body?.walletAddress,
        username: req.body?.username,
        primaryWallet: req.body?.primaryWallet,
        favoriteWallet: req.body?.favoriteWallet,
        actorId: req.session?.discordUser?.id || null,
        metadata: {
          source: 'superadmin_portal',
          reason: req.body?.reason || null,
        },
      });
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (error) {
      logger.error('Error linking wallet via superadmin identity:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  router.delete('/users/:discordId/wallets/:walletAddress', superadminGuard, (req, res) => {
    try {
      const walletAddress = decodeURIComponent(req.params.walletAddress || '');
      const result = superadminIdentityService.unlinkWallet({
        discordId: req.params.discordId,
        walletAddress,
        actorId: req.session?.discordUser?.id || null,
        metadata: { source: 'superadmin_portal' },
      });
      if (!result.success) {
        const status = result.message === 'User not found' ? 404 : 400;
        return res.status(status).json(result);
      }
      res.json(result);
    } catch (error) {
      logger.error('Error unlinking wallet via superadmin identity:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  router.get('/audit', superadminGuard, (req, res) => {
    try {
      const auditLogs = superadminIdentityService.listAudit({
        discordId: req.query.discordId || '',
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json({ success: true, auditLogs });
    } catch (error) {
      logger.error('Error reading superadmin identity audit logs:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  return router;
}

module.exports = createSuperadminIdentityRouter;
