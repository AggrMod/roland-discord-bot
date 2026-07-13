const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminGuildGuardRouter({ logger, adminAuthMiddleware, ensureGuildGuardModule, guildGuardService }) {
  const router = express.Router();

  router.get('/api/admin/guildguard/config', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    return res.json(toSuccessResponse({ config: guildGuardService.getConfig(req.guildId) }));
  });

  router.put('/api/admin/guildguard/config', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    try {
      const config = guildGuardService.updateConfig(req.guildId, req.body || {});
      return res.json(toSuccessResponse({ config }));
    } catch (error) {
      logger.error('Guild Guard config update failed:', error);
      return res.status(400).json(toErrorResponse(error.message || 'Invalid Guild Guard configuration', 'VALIDATION_ERROR'));
    }
  });

  router.get('/api/admin/guildguard/incidents', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    return res.json(toSuccessResponse({ incidents: guildGuardService.listIncidents(req.guildId, req.query?.limit) }));
  });

  router.get('/api/admin/guildguard/summary', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    return res.json(toSuccessResponse({ summary: guildGuardService.getDashboardSummary(req.guildId, req.query?.days) }));
  });

  router.get('/api/admin/guildguard/incidents/:incidentId', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    const incident = guildGuardService.getIncident(req.guildId, req.params.incidentId);
    if (!incident) return res.status(404).json(toErrorResponse('Incident not found', 'NOT_FOUND'));
    return res.json(toSuccessResponse({ incident }));
  });

  router.post('/api/admin/guildguard/incidents/:incidentId/review', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    try {
      const incident = guildGuardService.updateIncidentStatus(
        req.guildId,
        req.params.incidentId,
        String(req.body?.status || '').trim(),
        req.session?.discordUser?.id
      );
      if (!incident) return res.status(404).json(toErrorResponse('Incident not found', 'NOT_FOUND'));
      return res.json(toSuccessResponse({ incident }));
    } catch (error) {
      return res.status(400).json(toErrorResponse(error.message || 'Invalid review status', 'VALIDATION_ERROR'));
    }
  });

  router.post('/api/admin/guildguard/incidents/:incidentId/false-positive', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    const incident = guildGuardService.reportFalsePositive(
      req.guildId,
      req.params.incidentId,
      req.session?.discordUser?.id,
      req.body?.reason
    );
    if (!incident) return res.status(404).json(toErrorResponse('Incident not found', 'NOT_FOUND'));
    return res.json(toSuccessResponse({ incident }));
  });

  router.get('/api/admin/guildguard/false-positives', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    return res.json(toSuccessResponse({ falsePositives: guildGuardService.listFalsePositives(req.guildId, req.query?.limit) }));
  });

  router.post('/api/admin/guildguard/retention/run', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    return res.json(toSuccessResponse({ result: guildGuardService.purgeExpired(req.guildId, req.body?.retentionDays) }));
  });

  router.get('/api/admin/guildguard/staff-identities', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    return res.json(toSuccessResponse({ identities: guildGuardService.identityRegistry.list(req.guildId, false) }));
  });

  router.post('/api/admin/guildguard/staff-identities', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    try {
      const identity = guildGuardService.identityRegistry.upsert(req.guildId, req.body || {});
      return res.status(201).json(toSuccessResponse({ identity }));
    } catch (error) {
      return res.status(400).json(toErrorResponse(error.message || 'Invalid staff identity', 'VALIDATION_ERROR'));
    }
  });

  router.delete('/api/admin/guildguard/staff-identities/:userId', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    return res.json(toSuccessResponse({ removed: guildGuardService.identityRegistry.remove(req.guildId, req.params.userId) }));
  });

  router.get('/api/admin/guildguard/domains', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    return res.json(toSuccessResponse({ domains: guildGuardService.domainRegistry.getLists(req.guildId) }));
  });

  router.post('/api/admin/guildguard/domains', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    try {
      const type = req.body?.type === 'allow' ? 'allow' : req.body?.type === 'block' ? 'block' : null;
      if (!type) return res.status(400).json(toErrorResponse('Domain type must be allow or block', 'VALIDATION_ERROR'));
      const domain = guildGuardService.domainRegistry.add(req.guildId, req.body?.domain, type, {
        createdBy: req.session?.discordUser?.id,
        reason: req.body?.reason
      });
      return res.status(201).json(toSuccessResponse({ domain, type }));
    } catch (error) {
      return res.status(400).json(toErrorResponse(error.message || 'Invalid domain', 'VALIDATION_ERROR'));
    }
  });

  router.delete('/api/admin/guildguard/domains', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    const type = req.query?.type === 'allow' ? 'allow' : req.query?.type === 'block' ? 'block' : null;
    if (!type) return res.status(400).json(toErrorResponse('Domain type must be allow or block', 'VALIDATION_ERROR'));
    return res.json(toSuccessResponse({ removed: guildGuardService.domainRegistry.remove(req.guildId, req.query?.domain, type) }));
  });

  return router;
}

module.exports = createAdminGuildGuardRouter;
