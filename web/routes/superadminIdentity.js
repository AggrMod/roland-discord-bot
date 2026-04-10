const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

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
      res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error listing superadmin identity users:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/users/:discordId', superadminGuard, (req, res) => {
    try {
      const profile = superadminIdentityService.getProfile(req.params.discordId);
      if (!profile) {
        return res.status(404).json(toErrorResponse('User not found', 'NOT_FOUND'));
      }
      res.json(toSuccessResponse({ profile }));
    } catch (error) {
      logger.error('Error getting superadmin identity profile:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/users/ensure', superadminGuard, (req, res) => {
    try {
      const result = superadminIdentityService.ensureProfile({
        discordId: req.body?.discordId,
        username: req.body?.username,
        actorId: req.session?.discordUser?.id || null,
        metadata: {
          source: 'superadmin_portal',
          reason: req.body?.reason || null,
        },
      });
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to ensure identity profile', 'VALIDATION_ERROR', null, result));
      }
      res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error ensuring superadmin identity profile:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
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
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update identity flags', 'VALIDATION_ERROR', null, result));
      }
      res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error updating superadmin identity flags:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
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
        return res.status(400).json(toErrorResponse(result.message || 'Failed to link wallet', 'VALIDATION_ERROR', null, result));
      }
      res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error linking wallet via superadmin identity:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
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
        const code = status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR';
        return res.status(status).json(toErrorResponse(result.message || 'Failed to unlink wallet', code, null, result));
      }
      res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error unlinking wallet via superadmin identity:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/audit', superadminGuard, (req, res) => {
    try {
      const auditLogs = superadminIdentityService.listAudit({
        discordId: req.query.discordId || '',
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json(toSuccessResponse({ auditLogs }));
    } catch (error) {
      logger.error('Error reading superadmin identity audit logs:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createSuperadminIdentityRouter;
