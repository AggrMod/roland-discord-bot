const express = require('express');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { createBrandedPanelEmbed } = require('../../services/embedBranding');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminVerificationPanelRouter({
  logger,
  db,
  adminAuthMiddleware,
  ensureVerificationModule,
  ensureVerificationPanelsSchema,
  getClient,
}) {
  const router = express.Router();
  const buildVerifyPortalUrl = (baseUrl, guildId = '', action = '') => {
    const url = new URL('/verify', baseUrl);
    const normalizedGuildId = String(guildId || '').trim();
    if (normalizedGuildId) {
      url.searchParams.set('guild', normalizedGuildId);
    }
    if (action) {
      url.searchParams.set('action', action);
    }
    return url.toString();
  };

  router.get('/api/admin/verification/panel', adminAuthMiddleware, (req, res) => {
    if (!ensureVerificationModule(req, res)) return;

    try {
      ensureVerificationPanelsSchema();
      const row = db.prepare(`
        SELECT guild_id, channel_id, message_id, title, description, color, created_at, updated_at
        FROM verification_panels
        WHERE guild_id = ?
        LIMIT 1
      `).get(req.guildId);

      if (!row) {
        return res.json(toSuccessResponse({ panel: null }));
      }

      return res.json(toSuccessResponse({
        panel: {
          guildId: row.guild_id,
          channelId: row.channel_id,
          messageId: row.message_id || null,
          title: row.title || '',
          description: row.description || '',
          color: row.color || '#FFD700',
          createdAt: row.created_at || null,
          updatedAt: row.updated_at || null
        }
      }));
    } catch (routeError) {
      logger.error('Error loading verification panel config:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/verification/panel/post', adminAuthMiddleware, async (req, res) => {
    if (!ensureVerificationModule(req, res)) return;

    try {
      ensureVerificationPanelsSchema();
      const client = getClient();
      if (!client) {
        return res.status(500).json(toErrorResponse('Bot not initialized'));
      }

      const existing = db.prepare(`
        SELECT guild_id, channel_id, message_id, title, description, color
        FROM verification_panels
        WHERE guild_id = ?
        LIMIT 1
      `).get(req.guildId);

      const channelId = String(req.body?.channelId || existing?.channel_id || '').trim();
      if (!channelId) {
        return res.status(400).json(toErrorResponse('channelId is required', 'VALIDATION_ERROR'));
      }

      const title = String(req.body?.title || existing?.title || 'Verify your wallet!').trim();
      const description = String(
        req.body?.description
        || existing?.description
        || 'To get access to community roles, verify your wallet by clicking the button below.'
      ).trim();
      const color = String(req.body?.color || existing?.color || '#FFD700').trim() || '#FFD700';

      const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.send) {
        return res.status(400).json(toErrorResponse('Channel not found or not writable', 'VALIDATION_ERROR'));
      }
      if (String(channel.guild?.id || '') !== String(req.guildId || '')) {
        return res.status(400).json(toErrorResponse('Selected channel must belong to the active server', 'VALIDATION_ERROR'));
      }

      const webUrl = process.env.WEB_URL || 'http://localhost:3000';
      const embed = createBrandedPanelEmbed({
        guildId: req.guildId || channel.guild?.id || '',
        moduleKey: 'verification',
        panelTitle: title,
        description,
        defaultColor: color,
        defaultFooter: 'Powered by Guild Pilot',
        fallbackLogoUrl: client?.user?.displayAvatarURL?.() || null,
        useThumbnail: false,
      });

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('panel_verify')
            .setLabel('Verify')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setLabel('Add Wallet')
            .setStyle(ButtonStyle.Link)
            .setURL(buildVerifyPortalUrl(webUrl, req.guildId || '', 'add')),
          new ButtonBuilder()
            .setLabel('Get Help')
            .setStyle(ButtonStyle.Link)
            .setURL(`${webUrl}/help`)
        );

      let action = 'posted';
      let messageId = null;

      if (existing?.message_id && existing?.channel_id === channelId) {
        try {
          const oldMessage = await channel.messages.fetch(existing.message_id).catch(() => null);
          if (oldMessage) {
            await oldMessage.edit({ embeds: [embed], components: [row] });
            action = 'updated';
            messageId = oldMessage.id;
          }
        } catch (_error) {}
      }

      if (!messageId) {
        const msg = await channel.send({ embeds: [embed], components: [row] });
        messageId = msg.id;
      }

      db.prepare(`
        INSERT INTO verification_panels (guild_id, channel_id, message_id, title, description, color, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(guild_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          message_id = excluded.message_id,
          title = excluded.title,
          description = excluded.description,
          color = excluded.color,
          updated_at = CURRENT_TIMESTAMP
      `).run(req.guildId, channelId, messageId, title, description, color);

      return res.json(toSuccessResponse({ action, channelId, messageId }));
    } catch (routeError) {
      logger.error('Error posting verification panel from web:', routeError);
      return res.status(500).json(toErrorResponse('Failed to post verification panel'));
    }
  });

  return router;
}

module.exports = createAdminVerificationPanelRouter;
