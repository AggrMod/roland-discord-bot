const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminGovernanceMissionsRouter({
  logger,
  db,
  adminAuthMiddleware,
  ensureGovernanceModule,
  ensureHeistModule,
  roleService,
  tenantService,
  hasProposalsGuildColumn,
  isProposalInGuildScope,
  proposalService,
  getProposalRow,
  countActiveGovernanceProposals,
  entitlementService,
  missionService,
  heistService,
  aiAssistantService,
  getClient,
}) {
  const router = express.Router();

  router.get('/api/admin/governance/vp-mappings', adminAuthMiddleware, (req, res) => {
    if (!ensureGovernanceModule(req, res)) return;
    try {
      const mappings = roleService.getRoleVPMappings(req.guildId, req.guild);
      return res.json(toSuccessResponse({ mappings }));
    } catch (routeError) {
      logger.error('Error fetching role VP mappings:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/governance/vp-mappings', adminAuthMiddleware, (req, res) => {
    if (!ensureGovernanceModule(req, res)) return;
    try {
      const roleId = String(req.body?.roleId || '').trim();
      const roleName = String(req.body?.roleName || '').trim();
      const votingPower = Number.parseInt(req.body?.votingPower, 10);

      if (!roleId || !/^\d{17,20}$/.test(roleId)) {
        return res.status(400).json(toErrorResponse('Valid roleId is required', 'VALIDATION_ERROR'));
      }
      if (!Number.isFinite(votingPower) || votingPower < 1 || votingPower > 1000) {
        return res.status(400).json(toErrorResponse('votingPower must be between 1 and 1000', 'VALIDATION_ERROR'));
      }

      const result = roleService.addRoleVPMapping(roleId, roleName || null, votingPower, req.guildId);
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to add mapping', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error adding role VP mapping:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/governance/vp-mappings/:roleId', adminAuthMiddleware, (req, res) => {
    if (!ensureGovernanceModule(req, res)) return;
    try {
      const roleId = String(req.params?.roleId || '').trim();
      if (!roleId || !/^\d{17,20}$/.test(roleId)) {
        return res.status(400).json(toErrorResponse('Valid roleId is required', 'VALIDATION_ERROR'));
      }

      const result = roleService.removeRoleVPMapping(roleId, req.guildId);
      if (!result?.success) {
        return res.status(404).json(toErrorResponse(result?.message || 'Mapping not found', 'NOT_FOUND', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error removing role VP mapping:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

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

  router.get('/api/admin/heist/config', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      if (!heistService) {
        return res.status(500).json(toErrorResponse('Heist service unavailable', 'CONFIG_ERROR'));
      }
      const config = heistService.getConfig(req.guildId || '');
      return res.json(toSuccessResponse({ config }));
    } catch (routeError) {
      logger.error('Error fetching heist config:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/heist/config', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      if (!heistService) {
        return res.status(500).json(toErrorResponse('Heist service unavailable', 'CONFIG_ERROR'));
      }
      const result = heistService.updateConfig(req.guildId || '', req.body || {});
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to update heist config', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error updating heist config:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/heist/ladder', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const ladder = heistService?.getLadder(req.guildId || '') || [];
      return res.json(toSuccessResponse({ ladder }));
    } catch (routeError) {
      logger.error('Error fetching heist ladder:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/heist/ladder', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const ladder = Array.isArray(req.body?.ladder) ? req.body.ladder : [];
      const result = heistService?.setLadder(req.guildId || '', ladder);
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to update ladder', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error updating heist ladder:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/heist/templates', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const includeDisabled = String(req.query.includeDisabled || '').trim() === '1';
      const templates = heistService?.listTemplates(req.guildId || '', { includeDisabled }) || [];
      return res.json(toSuccessResponse({ templates }));
    } catch (routeError) {
      logger.error('Error listing heist templates:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/heist/templates', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const result = heistService?.createTemplate(req.guildId || '', req.body || {});
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to create template', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error creating heist template:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/heist/templates/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const result = heistService?.updateTemplate(req.guildId || '', Number(req.params.id), req.body || {});
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to update template', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error updating heist template:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/heist/templates/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const result = heistService?.deleteTemplate(req.guildId || '', Number(req.params.id));
      if (!result?.success) {
        return res.status(404).json(toErrorResponse(result?.message || 'Template not found', 'NOT_FOUND', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error deleting heist template:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/heist/missions', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const statusesRaw = String(req.query.statuses || '').trim();
      const statuses = statusesRaw ? statusesRaw.split(',').map((item) => item.trim()).filter(Boolean) : null;
      const missions = heistService?.listMissions(req.guildId || '', {
        statuses,
        limit: Number(req.query.limit || 100),
        offset: Number(req.query.offset || 0),
      }) || [];
      return res.json(toSuccessResponse({ missions }));
    } catch (routeError) {
      logger.error('Error listing heist missions:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/heist/missions/spawn-now', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const templateId = Number(req.body?.templateId || req.body?.template_id || 0);
      if (!Number.isFinite(templateId) || templateId <= 0) {
        return res.status(400).json(toErrorResponse('Valid templateId is required', 'VALIDATION_ERROR'));
      }
      const result = heistService?.spawnMissionNow(req.guildId || '', templateId, { spawnSource: 'admin' });
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to spawn mission', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error spawning heist mission:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/heist/missions/:id/cancel', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const missionId = String(req.params.id || '').trim();
      const result = heistService?.cancelMission(req.guildId || '', missionId, req.session?.discordUser?.id || null);
      if (!result?.success) {
        const lowerMessage = String(result?.message || '').toLowerCase();
        const statusCode = lowerMessage.includes('not found') ? 404 : 400;
        return res.status(statusCode).json(toErrorResponse(result?.message || 'Failed to cancel mission', statusCode === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error cancelling heist mission:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/heist/missions/:id/resolve', adminAuthMiddleware, async (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const missionId = String(req.params.id || '').trim();
      const result = await heistService?.resolveMission(req.guildId || '', missionId);
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to resolve mission', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error resolving heist mission:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/heist/trait-bonuses', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const rules = heistService?.listTraitBonusRules(req.guildId || '') || [];
      return res.json(toSuccessResponse({ rules }));
    } catch (routeError) {
      logger.error('Error listing heist trait bonuses:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/heist/trait-bonuses', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const result = heistService?.upsertTraitBonusRule(req.guildId || '', req.body || null);
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to save rule', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error creating heist trait bonus rule:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/heist/trait-bonuses/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const result = heistService?.upsertTraitBonusRule(req.guildId || '', req.body || null, Number(req.params.id));
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to update rule', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error updating heist trait bonus rule:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/heist/trait-bonuses/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const result = heistService?.deleteTraitBonusRule(req.guildId || '', Number(req.params.id));
      if (!result?.success) {
        return res.status(404).json(toErrorResponse(result?.message || 'Rule not found', 'NOT_FOUND', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error deleting heist trait bonus rule:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/heist/vault/items', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const includeDisabled = String(req.query.includeDisabled || '').trim() === '1';
      const items = heistService?.listVaultItems(req.guildId || '', { includeDisabled }) || [];
      return res.json(toSuccessResponse({ items }));
    } catch (routeError) {
      logger.error('Error listing heist vault items:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/admin/heist/vault/items', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const result = heistService?.createVaultItem(req.guildId || '', req.body || {});
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to create vault item', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error creating heist vault item:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/heist/vault/items/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const result = heistService?.updateVaultItem(req.guildId || '', Number(req.params.id), req.body || {});
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to update vault item', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error updating heist vault item:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/admin/heist/vault/items/:id', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const result = heistService?.deleteVaultItem(req.guildId || '', Number(req.params.id));
      if (!result?.success) {
        return res.status(404).json(toErrorResponse(result?.message || 'Item not found', 'NOT_FOUND', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error deleting heist vault item:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/admin/heist/vault/redemptions', adminAuthMiddleware, (req, res) => {
    if (!ensureHeistModule(req, res)) return;
    try {
      const redemptions = heistService?.listVaultRedemptions(req.guildId || '', {
        limit: Number(req.query.limit || 100),
      }) || [];
      return res.json(toSuccessResponse({ redemptions }));
    } catch (routeError) {
      logger.error('Error listing heist redemptions:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createAdminGovernanceMissionsRouter;
