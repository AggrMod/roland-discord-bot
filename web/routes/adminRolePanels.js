const express = require('express');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { createBrandedPanelEmbed } = require('../../services/embedBranding');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminRolePanelsRouter({
  logger,
  adminAuthMiddleware,
  ensureSelfServeRolesModule,
  fetchGuildById,
  getClient,
}) {
  const router = express.Router();

  const respondServiceResult = (res, result, defaultMessage, statusCode = 200) => {
    if (result && typeof result === 'object' && result.success === false) {
      return res.status(statusCode).json(toErrorResponse(result.message || defaultMessage || 'Request failed', 'VALIDATION_ERROR', null, result));
    }
    return res.status(statusCode).json(toSuccessResponse(result || { success: true }));
  };

  router.get('/api/admin/role-panels', adminAuthMiddleware, (req, res) => {
    if (!ensureSelfServeRolesModule(req, res)) return;

    try {
      const rolePanelService = require('../../services/rolePanelService');
      const panels = rolePanelService.listPanels(req.guildId);
      return res.json(toSuccessResponse({ panels }));
    } catch (routeError) {
      logger.error('Error listing role panels:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/role-panels', adminAuthMiddleware, (req, res) => {
    if (!ensureSelfServeRolesModule(req, res)) return;

    try {
      const rolePanelService = require('../../services/rolePanelService');
      const { title, description, channelId, singleSelect } = req.body || {};
      const result = rolePanelService.createPanel({
        guildId: req.guildId || '',
        title,
        description,
        channelId,
        singleSelect
      });
      return respondServiceResult(res, result, 'Failed to create role panel', result?.success ? 200 : 400);
    } catch (routeError) {
      logger.error('Error creating role panel:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/role-panels/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureSelfServeRolesModule(req, res)) return;

    try {
      const rolePanelService = require('../../services/rolePanelService');
      const { title, description, channelId, singleSelect } = req.body || {};
      const result = rolePanelService.updatePanel(
        parseInt(req.params.id, 10),
        { title, description, channelId, singleSelect },
        req.guildId
      );
      return respondServiceResult(res, result, 'Failed to update role panel');
    } catch (routeError) {
      logger.error('Error updating role panel:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/role-panels/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureSelfServeRolesModule(req, res)) return;

    try {
      const rolePanelService = require('../../services/rolePanelService');
      const result = rolePanelService.deletePanel(parseInt(req.params.id, 10), req.guildId);
      return respondServiceResult(res, result, 'Failed to delete role panel');
    } catch (routeError) {
      logger.error('Error deleting role panel:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/role-panels/:id/roles', adminAuthMiddleware, async (req, res) => {
    if (!ensureSelfServeRolesModule(req, res)) return;

    try {
      const rolePanelService = require('../../services/rolePanelService');
      const { roleId, label } = req.body || {};
      if (!roleId) {
        return res.status(400).json(toErrorResponse('roleId is required', 'VALIDATION_ERROR'));
      }

      const guild = req.guild || await fetchGuildById(req.guildId);
      const gRole = guild?.roles?.cache?.get(roleId);
      if (!gRole) {
        return res.status(400).json(toErrorResponse('Role not found in this server', 'VALIDATION_ERROR'));
      }

      const result = rolePanelService.addRole(
        parseInt(req.params.id, 10),
        { roleId, label: label || gRole.name },
        req.guildId
      );
      return respondServiceResult(res, result, 'Failed to add role to panel');
    } catch (routeError) {
      logger.error('Error adding role to panel:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/role-panels/:id/roles/:roleId', adminAuthMiddleware, (req, res) => {
    if (!ensureSelfServeRolesModule(req, res)) return;

    try {
      const rolePanelService = require('../../services/rolePanelService');
      const result = rolePanelService.removeRole(
        parseInt(req.params.id, 10),
        req.params.roleId,
        req.guildId
      );
      return respondServiceResult(res, result, 'Failed to remove role from panel');
    } catch (routeError) {
      logger.error('Error removing role from panel:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/role-panels/:id/roles/:roleId', adminAuthMiddleware, (req, res) => {
    if (!ensureSelfServeRolesModule(req, res)) return;

    try {
      const rolePanelService = require('../../services/rolePanelService');
      const { label, enabled } = req.body || {};
      const result = rolePanelService.updateRole(
        parseInt(req.params.id, 10),
        req.params.roleId,
        { label, enabled },
        req.guildId
      );
      return respondServiceResult(res, result, 'Failed to update role in panel');
    } catch (routeError) {
      logger.error('Error updating role in panel:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/role-panels/:id/post', adminAuthMiddleware, async (req, res) => {
    if (!ensureSelfServeRolesModule(req, res)) return;

    try {
      const rolePanelService = require('../../services/rolePanelService');
      const client = getClient();
      const panelId = parseInt(req.params.id, 10);
      const panel = rolePanelService.getPanel(panelId, req.guildId);
      if (!panel) {
        return res.status(404).json(toErrorResponse('Panel not found', 'NOT_FOUND'));
      }

      const { channelId } = req.body || {};
      const targetChannelId = channelId || panel.channel_id;
      if (!targetChannelId) {
        return res.status(400).json(toErrorResponse('channelId is required', 'VALIDATION_ERROR'));
      }

      const enabledRoles = (panel.roles || []).filter(r => r.enabled !== 0);
      if (!enabledRoles.length) {
        return res.status(400).json(toErrorResponse('No enabled roles on this panel', 'VALIDATION_ERROR'));
      }

      const channel = client?.channels?.cache?.get(targetChannelId)
        || await client?.channels?.fetch?.(targetChannelId).catch(() => null);
      if (!channel) {
        return res.status(400).json(toErrorResponse('Channel not found', 'VALIDATION_ERROR'));
      }

      const embed = createBrandedPanelEmbed({
        guildId: req.guildId,
        moduleKey: 'selfserve',
        panelTitle: panel.title || 'Get Your Roles',
        description: panel.description || 'Click a button below to claim or unclaim a community role.',
        defaultColor: '#6366f1',
        defaultFooter: 'Powered by Guild Pilot',
        fallbackLogoUrl: client?.user?.displayAvatarURL?.() || null,
        useThumbnail: false,
      });

      const rows = [];
      for (let i = 0; i < enabledRoles.length && rows.length < 5; i += 5) {
        const row = new ActionRowBuilder();
        enabledRoles.slice(i, i + 5).forEach(role => {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`claim_role_${panelId}__${role.role_id}`)
              .setLabel(role.label || role.role_id)
              .setStyle(ButtonStyle.Secondary)
          );
        });
        rows.push(row);
      }

      let action = 'posted';
      if (panel.channel_id === targetChannelId && panel.message_id) {
        try {
          const existingMsg = await channel.messages.fetch(panel.message_id);
          await existingMsg.edit({ embeds: [embed], components: rows });
          action = 'updated';
        } catch (_error) {
          const msg = await channel.send({ embeds: [embed], components: rows });
          rolePanelService.updatePanel(panelId, { channelId: targetChannelId, messageId: msg.id });
        }
      } else {
        const msg = await channel.send({ embeds: [embed], components: rows });
        rolePanelService.updatePanel(panelId, { channelId: targetChannelId, messageId: msg.id });
      }

      return res.json(toSuccessResponse({ action }));
    } catch (routeError) {
      logger.error('Error posting role panel:', routeError);
      return res.status(500).json(toErrorResponse('Failed to post panel'));
    }
  });

  return router;
}

module.exports = createAdminRolePanelsRouter;
