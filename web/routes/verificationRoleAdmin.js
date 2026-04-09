const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createVerificationRoleAdminRouter({
  logger,
  db,
  adminAuthMiddleware,
  ensureVerificationModule,
  tenantService,
  getTenantRoleConfig,
  saveTenantRoleConfig,
  getVerificationRuleCounts,
  checkVerificationLimit,
  parseRuleBoolean,
  roleService,
  fetchGuildById,
  getClient,
}) {
  const router = express.Router();

  router.get('/api/admin/roles/config', adminAuthMiddleware, (req, res) => {
    if (!ensureVerificationModule(req, res)) return;
    try {
      const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
      const config = useTenantScoped
        ? getTenantRoleConfig(req.guildId)
        : {
          ...roleService.getRoleConfigSummary(),
          tokenRules: roleService.getTokenRoleRules(req.guildId || null)
        };
      return res.json(toSuccessResponse({ config }));
    } catch (routeError) {
      logger.error('Error fetching role config:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/roles/tiers', adminAuthMiddleware, (req, res) => {
    if (!ensureVerificationModule(req, res)) return;
    try {
      const { name, minNFTs, maxNFTs, votingPower, roleId, collectionId, neverRemove } = req.body || {};
      if (!name || minNFTs === undefined || maxNFTs === undefined || votingPower === undefined) {
        return res.status(400).json(toErrorResponse('Missing required fields', 'VALIDATION_ERROR'));
      }

      const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
      const ruleCounts = getVerificationRuleCounts(req.guildId, { tenantScoped: useTenantScoped });
      const tierLimit = checkVerificationLimit(req.guildId, 'max_tiers', ruleCounts.tiers, 'verification collection rules');
      if (!tierLimit.success) {
        return res.status(400).json(toErrorResponse(tierLimit.message, 'LIMIT_EXCEEDED', {
          code: 'limit_exceeded',
          limit: tierLimit.limit,
          used: tierLimit.used,
        }));
      }

      const totalLimit = checkVerificationLimit(req.guildId, 'max_rules_total', ruleCounts.total, 'verification rules');
      if (!totalLimit.success) {
        return res.status(400).json(toErrorResponse(totalLimit.message, 'LIMIT_EXCEEDED', {
          code: 'limit_exceeded',
          limit: totalLimit.limit,
          used: totalLimit.used,
        }));
      }

      if (useTenantScoped) {
        const cfg = getTenantRoleConfig(req.guildId);
        if ((cfg.tiers || []).some(t => String(t.name).toLowerCase() === String(name).toLowerCase())) {
          return res.status(400).json(toErrorResponse('Tier already exists', 'VALIDATION_ERROR'));
        }
        cfg.tiers.push({
          name,
          minNFTs,
          maxNFTs,
          votingPower,
          roleId: roleId || null,
          collectionId: collectionId || null,
          neverRemove: parseRuleBoolean(neverRemove, false)
        });
        saveTenantRoleConfig(req.guildId, cfg);
        return res.json(toSuccessResponse({ message: 'Tier added' }));
      }

      const result = roleService.addTier(
        name,
        minNFTs,
        maxNFTs,
        votingPower,
        roleId || null,
        collectionId || null,
        parseRuleBoolean(neverRemove, false)
      );
      if (!result.success) return res.status(400).json(toErrorResponse(result.message || 'Failed to add tier', 'VALIDATION_ERROR', null, result));
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error adding tier:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/roles/tiers/:name', adminAuthMiddleware, (req, res) => {
    if (!ensureVerificationModule(req, res)) return;
    try {
      const { name } = req.params;
      const updates = req.body || {};

      const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
      if (useTenantScoped) {
        const cfg = getTenantRoleConfig(req.guildId);
        const idx = (cfg.tiers || []).findIndex(t => String(t.name).toLowerCase() === String(name).toLowerCase());
        if (idx < 0) return res.status(404).json(toErrorResponse('Tier not found', 'NOT_FOUND'));
        cfg.tiers[idx] = {
          ...cfg.tiers[idx],
          ...updates,
          neverRemove: parseRuleBoolean(updates.neverRemove ?? updates.never_remove ?? cfg.tiers[idx].neverRemove, false)
        };
        saveTenantRoleConfig(req.guildId, cfg);
        return res.json(toSuccessResponse({ message: 'Tier updated' }));
      }

      const result = roleService.editTier(name, updates);
      if (!result.success) return res.status(400).json(toErrorResponse(result.message || 'Failed to update tier', 'VALIDATION_ERROR', null, result));
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error editing tier:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/roles/tiers/:name', adminAuthMiddleware, (req, res) => {
    if (!ensureVerificationModule(req, res)) return;
    try {
      const { name } = req.params;
      const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
      if (useTenantScoped) {
        const cfg = getTenantRoleConfig(req.guildId);
        const before = (cfg.tiers || []).length;
        cfg.tiers = (cfg.tiers || []).filter(t => String(t.name).toLowerCase() !== String(name).toLowerCase());
        if (cfg.tiers.length === before) return res.status(404).json(toErrorResponse('Tier not found', 'NOT_FOUND'));
        saveTenantRoleConfig(req.guildId, cfg);
        return res.json(toSuccessResponse({ message: 'Tier deleted' }));
      }

      const result = roleService.deleteTier(name);
      if (!result.success) return res.status(400).json(toErrorResponse(result.message || 'Failed to delete tier', 'VALIDATION_ERROR', null, result));
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error deleting tier:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/roles/traits', adminAuthMiddleware, (req, res) => {
    if (!ensureVerificationModule(req, res)) return;
    try {
      const { traitType, roleId, collectionId, description, neverRemove } = req.body || {};
      const traitValues = req.body?.traitValues || (req.body?.traitValue ? [req.body.traitValue] : []);
      const traitValue = traitValues[0] || req.body?.traitValue;

      if (!traitType || !traitValue || !roleId) {
        return res.status(400).json(toErrorResponse('Missing required fields', 'VALIDATION_ERROR'));
      }
      if (!collectionId) {
        return res.status(400).json(toErrorResponse('collectionId is required', 'VALIDATION_ERROR'));
      }

      const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
      const ruleCounts = getVerificationRuleCounts(req.guildId, { tenantScoped: useTenantScoped });
      const traitLimit = checkVerificationLimit(req.guildId, 'max_trait_rules', ruleCounts.traits, 'verification trait rules');
      if (!traitLimit.success) {
        return res.status(400).json(toErrorResponse(traitLimit.message, 'LIMIT_EXCEEDED', {
          code: 'limit_exceeded',
          limit: traitLimit.limit,
          used: traitLimit.used,
        }));
      }

      const totalLimit = checkVerificationLimit(req.guildId, 'max_rules_total', ruleCounts.total, 'verification rules');
      if (!totalLimit.success) {
        return res.status(400).json(toErrorResponse(totalLimit.message, 'LIMIT_EXCEEDED', {
          code: 'limit_exceeded',
          limit: totalLimit.limit,
          used: totalLimit.used,
        }));
      }

      if (useTenantScoped) {
        const cfg = getTenantRoleConfig(req.guildId);
        const exists = (cfg.traitRoles || []).some(t =>
          String(t.traitType || t.trait_type).toLowerCase() === String(traitType).toLowerCase() &&
          String(t.traitValue || t.trait_value).toLowerCase() === String(traitValue).toLowerCase()
        );
        if (exists) return res.status(400).json(toErrorResponse('Trait rule already exists', 'VALIDATION_ERROR'));
        cfg.traitRoles.push({
          traitType,
          traitValue,
          traitValues,
          roleId,
          collectionId,
          description: description || '',
          neverRemove: parseRuleBoolean(neverRemove, false)
        });
        saveTenantRoleConfig(req.guildId, cfg);
        return res.json(toSuccessResponse({ message: 'Trait rule added' }));
      }

      const result = roleService.addTrait(
        traitType,
        traitValue,
        roleId,
        description,
        collectionId,
        parseRuleBoolean(neverRemove, false)
      );
      if (!result.success) return res.status(400).json(toErrorResponse(result.message || 'Failed to add trait rule', 'VALIDATION_ERROR', null, result));
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error adding trait:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/roles/traits/:traitType/:traitValue', adminAuthMiddleware, (req, res) => {
    if (!ensureVerificationModule(req, res)) return;
    try {
      const { traitType, traitValue } = req.params;
      const { roleId, collectionId, description } = req.body || {};
      const traitValues = req.body?.traitValues || (req.body?.traitValue ? [req.body.traitValue] : [traitValue]);
      const newTraitValue = req.body?.traitValue || traitValues[0] || traitValue;
      const newTraitType = req.body?.traitType || traitType;

      if (!roleId) return res.status(400).json(toErrorResponse('roleId is required', 'VALIDATION_ERROR'));
      if (!collectionId) return res.status(400).json(toErrorResponse('collectionId is required', 'VALIDATION_ERROR'));

      const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
      if (useTenantScoped) {
        const cfg = getTenantRoleConfig(req.guildId);
        const idx = (cfg.traitRoles || []).findIndex(t =>
          String(t.traitType || t.trait_type).toLowerCase() === String(traitType).toLowerCase() &&
          String(t.traitValue || t.trait_value).toLowerCase() === String(traitValue).toLowerCase()
        );
        if (idx < 0) return res.status(404).json(toErrorResponse('Trait rule not found', 'NOT_FOUND'));
        cfg.traitRoles[idx] = {
          ...cfg.traitRoles[idx],
          traitType: newTraitType,
          traitValue: newTraitValue,
          traitValues,
          roleId,
          collectionId,
          description: description || '',
          neverRemove: parseRuleBoolean(req.body?.neverRemove ?? req.body?.never_remove ?? cfg.traitRoles[idx].neverRemove, false)
        };
        saveTenantRoleConfig(req.guildId, cfg);
        return res.json(toSuccessResponse({ message: 'Trait rule updated' }));
      }

      const result = roleService.editTrait(
        traitType,
        traitValue,
        roleId,
        description,
        collectionId,
        parseRuleBoolean(req.body?.neverRemove ?? req.body?.never_remove, undefined)
      );
      if (!result.success) return res.status(400).json(toErrorResponse(result.message || 'Failed to update trait rule', 'VALIDATION_ERROR', null, result));
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error editing trait:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/roles/traits/:traitType/:traitValue', adminAuthMiddleware, (req, res) => {
    if (!ensureVerificationModule(req, res)) return;
    try {
      const { traitType, traitValue } = req.params;
      const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
      if (useTenantScoped) {
        const cfg = getTenantRoleConfig(req.guildId);
        const before = (cfg.traitRoles || []).length;
        cfg.traitRoles = (cfg.traitRoles || []).filter(t => !(
          String(t.traitType || t.trait_type).toLowerCase() === String(traitType).toLowerCase() &&
          String(t.traitValue || t.trait_value).toLowerCase() === String(traitValue).toLowerCase()
        ));
        if (cfg.traitRoles.length === before) return res.status(404).json(toErrorResponse('Trait rule not found', 'NOT_FOUND'));
        saveTenantRoleConfig(req.guildId, cfg);
        return res.json(toSuccessResponse({ message: 'Trait rule deleted' }));
      }

      const result = roleService.deleteTrait(traitType, traitValue);
      if (!result.success) return res.status(404).json(toErrorResponse(result.message || 'Trait rule not found', 'NOT_FOUND', null, result));
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error deleting trait:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/user/privacy/wallet-identity-opt-out', (req, res) => {
    if (!req.session?.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }

    try {
      const discordId = req.session.discordUser.id;
      const optOut = req.body?.optOut === true;

      db.prepare(`
        INSERT OR IGNORE INTO users (discord_id, username, wallet_alert_identity_opt_out)
        VALUES (?, ?, ?)
      `).run(discordId, req.session.discordUser.username || 'Web User', optOut ? 1 : 0);

      db.prepare(`
        UPDATE users
        SET wallet_alert_identity_opt_out = ?, updated_at = datetime('now')
        WHERE discord_id = ?
      `).run(optOut ? 1 : 0, discordId);

      return res.json(toSuccessResponse({ optOut }));
    } catch (routeError) {
      logger.error('Error updating wallet identity privacy preference:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/roles/tokens', adminAuthMiddleware, (req, res) => {
    if (!ensureVerificationModule(req, res)) return;
    try {
      const rules = roleService.getTokenRoleRules(req.guildId || null);
      return res.json(toSuccessResponse({ rules }));
    } catch (routeError) {
      logger.error('Error fetching token role rules:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/roles/tokens', adminAuthMiddleware, (req, res) => {
    if (!ensureVerificationModule(req, res)) return;
    try {
      const { tokenMint, tokenSymbol, minAmount, maxAmount, roleId, enabled, neverRemove } = req.body || {};
      if (!tokenMint || !roleId || minAmount === undefined || minAmount === null) {
        return res.status(400).json(toErrorResponse('tokenMint, roleId, and minAmount are required', 'VALIDATION_ERROR'));
      }

      const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
      const ruleCounts = getVerificationRuleCounts(req.guildId, { tenantScoped: useTenantScoped });
      const totalLimit = checkVerificationLimit(req.guildId, 'max_rules_total', ruleCounts.total, 'verification rules');
      if (!totalLimit.success) {
        return res.status(400).json(toErrorResponse(totalLimit.message, 'LIMIT_EXCEEDED', {
          code: 'limit_exceeded',
          limit: totalLimit.limit,
          used: totalLimit.used,
        }));
      }

      const result = roleService.addTokenRoleRule({
        guildId: req.guildId || '',
        tokenMint,
        tokenSymbol: tokenSymbol || null,
        minAmount,
        maxAmount: maxAmount === undefined ? null : maxAmount,
        roleId,
        enabled: enabled !== false,
        neverRemove: parseRuleBoolean(neverRemove, false)
      });
      if (!result.success) return res.status(400).json(toErrorResponse(result.message || 'Failed to add token role rule', 'VALIDATION_ERROR', null, result));
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error adding token role rule:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/roles/tokens/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureVerificationModule(req, res)) return;
    try {
      const updates = { ...(req.body || {}) };
      if (updates.neverRemove !== undefined || updates.never_remove !== undefined) {
        updates.neverRemove = parseRuleBoolean(updates.neverRemove ?? updates.never_remove, false);
      }
      const result = roleService.updateTokenRoleRule(req.params.id, updates, req.guildId || null);
      if (!result.success) return res.status(400).json(toErrorResponse(result.message || 'Failed to update token role rule', 'VALIDATION_ERROR', null, result));
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error updating token role rule:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/roles/tokens/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureVerificationModule(req, res)) return;
    try {
      const result = roleService.removeTokenRoleRule(req.params.id, req.guildId || null);
      if (!result.success) return res.status(404).json(toErrorResponse(result.message || 'Token role rule not found', 'NOT_FOUND', null, result));
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error deleting token role rule:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/roles/sync', adminAuthMiddleware, async (req, res) => {
    if (!ensureVerificationModule(req, res)) return;
    try {
      const client = getClient();
      if (!client) {
        return res.status(500).json(toErrorResponse('Bot not initialized'));
      }

      const { discordId } = req.body || {};
      const guild = req.guild || await fetchGuildById(req.guildId);
      if (!guild) {
        return res.status(404).json(toErrorResponse('Server not found', 'NOT_FOUND'));
      }

      if (discordId) {
        await roleService.updateUserRoles(discordId, req.session.discordUser?.username, req.guildId);
        const syncResult = await roleService.syncUserDiscordRoles(guild, discordId, req.guildId);
        if (!syncResult.success) return res.status(400).json(toErrorResponse(syncResult.message || 'Sync failed', 'VALIDATION_ERROR', null, syncResult));
        return res.json(toSuccessResponse(syncResult));
      }

      const allUsers = await roleService.getAllVerifiedUsers(guild);
      let syncedCount = 0;
      let errorCount = 0;

      for (const user of allUsers) {
        try {
          await roleService.updateUserRoles(user.discord_id, user.username, guild.id);
          const syncResult = await roleService.syncUserDiscordRoles(guild, user.discord_id, guild.id);
          if (syncResult.success) syncedCount++;
          else errorCount++;
        } catch (syncError) {
          logger.error(`Error syncing user ${user.discord_id}:`, syncError);
          errorCount++;
        }
      }

      return res.json(toSuccessResponse({
        message: `Synced ${syncedCount} users, ${errorCount} errors`,
        syncedCount,
        errorCount
      }));
    } catch (routeError) {
      logger.error('Error syncing roles:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createVerificationRoleAdminRouter;
