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
      const requestedRange = String(req.query.range || '7d').toLowerCase();
      const normalizedRange = ['24h', '7d', '30d'].includes(requestedRange) ? requestedRange : '7d';
      const sqliteDateModifier = normalizedRange === '24h'
        ? '-1 day'
        : (normalizedRange === '30d' ? '-30 day' : '-7 day');
      const sqliteDateWindowExpr = `date('now', '${sqliteDateModifier}')`;
      const sqliteDateTimeWindowExpr = `datetime('now', '${sqliteDateModifier}')`;
      const client = typeof getClient === 'function' ? getClient() : null;
      const guild = req.guild || await fetchGuildById(guildId);
      const botMember = guild?.members?.me || (guild?.members?.fetchMe ? await guild.members.fetchMe().catch(() => null) : null);
      const botPermissions = botMember?.permissions || null;
      const hasBotPermission = (permission) => {
        try {
          return !!botPermissions?.has?.(permission);
        } catch (_error) {
          return false;
        }
      };
      const requiredPermissionChecks = [
        {
          key: 'manage_guild',
          label: 'Manage Server',
          permission: 'ManageGuild',
          modules: ['Invite Tracker'],
          reason: 'Required to read and cache Discord invites for accurate invite tracking.',
        },
        {
          key: 'manage_roles',
          label: 'Manage Roles',
          permission: 'ManageRoles',
          modules: ['Verification', 'Self-Serve Roles', 'Welcome CAPTCHA'],
          reason: 'Required to assign and remove member roles.',
        },
        {
          key: 'send_messages',
          label: 'Send Messages',
          permission: 'SendMessages',
          modules: ['Welcome', 'Engagement', 'Ticketing', 'Trackers', 'Telegram Bridge'],
          reason: 'Required to post panels, alerts, task messages, bridge messages, and ticket responses.',
        },
        {
          key: 'embed_links',
          label: 'Embed Links',
          permission: 'EmbedLinks',
          modules: ['Welcome', 'Engagement', 'Governance', 'Trackers'],
          reason: 'Required to send rich Discord embeds.',
        },
        {
          key: 'manage_channels',
          label: 'Manage Channels',
          permission: 'ManageChannels',
          modules: ['Ticketing'],
          reason: 'Required to create and manage support ticket channels.',
        },
      ];
      const missingBotPermissions = botPermissions
        ? requiredPermissionChecks.filter((item) => !hasBotPermission(item.permission)).map(({ permission, ...item }) => item)
        : requiredPermissionChecks.map(({ permission, ...item }) => ({
            ...item,
            reason: `${item.reason} Bot permissions could not be read for this server.`,
          }));
      const permissionHealth = {
        ok: missingBotPermissions.length === 0,
        checked: !!botPermissions,
        botRoleName: botMember?.displayName || botMember?.user?.username || null,
        missing: missingBotPermissions,
      };
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
      const roleCount = guild?.roles?.cache?.size || 0;
      const verifiedWalletsCount = Number(safeGet(`
        SELECT COUNT(DISTINCT w.wallet_address) AS cnt
        FROM wallets w
        INNER JOIN user_tenant_memberships utm
          ON utm.discord_id = w.discord_id
        WHERE utm.guild_id = ?
      `, [guildId], { cnt: 0 })?.cnt || 0);
      
      // 2. Module Status
      const moduleState = tenantService.getTenantContext(guildId)?.modules || {};
      const modules = {
        verification: {
          enabled: !!moduleState.verification,
          stats: {
            verifiedUsers: Number(safeGet(`
              SELECT COUNT(DISTINCT w.discord_id) AS cnt
              FROM wallets w
              INNER JOIN user_tenant_memberships utm
                ON utm.discord_id = w.discord_id
              WHERE utm.guild_id = ?
            `, [guildId], { cnt: 0 })?.cnt || 0),
          },
        },
        governance: { enabled: !!moduleState.governance, stats: { activeProposals: Number(safeGet('SELECT COUNT(*) AS cnt FROM proposals WHERE guild_id = ? AND status IN ("supporting", "voting", "active")', [guildId], { cnt: 0 })?.cnt || 0) } },
        missions: { enabled: !!moduleState.heist, stats: { activeMissions: Number(safeGet('SELECT COUNT(*) AS cnt FROM heist_missions WHERE guild_id = ? AND status IN ("recruiting", "active")', [guildId], { cnt: 0 })?.cnt || 0) } },
        welcome: { enabled: !!moduleState.welcome, stats: { configured: Number(safeGet('SELECT COUNT(*) AS cnt FROM tenant_welcome_settings WHERE guild_id = ? AND enabled = 1', [guildId], { cnt: 0 })?.cnt || 0) } },
        tracking: {
          enabled: !!(moduleState.nfttracker || moduleState.tokentracker),
          stats: {
            actions: Number(
              (safeGet(`
                SELECT COUNT(*) AS cnt
                FROM nft_activity_events e
                WHERE datetime(COALESCE(e.event_time, e.created_at)) >= ${sqliteDateTimeWindowExpr}
                  AND EXISTS (
                    SELECT 1
                    FROM nft_tracked_collections c
                    WHERE c.guild_id = ?
                      AND c.enabled = 1
                      AND (
                        LOWER(COALESCE(c.collection_address, '')) = LOWER(COALESCE(e.collection_key, ''))
                        OR LOWER(COALESCE(c.me_symbol, '')) = LOWER(COALESCE(e.collection_key, ''))
                      )
                  )
              `, [guildId], { cnt: 0 })?.cnt || 0)
              + (safeGet(`SELECT COUNT(*) AS cnt FROM tracked_token_events WHERE guild_id = ? AND datetime(COALESCE(event_time, created_at)) >= ${sqliteDateTimeWindowExpr}`, [guildId], { cnt: 0 })?.cnt || 0)
            ),
          },
        },
        telegrambridge: {
          enabled: !!moduleState.telegrambridge,
          stats: {
            syncs: Number(safeGet('SELECT COUNT(*) AS cnt FROM telegram_bridge_mappings WHERE guild_id = ? AND enabled = 1', [guildId], { cnt: 0 })?.cnt || 0),
          },
        }
      };

      const moduleAnalytics = {
        verification: {
          linkedWallets: verifiedWalletsCount,
          uniqueUsers: Number(safeGet(`
            SELECT COUNT(DISTINCT w.discord_id) AS cnt
            FROM wallets w
            INNER JOIN user_tenant_memberships utm
              ON utm.discord_id = w.discord_id
            WHERE utm.guild_id = ?
          `, [guildId], { cnt: 0 })?.cnt || 0),
        },
        governance: {
          activeProposals: Number(safeGet('SELECT COUNT(*) AS cnt FROM proposals WHERE guild_id = ? AND status IN ("supporting", "voting", "active")', [guildId], { cnt: 0 })?.cnt || 0),
          totalVotesCast: Number(safeGet('SELECT COUNT(*) AS cnt FROM votes v JOIN proposals p ON p.proposal_id = v.proposal_id WHERE p.guild_id = ?', [guildId], { cnt: 0 })?.cnt || 0),
        },
        missions: {
          activeMissions: Number(safeGet('SELECT COUNT(*) AS cnt FROM heist_missions WHERE guild_id = ? AND status IN ("recruiting", "active")', [guildId], { cnt: 0 })?.cnt || 0),
          participantsActive: Number(safeGet('SELECT COALESCE(SUM(filled_slots), 0) AS cnt FROM heist_missions WHERE guild_id = ? AND status IN ("recruiting", "active")', [guildId], { cnt: 0 })?.cnt || 0),
        },
        welcome: {
          joins: Number(safeGet(`SELECT COALESCE(SUM(joins_total), 0) AS cnt FROM tenant_welcome_analytics_daily WHERE guild_id = ? AND day_key >= ${sqliteDateWindowExpr}`, [guildId], { cnt: 0 })?.cnt || 0),
          welcomesSent: Number(safeGet(`SELECT COALESCE(SUM(welcome_sent), 0) AS cnt FROM tenant_welcome_analytics_daily WHERE guild_id = ? AND day_key >= ${sqliteDateWindowExpr}`, [guildId], { cnt: 0 })?.cnt || 0),
        },
        invites: {
          joins: Number(safeGet(`SELECT COUNT(*) AS cnt FROM invite_events WHERE guild_id = ? AND datetime(joined_at) >= ${sqliteDateTimeWindowExpr}`, [guildId], { cnt: 0 })?.cnt || 0),
        },
        nfttracker: {
          events: Number(safeGet(`
            SELECT COUNT(*) AS cnt
            FROM nft_activity_events e
            WHERE datetime(COALESCE(e.event_time, e.created_at)) >= ${sqliteDateTimeWindowExpr}
              AND EXISTS (
                SELECT 1
                FROM nft_tracked_collections c
                WHERE c.guild_id = ?
                  AND c.enabled = 1
                  AND (
                    LOWER(COALESCE(c.collection_address, '')) = LOWER(COALESCE(e.collection_key, ''))
                    OR LOWER(COALESCE(c.me_symbol, '')) = LOWER(COALESCE(e.collection_key, ''))
                  )
              )
          `, [guildId], { cnt: 0 })?.cnt || 0),
          trackedCollections: Number(safeGet('SELECT COUNT(*) AS cnt FROM nft_tracked_collections WHERE guild_id = ? AND enabled = 1', [guildId], { cnt: 0 })?.cnt || 0),
        },
        tokentracker: {
          activeRules: Number(safeGet('SELECT COUNT(*) AS cnt FROM token_role_rules WHERE guild_id = ? AND enabled = 1', [guildId], { cnt: 0 })?.cnt || 0),
        },
        engagement: {
          points: Number(safeGet(`SELECT COALESCE(SUM(points), 0) AS cnt FROM points_ledger WHERE guild_id = ? AND datetime(created_at) >= ${sqliteDateTimeWindowExpr}`, [guildId], { cnt: 0 })?.cnt || 0),
          activeUsers: Number(safeGet(`SELECT COUNT(DISTINCT user_id) AS cnt FROM points_ledger WHERE guild_id = ? AND datetime(created_at) >= ${sqliteDateTimeWindowExpr}`, [guildId], { cnt: 0 })?.cnt || 0),
        },
        ticketing: {
          openTickets: Number(safeGet('SELECT COUNT(*) AS cnt FROM tickets WHERE guild_id = ? AND status = "open"', [guildId], { cnt: 0 })?.cnt || 0),
        },
        selfserveroles: {
          activePanels: Number(safeGet('SELECT COUNT(*) AS cnt FROM role_panels WHERE guild_id = ? AND enabled = 1', [guildId], { cnt: 0 })?.cnt || 0),
        },
        vault: {
          activeItems: Number(safeGet('SELECT COUNT(*) AS cnt FROM heist_vault_items WHERE guild_id = ? AND enabled = 1', [guildId], { cnt: 0 })?.cnt || 0),
          pendingClaims: Number(safeGet('SELECT COUNT(*) AS cnt FROM heist_vault_redemptions WHERE guild_id = ? AND fulfillment_status = "pending"', [guildId], { cnt: 0 })?.cnt || 0),
        },
        telegrambridge: {
          enabled: !!moduleState.telegrambridge,
          activeSyncs: Number(safeGet('SELECT COUNT(*) AS cnt FROM telegram_bridge_mappings WHERE guild_id = ? AND enabled = 1', [guildId], { cnt: 0 })?.cnt || 0),
          failures: Number(safeGet(`SELECT COUNT(*) AS cnt FROM telegram_bridge_audit WHERE guild_id = ? AND status = "failed" AND datetime(created_at) >= ${sqliteDateTimeWindowExpr}`, [guildId], { cnt: 0 })?.cnt || 0),
        },
      };

      const walletPreview = safeAll(`
        SELECT w.wallet_address, w.primary_wallet, w.is_favorite, w.created_at, u.username, u.total_nfts
        FROM wallets w
        INNER JOIN user_tenant_memberships utm ON utm.discord_id = w.discord_id
        LEFT JOIN users u ON u.discord_id = w.discord_id
        WHERE utm.guild_id = ?
        ORDER BY w.primary_wallet DESC, w.is_favorite DESC, w.created_at DESC
        LIMIT 3
      `, [guildId], []).map((row) => ({
        walletAddress: row.wallet_address,
        label: row.primary_wallet ? 'Primary' : (row.is_favorite ? 'Favorite' : 'Linked'),
        username: row.username || null,
        totalNfts: Number(row.total_nfts || 0),
      }));

      // 3. Active Governance Proposals (Top 3)
      const activeProposals = safeAll(`
        SELECT proposal_id, title, status, category, end_time, quorum_required, 
               (SELECT SUM(voting_power) FROM votes WHERE proposal_id = proposals.proposal_id AND vote_choice = 'yes') as yes_votes,
               (SELECT SUM(voting_power) FROM votes WHERE proposal_id = proposals.proposal_id AND vote_choice = 'no') as no_votes,
               (SELECT SUM(voting_power) FROM votes WHERE proposal_id = proposals.proposal_id AND vote_choice = 'abstain') as abstain_votes,
               total_vp
        FROM proposals 
        WHERE guild_id = ? AND status IN ("supporting", "voting", "active")
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
            roles: roleCount,
            guilds: 1,
            wallets: verifiedWalletsCount
          }
        },
        modules,
        analyticsRange: normalizedRange,
        moduleAnalytics,
        permissionHealth,
        walletPreview,
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
        paymentDetails: billingService.getPaymentDetails(req.guildId),
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
        paymentDetails: billingService.getPaymentDetails(req.guildId),
        supportUrl: billingService.getSupportUrl(req.guildId),
      }));
    } catch (error) {
      logger.error('Error fetching billing options:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/billing/crypto-receipts', adminAuthMiddleware, (req, res) => {
    try {
      const result = billingService.listCryptoReceiptsByGuild(req.guildId, {
        limit: Number(req.query.limit || 20),
        status: req.query.status,
      });
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to load crypto receipts', 'VALIDATION_ERROR'));
      }
      res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error loading billing crypto receipts:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/billing/crypto-quote', adminAuthMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await billingService.createCryptoQuote(req.guildId, {
        planKey: body.planKey,
        billingInterval: body.billingInterval,
        tokenSymbol: body.tokenSymbol,
      });
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to create quote', 'VALIDATION_ERROR'));
      }
      res.json(toSuccessResponse(result));
    } catch (error) {
      logger.error('Error creating billing crypto quote:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/billing/crypto-receipts', adminAuthMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      const quoteToken = typeof body.quoteToken === 'string' ? body.quoteToken.trim() : '';
      if (!quoteToken) {
        return res.status(400).json(toErrorResponse('Prepare a payment quote before submitting a transaction signature.', 'VALIDATION_ERROR'));
      }
      const result = billingService.submitCryptoReceipt(req.guildId, {
        txSignature: body.txSignature,
        amount: body.amount,
        tokenSymbol: body.tokenSymbol,
        senderWallet: body.senderWallet,
        planKey: body.planKey,
        billingInterval: body.billingInterval,
        quoteToken,
      });
      if (!result.success) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to submit payment receipt', 'VALIDATION_ERROR'));
      }
      let autoProcess = null;
      if (quoteToken) {
        const submitted = billingService.listCryptoReceiptsByGuild(req.guildId, { limit: 25 });
        const submittedRows = Array.isArray(submitted?.receipts) ? submitted.receipts : [];
        const txSignature = String(body.txSignature || '').trim();
        const matched = submittedRows.find((row) => String(row?.txSignature || '').trim() === txSignature)
          || submittedRows[0];
        if (matched?.id) {
          autoProcess = await billingService.autoVerifyAndApplyReceipt(matched.id, 'tenant-self-serve-billing');
        }
      }
      res.json(toSuccessResponse({
        ...result,
        autoProcess,
      }));
    } catch (error) {
      logger.error('Error submitting billing crypto receipt:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/activity', adminAuthMiddleware, async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
      const logs = tenantService.getTenantAuditLogs(req.guildId, limit);
      res.json(toSuccessResponse({
        activity: (logs || []).map((log) => ({
          id: log.id,
          guildId: log.guild_id,
          actorId: log.actor_id || 'unknown',
          action: log.action || 'unknown',
          beforeJson: log.before_json || null,
          afterJson: log.after_json || null,
          createdAt: log.created_at || null,
        })),
      }));
    } catch (error) {
      logger.error('Error fetching admin activity feed:', error);
      res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createAdminCoreRouter;
