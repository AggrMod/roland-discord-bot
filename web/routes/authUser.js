const express = require('express');
const crypto = require('crypto');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');
const xProviderService = require('../../services/xProviderService');

function createAuthUserRouter({
  logger,
  db,
  publicApiLimiter,
  resolveOAuthRedirectUri,
  getRequestedGuildId,
  tenantService,
  roleService,
  missionService,
  ticketService,
  walletService,
  proposalService,
  fetchGuildById,
  getDiscordUserGuilds,
  getBotGuildIds,
  hasDiscordAdminPermission,
  superadminService,
  normalizeGuildId,
  fallbackGuildId,
  getClient,
}) {
  const router = express.Router();
  let hasProposalsGuildColumnCached = null;

  const saveSession = (req) => new Promise((resolve) => {
    if (!req.session || typeof req.session.save !== 'function') {
      resolve();
      return;
    }
    req.session.save(() => resolve());
  });

  const hasProposalsGuildColumn = () => {
    if (typeof hasProposalsGuildColumnCached === 'boolean') return hasProposalsGuildColumnCached;
    try {
      const cols = db.prepare('PRAGMA table_info(proposals)').all();
      hasProposalsGuildColumnCached = cols.some(c => c && c.name === 'guild_id');
    } catch (_error) {
      hasProposalsGuildColumnCached = false;
    }
    return hasProposalsGuildColumnCached;
  };

  router.get('/api/features', publicApiLimiter, (_req, res) => {
    try {
      const heistEnabled = process.env.HEIST_ENABLED === 'true';
      return res.json(toSuccessResponse({ heistEnabled }));
    } catch (routeError) {
      logger.error('Error fetching feature flags:', routeError);
      return res.json(toSuccessResponse({ heistEnabled: false }));
    }
  });

  router.get('/auth/discord/login', (req, res) => {
    (async () => {
      const rawReturn = req.query.returnTo || '';
      if (rawReturn && rawReturn.startsWith('/') && !rawReturn.startsWith('//')) {
        req.session.returnTo = rawReturn;
      } else if (req.query.guild || req.query.section) {
        const qs = new URLSearchParams();
        if (req.query.guild) qs.set('guild', req.query.guild);
        if (req.query.section) qs.set('section', req.query.section);
        req.session.returnTo = '/?' + qs.toString();
      }

      const clientId = process.env.CLIENT_ID;
      const oauthRedirectUri = resolveOAuthRedirectUri(req);
      const oauthState = crypto.randomBytes(24).toString('hex');
      req.session.oauthRedirectUri = oauthRedirectUri;
      req.session.oauthState = oauthState;
      await saveSession(req);

      const redirectUri = encodeURIComponent(oauthRedirectUri);
      const scope = encodeURIComponent('identify guilds');
      const state = encodeURIComponent(oauthState);
      const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${state}`;
      return res.redirect(authUrl);
    })().catch((routeError) => {
      logger.error('OAuth login start error:', routeError);
      return res.redirect('/dashboard?error=oauth_login_start_failed');
    });
  });

  router.get('/auth/discord/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.redirect('/dashboard?error=no_code');
    const expectedState = String(req.session?.oauthState || '');
    if (!state || String(state) !== expectedState) {
      if (req.session?.oauthState) delete req.session.oauthState;
      return res.redirect('/dashboard?error=invalid_state');
    }

    try {
      const oauthRedirectUri = req.session?.oauthRedirectUri || resolveOAuthRedirectUri(req);
      if (req.session?.oauthRedirectUri) delete req.session.oauthRedirectUri;
      if (req.session?.oauthState) delete req.session.oauthState;

      const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.CLIENT_ID,
          client_secret: process.env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: oauthRedirectUri
        })
      });

      const tokenData = await tokenResponse.json();
      if (!tokenData.access_token) return res.redirect('/dashboard?error=no_token');

      const userResponse = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const userData = await userResponse.json();

      req.session.discordUser = {
        id: userData.id,
        username: userData.username,
        discriminator: userData.discriminator,
        avatar: userData.avatar,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || null,
        tokenExpiresAt: Date.now() + (Math.max(60, Number(tokenData.expires_in || 3600)) - 30) * 1000
      };

      const returnTo = req.session.returnTo;
      delete req.session.returnTo;
      await saveSession(req);
      const safeReturn = returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
      return res.redirect(safeReturn);
    } catch (routeError) {
      logger.error('OAuth callback error:', routeError);
      return res.redirect('/dashboard?error=auth_failed');
    }
  });

  router.get('/auth/discord/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      return res.redirect('/dashboard');
    });
  });

  router.get('/auth/x/login', (req, res) => {
    (async () => {
      if (!req.session.discordUser) {
        return res.redirect('/dashboard?error=x_requires_login');
      }
      if (!xProviderService.isConfigured()) {
        return res.redirect('/dashboard?error=x_not_configured');
      }

      const state = crypto.randomBytes(24).toString('hex');
      const pkce = xProviderService.generatePkcePair();
      const redirectUri = xProviderService.resolveRedirectUri(req);
      const guildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() }) || null;
      const rawReturn = String(req.query.returnTo || '').trim();
      const returnTo = rawReturn && rawReturn.startsWith('/') && !rawReturn.startsWith('//')
        ? rawReturn
        : `/?${new URLSearchParams({
            section: 'engagement',
            ...(guildId ? { guild: guildId } : {}),
          }).toString()}`;

      req.session.xOAuth = {
        state,
        codeVerifier: pkce.verifier,
        redirectUri,
        guildId,
        returnTo,
      };
      await saveSession(req);

      const authorizeUrl = xProviderService.buildAuthorizeUrl({
        redirectUri,
        state,
        codeChallenge: pkce.challenge,
      });
      return res.redirect(authorizeUrl);
    })().catch((routeError) => {
      logger.error('X OAuth login start error:', routeError);
      return res.redirect('/dashboard?error=x_oauth_login_start_failed');
    });
  });

  router.get('/auth/x/callback', (req, res) => {
    (async () => {
      const authState = req.session?.xOAuth || null;
      const { code, state } = req.query || {};
      if (!authState || !code || !state || String(state) !== String(authState.state || '')) {
        if (req.session?.xOAuth) delete req.session.xOAuth;
        await saveSession(req);
        return res.redirect('/dashboard?error=x_invalid_state');
      }

      const tokenData = await xProviderService.exchangeCodeForTokens({
        code: String(code),
        codeVerifier: authState.codeVerifier,
        redirectUri: authState.redirectUri,
      });
      const userData = await xProviderService.getAuthenticatedUser(tokenData.access_token);
      const linkedUser = userData?.data || {};

      const guildId = String(authState.guildId || '').trim();
      if (!guildId) {
        delete req.session.xOAuth;
        await saveSession(req);
        return res.redirect('/dashboard?error=x_missing_guild');
      }

      const eng = require('../../services/engagementService');
      const result = eng.upsertLinkedAccount(guildId, req.session.discordUser.id, {
        provider: 'x',
        provider_user_id: linkedUser.id,
        handle: linkedUser.username,
        display_name: linkedUser.name,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || null,
        token_expires_at: tokenData.expires_in
          ? new Date(Date.now() + (Math.max(60, Number(tokenData.expires_in || 7200)) * 1000)).toISOString()
          : null,
        status: 'linked',
        metadata: {
          tokenType: tokenData.token_type || 'bearer',
          scope: tokenData.scope || null,
          profileImageUrl: linkedUser.profile_image_url || null,
          description: linkedUser.description || null,
          verified: !!linkedUser.verified,
          publicMetrics: linkedUser.public_metrics || {},
        },
      });

      delete req.session.xOAuth;
      await saveSession(req);

      const returnTo = authState.returnTo && String(authState.returnTo).startsWith('/') && !String(authState.returnTo).startsWith('//')
        ? String(authState.returnTo)
        : '/?section=engagement';
      if (!result?.success) {
        return res.redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}xAuth=failed`);
      }
      return res.redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}xAuth=connected`);
    })().catch(async (routeError) => {
      logger.error('X OAuth callback error:', routeError);
      if (req.session?.xOAuth) delete req.session.xOAuth;
      await saveSession(req);
      return res.redirect('/dashboard?error=x_auth_failed');
    });
  });

  router.get('/api/user/me', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }

    try {
      const discordId = req.session.discordUser.id;
      const userInfo = await roleService.getUserInfo(discordId);
      const wallets = db.prepare('SELECT wallet_address, is_favorite, primary_wallet, created_at FROM wallets WHERE discord_id = ? ORDER BY is_favorite DESC, created_at ASC').all(discordId);
      const userPrefs = db.prepare('SELECT wallet_alert_identity_opt_out FROM users WHERE discord_id = ?').get(discordId) || {};
      const requestedGuildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      const missingTenantSelection = tenantService.isMultitenantEnabled() && !requestedGuildId;
      const membership = requestedGuildId
        ? db.prepare(`
          SELECT last_verified_at, updated_at
          FROM user_tenant_memberships
          WHERE discord_id = ? AND guild_id = ?
        `).get(discordId, requestedGuildId)
        : null;
      const effectiveLastVerifiedAt = membership?.last_verified_at || userInfo?.updated_at || null;
      const walletsWithVerificationTime = wallets.map((wallet) => ({
        ...wallet,
        last_verified_at: effectiveLastVerifiedAt || wallet.created_at || null,
      }));

      const hasMissionsGuildColumn = missionService.hasMissionsGuildColumn?.() === true;
      let proposals = [];
      let missions = [];
      let pointsResult = { total: 0 };

      if (!missingTenantSelection) {
        proposals = (hasProposalsGuildColumn() && requestedGuildId)
          ? db.prepare("SELECT * FROM proposals WHERE creator_id = ? AND guild_id = ? AND status NOT IN ('expired') ORDER BY created_at DESC").all(discordId, requestedGuildId)
          : db.prepare("SELECT * FROM proposals WHERE creator_id = ? AND status NOT IN ('expired') ORDER BY created_at DESC").all(discordId);

        missions = (hasMissionsGuildColumn && requestedGuildId)
          ? db.prepare(`
            SELECT m.*, mp.assigned_nft_name, mp.assigned_role, mp.points_awarded
            FROM missions m
            JOIN mission_participants mp ON m.mission_id = mp.mission_id
            WHERE mp.participant_id = ? AND m.guild_id = ? AND m.status IN (?, ?)
            ORDER BY mp.joined_at DESC
          `).all(discordId, requestedGuildId, 'recruiting', 'active')
          : db.prepare(`
            SELECT m.*, mp.assigned_nft_name, mp.assigned_role, mp.points_awarded
            FROM missions m
            JOIN mission_participants mp ON m.mission_id = mp.mission_id
            WHERE mp.participant_id = ? AND m.status IN (?, ?)
            ORDER BY mp.joined_at DESC
          `).all(discordId, 'recruiting', 'active');

        pointsResult = (hasMissionsGuildColumn && requestedGuildId)
          ? db.prepare(`
            SELECT COALESCE(SUM(mp.points_awarded), 0) AS total
            FROM mission_participants mp
            JOIN missions m ON m.mission_id = mp.mission_id
            WHERE mp.participant_id = ? AND m.guild_id = ?
          `).get(discordId, requestedGuildId)
          : db.prepare('SELECT COALESCE(SUM(points_awarded), 0) as total FROM mission_participants WHERE participant_id = ?').get(discordId);
      }

      return res.json(toSuccessResponse({
        requiresServerSelection: missingTenantSelection,
        activeGuildId: requestedGuildId || null,
        user: {
          discordId,
          username: req.session.discordUser.username,
          avatar: req.session.discordUser.avatar,
          tier: userInfo ? userInfo.tier : 'None',
          votingPower: userInfo ? userInfo.voting_power : 0,
          totalNFTs: userInfo ? userInfo.total_nfts : 0,
          totalPoints: pointsResult.total,
          lastVerifiedAt: effectiveLastVerifiedAt,
          walletAlertIdentityOptOut: Number(userPrefs.wallet_alert_identity_opt_out || 0) === 1
        },
        wallets: walletsWithVerificationTime,
        proposals,
        missions
      }));
    } catch (routeError) {
      logger.error('Error fetching user data:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/user/engagement/summary', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    try {
      const guildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!guildId) return res.status(400).json(toErrorResponse('Select a server first', 'VALIDATION_ERROR'));
      const eng = require('../../services/engagementService');
      return res.json(toSuccessResponse({
        summary: eng.listUserEngagementSummary(guildId, req.session.discordUser.id),
        config: eng.getConfig(guildId),
        currency: eng.getCurrencyMeta(guildId),
      }));
    } catch (routeError) {
      logger.error('Error fetching user engagement summary:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/user/engagement/accounts', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    try {
      const guildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!guildId) return res.status(400).json(toErrorResponse('Select a server first', 'VALIDATION_ERROR'));
      const eng = require('../../services/engagementService');
      return res.json(toSuccessResponse({
        accounts: eng.listLinkedAccounts(guildId, req.session.discordUser.id),
        providers: eng.getProviderCatalog(),
      }));
    } catch (routeError) {
      logger.error('Error fetching user engagement accounts:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/user/engagement/accounts', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    try {
      const guildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!guildId) return res.status(400).json(toErrorResponse('Select a server first', 'VALIDATION_ERROR'));
      const eng = require('../../services/engagementService');
      const result = eng.upsertLinkedAccount(guildId, req.session.discordUser.id, req.body || {});
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Could not link account', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error saving user engagement account:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/user/engagement/accounts/:provider', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    try {
      const guildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!guildId) return res.status(400).json(toErrorResponse('Select a server first', 'VALIDATION_ERROR'));
      const eng = require('../../services/engagementService');
      return res.json(toSuccessResponse(
        eng.disconnectLinkedAccount(guildId, req.session.discordUser.id, req.params.provider)
      ));
    } catch (routeError) {
      logger.error('Error disconnecting user engagement account:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/user/engagement/tasks', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    try {
      const guildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!guildId) return res.status(400).json(toErrorResponse('Select a server first', 'VALIDATION_ERROR'));
      const eng = require('../../services/engagementService');
      return res.json(toSuccessResponse({
        tasks: eng.listTasks(guildId, {
          provider: req.query.provider || '',
          status: req.query.status || 'active',
          userId: req.session.discordUser.id,
          limit: Number(req.query.limit || 50),
        }),
      }));
    } catch (routeError) {
      logger.error('Error fetching user engagement tasks:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/user/engagement/tasks/:id/complete', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    try {
      const guildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!guildId) return res.status(400).json(toErrorResponse('Select a server first', 'VALIDATION_ERROR'));
      const eng = require('../../services/engagementService');
      const task = eng.getTaskById(guildId, Number(req.params.id), { userId: req.session.discordUser.id });
      if (!task) {
        return res.status(404).json(toErrorResponse('Task not found', 'NOT_FOUND'));
      }

      let result;
      if (task.provider === 'x') {
        result = await eng.verifyXTaskAction(
          guildId,
          Number(req.params.id),
          req.session.discordUser.id,
          req.session.discordUser.username
        );
      } else {
        result = eng.recordTaskCompletion(
          guildId,
          Number(req.params.id),
          req.session.discordUser.id,
          req.session.discordUser.username,
          req.body || {}
        );
      }
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Could not record task completion', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error recording user engagement task completion:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/user/engagement/achievements', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    try {
      const guildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!guildId) return res.status(400).json(toErrorResponse('Select a server first', 'VALIDATION_ERROR'));
      const eng = require('../../services/engagementService');
      return res.json(toSuccessResponse({
        achievements: eng.listUserAchievements(guildId, req.session.discordUser.id),
      }));
    } catch (routeError) {
      logger.error('Error fetching user engagement achievements:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/user/engagement/redemptions', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    try {
      const guildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!guildId) return res.status(400).json(toErrorResponse('Select a server first', 'VALIDATION_ERROR'));
      const eng = require('../../services/engagementService');
      return res.json(toSuccessResponse({
        redemptions: eng.listRedemptions(guildId, {
          userId: req.session.discordUser.id,
          limit: Number(req.query.limit || 50),
        }),
      }));
    } catch (routeError) {
      logger.error('Error fetching user engagement redemptions:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/user/engagement/redeem', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    try {
      const guildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!guildId) return res.status(400).json(toErrorResponse('Select a server first', 'VALIDATION_ERROR'));
      const itemId = Number(req.body?.item_id || req.body?.itemId);
      if (!itemId) return res.status(400).json(toErrorResponse('item_id is required', 'VALIDATION_ERROR'));
      const eng = require('../../services/engagementService');
      const result = await eng.redeemItem(guildId, req.session.discordUser.id, req.session.discordUser.username, itemId);
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.reason || 'Could not redeem item', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error redeeming engagement shop item:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/user/tickets', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    try {
      const discordId = req.session.discordUser.id;
      const guildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!guildId) return res.status(400).json(toErrorResponse('Select a server first', 'VALIDATION_ERROR'));
      const tickets = ticketService.getAllTickets({ guildId, opener: discordId });
      return res.json(toSuccessResponse({ tickets }));
    } catch (routeError) {
      logger.error('Error fetching user tickets:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/user/role-panels', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    try {
      const guildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!guildId) return res.status(400).json(toErrorResponse('Select a server first', 'VALIDATION_ERROR'));
      const rolePanelService = require('../../services/rolePanelService');
      const panels = rolePanelService.listPanels(guildId)
        .map(p => ({ ...p, roles: (p.roles || []).filter(r => r.enabled !== 0) }))
        .filter(p => (p.roles || []).length > 0);
      return res.json(toSuccessResponse({ panels }));
    } catch (routeError) {
      logger.error('Error fetching user role panels:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/user/roles/toggle', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    try {
      const guildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      const { roleId, panelId } = req.body || {};
      if (!guildId || !roleId) return res.status(400).json(toErrorResponse('guild and role are required', 'VALIDATION_ERROR'));
      const guild = await fetchGuildById(guildId);
      if (!guild) return res.status(404).json(toErrorResponse('Guild not found', 'NOT_FOUND'));
      const member = await guild.members.fetch(req.session.discordUser.id).catch(() => null);
      if (!member) return res.status(404).json(toErrorResponse('Member not found', 'NOT_FOUND'));

      const rolePanelService = require('../../services/rolePanelService');
      const panel = panelId ? rolePanelService.getPanel(parseInt(panelId, 10), guildId) : rolePanelService.getPanelByRole(roleId, guildId);
      if (!panel) return res.status(400).json(toErrorResponse('Panel not found', 'VALIDATION_ERROR'));
      if (!(panel.roles || []).some(r => r.role_id === roleId && r.enabled !== 0)) {
        return res.status(400).json(toErrorResponse('Role not claimable in this panel', 'VALIDATION_ERROR'));
      }

      const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
      if (!role) return res.status(404).json(toErrorResponse('Role not found in server', 'NOT_FOUND'));

      const client = getClient();
      const botMember = guild.members.me || (client?.user ? await guild.members.fetch(client.user.id).catch(() => null) : null);
      if (!botMember) return res.status(500).json(toErrorResponse('Bot member not available'));
      if (!botMember.permissions.has('ManageRoles')) return res.status(403).json(toErrorResponse('Bot lacks ManageRoles permission', 'FORBIDDEN'));
      if (role.position >= botMember.roles.highest.position) return res.status(403).json(toErrorResponse('Bot cannot manage this role (hierarchy)', 'FORBIDDEN'));

      const hasRole = member.roles.cache.has(roleId);
      if (hasRole) await member.roles.remove(role, 'Self-serve web role unclaim');
      else await member.roles.add(role, 'Self-serve web role claim');

      if (!hasRole && panel.single_select === 1) {
        for (const panelRole of panel.roles || []) {
          if (panelRole.role_id === roleId) continue;
          if (!member.roles.cache.has(panelRole.role_id)) continue;
          const roleObj = guild.roles.cache.get(panelRole.role_id);
          if (roleObj) await member.roles.remove(roleObj, 'Single-select panel enforcement (web)');
        }
      }

      return res.json(toSuccessResponse({
        action: hasRole ? 'removed' : 'added',
        roleName: role.name,
        message: `${hasRole ? 'Removed' : 'Added'} role: ${role.name}`
      }));
    } catch (routeError) {
      logger.error('Error toggling user role via web:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/servers/me', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }

    const client = getClient();
    if (!client) {
      return res.status(500).json(toErrorResponse('Bot not initialized'));
    }

    try {
      const userId = req.session.discordUser.id;
      const isSuperadmin = superadminService.isSuperadmin(userId);
      const discordGuilds = await getDiscordUserGuilds(req);
      const botGuildIds = await getBotGuildIds();
      const managedServers = [];
      const unmanagedServers = [];

      if (isSuperadmin) {
        const tenantResult = tenantService.listTenants({ page: 1, pageSize: 10000 });
        const tenants = Array.isArray(tenantResult) ? tenantResult : (tenantResult?.tenants || []);
        const managedSeen = new Set();
        const unmanagedSeen = new Set();

        for (const tenant of tenants) {
          const guildId = tenant.guildId;
          if (!guildId || managedSeen.has(guildId)) continue;

          const guild = await fetchGuildById(guildId);
          if (!guild) continue;
          managedSeen.add(guildId);
          managedServers.push({
            guildId,
            name: guild.name || tenant.guildName || `Server ${guildId}`,
            icon: guild.icon || null,
            permissions: '8',
            source: 'tenant'
          });
        }

        for (const guildId of botGuildIds) {
          if (managedSeen.has(guildId)) continue;
          const guild = await fetchGuildById(guildId);
          managedSeen.add(guildId);
          managedServers.push({
            guildId,
            name: guild?.name || `Server ${guildId}`,
            icon: guild?.icon || null,
            permissions: '8',
            source: 'bot'
          });
        }

        for (const guildSummary of discordGuilds) {
          if (!hasDiscordAdminPermission(guildSummary)) continue;
          if (managedSeen.has(guildSummary.id) || unmanagedSeen.has(guildSummary.id)) continue;
          unmanagedSeen.add(guildSummary.id);
          unmanagedServers.push({
            guildId: guildSummary.id,
            name: guildSummary.name,
            icon: guildSummary.icon,
            permissions: guildSummary.permissions,
            source: 'oauth'
          });
        }

        managedServers.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        unmanagedServers.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        return res.json(toSuccessResponse({ isSuperadmin, managedServers, unmanagedServers }));
      }

      if (discordGuilds.length === 0) {
        const fallback = fallbackGuildId();
        if (fallback) {
          const guild = await fetchGuildById(fallback);
          const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
          if (guild && member?.permissions && (member.permissions.has('Administrator') || member.permissions.has('ManageGuild')) && botGuildIds.has(guild.id)) {
            managedServers.push({
              guildId: guild.id,
              name: guild.name,
              icon: guild.icon,
              permissions: member.permissions.bitfield?.toString?.() || '0'
            });
          }
        }
      }

      for (const guildSummary of discordGuilds) {
        if (!hasDiscordAdminPermission(guildSummary)) continue;
        const serverRecord = {
          guildId: guildSummary.id,
          name: guildSummary.name,
          icon: guildSummary.icon,
          permissions: guildSummary.permissions
        };
        if (botGuildIds.has(guildSummary.id)) managedServers.push(serverRecord);
        else unmanagedServers.push(serverRecord);
      }

      managedServers.sort((a, b) => a.name.localeCompare(b.name));
      unmanagedServers.sort((a, b) => a.name.localeCompare(b.name));
      return res.json(toSuccessResponse({ isSuperadmin, managedServers, unmanagedServers }));
    } catch (routeError) {
      logger.error('Error fetching user servers:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/servers/invite-link', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }

    try {
      const guildId = normalizeGuildId(req.query.guildId || '');
      const userId = req.session.discordUser.id;
      const isSuperadmin = superadminService.isSuperadmin(userId);
      const client = getClient();
      const runtimeClientId = client?.application?.id || client?.user?.id || null;
      if (runtimeClientId && process.env.CLIENT_ID && process.env.CLIENT_ID !== runtimeClientId) {
        logger.warn(`[invite-link] CLIENT_ID mismatch detected. env=${process.env.CLIENT_ID} runtime=${runtimeClientId}. Using runtime id.`);
      }
      const clientId = runtimeClientId || process.env.CLIENT_ID;
      if (!clientId) {
        return res.status(500).json(toErrorResponse('CLIENT_ID is not configured'));
      }

      if (guildId && !isSuperadmin) {
        const discordGuilds = await getDiscordUserGuilds(req);
        const guild = discordGuilds.find(entry => entry.id === guildId);
        if (!guild || !hasDiscordAdminPermission(guild)) {
          return res.status(403).json(toErrorResponse('Admin permission required', 'FORBIDDEN'));
        }
      }

      const permissions = process.env.BOT_INVITE_PERMISSIONS || '8';
      const baseUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${encodeURIComponent(permissions)}`;
      const redirectUrl = guildId
        ? `${baseUrl}&guild_id=${encodeURIComponent(guildId)}&disable_guild_select=true`
        : baseUrl;

      return res.redirect(redirectUrl);
    } catch (routeError) {
      logger.error('Error building invite link:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/user/wallets/:address/favorite', (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }

    try {
      const discordId = req.session.discordUser.id;
      const walletAddress = req.params.address;
      const result = walletService.setFavoriteWallet(discordId, walletAddress);
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to set favorite wallet', 'VALIDATION_ERROR'));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error setting favorite wallet:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.delete('/api/user/wallets/:address', (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }

    try {
      const discordId = req.session.discordUser.id;
      const walletAddress = req.params.address;
      const result = walletService.removeWallet(discordId, walletAddress);
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to remove wallet', 'VALIDATION_ERROR'));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error removing wallet:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createAuthUserRouter;
