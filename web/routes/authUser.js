const express = require('express');
const crypto = require('crypto');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');
const xProviderService = require('../../services/xProviderService');
const { getModuleDisplayName } = require('../../services/moduleLabelService');
const settingsManager = require('../../config/settings');

function createAuthUserRouter({
  logger,
  db,
  publicApiLimiter,
  resolveOAuthRedirectUri,
  getRequestedGuildId,
  tenantService,
  roleService,
  missionService,
  heistService,
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

  const parseCommaSeparated = (value) => String(value || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);

  const normalizeOrigin = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      return parsed.origin;
    } catch (_error) {
      try {
        const parsed = new URL(`https://${raw}`);
        return parsed.origin;
      } catch (_error2) {
        return '';
      }
    }
  };

  const getRequestOrigin = (req) => {
    const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
    const directHost = String(req.get('host') || '').trim();
    const host = forwardedHost || directHost;
    if (!host) return '';
    const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol || 'https';
    return `${protocol}://${host}`;
  };

  const getPublicWebAuthSecret = () => String(
    process.env.PUBLIC_WEB_AUTH_SECRET
      || process.env.SESSION_SECRET
      || process.env.DISCORD_CLIENT_SECRET
      || ''
  ).trim();

  const toBase64Url = (value) => Buffer.from(String(value || ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

  const fromBase64Url = (value) => {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4;
    const padded = padding ? normalized + '='.repeat(4 - padding) : normalized;
    return Buffer.from(padded, 'base64').toString('utf8');
  };

  const signPayload = (payload) => {
    const secret = getPublicWebAuthSecret();
    if (!secret) {
      return null;
    }
    const encodedPayload = toBase64Url(JSON.stringify(payload || {}));
    const signature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('hex');
    return `${encodedPayload}.${signature}`;
  };

  const verifySignedToken = (token) => {
    const secret = getPublicWebAuthSecret();
    if (!secret) return null;
    const raw = String(token || '').trim();
    const [encodedPayload, providedSignature] = raw.split('.');
    if (!encodedPayload || !providedSignature) return null;

    const expectedSignature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('hex');
    if (providedSignature.length !== expectedSignature.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(providedSignature), Buffer.from(expectedSignature))) return null;

    try {
      return JSON.parse(fromBase64Url(encodedPayload));
    } catch (_error) {
      return null;
    }
  };

  const WEB_AUTH_TOKEN_KIND = 'public_web_access_v1';
  const WEB_AUTH_STATE_KIND = 'public_web_oauth_state_v1';
  const WEB_AUTH_TOKEN_TTL_MS = Math.max(5 * 60 * 1000, Number(process.env.PUBLIC_WEB_ACCESS_TOKEN_TTL_MS || 8 * 60 * 60 * 1000));
  const WEB_AUTH_STATE_TTL_MS = Math.max(60 * 1000, Number(process.env.PUBLIC_WEB_OAUTH_STATE_TTL_MS || 10 * 60 * 1000));

  const getAllowedWebReturnOrigins = (req) => {
    const configured = parseCommaSeparated(process.env.PUBLIC_WEB_ALLOWED_RETURN_ORIGINS)
      .map(normalizeOrigin)
      .filter(Boolean);
    const defaults = [
      'https://the-solpranos.com',
      'https://www.the-solpranos.com',
      normalizeOrigin(getRequestOrigin(req)),
    ].filter(Boolean);
    return Array.from(new Set([...configured, ...defaults]));
  };

  const sanitizeExternalReturnTo = (rawReturnTo, req) => {
    const raw = String(rawReturnTo || '').trim();
    if (!raw) return '';

    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_error) {
      return '';
    }

    const allowedOrigins = getAllowedWebReturnOrigins(req);
    if (!allowedOrigins.includes(parsed.origin)) {
      return '';
    }
    return parsed.toString();
  };

  const getPublicWebDiscordRedirectUri = (req) => {
    const configured = String(process.env.PUBLIC_WEB_DISCORD_REDIRECT_URI || '').trim();
    if (configured) return configured;
    const requestOrigin = normalizeOrigin(getRequestOrigin(req));
    if (!requestOrigin) return '';
    return `${requestOrigin}/api/public/v1/auth/discord/callback`;
  };

  const buildReturnUrlWithFragment = (returnTo, params) => {
    const target = new URL(returnTo);
    const fragment = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null) continue;
      fragment.set(key, String(value));
    }
    target.hash = fragment.toString();
    return target.toString();
  };

  const checkGuildMembership = async (guildId, discordId) => {
    const normalizedGuildId = String(guildId || '').trim();
    const normalizedDiscordId = String(discordId || '').trim();
    if (!normalizedGuildId || !normalizedDiscordId || typeof fetchGuildById !== 'function') {
      return { isMember: false, guild: null, member: null };
    }

    const guild = await fetchGuildById(normalizedGuildId).catch(() => null);
    if (!guild) {
      return { isMember: false, guild: null, member: null };
    }
    const member = await guild.members.fetch(normalizedDiscordId).catch(() => null);
    return { isMember: !!member, guild, member };
  };

  const getBearerToken = (req) => {
    const header = String(req.get('authorization') || '').trim();
    if (!header.toLowerCase().startsWith('bearer ')) return '';
    return header.slice('bearer '.length).trim();
  };

  const resolvePublicGuildId = (req) => {
    const queryGuildId = normalizeGuildId(String(req.query?.guildId || req.query?.guild || '').trim());
    if (queryGuildId) {
      return queryGuildId;
    }
    const headerGuildId = normalizeGuildId(String(req.get('x-guild-id') || '').trim());
    if (headerGuildId) {
      return headerGuildId;
    }
    return getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
  };

  const normalizeComparableDiscordId = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const numericMatch = raw.match(/\d{17,20}/);
    if (numericMatch) return numericMatch[0];
    return raw;
  };

  const isCreatorCancellableStatus = (status) => {
    const normalized = String(status || '').toLowerCase();
    return ['draft', 'pending_review', 'on_hold', 'supporting', 'voting'].includes(normalized);
  };

  const getScopedProposalForGuild = (proposalId, guildId = '') => {
    const normalizedProposalId = String(proposalId || '').trim();
    const normalizedGuildId = String(guildId || '').trim();
    if (!normalizedProposalId) return null;

    if (hasProposalsGuildColumn() && normalizedGuildId) {
      return db.prepare('SELECT * FROM proposals WHERE proposal_id = ? AND guild_id = ?').get(normalizedProposalId, normalizedGuildId) || null;
    }
    return db.prepare('SELECT * FROM proposals WHERE proposal_id = ?').get(normalizedProposalId) || null;
  };

  const resolvePublicWebAuthContext = async (
    req,
    res,
    {
      requireGuild = true,
      requireMembership = true,
      requireVotingPower = false,
    } = {}
  ) => {
    const token = getBearerToken(req);
    if (!token) {
      res.status(401).json(toErrorResponse('Missing bearer token', 'UNAUTHORIZED'));
      return null;
    }

    const payload = verifySignedToken(token);
    const now = Date.now();
    if (!payload || payload.kind !== WEB_AUTH_TOKEN_KIND || Number(payload.exp || 0) < now) {
      res.status(401).json(toErrorResponse('Invalid or expired bearer token', 'UNAUTHORIZED'));
      return null;
    }

    const tokenGuildId = normalizeGuildId(String(payload.guildId || '').trim());
    const requestedGuildId = resolvePublicGuildId(req);
    const guildId = normalizeGuildId(String(requestedGuildId || tokenGuildId || '').trim());

    if (requireGuild && !guildId) {
      res.status(400).json(toErrorResponse('guildId query parameter is required', 'VALIDATION_ERROR'));
      return null;
    }
    if (tokenGuildId && guildId && tokenGuildId !== guildId) {
      res.status(403).json(toErrorResponse('Token guild does not match requested guild', 'FORBIDDEN'));
      return null;
    }

    const userId = String(payload.sub || '').trim();
    if (!userId) {
      res.status(401).json(toErrorResponse('Invalid bearer token subject', 'UNAUTHORIZED'));
      return null;
    }

    const membership = guildId
      ? await checkGuildMembership(guildId, userId)
      : { isMember: false, guild: null, member: null };

    if (requireMembership && guildId && !membership.isMember) {
      res.status(403).json(toErrorResponse('You must be a member of this Discord server', 'FORBIDDEN'));
      return null;
    }

    const userInfo = await roleService.getUserInfo(userId);
    const votingPower = membership.member
      ? Number(roleService.getUserVotingPower(userId, membership.member, guildId) || 0)
      : Number(userInfo?.voting_power || 0);

    if (requireVotingPower && (!userInfo || votingPower < 1)) {
      res.status(403).json(toErrorResponse('You need at least 1 verified NFT to perform this action', 'FORBIDDEN'));
      return null;
    }

    return {
      payload,
      userId,
      username: String(payload.username || '').trim() || 'Member',
      guildId,
      membership,
      userInfo,
      votingPower,
    };
  };

  const ensureHeistServiceAvailable = () => {
    if (!heistService) {
      return { ok: false, message: 'Heist service is not configured' };
    }
    return { ok: true };
  };

  const hydrateHeistProfileResponse = (guildId, userId, username) => {
    const config = heistService.getConfig(guildId);
    const profile = heistService.getProfile(guildId, userId, username);
    const ladder = heistService.getLadder(guildId);
    return {
      moduleDisplayName: config?.moduleDisplayName || 'Missions',
      config: config ? {
        xpLabel: config.xp_label,
        streetcreditLabel: config.streetcredit_label,
        taskLabel: config.task_label,
      } : null,
      profile,
      ladder,
    };
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

  router.get('/api/public/v1/auth/discord/start', (req, res) => {
    (async () => {
      if (!getPublicWebAuthSecret()) {
        return res.status(500).json(
          toErrorResponse('PUBLIC_WEB_AUTH_SECRET is not configured', 'CONFIG_ERROR')
        );
      }

      const guildId = resolvePublicGuildId(req);
      if (!guildId) {
        return res.status(400).json(
          toErrorResponse('guildId query parameter is required', 'VALIDATION_ERROR')
        );
      }

      const rawReturnTo = String(req.query.returnTo || '').trim();
      const safeReturnTo = sanitizeExternalReturnTo(rawReturnTo, req);
      if (rawReturnTo && !safeReturnTo) {
        return res.status(400).json(
          toErrorResponse('returnTo origin is not allowed', 'VALIDATION_ERROR')
        );
      }

      const redirectUri = getPublicWebDiscordRedirectUri(req);
      if (!redirectUri) {
        return res.status(500).json(
          toErrorResponse('Public OAuth redirect URI is not configured', 'CONFIG_ERROR')
        );
      }

      const now = Date.now();
      const stateToken = signPayload({
        kind: WEB_AUTH_STATE_KIND,
        guildId,
        returnTo: safeReturnTo,
        nonce: crypto.randomBytes(12).toString('hex'),
        iat: now,
        exp: now + WEB_AUTH_STATE_TTL_MS,
      });
      if (!stateToken) {
        return res.status(500).json(toErrorResponse('Could not create auth state', 'CONFIG_ERROR'));
      }

      const clientId = String(process.env.CLIENT_ID || '').trim();
      if (!clientId) {
        return res.status(500).json(toErrorResponse('CLIENT_ID is not configured', 'CONFIG_ERROR'));
      }

      const authUrl = new URL('https://discord.com/api/oauth2/authorize');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'identify guilds');
      authUrl.searchParams.set('state', stateToken);
      return res.redirect(authUrl.toString());
    })().catch((routeError) => {
      logger.error('Public Discord OAuth start error:', routeError);
      return res.status(500).json(toErrorResponse('Failed to start Discord OAuth', 'INTERNAL_ERROR'));
    });
  });

  router.get('/api/public/v1/auth/discord/callback', async (req, res) => {
    const code = String(req.query.code || '').trim();
    const state = String(req.query.state || '').trim();
    if (!code || !state) {
      return res.status(400).json(toErrorResponse('Missing code or state', 'VALIDATION_ERROR'));
    }

    const statePayload = verifySignedToken(state);
    const now = Date.now();
    if (!statePayload || statePayload.kind !== WEB_AUTH_STATE_KIND || Number(statePayload.exp || 0) < now) {
      return res.status(400).json(toErrorResponse('Invalid or expired OAuth state', 'VALIDATION_ERROR'));
    }

    try {
      const redirectUri = getPublicWebDiscordRedirectUri(req);
      if (!redirectUri) {
        return res.status(500).json(toErrorResponse('Public OAuth redirect URI is not configured', 'CONFIG_ERROR'));
      }

      const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.CLIENT_ID,
          client_secret: process.env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri
        })
      });
      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok || !tokenData?.access_token) {
        return res.status(400).json(toErrorResponse('Discord token exchange failed', 'OAUTH_ERROR'));
      }

      const userResponse = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const userData = await userResponse.json();
      if (!userResponse.ok || !userData?.id) {
        return res.status(400).json(toErrorResponse('Could not fetch Discord user profile', 'OAUTH_ERROR'));
      }

      const guildId = String(statePayload.guildId || '').trim();
      const membership = await checkGuildMembership(guildId, userData.id);

      const expiresAt = Date.now() + WEB_AUTH_TOKEN_TTL_MS;
      const accessToken = signPayload({
        kind: WEB_AUTH_TOKEN_KIND,
        sub: String(userData.id),
        username: String(userData.username || ''),
        avatar: userData.avatar ? String(userData.avatar) : null,
        guildId,
        iat: Date.now(),
        exp: expiresAt,
      });

      if (!accessToken) {
        return res.status(500).json(toErrorResponse('Failed to issue web access token', 'CONFIG_ERROR'));
      }

      const payload = {
        accessToken,
        tokenType: 'Bearer',
        expiresAt,
        guildId,
        isGuildMember: !!membership.isMember,
        user: {
          id: String(userData.id),
          username: String(userData.username || ''),
          avatar: userData.avatar ? String(userData.avatar) : null,
        }
      };

      const returnTo = String(statePayload.returnTo || '').trim();
      if (returnTo) {
        const redirectTarget = buildReturnUrlWithFragment(returnTo, {
          gp_auth: 'ok',
          gp_access_token: accessToken,
          gp_guild_id: guildId,
          gp_member: membership.isMember ? '1' : '0',
          gp_expires_at: String(expiresAt),
        });
        return res.redirect(redirectTarget);
      }

      return res.json(toSuccessResponse(payload));
    } catch (routeError) {
      logger.error('Public Discord OAuth callback error:', routeError);
      return res.status(500).json(toErrorResponse('Discord OAuth callback failed', 'INTERNAL_ERROR'));
    }
  });

  router.get('/api/public/v1/me', async (req, res) => {
    try {
      const token = getBearerToken(req);
      if (!token) {
        return res.status(401).json(toErrorResponse('Missing bearer token', 'UNAUTHORIZED'));
      }

      const payload = verifySignedToken(token);
      const now = Date.now();
      if (!payload || payload.kind !== WEB_AUTH_TOKEN_KIND || Number(payload.exp || 0) < now) {
        return res.status(401).json(toErrorResponse('Invalid or expired bearer token', 'UNAUTHORIZED'));
      }

      const guildId = String(payload.guildId || '').trim();
      const userId = String(payload.sub || '').trim();
      const membership = await checkGuildMembership(guildId, userId);

      const userInfo = await roleService.getUserInfo(userId);
      let totalNfts = Number(userInfo?.total_nfts || 0);
      try {
        const wallets = walletService.getAllUserWallets(userId);
        if (Array.isArray(wallets) && wallets.length > 0 && guildId) {
          const nftService = require('../../services/nftService');
          const allNFTs = await nftService.getAllNFTsForWallets(wallets, { guildId });
          const tierInfo = roleService.getTierForNFTs(allNFTs, guildId);
          totalNfts = Number(tierInfo?.count ?? allNFTs.length ?? 0);
        }
      } catch (scopeError) {
        logger.warn(`Public /me scoped NFT count fallback for ${userId}: ${scopeError?.message || scopeError}`);
      }
      const votingPower = membership.member
        ? Number(roleService.getUserVotingPower(userId, membership.member, guildId) || 0)
        : Number(userInfo?.voting_power || 0);

      const moduleDisplayNames = {
        heist: getModuleDisplayName('heist', guildId),
      };

      return res.json(toSuccessResponse({
        user: {
          id: userId,
          username: String(payload.username || ''),
          avatar: payload.avatar || null,
        },
        guildId,
        isGuildMember: !!membership.isMember,
        hasVerifiedNft: totalNfts > 0,
        totalNfts,
        votingPower,
        moduleDisplayNames,
      }));
    } catch (routeError) {
      logger.error('Error resolving public web auth identity:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/public/v1/heist/meta', async (req, res) => {
    try {
      const guildId = resolvePublicGuildId(req);
      if (tenantService.isMultitenantEnabled() && !guildId) {
        return res.status(400).json(toErrorResponse('guildId query parameter is required', 'VALIDATION_ERROR'));
      }
      const displayName = getModuleDisplayName('heist', guildId);
      return res.json(toSuccessResponse({
        guildId: guildId || null,
        moduleDisplayName: displayName,
      }));
    } catch (routeError) {
      logger.error('Error fetching heist meta:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/public/v1/heist/me', async (req, res) => {
    try {
      const serviceCheck = ensureHeistServiceAvailable();
      if (!serviceCheck.ok) {
        return res.status(500).json(toErrorResponse(serviceCheck.message, 'CONFIG_ERROR'));
      }

      const auth = await resolvePublicWebAuthContext(req, res, {
        requireGuild: true,
        requireMembership: true,
        requireVotingPower: false,
      });
      if (!auth) return;

      const payload = hydrateHeistProfileResponse(auth.guildId, auth.userId, auth.username);
      return res.json(toSuccessResponse(payload));
    } catch (routeError) {
      logger.error('Error fetching heist identity summary:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/public/v1/heist/missions/active', async (req, res) => {
    try {
      const serviceCheck = ensureHeistServiceAvailable();
      if (!serviceCheck.ok) {
        return res.status(500).json(toErrorResponse(serviceCheck.message, 'CONFIG_ERROR'));
      }
      const auth = await resolvePublicWebAuthContext(req, res, {
        requireGuild: true,
        requireMembership: true,
        requireVotingPower: false,
      });
      if (!auth) return;

      const missions = heistService.listMissions(auth.guildId, {
        statuses: ['recruiting', 'active'],
        limit: Number(req.query.limit || 50),
        offset: Number(req.query.offset || 0),
      }).map((mission) => heistService.getPublicMissionPayload(auth.guildId, mission));

      return res.json(toSuccessResponse({
        moduleDisplayName: getModuleDisplayName('heist', auth.guildId),
        missions,
      }));
    } catch (routeError) {
      logger.error('Error fetching active heist missions:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/public/v1/heist/missions/history', async (req, res) => {
    try {
      const serviceCheck = ensureHeistServiceAvailable();
      if (!serviceCheck.ok) {
        return res.status(500).json(toErrorResponse(serviceCheck.message, 'CONFIG_ERROR'));
      }
      const auth = await resolvePublicWebAuthContext(req, res, {
        requireGuild: true,
        requireMembership: true,
        requireVotingPower: false,
      });
      if (!auth) return;

      const statuses = String(req.query.scope || '').trim().toLowerCase() === 'all'
        ? null
        : ['completed', 'failed', 'cancelled'];
      const missions = heistService.listUserMissions(auth.guildId, auth.userId, {
        statuses,
        limit: Number(req.query.limit || 100),
        offset: Number(req.query.offset || 0),
      }).map((mission) => heistService.getPublicMissionPayload(auth.guildId, mission));

      return res.json(toSuccessResponse({
        moduleDisplayName: getModuleDisplayName('heist', auth.guildId),
        missions,
      }));
    } catch (routeError) {
      logger.error('Error fetching heist mission history:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/public/v1/heist/missions/:id', async (req, res) => {
    try {
      const serviceCheck = ensureHeistServiceAvailable();
      if (!serviceCheck.ok) {
        return res.status(500).json(toErrorResponse(serviceCheck.message, 'CONFIG_ERROR'));
      }
      const auth = await resolvePublicWebAuthContext(req, res, {
        requireGuild: true,
        requireMembership: true,
        requireVotingPower: false,
      });
      if (!auth) return;

      const missionId = String(req.params.id || '').trim();
      const mission = heistService.getMission(auth.guildId, missionId, { includeSlots: true });
      if (!mission) {
        return res.status(404).json(toErrorResponse('Mission not found', 'NOT_FOUND'));
      }
      const eligibleNfts = await heistService.listEligibleNftsForMission(auth.guildId, auth.userId, missionId);
      return res.json(toSuccessResponse({
        moduleDisplayName: getModuleDisplayName('heist', auth.guildId),
        mission: heistService.getPublicMissionPayload(auth.guildId, mission, { includeSlots: true }),
        eligibleNfts: eligibleNfts.map((nft) => ({
          mint: nft.mint,
          name: nft.name,
          walletAddress: nft.wallet_address,
          attributes: Array.isArray(nft.attributes) ? nft.attributes : [],
        })),
      }));
    } catch (routeError) {
      logger.error('Error fetching heist mission detail:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/public/v1/heist/missions/:id/join', async (req, res) => {
    try {
      const serviceCheck = ensureHeistServiceAvailable();
      if (!serviceCheck.ok) {
        return res.status(500).json(toErrorResponse(serviceCheck.message, 'CONFIG_ERROR'));
      }
      const auth = await resolvePublicWebAuthContext(req, res, {
        requireGuild: true,
        requireMembership: true,
        requireVotingPower: false,
      });
      if (!auth) return;

      const wallets = walletService.getAllUserWallets(auth.userId);
      if (!Array.isArray(wallets) || wallets.length === 0) {
        return res.status(403).json(toErrorResponse('You need a linked wallet to join missions', 'FORBIDDEN'));
      }

      const missionId = String(req.params.id || '').trim();
      const selectedMints = Array.isArray(req.body?.selectedMints)
        ? req.body.selectedMints
        : (Array.isArray(req.body?.mints) ? req.body.mints : []);
      const result = await heistService.joinMission({
        guildId: auth.guildId,
        missionId,
        userId: auth.userId,
        username: auth.username,
        selectedMints,
      });
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to join mission', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error joining heist mission:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/public/v1/heist/missions/:id/leave', async (req, res) => {
    try {
      const serviceCheck = ensureHeistServiceAvailable();
      if (!serviceCheck.ok) {
        return res.status(500).json(toErrorResponse(serviceCheck.message, 'CONFIG_ERROR'));
      }
      const auth = await resolvePublicWebAuthContext(req, res, {
        requireGuild: true,
        requireMembership: true,
        requireVotingPower: false,
      });
      if (!auth) return;

      const missionId = String(req.params.id || '').trim();
      const result = heistService.leaveMission({
        guildId: auth.guildId,
        missionId,
        userId: auth.userId,
      });
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to leave mission', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error leaving heist mission:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/public/v1/heist/vault/items', async (req, res) => {
    try {
      const serviceCheck = ensureHeistServiceAvailable();
      if (!serviceCheck.ok) {
        return res.status(500).json(toErrorResponse(serviceCheck.message, 'CONFIG_ERROR'));
      }
      const auth = await resolvePublicWebAuthContext(req, res, {
        requireGuild: true,
        requireMembership: true,
        requireVotingPower: false,
      });
      if (!auth) return;

      const items = heistService.listVaultItems(auth.guildId, { includeDisabled: false });
      const profile = heistService.getProfile(auth.guildId, auth.userId, auth.username);
      return res.json(toSuccessResponse({
        moduleDisplayName: getModuleDisplayName('heist', auth.guildId),
        items,
        profile,
      }));
    } catch (routeError) {
      logger.error('Error fetching heist vault items:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/public/v1/heist/vault/redeem', async (req, res) => {
    try {
      const serviceCheck = ensureHeistServiceAvailable();
      if (!serviceCheck.ok) {
        return res.status(500).json(toErrorResponse(serviceCheck.message, 'CONFIG_ERROR'));
      }
      const auth = await resolvePublicWebAuthContext(req, res, {
        requireGuild: true,
        requireMembership: true,
        requireVotingPower: false,
      });
      if (!auth) return;

      const wallets = walletService.getAllUserWallets(auth.userId);
      if (!Array.isArray(wallets) || wallets.length === 0) {
        return res.status(403).json(toErrorResponse('You need a linked wallet to redeem vault items', 'FORBIDDEN'));
      }

      const itemId = Number(req.body?.itemId || req.body?.item_id || 0);
      if (!Number.isFinite(itemId) || itemId <= 0) {
        return res.status(400).json(toErrorResponse('Valid itemId is required', 'VALIDATION_ERROR'));
      }

      const result = await heistService.redeemVaultItem(auth.guildId, auth.userId, auth.username, itemId);
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to redeem item', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error redeeming heist vault item:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/public/v1/heist/profile/history', async (req, res) => {
    try {
      const serviceCheck = ensureHeistServiceAvailable();
      if (!serviceCheck.ok) {
        return res.status(500).json(toErrorResponse(serviceCheck.message, 'CONFIG_ERROR'));
      }
      const auth = await resolvePublicWebAuthContext(req, res, {
        requireGuild: true,
        requireMembership: true,
        requireVotingPower: false,
      });
      if (!auth) return;

      const history = heistService.listVaultRedemptions(auth.guildId, {
        userId: auth.userId,
        limit: Number(req.query.limit || 50),
      });
      const missions = heistService.listUserMissions(auth.guildId, auth.userId, {
        statuses: ['completed', 'failed', 'cancelled'],
        limit: Number(req.query.missionLimit || 100),
      }).map((mission) => heistService.getPublicMissionPayload(auth.guildId, mission));

      return res.json(toSuccessResponse({
        moduleDisplayName: getModuleDisplayName('heist', auth.guildId),
        missions,
        redemptions: history,
      }));
    } catch (routeError) {
      logger.error('Error fetching heist profile history:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/public/v1/governance/proposals/:id/comments', async (req, res) => {
    try {
      const proposalId = String(req.params.id || '').trim();
      const scopedGuildId = resolvePublicGuildId(req);
      if (tenantService.isMultitenantEnabled() && !scopedGuildId) {
        return res.status(400).json(toErrorResponse('guildId query parameter is required', 'VALIDATION_ERROR'));
      }

      const proposal = getScopedProposalForGuild(proposalId, scopedGuildId);
      if (!proposal) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND'));
      }

      const comments = proposalService.getComments(proposalId);
      return res.json(toSuccessResponse({ comments }));
    } catch (routeError) {
      logger.error('Error fetching public governance comments:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/public/v1/governance/proposals/:id/my-state', async (req, res) => {
    try {
      const auth = await resolvePublicWebAuthContext(req, res, {
        requireGuild: true,
        requireMembership: false,
        requireVotingPower: false,
      });
      if (!auth) return;

      const proposalId = String(req.params.id || '').trim();
      const proposal = getScopedProposalForGuild(proposalId, auth.guildId);
      if (!proposal) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND'));
      }

      const supportRow = db.prepare(
        'SELECT 1 AS supported FROM proposal_supporters WHERE proposal_id = ? AND supporter_id = ?'
      ).get(proposalId, auth.userId);
      const voteRow = db.prepare(
        'SELECT vote_choice, voting_power, voted_at FROM votes WHERE proposal_id = ? AND voter_id = ?'
      ).get(proposalId, auth.userId);
      const creatorMatches = normalizeComparableDiscordId(proposal.creator_id) === normalizeComparableDiscordId(auth.userId);
      const canCancel = creatorMatches && isCreatorCancellableStatus(proposal.status);

      return res.json(toSuccessResponse({
        proposalId,
        guildId: auth.guildId,
        isGuildMember: !!auth.membership?.isMember,
        hasSupported: !!supportRow,
        canCancel,
        vote: voteRow
          ? {
              choice: String(voteRow.vote_choice || '').toLowerCase(),
              votingPower: Number(voteRow.voting_power || 0),
              votedAt: voteRow.voted_at || null,
            }
          : null,
      }));
    } catch (routeError) {
      logger.error('Error fetching public governance proposal user state:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/public/v1/governance/proposals', async (req, res) => {
    try {
      const auth = await resolvePublicWebAuthContext(req, res, {
        requireGuild: true,
        requireMembership: true,
        requireVotingPower: true,
      });
      if (!auth) return;

      const {
        title,
        goal,
        description,
        category,
        costIndication,
      } = req.body || {};

      if (!String(title || '').trim()) {
        return res.status(400).json(toErrorResponse('Title is required', 'VALIDATION_ERROR'));
      }
      if (!String(goal || '').trim()) {
        return res.status(400).json(toErrorResponse('Goal is required', 'VALIDATION_ERROR'));
      }
      if (!String(description || '').trim()) {
        return res.status(400).json(toErrorResponse('Description is required', 'VALIDATION_ERROR'));
      }
      if (!String(costIndication || '').trim()) {
        return res.status(400).json(toErrorResponse('Costs are required', 'VALIDATION_ERROR'));
      }
      if (!String(category || '').trim()) {
        return res.status(400).json(toErrorResponse('Category is required', 'VALIDATION_ERROR'));
      }

      const result = proposalService.createProposal(auth.userId, {
        title: String(title).trim(),
        goal: String(goal).trim(),
        description: String(description).trim(),
        category: String(category).trim(),
        costIndication: String(costIndication).trim(),
        guildId: auth.guildId,
        initialStatus: 'supporting',
      });

      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to create proposal', 'VALIDATION_ERROR', null, result));
      }

      proposalService.postToProposalsChannel(result.proposalId, {
        creatorDisplayName: auth.username || '',
      }).catch(() => {});

      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error creating public governance proposal:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/public/v1/governance/proposals/:id/support', async (req, res) => {
    try {
      const auth = await resolvePublicWebAuthContext(req, res, {
        requireGuild: true,
        requireMembership: true,
        requireVotingPower: true,
      });
      if (!auth) return;

      const proposalId = String(req.params.id || '').trim();
      const proposal = getScopedProposalForGuild(proposalId, auth.guildId);
      if (!proposal) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND'));
      }

      const result = proposalService.addSupporter(proposalId, auth.userId);
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to support proposal', 'VALIDATION_ERROR', null, result));
      }

      let promoted = false;
      const supportThreshold = Number(settingsManager?.getSettings?.()?.supportThreshold || 4);
      if (String(proposal?.status || '').toLowerCase() === 'supporting' && Number(result.supporterCount || 0) >= supportThreshold) {
        const promoteResult = await proposalService.promoteToVoting(proposalId, auth.userId);
        promoted = !!promoteResult?.success;
      }

      if (!promoted) {
        const refreshedProposal = proposalService.getProposal(proposalId);
        promoted = String(refreshedProposal?.status || '').toLowerCase() === 'voting';
        if (!promoted && String(refreshedProposal?.status || '').toLowerCase() === 'supporting') {
          proposalService.postToProposalsChannel(proposalId).catch(() => {});
        }
      }

      return res.json(toSuccessResponse({ ...result, promoted }));
    } catch (routeError) {
      logger.error('Error adding public governance support:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/public/v1/governance/proposals/:id/vote', async (req, res) => {
    try {
      const auth = await resolvePublicWebAuthContext(req, res, {
        requireGuild: true,
        requireMembership: true,
        requireVotingPower: true,
      });
      if (!auth) return;

      const proposalId = String(req.params.id || '').trim();
      const proposal = getScopedProposalForGuild(proposalId, auth.guildId);
      if (!proposal) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND'));
      }

      const choice = String(req.body?.choice || '').trim().toLowerCase();
      if (!['yes', 'no', 'abstain'].includes(choice)) {
        return res.status(400).json(toErrorResponse('Choice must be yes, no, or abstain', 'VALIDATION_ERROR'));
      }

      const result = proposalService.castVote(proposalId, auth.userId, choice, auth.votingPower);
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to cast vote', 'VALIDATION_ERROR', null, result));
      }

      proposalService.updateVotingMessage(proposalId).catch(() => {});
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error casting public governance vote:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/public/v1/governance/proposals/:id/comments', async (req, res) => {
    try {
      const auth = await resolvePublicWebAuthContext(req, res, {
        requireGuild: true,
        requireMembership: true,
        requireVotingPower: false,
      });
      if (!auth) return;

      const proposalId = String(req.params.id || '').trim();
      const proposal = getScopedProposalForGuild(proposalId, auth.guildId);
      if (!proposal) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND'));
      }

      const content = String(req.body?.content || '').trim();
      if (!content) {
        return res.status(400).json(toErrorResponse('Content is required', 'VALIDATION_ERROR'));
      }
      if (content.length > 1000) {
        return res.status(400).json(toErrorResponse('Comment must be 1000 characters or less', 'VALIDATION_ERROR'));
      }

      const result = proposalService.addComment(
        proposalId,
        auth.userId,
        auth.username,
        content
      );

      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to add comment', 'VALIDATION_ERROR', null, result));
      }

      proposalService.postCommentToDiscussion(proposalId, result.comment, { source: 'web' }).catch((routeError) => {
        logger.warn(`Failed to mirror public governance comment ${proposalId}: ${routeError?.message || routeError}`);
      });

      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error posting public governance comment:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/public/v1/governance/proposals/:id/cancel', async (req, res) => {
    try {
      const auth = await resolvePublicWebAuthContext(req, res, {
        requireGuild: true,
        requireMembership: true,
        requireVotingPower: false,
      });
      if (!auth) return;

      const proposalId = String(req.params.id || '').trim();
      const proposal = getScopedProposalForGuild(proposalId, auth.guildId);
      if (!proposal) {
        return res.status(404).json(toErrorResponse('Proposal not found', 'NOT_FOUND'));
      }

      if (normalizeComparableDiscordId(proposal.creator_id) !== normalizeComparableDiscordId(auth.userId)) {
        return res.status(403).json(toErrorResponse('Only the proposal creator can cancel this proposal', 'FORBIDDEN'));
      }
      if (!isCreatorCancellableStatus(proposal.status)) {
        return res.status(400).json(toErrorResponse(`Proposal cannot be cancelled in status "${proposal.status}"`, 'VALIDATION_ERROR'));
      }

      const result = proposalService.cancelProposal(proposalId, auth.userId, auth.guildId);
      if (!result?.success) {
        return res.status(400).json(toErrorResponse(result?.message || 'Failed to cancel proposal', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result));
    } catch (routeError) {
      logger.error('Error cancelling public governance proposal:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
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
      let heistProfile = null;
      const moduleDisplayNames = {
        heist: getModuleDisplayName('heist', requestedGuildId || ''),
      };

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

        if (heistService && requestedGuildId) {
          const nextHeistMissions = heistService.listUserMissions(requestedGuildId, discordId, {
            statuses: ['recruiting', 'active'],
            limit: 50,
          }).map((mission) => heistService.getPublicMissionPayload(requestedGuildId, mission));
          if (nextHeistMissions.length > 0) {
            missions = nextHeistMissions;
          }
          heistProfile = heistService.getProfile(requestedGuildId, discordId, req.session.discordUser.username);
        }
      }

      return res.json(toSuccessResponse({
        requiresServerSelection: missingTenantSelection,
        activeGuildId: requestedGuildId || null,
        moduleDisplayNames,
        user: {
          discordId,
          username: req.session.discordUser.username,
          avatar: req.session.discordUser.avatar,
          tier: userInfo ? userInfo.tier : 'None',
          totalNFTs: userInfo ? userInfo.total_nfts : 0,
          totalPoints: pointsResult.total,
          lastVerifiedAt: effectiveLastVerifiedAt,
          walletAlertIdentityOptOut: Number(userPrefs.wallet_alert_identity_opt_out || 0) === 1
        },
        wallets: walletsWithVerificationTime,
        proposals,
        missions,
        heist: {
          profile: heistProfile,
        }
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

  router.get('/api/user/engagement/leaderboard', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    try {
      const guildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!guildId) return res.status(400).json(toErrorResponse('Select a server first', 'VALIDATION_ERROR'));
      const eng = require('../../services/engagementService');
      return res.json(toSuccessResponse({
        leaderboard: eng.getLeaderboard(guildId, Number(req.query.limit || 25)),
      }));
    } catch (routeError) {
      logger.error('Error fetching user engagement leaderboard:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/user/engagement/shop', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    try {
      const guildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!guildId) return res.status(400).json(toErrorResponse('Select a server first', 'VALIDATION_ERROR'));
      const eng = require('../../services/engagementService');
      return res.json(toSuccessResponse({
        items: eng.getShopItems(guildId, { includeDisabled: false }),
        points: eng.getUserPoints(guildId, req.session.discordUser.id),
        currency: eng.getCurrencyMeta(guildId),
      }));
    } catch (routeError) {
      logger.error('Error fetching user engagement shop:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/user/engagement/history', async (req, res) => {
    if (!req.session.discordUser) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    try {
      const guildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
      if (!guildId) return res.status(400).json(toErrorResponse('Select a server first', 'VALIDATION_ERROR'));
      const eng = require('../../services/engagementService');
      return res.json(toSuccessResponse({
        history: eng.getUserHistory(guildId, req.session.discordUser.id, Number(req.query.limit || 25)),
        currency: eng.getCurrencyMeta(guildId),
      }));
    } catch (routeError) {
      logger.error('Error fetching user engagement history:', routeError);
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
