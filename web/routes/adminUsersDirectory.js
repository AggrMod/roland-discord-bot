const express = require('express');
const { ChannelType } = require('discord.js');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminUsersDirectoryRouter({
  logger,
  db,
  adminAuthMiddleware,
  ensureVerificationModule,
  fetchGuildById,
  roleService,
  hasProposalsGuildColumn,
  tenantService,
  missionService,
  getClient,
}) {
  const router = express.Router();

  router.get('/api/admin/discord/channels', adminAuthMiddleware, async (req, res) => {
    try {
      const client = getClient?.();
      if (!client) {
        return res.status(500).json(toErrorResponse('Bot not initialized'));
      }

      const guild = req.guild || await fetchGuildById(req.guildId);
      const channels = await guild.channels.fetch();

      const textTypes = [
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.GuildForum,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread
      ];

      const threadTypes = [
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread
      ];

      const categoryType = ChannelType.GuildCategory;

      const channelList = channels
        .filter(ch => ch && (textTypes.includes(ch.type) || ch.type === categoryType))
        .map(ch => ({
          id: ch.id,
          name: ch.name,
          type: ch.type,
          kind: ch.type === categoryType ? 'category' : (threadTypes.includes(ch.type) ? 'thread' : 'text'),
          parentName: ch.parent ? ch.parent.name : null
        }))
        .sort((a, b) => (a.parentName || '').localeCompare(b.parentName || '') || a.name.localeCompare(b.name));

      return res.json(toSuccessResponse({ channels: channelList }));
    } catch (routeError) {
      logger.error('Error fetching Discord channels:', routeError);
      return res.status(500).json(toErrorResponse('Failed to fetch channels'));
    }
  });

  router.get('/api/admin/discord/roles', adminAuthMiddleware, async (req, res) => {
    try {
      const client = getClient?.();
      if (!client) {
        return res.status(500).json(toErrorResponse('Bot not initialized'));
      }

      const guild = req.guild || await fetchGuildById(req.guildId);
      const roles = await guild.roles.fetch();

      const roleList = roles
        .filter(role => role.name !== '@everyone')
        .map(role => ({
          id: role.id,
          name: role.name,
          color: role.hexColor
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return res.json(toSuccessResponse({ roles: roleList }));
    } catch (routeError) {
      logger.error('Error fetching Discord roles:', routeError);
      return res.status(500).json(toErrorResponse('Failed to fetch roles'));
    }
  });

  router.get('/api/admin/users', adminAuthMiddleware, async (req, res) => {
    if (!ensureVerificationModule(req, res)) return;
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const totalCount = db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM user_tenant_memberships um
        INNER JOIN users u ON u.discord_id = um.discord_id
        WHERE um.guild_id = ?
      `).get(req.guildId).cnt;
      const users = db.prepare(`
        SELECT
          u.*,
          COUNT(w.id) as wallet_count,
          um.last_verified_at as last_verified_at,
          um.updated_at as tenant_updated_at
        FROM user_tenant_memberships um
        INNER JOIN users u ON u.discord_id = um.discord_id
        LEFT JOIN wallets w ON u.discord_id = w.discord_id
        WHERE um.guild_id = ?
        GROUP BY um.discord_id
        ORDER BY COALESCE(u.total_nfts, 0) DESC, COALESCE(um.updated_at, um.created_at) DESC
        LIMIT ? OFFSET ?
      `).all(req.guildId, limit, offset);

      const mappings = db.prepare('SELECT * FROM role_vp_mappings').all();
      const client = getClient?.();
      if (mappings.length > 0 && client) {
        const guild = req.guild || client.guilds.cache.get(req.guildId) || await fetchGuildById(req.guildId);
        for (const user of users) {
          try {
            const member = guild ? await guild.members.fetch(user.discord_id).catch(() => null) : null;
            user.voting_power = roleService.getUserVotingPower(user.discord_id, member);
          } catch (_ignored) {
            // Keep DB value on error.
          }
        }
      }

      return res.json(toSuccessResponse({ users, total: totalCount, limit, offset }));
    } catch (routeError) {
      logger.error('Error fetching users:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/users/:discordId', adminAuthMiddleware, (req, res) => {
    if (!ensureVerificationModule(req, res)) return;
    try {
      const { discordId } = req.params;
      const membership = db.prepare(`
        SELECT *
        FROM user_tenant_memberships
        WHERE discord_id = ? AND guild_id = ?
      `).get(discordId, req.guildId);
      if (!membership) {
        return res.status(404).json(toErrorResponse('User not found in this tenant', 'NOT_FOUND'));
      }
      const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
      const wallets = db.prepare('SELECT * FROM wallets WHERE discord_id = ?').all(discordId);
      const proposalsGuildScoped = hasProposalsGuildColumn();
      const proposals = (proposalsGuildScoped && req.guildId)
        ? db.prepare('SELECT * FROM proposals WHERE creator_id = ? AND guild_id = ?').all(discordId, req.guildId)
        : (tenantService.isMultitenantEnabled() ? [] : db.prepare('SELECT * FROM proposals WHERE creator_id = ?').all(discordId));
      const votes = (proposalsGuildScoped && req.guildId)
        ? db.prepare(`
          SELECT v.*
          FROM votes v
          INNER JOIN proposals p ON p.proposal_id = v.proposal_id
          WHERE v.voter_id = ? AND p.guild_id = ?
        `).all(discordId, req.guildId)
        : (tenantService.isMultitenantEnabled() ? [] : db.prepare('SELECT * FROM votes WHERE voter_id = ?').all(discordId));
      const missions = (missionService.hasMissionsGuildColumn?.() === true)
        ? db.prepare(`
          SELECT m.*, mp.assigned_nft_name, mp.points_awarded
          FROM missions m
          JOIN mission_participants mp ON m.mission_id = mp.mission_id
          WHERE mp.participant_id = ? AND m.guild_id = ?
        `).all(discordId, req.guildId)
        : db.prepare(`
          SELECT m.*, mp.assigned_nft_name, mp.points_awarded
          FROM missions m
          JOIN mission_participants mp ON m.mission_id = mp.mission_id
          WHERE mp.participant_id = ?
        `).all(discordId);

      return res.json(toSuccessResponse({
        user,
        wallets,
        proposals,
        votes,
        missions,
        membership,
      }));
    } catch (routeError) {
      logger.error('Error fetching user details:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/users/:discordId', adminAuthMiddleware, (req, res) => {
    if (!ensureVerificationModule(req, res)) return;
    try {
      const { discordId } = req.params;
      const membership = db.prepare(`
        SELECT *
        FROM user_tenant_memberships
        WHERE discord_id = ? AND guild_id = ?
      `).get(discordId, req.guildId);
      if (!membership) {
        return res.status(404).json(toErrorResponse('User not found in this tenant', 'NOT_FOUND'));
      }
      const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
      const globalScopeRequested = req.isSuperadmin && String(req.query.scope || '').trim().toLowerCase() === 'global';

      if (globalScopeRequested) {
        if (!user) {
          return res.status(404).json(toErrorResponse('User not found', 'NOT_FOUND'));
        }
        db.prepare('DELETE FROM wallets WHERE discord_id = ?').run(discordId);
        db.prepare('DELETE FROM votes WHERE voter_id = ?').run(discordId);
        db.prepare('DELETE FROM user_tenant_memberships WHERE discord_id = ?').run(discordId);
        db.prepare('DELETE FROM users WHERE discord_id = ?').run(discordId);
        logger.log(`Superadmin removed user ${discordId} (${user.username}) globally`);
        return res.json(toSuccessResponse({ message: 'User removed globally' }));
      }

      db.prepare('DELETE FROM user_tenant_memberships WHERE discord_id = ? AND guild_id = ?').run(discordId, req.guildId);
      if (hasProposalsGuildColumn() && req.guildId) {
        db.prepare(`
          DELETE FROM votes
          WHERE voter_id = ?
            AND proposal_id IN (
              SELECT proposal_id
              FROM proposals
              WHERE guild_id = ?
            )
        `).run(discordId, req.guildId);
      }
      if (missionService.hasMissionsGuildColumn?.() === true) {
        db.prepare(`
          DELETE FROM mission_participants
          WHERE participant_id = ?
            AND mission_id IN (
              SELECT mission_id
              FROM missions
              WHERE guild_id = ?
            )
        `).run(discordId, req.guildId);
      }

      logger.log(`Admin removed user ${discordId} (${user?.username || 'unknown'}) from guild ${req.guildId} verification scope`);
      return res.json(toSuccessResponse({ message: 'User removed from this server' }));
    } catch (routeError) {
      logger.error('Error removing user:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createAdminUsersDirectoryRouter;
