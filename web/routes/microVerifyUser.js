const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createMicroVerifyUserRouter({
  logger,
  microVerifyService,
}) {
  const router = express.Router();

  const requireSession = (req, res) => {
    if (req.session?.discordUser) return true;
    res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    return false;
  };

  router.post('/api/micro-verify/request', (req, res) => {
    if (!requireSession(req, res)) return;

    try {
      const discordId = req.session.discordUser.id;
      const username = req.session.discordUser.username;
      const result = microVerifyService.createRequest(discordId, username, req.guildId || '');
      if (!result?.success) {
        return res.json(toErrorResponse(result?.message || 'Failed to create request', 'VALIDATION_ERROR', null, result || { success: false }));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error creating micro-verify request:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/micro-verify/status', (req, res) => {
    if (!requireSession(req, res)) return;

    try {
      const discordId = req.session.discordUser.id;
      const result = microVerifyService.getPendingRequest(discordId);

      if (result.success) {
        const request = result.request;
        const expiresAt = new Date(request.expires_at);
        const timeLeftMs = expiresAt - new Date();
        const timeLeftMinutes = Math.max(0, Math.floor(timeLeftMs / 1000 / 60));

        return res.json(toSuccessResponse({
          request: {
            id: request.id,
            amount: request.expected_amount,
            destinationWallet: request.destination_wallet,
            expiresAt: request.expires_at,
            timeLeftMinutes,
            status: request.status
          }
        }));
      }

      return res.json(toErrorResponse(result?.message || 'No pending request', 'NOT_FOUND', null, { success: false }));
    } catch (routeError) {
      logger.error('Error getting micro-verify status:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/micro-verify/check-now', async (req, res) => {
    if (!requireSession(req, res)) return;

    try {
      const discordId = req.session.discordUser.id;
      const result = await microVerifyService.checkNow(discordId);
      if (!result?.success) {
        return res.json(toErrorResponse(result?.message || 'Check failed', 'VALIDATION_ERROR', null, result || { success: false }));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error in check-now:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/micro-verify/config', (_req, res) => {
    try {
      const config = microVerifyService.getConfig();
      return res.json(toSuccessResponse({
        enabled: config.enabled,
        ttlMinutes: config.ttlMinutes
      }));
    } catch (routeError) {
      logger.error('Error getting micro-verify config:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createMicroVerifyUserRouter;
