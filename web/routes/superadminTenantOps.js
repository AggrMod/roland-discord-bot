const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');
const db = require('../../database/db');

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

  async function syncTenantScaffoldFromClientGuilds() {
    const client = typeof getClient === 'function' ? getClient() : null;
    if (!client?.guilds?.cache) return;

    const guilds = [...client.guilds.cache.values()];
    for (const guild of guilds) {
      const guildId = normalizeGuildId(guild?.id);
      if (!guildId) continue;
      try {
        tenantService.ensureTenant(guildId, guild?.name || null);
      } catch (_error) {
        // Best-effort sync only.
      }
    }
  }

  async function hydrateTenantGuildNames(tenants = []) {
    if (!Array.isArray(tenants) || !tenants.length) return tenants;

    const targets = tenants.filter(tenant => {
      const guildId = normalizeGuildId(tenant?.guildId);
      if (!guildId) return false;
      const guildName = String(tenant?.guildName || '').trim();
      return !guildName || guildName === guildId;
    });

    if (!targets.length) return tenants;

    const nameMap = new Map();
    await Promise.all(targets.map(async (tenant) => {
      const guildId = normalizeGuildId(tenant?.guildId);
      if (!guildId) return;
      try {
        const guild = await fetchGuildById(guildId);
        const guildName = String(guild?.name || '').trim();
        if (!guildName) return;
        nameMap.set(guildId, guildName);
        tenantService.ensureTenant(guildId, guildName);
      } catch (_error) {
        // Keep original fallback value.
      }
    }));

    if (!nameMap.size) return tenants;
    return tenants.map(tenant => {
      const guildId = normalizeGuildId(tenant?.guildId);
      const mappedName = guildId ? nameMap.get(guildId) : null;
      if (!mappedName) return tenant;
      return {
        ...tenant,
        guildName: mappedName,
      };
    });
  }

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

  router.get('/tenants', superadminGuard, async (req, res) => {
    try {
      await syncTenantScaffoldFromClientGuilds();
      const result = tenantService.listTenants({
        q: req.query.q,
        status: req.query.status,
        page: req.query.page,
        pageSize: req.query.pageSize,
      });
      const hydratedTenants = await hydrateTenantGuildNames(result.tenants || []);

      res.json(toSuccessResponse({
        tenants: hydratedTenants,
        pagination: result.pagination,
      }));
    } catch (error) {
      logger.error('Error fetching tenants:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/workspace/tenants', superadminGuard, async (req, res) => {
    try {
      await syncTenantScaffoldFromClientGuilds();
      const result = tenantService.listTenants({
        q: req.query.q,
        status: req.query.status,
        page: req.query.page,
        pageSize: req.query.pageSize,
      });
      const hydratedTenants = await hydrateTenantGuildNames(result.tenants || []);
      const normalized = hydratedTenants.map((tenant) => {
        const billing = tenant?.billing || null;
        return {
          guildId: tenant.guildId,
          guildName: tenant.guildName || tenant.guildId,
          status: String(tenant.status || 'active'),
          planKey: String(tenant.planKey || 'starter'),
          enabledModulesCount: Number(tenant.enabledModulesCount || 0),
          totalModulesCount: Number(tenant.totalModulesCount || 0),
          updatedAt: tenant.updatedAt || null,
          summary: {
            planLabel: String(tenant.planLabel || tenant.planKey || 'starter'),
            moduleCoverage: `${Number(tenant.enabledModulesCount || 0)}/${Number(tenant.totalModulesCount || 0)}`,
            billingStatus: String(billing?.subscriptionStatus || 'unknown'),
          },
          billing: billing ? {
            provider: billing.provider || null,
            subscriptionStatus: billing.subscriptionStatus || null,
            billingInterval: billing.billingInterval || null,
            currentPeriodEnd: billing.currentPeriodEnd || null,
            lastPaymentAt: billing.lastPaymentAt || null,
            lastPaymentStatus: billing.lastPaymentStatus || null,
          } : null,
        };
      });

      res.json(toSuccessResponse({
        tenants: normalized,
        pagination: result.pagination,
      }));
    } catch (error) {
      logger.error('Error fetching workspace tenants:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/workspace/billing', superadminGuard, async (req, res) => {
    try {
      const page = Math.max(parseInt(req.query.page || '1', 10), 1);
      const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '25', 10), 1), 100);
      const status = String(req.query.status || '').trim().toLowerCase();
      const q = String(req.query.q || '').trim().toLowerCase();

      let rows = db.prepare(`
        SELECT
          t.guild_id AS guildId,
          t.guild_name AS guildName,
          tb.provider AS provider,
          tb.subscription_status AS subscriptionStatus,
          tb.billing_interval AS billingInterval,
          tb.current_period_end AS currentPeriodEnd,
          tb.last_payment_at AS lastPaymentAt,
          tb.last_payment_status AS lastPaymentStatus,
          tb.updated_at AS updatedAt
        FROM tenant_billing tb
        INNER JOIN tenants t ON t.id = tb.tenant_id
        ORDER BY COALESCE(tb.updated_at, tb.created_at) DESC, tb.id DESC
      `).all();

      if (status) {
        rows = rows.filter((row) => String(row?.subscriptionStatus || '').toLowerCase() === status);
      }
      if (q) {
        rows = rows.filter((row) => {
          const guildName = String(row?.guildName || '').toLowerCase();
          const guildId = String(row?.guildId || '').toLowerCase();
          const provider = String(row?.provider || '').toLowerCase();
          const subStatus = String(row?.subscriptionStatus || '').toLowerCase();
          return guildName.includes(q) || guildId.includes(q) || provider.includes(q) || subStatus.includes(q);
        });
      }

      const total = rows.length;
      const totalPages = Math.max(Math.ceil(total / pageSize), 1);
      const normalizedPage = Math.min(page, totalPages);
      const start = (normalizedPage - 1) * pageSize;
      const sliced = rows.slice(start, start + pageSize).map((row) => ({
        guildId: row.guildId,
        guildName: row.guildName || row.guildId,
        provider: row.provider || null,
        subscriptionStatus: row.subscriptionStatus || 'unknown',
        billingInterval: row.billingInterval || null,
        currentPeriodEnd: row.currentPeriodEnd || null,
        lastPaymentAt: row.lastPaymentAt || null,
        lastPaymentStatus: row.lastPaymentStatus || null,
        updatedAt: row.updatedAt || null,
        verificationStatus: ['active', 'trialing', 'paid', 'approved', 'success'].includes(String(row.subscriptionStatus || '').toLowerCase())
          ? 'verified'
          : (String(row.subscriptionStatus || '').trim() ? 'pending' : 'unverified'),
      }));

      res.json(toSuccessResponse({
        entries: sliced,
        pagination: {
          page: normalizedPage,
          pageSize,
          total,
          totalPages,
        },
      }));
    } catch (error) {
      logger.error('Error fetching workspace billing ledger:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/workspace/activity', superadminGuard, async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10), 1), 100);
      const rows = db.prepare(`
        SELECT id, guild_id, actor_id, action, created_at
        FROM tenant_audit_logs
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(limit);
      const actorDisplayMap = await resolveDiscordDisplayMap(rows.map((row) => row.actor_id).filter(Boolean));

      res.json(toSuccessResponse({
        items: rows.map((row) => ({
          id: row.id,
          guildId: row.guild_id,
          actorId: row.actor_id || null,
          actorDisplayName: actorDisplayMap.get(String(row.actor_id || '').trim()) || null,
          action: row.action || 'unknown',
          createdAt: row.created_at || null,
        })),
      }));
    } catch (error) {
      logger.error('Error fetching workspace activity stream:', error);
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
      let tenant = tenantService.getTenant(req.params.guildId);
      if (!tenant) {
        let guild = null;
        try {
          guild = await fetchGuildById(req.params.guildId);
        } catch (_error) {
          guild = null;
        }
        const ensured = tenantService.ensureTenant(req.params.guildId, guild?.name || null);
        tenant = ensured || tenantService.getTenant(req.params.guildId);
      }
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
      const ALLOWED_BRANDING_FIELDS = ['displayName', 'description', 'logoUrl', 'primaryColor', 'supportUrl', 'bot_display_name', 'bot_server_avatar_url', 'bot_server_banner_url', 'bot_server_bio', 'brand_emoji', 'brand_color', 'display_name', 'primary_color', 'secondary_color', 'logo_url', 'icon_url', 'support_url', 'missions_label'];
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
