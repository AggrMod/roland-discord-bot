const express = require('express');
const fs = require('fs');
const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { createBrandedPanelEmbed } = require('../../services/embedBranding');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminRolesRouter({
  logger,
  adminAuthMiddleware,
  ensureVerificationModule,
  ensureSelfServeRolesModule,
  fetchGuildById,
  getClient,
}) {
  const router = express.Router();
  const panelConfigPath = path.join(__dirname, '..', '..', 'config', 'role-claim-panels.json');

  const respondServiceResult = (res, result, defaultMessage) => {
    if (result && typeof result === 'object' && result.success === false) {
      return res.json(toErrorResponse(result.message || defaultMessage || 'Request failed', 'VALIDATION_ERROR', null, result));
    }
    return res.json(toSuccessResponse(result || { success: true }));
  };

  router.get('/api/admin/og-role/config', adminAuthMiddleware, async (req, res) => {
    if (!ensureVerificationModule(req, res)) return;

    try {
      const ogRoleService = require('../../services/ogRoleService');
      const guild = req.guild || await fetchGuildById(req.guildId);
      const status = await ogRoleService.getStatus(guild);
      return res.json(toSuccessResponse({ config: status }));
    } catch (routeError) {
      logger.error('Error fetching OG role config:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/og-role/config', adminAuthMiddleware, (req, res) => {
    if (!ensureVerificationModule(req, res)) return;

    try {
      const ogRoleService = require('../../services/ogRoleService');
      const { enabled, roleId, limit } = req.body || {};

      let result = { success: true };

      if (enabled !== undefined) {
        result = ogRoleService.setEnabled(enabled, req.guildId);
        if (!result.success) return respondServiceResult(res, result, 'Failed to update OG role');
      }

      if (roleId !== undefined) {
        result = ogRoleService.setRole(roleId, req.guildId);
        if (!result.success) return respondServiceResult(res, result, 'Failed to update OG role');
      }

      if (limit !== undefined) {
        result = ogRoleService.setLimit(limit, req.guildId);
        if (!result.success) return respondServiceResult(res, result, 'Failed to update OG role');
      }

      return res.json(toSuccessResponse({ message: 'OG role config updated' }));
    } catch (routeError) {
      logger.error('Error updating OG role config:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/og-role/sync', adminAuthMiddleware, async (req, res) => {
    if (!ensureVerificationModule(req, res)) return;

    try {
      const ogRoleService = require('../../services/ogRoleService');
      const { fullSync } = req.body || {};
      const guild = req.guild || await fetchGuildById(req.guildId);
      const result = await ogRoleService.syncRoles(guild, fullSync || false);
      return respondServiceResult(res, result, 'Failed to sync OG roles');
    } catch (routeError) {
      logger.error('Error syncing OG roles:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/role-claim/config', adminAuthMiddleware, async (req, res) => {
    if (!ensureSelfServeRolesModule(req, res)) return;

    try {
      const roleClaimService = require('../../services/roleClaimService');
      const guild = req.guild || await fetchGuildById(req.guildId);
      const status = await roleClaimService.getRoleStatus(guild);
      return respondServiceResult(res, status, 'Failed to load role claim config');
    } catch (routeError) {
      logger.error('Error fetching role claim config:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/role-claim/add', adminAuthMiddleware, async (req, res) => {
    if (!ensureSelfServeRolesModule(req, res)) return;

    try {
      const roleClaimService = require('../../services/roleClaimService');
      const { roleId, label } = req.body || {};

      if (!roleId) {
        return res.status(400).json(toErrorResponse('roleId is required', 'VALIDATION_ERROR'));
      }

      const guild = req.guild || await fetchGuildById(req.guildId);
      const validation = await roleClaimService.validateRole(guild, roleId);
      if (!validation.valid) {
        return res.json(toErrorResponse(validation.message, 'VALIDATION_ERROR', null, { success: false }));
      }

      const result = roleClaimService.addRole(roleId, label);
      return respondServiceResult(res, result, 'Failed to add claimable role');
    } catch (routeError) {
      logger.error('Error adding claimable role:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/role-claim/:roleId', adminAuthMiddleware, (req, res) => {
    if (!ensureSelfServeRolesModule(req, res)) return;

    try {
      const roleClaimService = require('../../services/roleClaimService');
      const { roleId } = req.params;
      const result = roleClaimService.removeRole(roleId);
      return respondServiceResult(res, result, 'Failed to remove claimable role');
    } catch (routeError) {
      logger.error('Error removing claimable role:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/role-claim/:roleId/toggle', adminAuthMiddleware, (req, res) => {
    if (!ensureSelfServeRolesModule(req, res)) return;

    try {
      const roleClaimService = require('../../services/roleClaimService');
      const { roleId } = req.params;
      const { enabled } = req.body || {};
      const result = roleClaimService.updateRole(roleId, { enabled: !!enabled });
      return respondServiceResult(res, result, 'Failed to toggle claimable role');
    } catch (routeError) {
      logger.error('Error toggling claimable role:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/roles/post-panel', adminAuthMiddleware, async (req, res) => {
    if (!ensureSelfServeRolesModule(req, res)) return;

    try {
      const roleClaimService = require('../../services/roleClaimService');
      const client = getClient();
      const { channelId, title, description } = req.body || {};

      if (!channelId) {
        return res.status(400).json(toErrorResponse('channelId is required', 'VALIDATION_ERROR'));
      }

      const roles = roleClaimService.getClaimableRoles();
      if (!roles || roles.length === 0) {
        return res.status(400).json(toErrorResponse('No enabled claimable roles configured', 'VALIDATION_ERROR'));
      }

      const channel = client?.channels?.cache?.get(channelId) || await client?.channels?.fetch?.(channelId).catch(() => null);
      if (!channel) {
        return res.status(400).json(toErrorResponse('Channel not found', 'VALIDATION_ERROR'));
      }

      const embed = createBrandedPanelEmbed({
        guildId: req.guildId || channel.guild?.id || '',
        moduleKey: 'selfserve',
        panelTitle: title || 'Get Your Roles',
        description: description || 'Click a button below to claim or unclaim a community role.',
        defaultColor: '#6366f1',
        defaultFooter: 'Powered by Guild Pilot',
        fallbackLogoUrl: client?.user?.displayAvatarURL?.() || null,
        useThumbnail: false,
      });

      const rows = [];
      for (let i = 0; i < roles.length && rows.length < 5; i += 5) {
        const row = new ActionRowBuilder();
        const chunk = roles.slice(i, i + 5);
        for (const role of chunk) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`claim_role_${role.roleId}`)
              .setLabel(role.label || role.roleId)
              .setStyle(ButtonStyle.Secondary)
          );
        }
        rows.push(row);
      }

      let panelConfig = {};
      try {
        panelConfig = JSON.parse(fs.readFileSync(panelConfigPath, 'utf8'));
      } catch (_error) {
        panelConfig = {};
      }

      let action = 'posted';
      const existingMsgId = panelConfig[channelId];
      if (existingMsgId) {
        try {
          const existingMsg = await channel.messages.fetch(existingMsgId);
          await existingMsg.edit({ embeds: [embed], components: rows });
          action = 'updated';
        } catch (_error) {
          const msg = await channel.send({ embeds: [embed], components: rows });
          panelConfig[channelId] = msg.id;
          action = 'posted';
        }
      } else {
        const msg = await channel.send({ embeds: [embed], components: rows });
        panelConfig[channelId] = msg.id;
      }

      fs.writeFileSync(panelConfigPath, JSON.stringify(panelConfig, null, 2));
      return res.json(toSuccessResponse({ messageId: panelConfig[channelId], action }));
    } catch (routeError) {
      logger.error('Error posting role claim panel:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createAdminRolesRouter;
