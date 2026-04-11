const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminGovernanceMissionsRouter({
  logger,
  db,
  adminAuthMiddleware,
  ensureGovernanceModule,
  ensureHeistModule,
  tenantService,
  hasProposalsGuildColumn,
  isProposalInGuildScope,
  proposalService,
  getProposalRow,
  countActiveGovernanceProposals,
  entitlementService,
  missionService,
  aiAssistantService,
  getClient,
}) {
  const router = express.Router();

  router.get('/api/admin/proposals', adminAuthMiddleware, (req, res) => {
    if (!ensureGovernanceModule(req, res)) return;
    try {
      if (tenantService.isMultitenantEnabled() && !hasProposalsGuildColumn()) {
        return res.status(500).json(toErrorResponse(
          'Governance schema is not tenant-scoped. Run database migrations to continue.',
          'SCHEMA_NOT_SCOPED'
        ));
      }
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const hasGuildScope = hasProposalsGuildColumn() && !!req.guildId;
      const totalCount = hasGuildScope
        ? db.prepare('SELECT COUNT(*) as cnt FROM proposals WHERE guild_id = ?').get(req.guildId).cnt
        : db.prepare('SELECT COUNT(*) as cnt FROM proposals').get().cnt;
      const proposals = hasGuildScope
        ? db.prepare('SELECT * FROM proposals WHERE guild_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(req.guildId, limit, offset)
        : db.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
      return res.json(toSuccessResponse({ proposals, total: totalCount, limit, offset }));
    } catch (routeError) {
      logger.error('Error fetching proposals:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/proposals/:id/close', adminAuthMiddleware, async (req, res) => {
    if (!ensureGovernanceModule(req, res)) return;
    try {
      const { id } = req.params;
      if (!isProposalInGuildScope(id, req.guildId)) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND'));
      }
      const result = await proposalService.closeVote(id);
      if (result?.success === false) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to close proposal', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result || { message: 'Proposal closed' }));
    } catch (routeError) {
      logger.error('Error closing proposal:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/governance/proposals/:id/approve', adminAuthMiddleware, (req, res) => {
    if (!ensureGovernanceModule(req, res)) return;
    try {
      if (!isProposalInGuildScope(req.params.id, req.guildId)) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND'));
      }
      const proposal = getProposalRow(req.params.id);
      const effectiveGuildId = String(proposal?.guild_id || req.guildId || '').trim();
      const activeCount = countActiveGovernanceProposals(effectiveGuildId);
      const governanceLimit = entitlementService.enforceLimit({
        guildId: effectiveGuildId,
        moduleKey: 'governance',
        limitKey: 'max_active_proposals',
        currentCount: activeCount,
        incrementBy: 1,
        itemLabel: 'active proposals',
      });

      if (!governanceLimit.success) {
        return res.status(400).json(toErrorResponse(governanceLimit.message, 'LIMIT_EXCEEDED', {
          code: 'limit_exceeded',
          limit: governanceLimit.limit,
          used: governanceLimit.used,
        }));
      }

      const result = proposalService.approveProposal(req.params.id, req.session.discordUser.id);
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to approve proposal', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error approving proposal:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/governance/proposals/:id/hold', adminAuthMiddleware, (req, res) => {
    if (!ensureGovernanceModule(req, res)) return;
    try {
      if (!isProposalInGuildScope(req.params.id, req.guildId)) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND'));
      }
      const { reason } = req.body;
      const result = proposalService.holdProposal(req.params.id, req.session.discordUser.id, reason);
      if (result?.success === false) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to hold proposal', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result || { message: 'Proposal updated' }));
    } catch (routeError) {
      logger.error('Error holding proposal:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/governance/proposals/:id/promote', adminAuthMiddleware, async (req, res) => {
    if (!ensureGovernanceModule(req, res)) return;
    try {
      if (!isProposalInGuildScope(req.params.id, req.guildId)) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND'));
      }
      const result = await proposalService.promoteToVoting(req.params.id, req.session.discordUser.id);
      if (result?.success === false) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to promote proposal', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result || { message: 'Proposal promoted' }));
    } catch (routeError) {
      logger.error('Error promoting proposal:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/governance/proposals/:id/conclude', adminAuthMiddleware, async (req, res) => {
    if (!ensureGovernanceModule(req, res)) return;
    try {
      if (!isProposalInGuildScope(req.params.id, req.guildId)) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND'));
      }
      const result = await proposalService.concludeProposal(req.params.id);
      if (result?.success === false) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to conclude proposal', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result || { message: 'Proposal concluded' }));
    } catch (routeError) {
      logger.error('Error concluding proposal:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/governance/proposals/:id/pause', adminAuthMiddleware, (req, res) => {
    if (!ensureGovernanceModule(req, res)) return;
    try {
      if (!isProposalInGuildScope(req.params.id, req.guildId)) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND'));
      }
      const result = proposalService.emergencyPause(req.params.id, req.session.discordUser.id);
      if (result?.success === false) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to pause proposal', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result || { message: 'Proposal paused' }));
    } catch (routeError) {
      logger.error('Error pausing proposal:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/missions', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const hasGuildColumn = missionService.hasMissionsGuildColumn?.() === true;
      if (tenantService.isMultitenantEnabled() && !hasGuildColumn) {
        return res.status(500).json(toErrorResponse(
          'Missions schema is not tenant-scoped. Run database migrations to continue.',
          'SCHEMA_NOT_SCOPED'
        ));
      }
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const totalCount = hasGuildColumn
        ? db.prepare('SELECT COUNT(*) as cnt FROM missions WHERE guild_id = ?').get(req.guildId).cnt
        : db.prepare('SELECT COUNT(*) as cnt FROM missions').get().cnt;
      const missions = hasGuildColumn
        ? db.prepare('SELECT * FROM missions WHERE guild_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(req.guildId, limit, offset)
        : db.prepare('SELECT * FROM missions ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
      const missionsWithParticipants = missions.map(m => {
        const participants = db.prepare('SELECT * FROM mission_participants WHERE mission_id = ?').all(m.mission_id);
        return { ...m, participants };
      });

      return res.json(toSuccessResponse({ missions: missionsWithParticipants, total: totalCount, limit, offset }));
    } catch (routeError) {
      logger.error('Error fetching missions:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/missions/create', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      if (tenantService.isMultitenantEnabled() && missionService.hasMissionsGuildColumn?.() !== true) {
        return res.status(500).json(toErrorResponse(
          'Missions schema is not tenant-scoped. Run database migrations to continue.',
          'SCHEMA_NOT_SCOPED'
        ));
      }
      const { title, description, requiredRoles, minTier, totalSlots, rewardPoints } = req.body;

      if (!title || !description || !totalSlots) {
        return res.status(400).json(toErrorResponse('Missing required fields', 'VALIDATION_ERROR'));
      }

      const result = missionService.createMission(
        title,
        description,
        requiredRoles || [],
        minTier || 'Associate',
        totalSlots,
        rewardPoints || 0,
        req.guildId || ''
      );
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to create mission', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error creating mission:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/missions/:id/start', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const { id } = req.params;
      const hasGuildColumn = missionService.hasMissionsGuildColumn?.() === true;
      if (tenantService.isMultitenantEnabled() && !hasGuildColumn) {
        return res.status(500).json(toErrorResponse(
          'Missions schema is not tenant-scoped. Run database migrations to continue.',
          'SCHEMA_NOT_SCOPED'
        ));
      }
      const updateResult = hasGuildColumn
        ? db.prepare('UPDATE missions SET status = ?, start_time = CURRENT_TIMESTAMP WHERE mission_id = ? AND guild_id = ?').run('active', id, req.guildId)
        : db.prepare('UPDATE missions SET status = ?, start_time = CURRENT_TIMESTAMP WHERE mission_id = ?').run('active', id);
      if (!updateResult.changes) {
        return res.status(404).json(toErrorResponse('Mission not found', 'NOT_FOUND'));
      }

      logger.log(`Mission ${id} started by admin`);
      return res.json(toSuccessResponse({ message: 'Mission started' }));
    } catch (routeError) {
      logger.error('Error starting mission:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/missions/:id/complete', adminAuthMiddleware, async (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const { id } = req.params;
      const hasGuildColumn = missionService.hasMissionsGuildColumn?.() === true;
      if (tenantService.isMultitenantEnabled() && !hasGuildColumn) {
        return res.status(500).json(toErrorResponse(
          'Missions schema is not tenant-scoped. Run database migrations to continue.',
          'SCHEMA_NOT_SCOPED'
        ));
      }
      const mission = hasGuildColumn
        ? db.prepare('SELECT * FROM missions WHERE mission_id = ? AND guild_id = ?').get(id, req.guildId)
        : db.prepare('SELECT * FROM missions WHERE mission_id = ?').get(id);

      if (!mission) {
        return res.status(404).json(toErrorResponse('Mission not found', 'NOT_FOUND'));
      }

      db.prepare('UPDATE mission_participants SET points_awarded = ? WHERE mission_id = ?').run(mission.reward_points, id);
      if (hasGuildColumn) {
        db.prepare('UPDATE missions SET status = ? WHERE mission_id = ? AND guild_id = ?').run('completed', id, req.guildId);
      } else {
        db.prepare('UPDATE missions SET status = ? WHERE mission_id = ?').run('completed', id);
      }

      logger.log(`Mission ${id} completed, ${mission.reward_points} points awarded to participants`);

      // Generate AI Recap if possible
      try {
        if (aiAssistantService) {
          const settingsManager = require('../../config/settings');
          const settings = settingsManager.getSettings();
          const recap = await aiAssistantService.generateMissionRecap(req.guildId || '', mission);
          if (recap) {
            db.prepare('UPDATE missions SET ai_recap = ? WHERE mission_id = ?').run(recap, id);

            // Post to Discord if channel is configured
            const logChannelId = settings.missionLogChannelId || settings.governanceLogChannelId;
            const client = getClient?.();
            if (client && logChannelId) {
              const channel = await client.channels.fetch(logChannelId).catch(() => null);
              if (channel) {
                const { EmbedBuilder } = require('discord.js');
                const embed = new EmbedBuilder()
                  .setColor('#FFD700')
                  .setTitle(`🎬 Mission Debrief: ${mission.title}`)
                  .setDescription(recap)
                  .setTimestamp();
                
                await channel.send({ embeds: [embed] }).catch(err => logger.error('[mission-debrief] failed to send to discord:', err));
              }
            }
          }
        }
      } catch (e) {
        logger.error(`[ai-assistant] failed to generate mission recap for ${id}:`, e);
      }

      return res.json(toSuccessResponse({ message: 'Mission completed and points awarded' }));
    } catch (routeError) {
      logger.error('Error completing mission:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createAdminGovernanceMissionsRouter;
