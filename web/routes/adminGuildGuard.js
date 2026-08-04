const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminGuildGuardRouter({ logger, adminAuthMiddleware, ensureGuildGuardModule, guildGuardService, getClient }) {
  const router = express.Router();

  async function getProtectionHealth(guildId) {
    const config = guildGuardService.getConfig(guildId);
    const guild = getClient?.()?.guilds?.cache?.get(String(guildId || '')) || null;
    let member = guild?.members?.me || null;
    if (!member && typeof guild?.members?.fetchMe === 'function') {
      try { member = await guild.members.fetchMe(); } catch (_) { member = null; }
    }
    const rules = Array.isArray(config.rules) ? config.rules : [];
    const needsDelete = config.actions?.deleteMessages === true || rules.some(rule => rule?.enabled !== false && rule?.actions?.deleteMessages === true);
    const needsTimeout = config.actions?.timeoutUsers === true || rules.some(rule => rule?.enabled !== false && rule?.actions?.timeoutUsers === true);
    const needsLockdown = config.actions?.lockdownEnabled === true;
    const alertChannelId = String(config.alertChannelId || '').trim();
    const alertChannel = alertChannelId ? guild?.channels?.cache?.get(alertChannelId) || null : null;
    const channelPermissions = alertChannel && member && typeof alertChannel.permissionsFor === 'function'
      ? alertChannel.permissionsFor(member)
      : null;
    const hasGuildPermission = permission => Boolean(member?.permissions?.has?.(permission));
    const checks = [
      { id: 'bot_connected', label: 'GuildPilot is connected to this server', ok: Boolean(guild && member), required: true },
      { id: 'alert_channel', label: 'Moderator alert channel selected', ok: Boolean(alertChannelId), required: true },
      {
        id: 'send_alerts',
        label: 'GuildPilot can send alerts in the selected channel',
        ok: Boolean(alertChannelId && alertChannel && channelPermissions?.has?.(PermissionFlagsBits.ViewChannel) && channelPermissions?.has?.(PermissionFlagsBits.SendMessages)),
        required: Boolean(alertChannelId)
      },
      { id: 'manage_messages', label: 'GuildPilot can remove dangerous messages', ok: !needsDelete || hasGuildPermission(PermissionFlagsBits.ManageMessages), required: needsDelete },
      { id: 'moderate_members', label: 'GuildPilot can timeout suspicious members', ok: !needsTimeout || hasGuildPermission(PermissionFlagsBits.ModerateMembers), required: needsTimeout },
      { id: 'manage_server', label: 'GuildPilot can activate and restore raid mode', ok: !needsLockdown || hasGuildPermission(PermissionFlagsBits.ManageGuild), required: needsLockdown }
    ];
    const requiredChecks = checks.filter(check => check.required);
    return {
      ready: requiredChecks.every(check => check.ok),
      score: requiredChecks.length ? Math.round((requiredChecks.filter(check => check.ok).length / requiredChecks.length) * 100) : 100,
      checks
    };
  }

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

  router.get('/api/admin/guildguard/presets', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    return res.json(toSuccessResponse({ presets: guildGuardService.listPresets() }));
  });

  router.post('/api/admin/guildguard/preset', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    try {
      const config = guildGuardService.applyPreset(req.guildId, req.body?.preset);
      return res.json(toSuccessResponse({ config }));
    } catch (error) {
      return res.status(400).json(toErrorResponse(error.message || 'Unable to apply protection preset', 'VALIDATION_ERROR'));
    }
  });

  router.get('/api/admin/guildguard/health', adminAuthMiddleware, async (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    try {
      return res.json(toSuccessResponse({ health: await getProtectionHealth(req.guildId) }));
    } catch (error) {
      logger.warn('Guild Guard health check failed:', error);
      return res.status(500).json(toErrorResponse('Unable to check Guild Guard permissions', 'HEALTH_CHECK_FAILED'));
    }
  });

  router.get('/api/admin/guildguard/rules', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    return res.json(toSuccessResponse({ rules: guildGuardService.listRules(req.guildId) }));
  });

  router.post('/api/admin/guildguard/rules', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    try {
      const config = guildGuardService.createRule(req.guildId, req.body || {}, req.session?.discordUser?.id);
      return res.status(201).json(toSuccessResponse({ rules: config.rules }));
    } catch (error) {
      return res.status(400).json(toErrorResponse(error.message || 'Invalid Guild Guard rule', 'VALIDATION_ERROR'));
    }
  });

  router.put('/api/admin/guildguard/rules/:ruleId', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    try {
      const rule = guildGuardService.updateRule(req.guildId, req.params.ruleId, req.body || {});
      if (!rule) return res.status(404).json(toErrorResponse('Rule not found', 'NOT_FOUND'));
      return res.json(toSuccessResponse({ rule }));
    } catch (error) {
      return res.status(400).json(toErrorResponse(error.message || 'Invalid Guild Guard rule', 'VALIDATION_ERROR'));
    }
  });

  router.delete('/api/admin/guildguard/rules/:ruleId', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    return res.json(toSuccessResponse({ removed: guildGuardService.deleteRule(req.guildId, req.params.ruleId) }));
  });

  router.get('/api/admin/guildguard/incidents', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    return res.json(toSuccessResponse({ incidents: guildGuardService.listIncidents(req.guildId, req.query?.limit) }));
  });

  router.get('/api/admin/guildguard/campaigns', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    return res.json(toSuccessResponse({ campaigns: guildGuardService.listIncidentCampaigns(req.guildId, req.query?.days) }));
  });

  router.post('/api/admin/guildguard/incidents/bulk-response', adminAuthMiddleware, async (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    try {
      const guild = getClient?.()?.guilds?.cache?.get(String(req.guildId || '')) || null;
      const result = await guildGuardService.executeBulkIncidentResponse(
        req.guildId,
        req.body || {},
        req.session?.discordUser?.id,
        guild
      );
      return res.json(toSuccessResponse({ result }));
    } catch (error) {
      return res.status(400).json(toErrorResponse(error.message || 'Unable to apply bulk incident response', 'VALIDATION_ERROR'));
    }
  });

  router.get('/api/admin/guildguard/summary', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    return res.json(toSuccessResponse({ summary: guildGuardService.getDashboardSummary(req.guildId, req.query?.days) }));
  });

  router.get('/api/admin/guildguard/incidents/:incidentId', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    const incident = guildGuardService.getIncident(req.guildId, req.params.incidentId);
    if (!incident) return res.status(404).json(toErrorResponse('Incident not found', 'NOT_FOUND'));
    return res.json(toSuccessResponse({ incident, globalReport: guildGuardService.getGlobalReportForIncident(req.guildId, req.params.incidentId) }));
  });

  router.get('/api/admin/guildguard/users/:userId/risk', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.status(400).json(toErrorResponse('User ID is required', 'VALIDATION_ERROR'));
    return res.json(toSuccessResponse({
      profile: guildGuardService.getRiskProfile(req.guildId, userId),
      incidentSummary: guildGuardService.getUserIncidentSummary(req.guildId, userId),
      globalReputation: guildGuardService.getGlobalReputation(userId),
      incidents: guildGuardService.listUserIncidents(req.guildId, userId, req.query?.limit),
      signals: guildGuardService.listRiskSignals(req.guildId, userId, req.query?.signalLimit)
    }));
  });

  router.delete('/api/admin/guildguard/users/:userId/history', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.status(400).json(toErrorResponse('User ID is required', 'VALIDATION_ERROR'));
    try {
      return res.json(toSuccessResponse({
        userId,
        removed: guildGuardService.clearUserHistory(req.guildId, userId)
      }));
    } catch (error) {
      return res.status(400).json(toErrorResponse(error.message || 'Unable to clear user history', 'VALIDATION_ERROR'));
    }
  });

  router.post('/api/admin/guildguard/users/:userId/risk/reset', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    return res.json(toSuccessResponse({ removed: guildGuardService.resetRiskProfile(req.guildId, req.params.userId) }));
  });

  router.post('/api/admin/guildguard/incidents/:incidentId/global-publish', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    try {
      const report = guildGuardService.publishGlobalReport(
        req.guildId,
        req.params.incidentId,
        req.session?.discordUser?.id,
        req.body?.category
      );
      return res.status(201).json(toSuccessResponse({ report }));
    } catch (error) {
      return res.status(400).json(toErrorResponse(error.message || 'Unable to publish global reputation report', 'VALIDATION_ERROR'));
    }
  });

  router.delete('/api/admin/guildguard/global-reputation/reports/:reportId', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    const report = guildGuardService.revokeGlobalReport(req.params.reportId, req.session?.discordUser?.id, req.body?.reason, req.guildId);
    if (!report) return res.status(404).json(toErrorResponse('Global reputation report not found', 'NOT_FOUND'));
    return res.json(toSuccessResponse({ report }));
  });

  router.get('/api/admin/guildguard/global-reputation/reports', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    return res.json(toSuccessResponse({ reports: guildGuardService.listGlobalReports(req.guildId, req.query?.limit) }));
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

  router.post('/api/admin/guildguard/incidents/:incidentId/block-domains', adminAuthMiddleware, (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    try {
      const result = guildGuardService.blockIncidentDomains(
        req.guildId,
        req.params.incidentId,
        req.session?.discordUser?.id
      );
      if (!result) return res.status(404).json(toErrorResponse('Incident not found', 'NOT_FOUND'));
      return res.json(toSuccessResponse({ result }));
    } catch (error) {
      return res.status(400).json(toErrorResponse(error.message || 'Unable to block incident domains', 'VALIDATION_ERROR'));
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
    const result = guildGuardService.purgeExpired(req.guildId, req.body?.retentionDays);
    result.decayed = guildGuardService.decayRiskProfiles(req.guildId);
    return res.json(toSuccessResponse({ result }));
  });

  router.get('/api/admin/guildguard/staff-identities', adminAuthMiddleware, async (req, res) => {
    if (!ensureGuildGuardModule(req, res)) return;
    try {
      const guild = getClient?.()?.guilds?.cache?.get(String(req.guildId || ''));
      if (guild) await guildGuardService.identityRegistry.syncFromGuild(guild);
    } catch (error) {
      logger.warn('Guild Guard staff identity sync failed:', error);
    }
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
