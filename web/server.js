const express = require('express');
const session = require('express-session');
const BetterSqlite3Store = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const ipKeyGenerator = rateLimit.ipKeyGenerator;
const crypto = require('crypto');
const os = require('os');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const nacl = require('tweetnacl');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const db = require('../database/db');
const logger = require('../utils/logger');
const settingsManager = require('../config/settings');
const tenantService = require('../services/tenantService');
const walletService = require('../services/walletService');
const roleService = require('../services/roleService');
const proposalService = require('../services/proposalService');
const missionService = require('../services/missionService');
const treasuryService = require('../services/treasuryService');
const microVerifyService = require('../services/microVerifyService');
const nftActivityService = require('../services/nftActivityService');
const trackedWalletsService = require('../services/trackedWalletsService');
const ticketService = require('../services/ticketService');
const entitlementService = require('../services/entitlementService');
const billingService = require('../services/billingService');
const monetizationTemplateService = require('../services/monetizationTemplateService');
const superadminService = require('../services/superadminService');
const superadminIdentityService = require('../services/superadminIdentityService');
const superadminGuard = require('../middleware/superadminGuard');
const { BATTLE_ERAS } = require('../config/battleEras');
const battleService = require('../services/battleService');
const { getBranding } = require('../services/embedBranding');
const { getPlanKeys, getPlanPreset } = require('../config/plans');
const {
  getGuildBotProfileSnapshot,
  applyGuildBotProfileBranding,
} = require('./utils/discordProfileBranding');
const { toSuccessResponse, toErrorResponse } = require('./routes/responseCompat');

const DISCORD_ADMIN_PERMISSION = 0x8n;
const DISCORD_MANAGE_GUILD_PERMISSION = 0x20n;
const REQUEST_GUILD_HEADER = 'x-guild-id';

function normalizeGuildId(guildId) {
  if (typeof guildId !== 'string') return '';
  const trimmed = guildId.trim();
  return /^\d{17,20}$/.test(trimmed) ? trimmed : '';
}

function parseGuildPermissionBits(permissions) {
  try {
    if (permissions === null || permissions === undefined || permissions === '') {
      return 0n;
    }

    return BigInt(String(permissions));
  } catch (error) {
    return 0n;
  }
}

function hasDiscordAdminPermission(guildSummary) {
  if (!guildSummary) {
    return false;
  }

  const perms = parseGuildPermissionBits(guildSummary.permissions);
  const isAdmin = (perms & DISCORD_ADMIN_PERMISSION) === DISCORD_ADMIN_PERMISSION;
  const canManageGuild = (perms & DISCORD_MANAGE_GUILD_PERMISSION) === DISCORD_MANAGE_GUILD_PERMISSION;
  return isAdmin || canManageGuild;
}

function normalizeWebhookValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }

  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        const normalized = stableJson(value[key]);
        if (normalized !== undefined) {
          acc[key] = normalized;
        }
        return acc;
      }, {});
  }

  return value;
}

function hashWebhookPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(stableJson(payload))).digest('hex');
}

function timingSafeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0 || a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function normalizeWebhookSecretHeader(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/^Bearer\s+/i, '').trim();
}

function getActivityWebhookSecret() {
  return String(process.env.TRACKED_TOKEN_WEBHOOK_SECRET || process.env.NFT_ACTIVITY_WEBHOOK_SECRET || '').trim();
}

function parseCommaSeparated(value) {
  return String(value || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function normalizeOrigin(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    const parsed = new URL(input);
    return parsed.origin;
  } catch (_error) {
    try {
      const parsed = new URL(`https://${input}`);
      return parsed.origin;
    } catch (_error2) {
      return '';
    }
  }
}

function normalizeCallbackUrl(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    const parsed = new URL(input);
    const pathname = parsed.pathname.endsWith('/') && parsed.pathname !== '/'
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;
    return `${parsed.origin}${pathname}`;
  } catch (_error) {
    try {
      const parsed = new URL(`https://${input}`);
      const pathname = parsed.pathname.endsWith('/') && parsed.pathname !== '/'
        ? parsed.pathname.slice(0, -1)
        : parsed.pathname;
      return `${parsed.origin}${pathname}`;
    } catch (_error2) {
      return '';
    }
  }
}

function getRequestOrigin(req) {
  const forwardedHostRaw = req.get('x-forwarded-host') || '';
  const directHostRaw = req.get('host') || '';
  const host = String(forwardedHostRaw || directHostRaw).split(',')[0].trim();
  if (!host) return '';
  const forwardedProtoRaw = req.get('x-forwarded-proto') || '';
  const proto = String(forwardedProtoRaw || req.protocol || 'https').split(',')[0].trim() || 'https';
  return `${proto}://${host}`;
}

function getConfiguredOAuthRedirectUris() {
  const configured = [
    process.env.DISCORD_REDIRECT_URI,
    ...parseCommaSeparated(process.env.DISCORD_REDIRECT_URIS)
  ];
  const normalized = configured.map(normalizeCallbackUrl).filter(Boolean);
  return Array.from(new Set(normalized));
}

function resolveOAuthRedirectUri(req) {
  const configured = getConfiguredOAuthRedirectUris();
  if (configured.length === 0) {
    return 'http://localhost:3000/auth/discord/callback';
  }

  const requestOrigin = normalizeOrigin(getRequestOrigin(req));
  if (requestOrigin) {
    const preferred = normalizeCallbackUrl(`${requestOrigin}/auth/discord/callback`);
    if (preferred && configured.includes(preferred)) {
      return preferred;
    }
  }

  return configured[0];
}

function ensureVerificationPanelsSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS verification_panels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL UNIQUE,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      title TEXT DEFAULT 'Verify your wallet!',
      description TEXT DEFAULT 'To get access to community roles, verify your wallet by clicking the button below.',
      color TEXT DEFAULT '#FFD700',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const ignoreDuplicateColumn = (error) => {
    const message = String(error?.message || '').toLowerCase();
    return message.includes('duplicate column name') || message.includes('already exists');
  };

  try {
    db.exec("ALTER TABLE verification_panels ADD COLUMN color TEXT DEFAULT '#FFD700'");
  } catch (error) {
    if (!ignoreDuplicateColumn(error)) throw error;
  }

  try {
    db.exec('ALTER TABLE verification_panels ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP');
  } catch (error) {
    if (!ignoreDuplicateColumn(error)) throw error;
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_verification_panels_guild ON verification_panels(guild_id)');
}

class WebServer {
  constructor() {
    this.app = express();
    this.port = process.env.WEB_PORT || 3000;
    this.client = null; // Discord client reference
    this.billingSweepTimer = null;
    this.setupMiddleware();
    this.setupRoutes();
  }

  setClient(client) {
    this.client = client;
    ticketService.setClient(client);
    tenantService.setCommandSource(() => this.client?.commands);
  }

  setupMiddleware() {
    // Trust proxy - CRITICAL for production (AWS ELB, Nginx, etc.)
    // Set to 1 assuming exactly one reverse proxy (nginx). Adjust if architecture changes.
    this.app.set('trust proxy', 1);

    // CORS allowlist includes current + legacy portal domains to keep existing installs/links working.
    const allowedOrigins = Array.from(new Set([
      normalizeOrigin(process.env.WEB_URL),
      ...parseCommaSeparated(process.env.WEB_URL_ALIASES).map(normalizeOrigin),
      'https://guildpilot.app',
      'https://www.guildpilot.app'
    ].filter(Boolean)));
    if (process.env.NODE_ENV !== 'production') {
      allowedOrigins.push('http://localhost:3000', 'http://localhost:5173');
    }

    this.app.use(cors({
      origin: allowedOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', REQUEST_GUILD_HEADER, 'x-entitlement-secret', 'x-webhook-secret', 'X-Requested-With', 'x-csrf-token'],
      exposedHeaders: ['X-Total-Count'], // For pagination
      maxAge: 86400 // 24 hours preflight cache
    }));

    this.app.use(require('cookie-parser')());
    this.app.use(express.json({ limit: process.env.WEBHOOK_BODY_LIMIT || '2mb' }));
    this.app.use(express.static(path.join(__dirname, 'public')));

    this.app.get('/health', (_req, res) => {
      res.json({
        ok: true,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      });
    });

    // Session secret — validated at startup in index.js (min 32 chars required)
    const sessionSecret = process.env.SESSION_SECRET;
    if (!sessionSecret) {
      logger.error('FATAL: SESSION_SECRET is not set. Cannot start web server.');
      process.exit(1);
    }

    // Persistent SQLite session store (sessions survive restarts)
    const sessionsDb = new Database(path.join(__dirname, '..', 'sessions.db'));
    const sessionStore = new BetterSqlite3Store({
      client: sessionsDb,
      expired: {
        clear: true,
        intervalMs: 900000 // Clear expired sessions every 15 minutes
      }
    });

    this.app.use(session({
      store: sessionStore,
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      }
    }));

    // CSRF defense-in-depth: require XMLHttpRequest marker on internal mutating
    // API calls. Secret-authenticated webhook/entitlement routes are exempt.
    const mutatingMethods = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
    this.app.use('/api', (req, res, next) => {
      if (!mutatingMethods.has(req.method)) {
        return next();
      }

      const pathName = String(req.path || '');
      const hasSecretAuth = !!req.headers['x-webhook-secret'] || !!req.headers['x-entitlement-secret'];
      if (pathName.startsWith('/webhooks/') || hasSecretAuth) {
        return next();
      }

      const requestedWith = String(req.headers['x-requested-with'] || '').trim().toLowerCase();
      if (requestedWith !== 'xmlhttprequest') {
        return res.status(403).json(toErrorResponse('Missing or invalid X-Requested-With header', 'FORBIDDEN'));
      }

      next();
    });
    // Stub endpoint so portal.js fetchCsrfToken() doesn't 404.
    this.app.get('/api/csrf-token', (req, res) => res.json(toSuccessResponse({ token: '' })));
  }

  setupRoutes() {
    // ==================== RATE LIMITING ====================

    const rateLimitMessage = toErrorResponse('Too many requests, please try again later.', 'RATE_LIMITED');

    const rateLimitDefaults = { standardHeaders: true, legacyHeaders: false, validate: { xForwardedForHeader: false } };

    const publicApiLimiter = rateLimit({ ...rateLimitDefaults, windowMs: 15 * 60 * 1000, max: 100, message: rateLimitMessage });
    const authLimiter = rateLimit({ ...rateLimitDefaults, windowMs: 15 * 60 * 1000, max: 10, message: rateLimitMessage });
    const verifyLimiter = rateLimit({ ...rateLimitDefaults, windowMs: 60 * 60 * 1000, max: 20, message: rateLimitMessage });
    const adminLimiter = rateLimit({ ...rateLimitDefaults, windowMs: 15 * 60 * 1000, max: 200, message: rateLimitMessage });

    const commentLimiter = rateLimit({
      ...rateLimitDefaults,
      windowMs: 60 * 1000,
      max: 5,
      validate: { xForwardedForHeader: false, ip: false },
      keyGenerator: (req) => {
        const userId = req.session?.discordUser?.id;
        if (userId) return `u:${userId}`;
        return ipKeyGenerator(req.ip || '');
      },
      message: rateLimitMessage
    });

    this.app.use('/api/public/', publicApiLimiter);
    this.app.use('/auth/', authLimiter);
    this.app.use('/api/verify/', verifyLimiter);
    // Only rate-limit new request creation â€” not status/config/check-now
    this.app.use('/api/micro-verify/request', verifyLimiter);
    this.app.use('/api/admin/', adminLimiter);

    const fallbackGuildId = () => normalizeGuildId(process.env.GUILD_ID || process.env.DISCORD_GUILD_ID);

    const getRequestedGuildId = (req, { allowFallback = true } = {}) => {
      const headerGuildId = normalizeGuildId(req.get(REQUEST_GUILD_HEADER));
      if (headerGuildId) {
        return headerGuildId;
      }

      return allowFallback ? fallbackGuildId() : '';
    };

    const refreshDiscordAccessToken = async (req) => {
      const refreshToken = String(req.session?.discordUser?.refreshToken || '').trim();
      if (!refreshToken) {
        return null;
      }

      const oauthRedirectUri = req.session?.oauthRedirectUri || resolveOAuthRedirectUri(req);
      const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          client_id: process.env.CLIENT_ID,
          client_secret: process.env.DISCORD_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          redirect_uri: oauthRedirectUri
        })
      });

      if (!tokenResponse.ok) {
        return null;
      }

      const tokenData = await tokenResponse.json();
      if (!tokenData?.access_token) {
        return null;
      }

      req.session.discordUser = {
        ...(req.session.discordUser || {}),
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || refreshToken,
        tokenExpiresAt: Date.now() + (Math.max(60, Number(tokenData.expires_in || 3600)) - 30) * 1000
      };
      return req.session.discordUser.accessToken;
    };

    const getValidDiscordAccessToken = async (req) => {
      const sessionUser = req.session?.discordUser || null;
      if (!sessionUser) return null;

      const accessToken = String(sessionUser.accessToken || '').trim();
      const tokenExpiresAt = Number(sessionUser.tokenExpiresAt || 0);
      if (accessToken && tokenExpiresAt > Date.now()) {
        return accessToken;
      }
      if (accessToken && !tokenExpiresAt) {
        return accessToken;
      }
      return refreshDiscordAccessToken(req);
    };

    const getDiscordUserGuilds = async (req) => {
      try {
        const accessToken = await getValidDiscordAccessToken(req);
        if (!accessToken) {
          return [];
        }

        let response = await fetch('https://discord.com/api/users/@me/guilds', {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });

        if (response.status === 401) {
          const refreshedToken = await refreshDiscordAccessToken(req);
          if (refreshedToken) {
            response = await fetch('https://discord.com/api/users/@me/guilds', {
              headers: {
                Authorization: `Bearer ${refreshedToken}`
              }
            });
          }
        }

        if (!response.ok) {
          return [];
        }

        const guilds = await response.json();
        return Array.isArray(guilds) ? guilds : [];
      } catch (_error) {
        return [];
      }
    };

    const getBotGuildIds = async () => {
      if (!this.client) {
        return new Set();
      }

      try {
        const liveGuilds = await this.client.guilds.fetch();
        if (liveGuilds && typeof liveGuilds.map === 'function') {
          return new Set(liveGuilds.map(guild => guild.id));
        }
      } catch (error) {
        logger.warn('Could not fetch live bot guild list, falling back to cache:', error?.message || error);
      }

      return new Set(this.client.guilds.cache.map(guild => guild.id));
    };

    const fetchGuildById = async (guildId) => {
      const normalizedGuildId = normalizeGuildId(guildId);
      if (!normalizedGuildId || !this.client) {
        return null;
      }

      return this.client.guilds.cache.get(normalizedGuildId) || this.client.guilds.fetch(normalizedGuildId).catch(() => null);
    };

    this.app.use(['/api/verify', '/api/micro-verify'], (req, _res, next) => {
      const requestedGuildId = getRequestedGuildId(req, {
        allowFallback: !tenantService.isMultitenantEnabled()
      });
      if (requestedGuildId) {
        req.guildId = requestedGuildId;
      }
      next();
    });

    const guildIconUrl = (guild) => {
      if (!guild?.id || !guild?.icon) return null;
      return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=256`;
    };

    const resolveAdminGuildAccess = async (req, { allowFallback = false } = {}) => {
      if (!req.session.discordUser) {
        return { ok: false, status: 401, message: 'Not authenticated' };
      }

      if (!this.client) {
        return { ok: false, status: 500, message: 'Bot not initialized' };
      }

      const userId = req.session.discordUser.id;
      const requestedGuildId = getRequestedGuildId(req, { allowFallback });

      if (!requestedGuildId) {
        return { ok: false, status: 409, message: 'Select a server to continue' };
      }

      const isSuperadmin = superadminService.isSuperadmin(userId);
      const guild = await fetchGuildById(requestedGuildId);

      if (!guild) {
        return { ok: false, status: 404, message: 'Server not found' };
      }

      const guildSummary = {
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        permissions: null
      };

      if (isSuperadmin) {
        const headerGuildId = normalizeGuildId(req.get(REQUEST_GUILD_HEADER));
        const fallback = fallbackGuildId();
        if (headerGuildId && headerGuildId !== fallback) {
          logger.log(`[tenant-cross] superadmin=${userId} route=${req.method} ${req.originalUrl} guild=${headerGuildId}`);
        }

        return {
          ok: true,
          isSuperadmin,
          guild,
          guildId: requestedGuildId,
          guildSummary
        };
      }

      const discordGuilds = await getDiscordUserGuilds(req);
      const userGuild = discordGuilds.find(entry => entry.id === requestedGuildId);
      if (!userGuild || !hasDiscordAdminPermission(userGuild)) {
        // Fallback: fetch user as guild member directly (covers guilds where OAuth scope is limited)
        const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
        if (member?.permissions && (member.permissions.has('Administrator') || member.permissions.has('ManageGuild'))) {
          const botGuildIds = await getBotGuildIds();
          if (!botGuildIds.has(requestedGuildId)) {
            return { ok: false, status: 403, message: 'Bot is not installed in the selected server' };
          }

          return {
            ok: true,
            isSuperadmin,
            guild,
            guildId: requestedGuildId,
            guildSummary: {
              id: guild.id,
              name: guild.name,
              icon: guild.icon,
              permissions: member.permissions.bitfield?.toString?.() || '0'
            }
          };
        }

        return { ok: false, status: 403, message: 'Admin permission required' };
      }

      const botGuildIds = await getBotGuildIds();
      if (!botGuildIds.has(requestedGuildId)) {
        return { ok: false, status: 403, message: 'Bot is not installed in the selected server' };
      }

      return {
        ok: true,
        isSuperadmin,
        guild,
        guildId: requestedGuildId,
        guildSummary: {
          id: userGuild.id,
          name: userGuild.name,
          icon: userGuild.icon,
          permissions: userGuild.permissions
        }
      };
    };

    const sendSelectServerMessage = (res, status = 409) => {
      return res.status(status).json(toErrorResponse('Select a server to continue', 'TENANT_REQUIRED'));
    };

    function ensureTenantModuleEnabled(req, res, moduleKey, moduleLabel) {
      if (!tenantService.isMultitenantEnabled()) return true;
      if (!req.guildId) return true;
      const actorId = String(req.session?.discordUser?.id || '').trim();
      if (actorId && superadminService.isSuperadmin(actorId)) return true;
      if (tenantService.isModuleEnabled(req.guildId, moduleKey)) return true;
      res.status(403).json(toErrorResponse(`${moduleLabel} module is disabled for this server.`, 'FORBIDDEN'));
      return false;
    }

    function ensureVerificationModule(req, res) {
      return ensureTenantModuleEnabled(req, res, 'verification', 'Verification');
    }

    function ensureSelfServeRolesModule(req, res) {
      return ensureTenantModuleEnabled(req, res, 'selfserveroles', 'Self-Serve Roles');
    }

    function ensureEngagementModule(req, res) {
      return ensureTenantModuleEnabled(req, res, 'engagement', 'Engagement');
    }

    function ensureGovernanceModule(req, res) {
      return ensureTenantModuleEnabled(req, res, 'governance', 'Governance');
    }

    function ensureHeistModule(req, res) {
      return ensureTenantModuleEnabled(req, res, 'heist', 'Missions');
    }

    function ensureBrandingModule(req, res) {
      return ensureTenantModuleEnabled(req, res, 'branding', 'Branding');
    }

    function ensureNftTrackerModule(req, res) {
      return ensureTenantModuleEnabled(req, res, 'nfttracker', 'NFT Tracker');
    }

    function ensureTokenTrackerModule(req, res) {
      return ensureTenantModuleEnabled(req, res, 'tokentracker', 'Token Tracker');
    }

    function ensureWalletTrackerModule(req, res) {
      return ensureTenantModuleEnabled(req, res, 'wallettracker', 'Wallet Tracker');
    }

    function ensureMinigamesModule(req, res) {
      return ensureTenantModuleEnabled(req, res, 'minigames', 'Minigames');
    }

    function ensureTicketingModule(req, res) {
      return ensureTenantModuleEnabled(req, res, 'ticketing', 'Ticketing');
    }

    // ==================== API V1 (VERSIONED PUBLIC API) ====================

    const v1Router = require('./routes/v1');
    const { errorHandler, notFoundHandler } = require('../utils/apiErrorHandler');

    this.app.use('/api/public/v1', (req, _res, next) => {
      const scopedGuildId = normalizeGuildId(
        String(req.query?.guildId || req.query?.guild || req.get(REQUEST_GUILD_HEADER) || '')
      );
      if (scopedGuildId) {
        req.guildId = scopedGuildId;
      }
      next();
    });

    // Mount v1 API routes (standardized, versioned)
    this.app.use('/api/public/v1', v1Router);
    
    // ==================== PUBLIC PAGES ====================
    
    const appendQueryParam = (params, key, value) => {
      if (value === undefined || value === null || value === '') return;
      if (Array.isArray(value)) {
        if (value.length > 0) params.set(key, String(value[0]));
        return;
      }
      params.set(key, String(value));
    };

    const redirectToPortalSection = (req, res, section, options = {}) => {
      const { requireAuth = false, forcedParams = {} } = options;
      const qs = new URLSearchParams();
      qs.set('section', section);

      Object.entries(req.query || {}).forEach(([key, value]) => {
        if (key === 'section') return;
        appendQueryParam(qs, key, value);
      });

      Object.entries(forcedParams).forEach(([key, value]) => {
        appendQueryParam(qs, key, value);
      });

      const dest = '/?' + qs.toString();
      if (requireAuth && !req.session.discordUser) {
        req.session.returnTo = dest;
        return res.redirect('/auth/discord/login');
      }
      return res.redirect(dest);
    };

    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'portal.html'));
    });

    this.app.get('/verify', (req, res) => {
      // Unified UI: send verification flow to portal wallets section
      return redirectToPortalSection(req, res, 'wallets', { requireAuth: true });
    });

    const portalAliasRoutes = {
      '/dashboard': 'dashboard',
      '/servers': 'servers',
      '/governance': 'governance',
      '/wallets': 'wallets',
      '/heist': 'heist',
      '/nft-activity': 'nft-activity',
      '/token-activity': 'token-activity',
      '/battle': 'battle',
      '/engagement': 'engagement',
      '/self-serve-roles': 'self-serve-roles',
      '/ticketing': 'ticketing',
      '/treasury': 'treasury',
      '/help': 'help',
      '/plans': 'plans',
      '/settings': 'settings',
      '/admin': 'admin'
    };

    Object.entries(portalAliasRoutes).forEach(([routePath, section]) => {
      this.app.get(routePath, (req, res) => redirectToPortalSection(req, res, section));
    });

    this.app.get('/superadmin', (req, res) => {
      return redirectToPortalSection(req, res, 'admin', {
        forcedParams: { adminView: 'superadmin' }
      });
    });

    this.app.get('/monitor', (req, res) => {
      return redirectToPortalSection(req, res, 'admin', {
        forcedParams: { adminView: 'monitor' }
      });
    });

    // Legal pages (required for Discord app verification)
    this.app.get('/privacy-policy', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'privacy-policy.html'));
    });
    this.app.get('/terms-of-service', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'terms-of-service.html'));
    });

    // Keep advanced admin dashboard accessible for deep management tools
    this.app.get('/admin-panel', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    });

    // ==================== FEATURE FLAGS ====================

    const createAuthUserRouter = require('./routes/authUser');
    this.app.use('/', createAuthUserRouter({
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
      getClient: () => this.client,
    }));
    const createGovernanceUserRouter = require('./routes/governanceUser');
    this.app.use('/', createGovernanceUserRouter({
      logger,
      roleService,
      proposalService,
      tenantService,
      getRequestedGuildId,
      isProposalInGuildScope: (...args) => isProposalInGuildScope(...args),
      ensurePublicGovernanceScope: (...args) => ensurePublicGovernanceScope(...args),
      commentLimiter,
    }));
    const createUserAdminCheckRouter = require('./routes/userAdminCheck');
    this.app.use('/', createUserAdminCheckRouter({
      logger,
      resolveAdminGuildAccess,
    }));

    const createSuperadminCoreRouter = require('./routes/superadminCore');
    this.app.use('/api/superadmin', createSuperadminCoreRouter({
      superadminGuard,
      superadminService,
      tenantService,
      settingsManager,
      logger,
      getActivityWebhookSecret,
    }));

    const createSuperadminAdminsRouter = require('./routes/superadminAdmins');
    this.app.use('/api/superadmin', createSuperadminAdminsRouter({
      superadminGuard,
      superadminService,
      logger,
    }));

    const createSuperadminIdentityRouter = require('./routes/superadminIdentity');
    this.app.use('/api/superadmin/identity', createSuperadminIdentityRouter({
      superadminGuard,
      superadminIdentityService,
      logger,
    }));

    const createSuperadminTenantOpsRouter = require('./routes/superadminTenantOps');
    this.app.use('/api/superadmin', createSuperadminTenantOpsRouter({
      superadminGuard,
      tenantService,
      entitlementService,
      monetizationTemplateService,
      getPlanKeys,
      getPlanPreset,
      fetchGuildById,
      guildIconUrl,
      normalizeGuildId,
      requestGuildHeader: REQUEST_GUILD_HEADER,
      fs,
      path,
      logger,
      client: this.client,
      getGuildBotProfileSnapshot,
      applyGuildBotProfileBranding,
    }));

    const createSuperadminOpsRouter = require('./routes/superadminOps');
    this.app.use('/api/superadmin', createSuperadminOpsRouter({
      superadminGuard,
      battleService,
      nftActivityService,
      BATTLE_ERAS,
      db,
      os,
      exec,
      logger,
    }));

    const adminAuthMiddleware = async (req, res, next) => {
      try {
        const access = await resolveAdminGuildAccess(req, { allowFallback: false });
        if (!access.ok) {
          return res.status(access.status).json(toErrorResponse(access.message, 'FORBIDDEN'));
        }

        req.guildId = access.guildId;
        req.guild = access.guild;
        req.guildName = access.guild?.name || null;
        req.isSuperadmin = access.isSuperadmin;
        next();
      } catch (error) {
        logger.error('Admin auth error:', error);
        return res.status(500).json(toErrorResponse('Authorization check failed'));
      }
    };

    const createAdminCoreRouter = require('./routes/adminCore');
    this.app.use('/api/admin', createAdminCoreRouter({
      adminAuthMiddleware,
      ensureBrandingModule,
      tenantService,
      fetchGuildById,
      guildIconUrl,
      billingService,
      logger,
      normalizeWebhookValue,
      getActivityWebhookSecret,
      client: this.client,
      getGuildBotProfileSnapshot,
      applyGuildBotProfileBranding,
    }));

    const createAdminSettingsRouter = require('./routes/adminSettings');
    this.app.use('/', createAdminSettingsRouter({
      logger,
      adminAuthMiddleware,
      settingsManager,
      tenantService,
      fetchGuildById,
      guildIconUrl,
      ticketService,
    }));

    const createAdminUsersDirectoryRouter = require('./routes/adminUsersDirectory');
    const createAdminGovernanceMissionsRouter = require('./routes/adminGovernanceMissions');

    // Role configuration endpoints
    const parseRuleBoolean = (value, defaultValue = false) => {
      if (value === null || value === undefined) return defaultValue;
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value === 1;
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
      }
      return defaultValue;
    };

    const normalizeTierRule = (rule = {}) => ({
      ...rule,
      neverRemove: parseRuleBoolean(
        rule.neverRemove ?? rule.never_remove ?? rule.keepOnLoss ?? rule.keep_on_loss,
        false
      )
    });

    const normalizeTraitRule = (rule = {}) => ({
      ...rule,
      neverRemove: parseRuleBoolean(
        rule.neverRemove ?? rule.never_remove ?? rule.keepOnLoss ?? rule.keep_on_loss,
        false
      )
    });

    const getTenantRoleConfig = (guildId) => {
      const row = db.prepare('SELECT tiers_json, traits_json FROM tenant_role_configs WHERE guild_id = ?').get(guildId);
      if (!row) {
        return {
          tiers: [],
          traitRoles: [],
          tokenRules: roleService.getTokenRoleRules(guildId)
        };
      }
      let tiers = [];
      let traitRoles = [];
      try { tiers = JSON.parse(row.tiers_json || '[]'); } catch {}
      try { traitRoles = JSON.parse(row.traits_json || '[]'); } catch {}
      const normalizedTiers = Array.isArray(tiers) ? tiers.map(normalizeTierRule) : [];
      const normalizedTraits = Array.isArray(traitRoles) ? traitRoles.map(normalizeTraitRule) : [];
      return {
        tiers: normalizedTiers,
        traitRoles: normalizedTraits,
        tokenRules: roleService.getTokenRoleRules(guildId)
      };
    };

    const saveTenantRoleConfig = (guildId, cfg) => {
      const normalizedTiers = Array.isArray(cfg.tiers) ? cfg.tiers.map(normalizeTierRule) : [];
      const normalizedTraits = Array.isArray(cfg.traitRoles) ? cfg.traitRoles.map(normalizeTraitRule) : [];
      db.prepare(`
        INSERT INTO tenant_role_configs (guild_id, tiers_json, traits_json, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(guild_id) DO UPDATE SET
          tiers_json = excluded.tiers_json,
          traits_json = excluded.traits_json,
          updated_at = CURRENT_TIMESTAMP
      `).run(guildId, JSON.stringify(normalizedTiers), JSON.stringify(normalizedTraits));
    };

    const getVerificationRuleCounts = (guildId, { tenantScoped = true } = {}) => {
      const source = tenantScoped
        ? getTenantRoleConfig(guildId)
        : roleService.getRoleConfigSummary();
      const tierCount = Array.isArray(source.tiers) ? source.tiers.length : 0;
      const traitCount = Array.isArray(source.traitRoles) ? source.traitRoles.length : 0;
      const tokenCount = Array.isArray(source.tokenRules)
        ? source.tokenRules.filter(rule => !guildId || String(rule.guildId || '') === String(guildId)).length
        : 0;
      return {
        tiers: tierCount,
        traits: traitCount,
        tokens: tokenCount,
        total: tierCount + traitCount + tokenCount,
      };
    };

    const checkVerificationLimit = (guildId, limitKey, currentCount, itemLabel) => {
      return entitlementService.enforceLimit({
        guildId,
        moduleKey: 'verification',
        limitKey,
        currentCount,
        incrementBy: 1,
        itemLabel,
      });
    };

    const hasProposalsGuildColumn = (() => {
      let cached = null;
      return () => {
        if (cached !== null) return cached;
        try {
          const columns = db.prepare('PRAGMA table_info(proposals)').all();
          cached = columns.some(column => String(column?.name || '').toLowerCase() === 'guild_id');
        } catch (_error) {
          cached = false;
        }
        return cached;
      };
    })();

    const getProposalRow = (proposalId) => {
      if (!proposalId) return null;
      try {
        return db.prepare('SELECT proposal_id, guild_id, status FROM proposals WHERE proposal_id = ?').get(String(proposalId).trim());
      } catch (_error) {
        return null;
      }
    };

    const countActiveGovernanceProposals = (guildId) => {
      const normalizedGuildId = String(guildId || '').trim();
      if (tenantService.isMultitenantEnabled() && !hasProposalsGuildColumn()) {
        return 0;
      }
      if (hasProposalsGuildColumn() && normalizedGuildId) {
        return Number(db.prepare(`
          SELECT COUNT(*) AS cnt
          FROM proposals
          WHERE guild_id = ?
            AND status IN ('supporting', 'voting')
        `).get(normalizedGuildId)?.cnt || 0);
      }

      return Number(db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM proposals
        WHERE status IN ('supporting', 'voting')
      `).get()?.cnt || 0);
    };

    const isProposalInGuildScope = (proposalId, guildId) => {
      const proposal = getProposalRow(proposalId);
      if (!proposal) return false;
      if (!hasProposalsGuildColumn()) return true;
      const proposalGuildId = String(proposal.guild_id || '').trim();
      const requestedGuildId = String(guildId || '').trim();
      if (!proposalGuildId) return !tenantService.isMultitenantEnabled();
      return requestedGuildId && proposalGuildId === requestedGuildId;
    };

    const getPublicRequestedGuildId = (req) => {
      const queryGuildId = normalizeGuildId(String(req.query?.guildId || req.query?.guild || '').trim());
      if (queryGuildId) return queryGuildId;
      const headerGuildId = normalizeGuildId(req.get(REQUEST_GUILD_HEADER));
      if (headerGuildId) return headerGuildId;
      return '';
    };

    const ensurePublicGovernanceScope = (req, res) => {
      const guildId = getPublicRequestedGuildId(req);
      if (tenantService.isMultitenantEnabled() && !hasProposalsGuildColumn()) {
        res.status(500).json(toErrorResponse('Governance schema is not tenant-scoped. Run database migrations to continue.'));
        return null;
      }
      if (tenantService.isMultitenantEnabled() && !guildId) {
        res.status(400).json(toErrorResponse('guildId query parameter (or x-guild-id header) is required in multi-tenant mode', 'VALIDATION_ERROR'));
        return null;
      }
      return guildId;
    };

    this.app.use('/', createAdminUsersDirectoryRouter({
      logger,
      db,
      adminAuthMiddleware,
      ensureVerificationModule,
      fetchGuildById,
      roleService,
      hasProposalsGuildColumn,
      tenantService,
      missionService,
      getClient: () => this.client,
    }));

    this.app.use('/', createAdminGovernanceMissionsRouter({
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
    }));

    const createVerificationRoleAdminRouter = require('./routes/verificationRoleAdmin');
    this.app.use('/', createVerificationRoleAdminRouter({
      logger,
      db,
      adminAuthMiddleware,
      ensureVerificationModule,
      tenantService,
      getTenantRoleConfig,
      saveTenantRoleConfig,
      getVerificationRuleCounts,
      checkVerificationLimit,
      parseRuleBoolean,
      roleService,
      fetchGuildById,
      getClient: () => this.client,
    }));

    // ==================== OG ROLE API ====================

    const createAdminRolesRouter = require('./routes/adminRoles');
    this.app.use('/', createAdminRolesRouter({
      logger,
      adminAuthMiddleware,
      ensureVerificationModule,
      ensureSelfServeRolesModule,
      fetchGuildById,
      getClient: () => this.client,
    }));
    const createAdminVerificationPanelRouter = require('./routes/adminVerificationPanel');
    this.app.use('/', createAdminVerificationPanelRouter({
      logger,
      db,
      adminAuthMiddleware,
      ensureVerificationModule,
      ensureVerificationPanelsSchema,
      getClient: () => this.client,
    }));
    const createAdminRolePanelsRouter = require('./routes/adminRolePanels');
    this.app.use('/', createAdminRolePanelsRouter({
      logger,
      adminAuthMiddleware,
      ensureSelfServeRolesModule,
      fetchGuildById,
      getClient: () => this.client,
    }));

    const createUserWalletVerificationRouter = require('./routes/userWalletVerification');
    this.app.use('/', createUserWalletVerificationRouter({
      logger,
      db,
      getBranding,
      fetchGuildById,
      roleService,
      walletService,
      verifySignature: (walletAddress, signature, message) => this.verifySignature(walletAddress, signature, message),
    }));
    const createMicroVerifyUserRouter = require('./routes/microVerifyUser');
    this.app.use('/', createMicroVerifyUserRouter({
      logger,
      microVerifyService,
    }));

    const createAdminEngagementRouter = require('./routes/adminEngagement');
    this.app.use('/', createAdminEngagementRouter({
      logger,
      adminAuthMiddleware,
      ensureEngagementModule,
    }));
    const createAdminNftActivityRouter = require('./routes/adminNftActivity');
    this.app.use('/', createAdminNftActivityRouter({
      logger,
      adminAuthMiddleware,
      ensureNftTrackerModule,
      nftActivityService,
    }));
    const createAdminTrackersRouter = require('./routes/adminTrackers');
    this.app.use('/', createAdminTrackersRouter({
      logger,
      adminAuthMiddleware,
      ensureNftTrackerModule,
      nftActivityService,
      ensureMinigamesModule,
      battleService,
      ensureWalletTrackerModule,
      trackedWalletsService,
      ensureTokenTrackerModule,
    }));
    const createAdminTicketsRouter = require('./routes/adminTickets');
    this.app.use('/', createAdminTicketsRouter({
      logger,
      adminAuthMiddleware,
      ensureTicketingModule,
      ticketService,
    }));
    const createBillingWebhookRouter = require('./routes/billingWebhook');
    this.app.use('/', createBillingWebhookRouter({
      logger,
      db,
      tenantService,
      billingService,
      normalizeWebhookValue,
      timingSafeEquals,
      hashWebhookPayload,
      stableJson,
    }));
    const createActivityWebhooksRouter = require('./routes/activityWebhooks');
    this.app.use('/', createActivityWebhooksRouter({
      logger,
      nftActivityService,
      trackedWalletsService,
      getActivityWebhookSecret,
      normalizeWebhookSecretHeader,
      timingSafeEquals,
    }));

    // ==================== ERROR HANDLING ====================
    
    // 404 handler (must be after all routes)
    this.app.use(notFoundHandler);
    
    // Global error handler (must be last)
    this.app.use(errorHandler);
  }

  verifySignature(walletAddress, signatureBase58, message) {
    try {
      const publicKeyBytes = bs58.decode(walletAddress);
      const signatureBytes = bs58.decode(signatureBase58);
      const messageBytes = new TextEncoder().encode(message);

      return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
    } catch (error) {
      logger.error('Error verifying signature:', error);
      return false;
    }
  }

  start() {
    this.server = this.app.listen(this.port, () => {
      const baseUrl = normalizeOrigin(process.env.WEB_URL) || `http://localhost:${this.port}`;
      logger.log(`Web server running on port ${this.port}`);
      logger.log(`Verification URL: ${baseUrl}/verify`);
      logger.log(`Dashboard URL: ${baseUrl}/dashboard`);
      logger.log(`Admin Portal URL: ${baseUrl}/admin`);
    });

    const sweepEnabled = String(process.env.BILLING_EXPIRY_SWEEP_ENABLED || 'true').toLowerCase() !== 'false';
    if (sweepEnabled) {
      const intervalMs = Math.max(5 * 60 * 1000, Number(process.env.BILLING_EXPIRY_SWEEP_MS) || (60 * 60 * 1000));
      const graceMinutes = Math.max(0, Number(process.env.BILLING_EXPIRY_GRACE_MINUTES) || (24 * 60));

      const runBillingSweep = () => {
        try {
          const summary = billingService.enforceSubscriptionExpiry({ graceMinutes, batchSize: 100 });
          if (summary.scanned > 0 || summary.downgraded > 0 || summary.errors > 0) {
            logger.log(`[billing-expiry-sweep] scanned=${summary.scanned} downgraded=${summary.downgraded} errors=${summary.errors}`);
          }
        } catch (error) {
          logger.error('Billing expiry sweep failed:', error);
        }
      };

      setTimeout(runBillingSweep, 12 * 1000);
      this.billingSweepTimer = setInterval(runBillingSweep, intervalMs);
      this.billingSweepTimer.unref?.();
      logger.log(`[billing-expiry-sweep] enabled intervalMs=${intervalMs} graceMinutes=${graceMinutes}`);
    }
  }

  stop() {
    if (this.billingSweepTimer) {
      clearInterval(this.billingSweepTimer);
      this.billingSweepTimer = null;
    }

    if (this.server) {
      this.server.close();
      logger.log('ðŸ›‘ Web server stopped');
    }
  }
}

module.exports = WebServer;


