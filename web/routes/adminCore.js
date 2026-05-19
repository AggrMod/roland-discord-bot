const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminCoreRouter({
  adminAuthMiddleware,
  ensureBrandingModule,
  tenantService,
  fetchGuildById,
  guildIconUrl,
  billingService,
  logger,
  normalizeWebhookValue,
  getActivityWebhookSecret,
  getClient = null,
  getGuildBotProfileSnapshot = async () => null,
  applyGuildBotProfileBranding = async () => ({ success: false, skipped: true }),
  db,
  proposalService,
  heistService,
  walletService,
}) {
  const router = express.Router();

  router.get('/env-status', adminAuthMiddleware, (_req, res) => {
    res.json(toSuccessResponse({
      mockMode: process.env.MOCK_MODE === 'true',
      heliusConfigured: !!process.env.HELIUS_API_KEY,
      solanaRpc: process.env.SOLANA_RPC_URL || 'default',
      nodeEnv: process.env.NODE_ENV || 'development',
      webhookSecretConfigured: !!getActivityWebhookSecret(),
    }));
  });

  router.get('/dashboard', adminAuthMiddleware, async (req, res) => {
    try {
      const guildId = req.guildId;
      const client = typeof getClient === 'function' ? getClient() : null;
      const guild = req.guild || await fetchGuildById(guildId);
      const safeGet = (sql, params = [], fallback = {}) => {
        try {
          return db.prepare(sql).get(...params) || fallback;
        } catch (_error) {
          return fallback;
        }
      };
      const safeAll = (sql, params = [], fallback = []) => {
        try {
          return db.prepare(sql).all(...params);
        } catch (_error) {
          return fallback;
        }
      };
      
      // 1. Server Metrics
      const memberCount = guild?.memberCount || 0;
      const onlineCount = guild?.approximatePresenceCount || 0; 
      const verifiedWalletsCount = Number(safeGet('SELECT COUNT(DISTINCT wallet_address) AS cnt FROM wallets', [], { cnt: 0 })?.cnt || 0);
      
      // 2. Module Status
      const moduleState = tenantService.getTenantContext(guildId)?.modules || {};
      const modules = {
        verification: { enabled: !!moduleState.verification, stats: { verifiedUsers: Number(safeGet('SELECT COUNT(DISTINCT discord_id) AS cnt FROM wallets', [], { cnt: 0 })?.cnt || 0) } },
        governance: { enabled: !!moduleState.governance, stats: { activeProposals: Number(safeGet('SELECT COUNT(*) AS cnt FROM proposals WHERE guild_id = ? AND status IN ("supporting", "voting")', [guildId], { cnt: 0 })?.cnt || 0) } },
        missions: { enabled: !!moduleState.heist, stats: { activeMissions: Number(safeGet('SELECT COUNT(*) AS cnt FROM heist_missions WHERE guild_id = ? AND status IN ("recruiting", "active")', [guildId], { cnt: 0 })?.cnt || 0) } },
        welcome: { enabled: !!moduleState.welcome, stats: { configured: Number(safeGet('SELECT COUNT(*) AS cnt FROM tenant_welcome_settings WHERE guild_id = ? AND enabled = 1', [guildId], { cnt: 0 })?.cnt || 0) } },
        tracking: { enabled: !!(moduleState.nfttracker || moduleState.tokentracker), stats: { actions: 0 } }
      };

      // 3. Active Governance Proposals (Top 3)
      const activeProposals = safeAll(`
        SELECT proposal_id, title, status, category, end_time, quorum_required, 
               (SELECT SUM(voting_power) FROM votes WHERE proposal_id = proposals.proposal_id AND vote_choice = 'yes') as yes_votes,
               (SELECT SUM(voting_power) FROM votes WHERE proposal_id = proposals.proposal_id AND vote_choice = 'no') as no_votes,
               (SELECT SUM(voting_power) FROM votes WHERE proposal_id = proposals.proposal_id AND vote_choice = 'abstain') as abstain_votes,
               total_vp
        FROM proposals 
        WHERE guild_id = ? AND status IN ("supporting", "voting")
        ORDER BY created_at DESC LIMIT 3
      `, [guildId], []).map(p => ({
        id: p.proposal_id,
        title: p.title,
        status: p.status,
        category: p.category,
        endTime: p.end_time,
        quorumRequired: p.quorum_required,
        totalVP: p.total_vp || 0,
        votes: {
          yes: p.yes_votes || 0,
          no: p.no_votes || 0,
          abstain: p.abstain_votes || 0
        }
      }));

      // 4. Active Missions (Top 3)
      const activeMissions = safeAll(`
        SELECT mission_id, title, status, mode, filled_slots, total_slots, ends_at
        FROM heist_missions
        WHERE guild_id = ? AND status IN ("recruiting", "active")
        ORDER BY created_at DESC LIMIT 3
      `, [guildId], []).map(m => ({
        id: m.mission_id,
        title: m.title,
        status: m.status,
        mode: m.mode,
        filledSlots: m.filled_slots,
        totalSlots: m.total_slots,
        endsAt: m.ends_at
      }));
      
      res.json(toSuccessResponse({
        server: {
          id: guildId,
          name: guild?.name || 'Unknown Server',
          icon: guildIconUrl(guild),
          metrics: {
            members: memberCount,
            online: onlineCount,
            guilds: 1, 
            wallets: verifiedWalletsCount
          }
        },
        modules,
        activeProposals,
        activeMissions
      }));
    } catch (error) {
      logger.error('Error fetching dashboard data:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/branding', adminAuthMiddleware, async (req, res) => {
    if (!ensureBrandingModule(req, res)) return;
    try {
      const client = typeof getClient === 'function' ? getClient() : null;
      const tenant = tenantService.getTenantContext(req.guildId);
      const guild = req.guild || await fetchGuildById(req.guildId);
      const fallbackLogo = guildIconUrl(guild);
      const serverProfile = await getGuildBotProfileSnapshot({ client, guildId: req.guildId });
      const branding = {
        ...(tenant?.branding || {}),
        logo_url: (tenant?.branding?.logo_url || tenant?.branding?.icon_url || fallbackLogo || null),
        icon_url: (tenant?.branding?.icon_url || tenant?.branding?.logo_url || fallbackLogo || null),
      };
      res.json(toSuccessResponse({
        branding,
        serverProfile: serverProfile || null,
        serverProfileCapabilities: {
          nick: true,
          avatar: true,
          banner: true,
          bio: true,
        },
      }));
    } catch (error) {
      logger.error('Error fetching admin branding:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/branding', adminAuthMiddleware, async (req, res) => {
    if (!ensureBrandingModule(req, res)) return;
    try {
      const client = typeof getClient === 'function' ? getClient() : null;
      const ALLOWED_BRANDING_FIELDS = ['bot_display_name', 'bot_server_avatar_url', 'bot_server_banner_url', 'bot_server_bio', 'brand_emoji', 'brand_color', 'logo_url', 'support_url', 'footer_text', 'display_name', 'primary_color', 'secondary_color', 'icon_url', 'ticketing_color', 'selfserve_color', 'nfttracker_color', 'ticket_panel_title', 'ticket_panel_description', 'selfserve_panel_title', 'selfserve_panel_description', 'nfttracker_panel_title', 'nfttracker_panel_description', 'missions_label'];
      const patch = {};
      for (const key of ALLOWED_BRANDING_FIELDS) {
        if (req.body[key] !== undefined) patch[key] = req.body[key];
      }
      const result = tenantService.updateTenantBranding(req.guildId, patch, req.session?.discordUser?.id || 'unknown');
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update branding', 'VALIDATION_ERROR', null, result));
      }

      const profileResult = await applyGuildBotProfileBranding({
        client,
        guildId: req.guildId,
        brandingPatch: patch,
        logger,
        reason: `Tenant branding update by ${req.session?.discordUser?.id || 'unknown'}`,
      });

      res.json(toSuccessResponse({
        branding: result.tenant?.branding || null,
        serverProfileApplied: !!profileResult?.success,
        serverProfileWarning: profileResult && !profileResult.success && !profileResult.skipped
          ? (profileResult.message || 'Could not apply server profile changes on Discord')
          : null,
      }));
    } catch (error) {
      logger.error('Error updating admin branding:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/plan', adminAuthMiddleware, (req, res) => {
    try {
      const tenantContext = tenantService.getTenantContext(req.guildId);
      const snapshot = billingService.getSubscriptionSnapshot(req.guildId);
      const plan = tenantContext?.planKey || snapshot?.plan || 'starter';

      res.json(toSuccessResponse({
        plan,
        planLabel: snapshot?.planLabel || tenantContext?.planLabel || plan,
        status: snapshot?.status || tenantContext?.status || 'active',
        expiresAt: snapshot?.expiresAt || null,
        billing: snapshot?.billing || null,
        renewal: snapshot?.renewal || { options: [] },
      }));
    } catch (error) {
      logger.error('Error fetching admin plan:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/billing/options', adminAuthMiddleware, (req, res) => {
    try {
      const tenantContext = tenantService.getTenantContext(req.guildId);
      const requestedPlan = normalizeWebhookValue(req.query.plan) || tenantContext?.planKey || 'starter';
      const requestedInterval = normalizeWebhookValue(req.query.interval) || tenantContext?.billing?.billingInterval || 'monthly';
      const options = billingService.getRenewalOptions({
        guildId: req.guildId,
        planKey: requestedPlan,
        interval: requestedInterval,
      });

      res.json(toSuccessResponse({
        plan: requestedPlan,
        interval: requestedInterval,
        options,
        supportUrl: billingService.getSupportUrl(req.guildId),
      }));
    } catch (error) {
      logger.error('Error fetching billing options:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createAdminCoreRouter;
