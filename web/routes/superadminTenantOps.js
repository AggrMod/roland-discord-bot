const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createSuperadminTenantOpsRouter({
  superadminGuard,
  tenantService,
  entitlementService,
  monetizationTemplateService,
  getPlanKeys,
  getPlanPreset,
  fetchGuildById,
  guildIconUrl,
  normalizeGuildId,
  requestGuildHeader,
  fs,
  path,
  logger,
  getClient = null,
  getGuildBotProfileSnapshot = async () => null,
  applyGuildBotProfileBranding = async () => ({ success: false, skipped: true }),
}) {
  const router = express.Router();

  async function resolveDiscordDisplayMap(ids = []) {
    const normalizedIds = [...new Set((ids || []).map(id => String(id || '').trim()).filter(Boolean))];
    if (!normalizedIds.length) return new Map();

    const displayMap = new Map();
    const client = typeof getClient === 'function' ? getClient() : null;
    if (!client?.users?.fetch) return displayMap;

    await Promise.all(normalizedIds.map(async (discordId) => {
      try {
        const user = await client.users.fetch(discordId, { force: false });
        if (!user) return;
        const display = user.globalName || user.displayName || user.username || null;
        if (display) displayMap.set(discordId, display);
      } catch (_error) {
        // Best-effort only; keep raw id fallback.
      }
    }));

    return displayMap;
  }

  const logSuperadminTenantAction = (req, _res, next) => {
    const activeGuildId = normalizeGuildId(req.get(requestGuildHeader));
    const targetGuildId = normalizeGuildId(req.params.guildId);
    if (activeGuildId && targetGuildId && activeGuildId !== targetGuildId) {
      logger.log(`[tenant-cross] superadmin=${req.session.discordUser.id} route=${req.method} ${req.originalUrl} active=${activeGuildId} target=${targetGuildId}`);
    }
    next();
  };

  router.get('/tenants', superadminGuard, (req, res) => {
    try {
      const result = tenantService.listTenants({
        q: req.query.q,
        status: req.query.status,
        page: req.query.page,
        pageSize: req.query.pageSize,
      });

      res.json(toSuccessResponse({
        tenants: result.tenants,
        pagination: result.pagination,
      }));
    } catch (error) {
      logger.error('Error fetching tenants:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/tenants/:guildId/audit', superadminGuard, logSuperadminTenantAction, async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10), 1), 100);
      const logs = tenantService.getTenantAuditLogs(req.params.guildId, limit);
      const actorIds = logs.map(log => log.actor_id).filter(Boolean);
      const actorDisplayMap = await resolveDiscordDisplayMap(actorIds);
      const hydratedLogs = logs.map(log => ({
        ...log,
        actor_display_name: actorDisplayMap.get(String(log.actor_id || '').trim()) || null,
      }));

      res.json(toSuccessResponse({
        auditLogs: hydratedLogs,
      }));
    } catch (error) {
      logger.error('Error fetching tenant audit logs:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/tenants/:guildId', superadminGuard, logSuperadminTenantAction, async (req, res) => {
    try {
      const tenant = tenantService.getTenant(req.params.guildId);
      if (!tenant) {
        return res.status(404).json(toErrorResponse('Tenant not found', 'NOT_FOUND'));
      }

      const client = typeof getClient === 'function' ? getClient() : null;
      const guild = await fetchGuildById(req.params.guildId);
      const fallbackLogo = guildIconUrl(guild);
      const serverProfile = await getGuildBotProfileSnapshot({ client, guildId: req.params.guildId });
      const branding = {
        ...(tenant.branding || {}),
        logo_url: tenant?.branding?.logo_url || fallbackLogo || null,
      };

      res.json(toSuccessResponse({
        tenant: {
          ...tenant,
          branding,
          serverProfile: serverProfile || null,
          serverProfileCapabilities: {
            nick: true,
            avatar: true,
            banner: true,
            bio: true,
          },
        },
      }));
    } catch (error) {
      logger.error('Error fetching tenant:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/limits/catalog', superadminGuard, (_req, res) => {
    try {
      const plans = getPlanKeys().map(planKey => {
        const preset = getPlanPreset(planKey);
        return {
          key: planKey,
          label: preset?.label || planKey,
          description: preset?.description || '',
          billing: preset?.billing || null,
          moduleLimits: entitlementService.getPlanModuleLimits(planKey),
        };
      });

      res.json(toSuccessResponse({
        plans,
        definitions: entitlementService.getLimitDefinitions(),
      }));
    } catch (error) {
      logger.error('Error fetching limits catalog:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/monetization/templates', superadminGuard, (_req, res) => {
    try {
      const templates = monetizationTemplateService.listTemplates();
      res.json(toSuccessResponse({ templates }));
    } catch (error) {
      logger.error('Error fetching monetization templates:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/tenants/:guildId/template-preview', superadminGuard, logSuperadminTenantAction, (req, res) => {
    try {
      const templateKey = String(req.query?.templateKey || '').trim();
      if (!templateKey) {
        return res.status(400).json(toErrorResponse('templateKey is required', 'VALIDATION_ERROR'));
      }

      const result = monetizationTemplateService.previewTemplate(req.params.guildId, templateKey);

      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to preview template', 'VALIDATION_ERROR', null, result));
      }

      res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error previewing monetization template:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/tenants/:guildId/apply-template', superadminGuard, logSuperadminTenantAction, (req, res) => {
    try {
      const templateKey = String(req.body?.templateKey || '').trim();
      if (!templateKey) {
        return res.status(400).json(toErrorResponse('templateKey is required', 'VALIDATION_ERROR'));
      }

      const result = monetizationTemplateService.applyTemplate(
        req.params.guildId,
        templateKey,
        req.session?.discordUser?.id || 'unknown'
      );

      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to apply template', 'VALIDATION_ERROR', null, result));
      }

      res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error applying monetization template:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/tenants/:guildId/rollback-template', superadminGuard, logSuperadminTenantAction, (req, res) => {
    try {
      const result = monetizationTemplateService.rollbackLastTemplate(
        req.params.guildId,
        req.session?.discordUser?.id || 'unknown'
      );

      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to rollback template', 'VALIDATION_ERROR', null, result));
      }

      res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error rolling back monetization template:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/tenants/:guildId/limits', superadminGuard, logSuperadminTenantAction, (req, res) => {
    try {
      const snapshot = entitlementService.getTenantLimitSnapshot(req.params.guildId);
      if (!snapshot) {
        return res.status(404).json(toErrorResponse('Tenant not found', 'NOT_FOUND'));
      }

      res.json(toSuccessResponse({ limits: snapshot }));
    } catch (error) {
      logger.error('Error fetching tenant limits:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/tenants/:guildId/limits', superadminGuard, logSuperadminTenantAction, (req, res) => {
    try {
      const guildId = req.params.guildId;
      const before = entitlementService.getTenantLimitSnapshot(guildId);
      if (!before) {
        return res.status(404).json(toErrorResponse('Tenant not found', 'NOT_FOUND'));
      }

      const updates = [];
      if (req.body && typeof req.body === 'object' && req.body.moduleKey && req.body.limitKey) {
        updates.push({
          moduleKey: req.body.moduleKey,
          limitKey: req.body.limitKey,
          limitValue: req.body.limitValue,
        });
      } else if (req.body && typeof req.body === 'object' && req.body.overrides && typeof req.body.overrides === 'object') {
        for (const [moduleKey, limitMap] of Object.entries(req.body.overrides)) {
          if (!limitMap || typeof limitMap !== 'object') continue;
          for (const [limitKey, limitValue] of Object.entries(limitMap)) {
            updates.push({ moduleKey, limitKey, limitValue });
          }
        }
      }

      if (updates.length === 0) {
        return res.status(400).json(toErrorResponse('No valid limit updates provided', 'VALIDATION_ERROR'));
      }

      for (const update of updates) {
        const result = entitlementService.setTenantModuleOverride(
          guildId,
          update.moduleKey,
          update.limitKey,
          update.limitValue
        );
        if (!result.success) {
          return res.status(400).json(toErrorResponse(result.message || 'Failed to update limit override', 'VALIDATION_ERROR', null, result));
        }
      }

      const after = entitlementService.getTenantLimitSnapshot(guildId);
      tenantService.logAudit(guildId, req.session?.discordUser?.id || 'unknown', 'set_module_limits', before, after);
      res.json(toSuccessResponse({ limits: after }));
    } catch (error) {
      logger.error('Error updating tenant limits:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/tenants/:guildId/plan', superadminGuard, logSuperadminTenantAction, (req, res) => {
    try {
      const result = tenantService.setTenantPlan(
        req.params.guildId,
        req.body?.plan,
        req.session.discordUser.id
      );

      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update tenant plan', 'VALIDATION_ERROR', null, result));
      }

      res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error updating tenant plan:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/tenants/:guildId/modules', superadminGuard, logSuperadminTenantAction, (req, res) => {
    try {
      const { moduleKey, enabled } = req.body || {};
      if (!moduleKey) {
        return res.status(400).json(toErrorResponse('moduleKey is required', 'VALIDATION_ERROR'));
      }

      const result = tenantService.setTenantModule(
        req.params.guildId,
        moduleKey,
        enabled,
        req.session.discordUser.id
      );

      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update tenant module', 'VALIDATION_ERROR', null, result));
      }

      res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error updating tenant module:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/tenants/:guildId/status', superadminGuard, logSuperadminTenantAction, (req, res) => {
    try {
      const result = tenantService.setTenantStatus(
        req.params.guildId,
        req.body?.status,
        req.session.discordUser.id
      );

      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update tenant status', 'VALIDATION_ERROR', null, result));
      }

      res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error updating tenant status:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/tenants/:guildId/mock-data', superadminGuard, logSuperadminTenantAction, (req, res) => {
    try {
      const result = tenantService.setTenantMockData(
        req.params.guildId,
        !!req.body?.enabled,
        req.session.discordUser.id
      );

      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update tenant mock-data flag', 'VALIDATION_ERROR', null, result));
      }

      res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error updating tenant mock-data flag:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/tenants/:guildId/logo-upload', superadminGuard, logSuperadminTenantAction, async (req, res) => {
    try {
      const guildId = req.params.guildId;
      const { dataUrl } = req.body || {};
      if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        return res.status(400).json(toErrorResponse('dataUrl (image) is required', 'VALIDATION_ERROR'));
      }

      const match = dataUrl.match(/^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/i);
      if (!match) {
        return res.status(400).json(toErrorResponse('Unsupported image format', 'VALIDATION_ERROR'));
      }

      const mime = match[1].toLowerCase();
      const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
      const b64 = match[3];
      const buffer = Buffer.from(b64, 'base64');
      const maxBytes = 2 * 1024 * 1024;
      if (buffer.length > maxBytes) {
        return res.status(400).json(toErrorResponse('Logo too large (max 2MB)', 'VALIDATION_ERROR'));
      }

      const uploadDir = path.join(__dirname, '..', 'public', 'uploads', 'tenant-logos');
      fs.mkdirSync(uploadDir, { recursive: true });
      const safeGuildId = normalizeGuildId(guildId);
      const fileName = `${safeGuildId}-${Date.now()}.${ext}`;
      const filePath = path.join(uploadDir, fileName);
      fs.writeFileSync(filePath, buffer);

      const publicUrl = `/uploads/tenant-logos/${fileName}`;
      const result = tenantService.updateTenantBranding(guildId, { logo_url: publicUrl }, req.session.discordUser.id);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update tenant branding', 'VALIDATION_ERROR', null, result));
      }

      return res.json(toSuccessResponse({ logo_url: publicUrl }));
    } catch (error) {
      logger.error('Error uploading tenant logo:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/tenants/:guildId/branding', superadminGuard, logSuperadminTenantAction, async (req, res) => {
    try {
      const client = typeof getClient === 'function' ? getClient() : null;
      const guildId = req.params.guildId;
      const ALLOWED_BRANDING_FIELDS = ['displayName', 'description', 'logoUrl', 'primaryColor', 'supportUrl', 'bot_display_name', 'bot_server_avatar_url', 'bot_server_banner_url', 'bot_server_bio', 'brand_emoji', 'brand_color', 'display_name', 'primary_color', 'secondary_color', 'logo_url', 'icon_url', 'support_url'];
      const patch = {};
      for (const key of ALLOWED_BRANDING_FIELDS) {
        if ((req.body || {})[key] !== undefined) patch[key] = req.body[key];
      }
      const result = tenantService.updateTenantBranding(
        guildId,
        patch,
        req.session.discordUser.id
      );

      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update tenant branding', 'VALIDATION_ERROR', null, result));
      }

      const profileResult = await applyGuildBotProfileBranding({
        client,
        guildId,
        brandingPatch: patch,
        logger,
        reason: `Superadmin branding update by ${req.session?.discordUser?.id || 'unknown'}`,
      });

      res.json(toSuccessResponse({
        ...result,
        serverProfileApplied: !!profileResult?.success,
        serverProfileWarning: profileResult && !profileResult.success && !profileResult.skipped
          ? (profileResult.message || 'Could not apply server profile changes on Discord')
          : null,
      }));
    } catch (error) {
      logger.error('Error updating tenant branding:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createSuperadminTenantOpsRouter;
