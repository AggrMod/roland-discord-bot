const express = require('express');
const session = require('express-session');
const BetterSqlite3Store = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
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
const { getPlanKeys, getPlanPreset } = require('../config/plans');

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
      'https://www.guildpilot.app',
      'https://discordbot.solpranos.com',
      'https://discordbot.the-solpranos.com',
      'https://the-solpranos.com',
      'https://www.the-solpranos.com'
    ].filter(Boolean)));
    if (process.env.NODE_ENV !== 'production') {
      allowedOrigins.push('http://localhost:3000', 'http://localhost:5173');
    }

    this.app.use(cors({
      origin: allowedOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', REQUEST_GUILD_HEADER, 'x-entitlement-secret', 'x-webhook-secret'],
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

    // Session secret enforcement
    const sessionSecret = process.env.SESSION_SECRET || 'solpranos-secret-key-change-this-in-production';
    if (!process.env.SESSION_SECRET || sessionSecret === 'solpranos-secret-key-change-this-in-production') {
      if (process.env.NODE_ENV === 'production') {
        console.error('FATAL: SESSION_SECRET is not set or uses the default value in production. Refusing to start.');
        process.exit(1);
      }
      logger.warn('WARNING: Using default session secret. Set SESSION_SECRET in production.');
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

    // CSRF: all admin/superadmin routes are session-protected with sameSite:lax cookies
    // which provides CSRF resistance. Dedicated csrf-csrf middleware removed due to
    // cookie-parser ordering issues; can be re-added as a standalone module in a future PR.
    // Stub endpoint so portal.js fetchCsrfToken() doesn't 404.
    this.app.get('/api/csrf-token', (req, res) => res.json({ token: '' }));
  }

  setupRoutes() {
    // Standardized API response helpers
    function apiError(res, status, code, message) {
      return res.status(status).json({ success: false, error: { code, message } });
    }
    function apiSuccess(res, data, meta = {}) {
      return res.json({ success: true, data, ...meta });
    }
    // Note: existing endpoints will be migrated to use apiError/apiSuccess gradually

    // ==================== RATE LIMITING ====================

    const rateLimitMessage = { success: false, message: 'Too many requests, please try again later.' };

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
        if (userId) return userId;
        const rawIp = req.ip || req.socket?.remoteAddress || '';
        return rateLimit.ipKeyGenerator(rawIp);
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

    const getDiscordUserGuilds = async (req) => {
      const accessToken = req.session?.discordUser?.accessToken;
      if (!accessToken) {
        return [];
      }

      const response = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });

      if (!response.ok) {
        return [];
      }

      const guilds = await response.json();
      return Array.isArray(guilds) ? guilds : [];
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
      const requestedGuildId = getRequestedGuildId(req);
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
      return res.status(status).json({ success: false, message: 'Select a server to continue' });
    };

    function ensureTenantModuleEnabled(req, res, moduleKey, moduleLabel) {
      if (!tenantService.isMultitenantEnabled()) return true;
      if (!req.guildId) return true;
      const actorId = String(req.session?.discordUser?.id || '').trim();
      if (actorId && superadminService.isSuperadmin(actorId)) return true;
      if (tenantService.isModuleEnabled(req.guildId, moduleKey)) return true;
      res.status(403).json({ success: false, message: `${moduleLabel} module is disabled for this server.` });
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

    function ensureTicketingModule(req, res) {
      return ensureTenantModuleEnabled(req, res, 'ticketing', 'Ticketing');
    }

    // ==================== API V1 (VERSIONED PUBLIC API) ====================

    const v1Router = require('./routes/v1');
    const { errorHandler, notFoundHandler } = require('../utils/apiErrorHandler');

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

    this.app.get('/api/features', publicApiLimiter, (req, res) => {
      try {
        const heistEnabled = process.env.HEIST_ENABLED === 'true';
        res.json({ 
          success: true, 
          heistEnabled 
        });
      } catch (error) {
        logger.error('Error fetching feature flags:', error);
        res.json({ success: true, heistEnabled: false });
      }
    });

    // ==================== DISCORD OAUTH ====================

    this.app.get('/auth/discord/login', (req, res) => {
      // Preserve returnTo context through OAuth so users land in the right place
      const rawReturn = req.query.returnTo || '';
      if (rawReturn && rawReturn.startsWith('/') && !rawReturn.startsWith('//')) {
        req.session.returnTo = rawReturn;
      } else if (req.query.guild || req.query.section) {
        // Legacy / bot-generated links: ?guild=ID&section=dashboard
        const qs = new URLSearchParams();
        if (req.query.guild) qs.set('guild', req.query.guild);
        if (req.query.section) qs.set('section', req.query.section);
        req.session.returnTo = '/?' + qs.toString();
      }

      const clientId = process.env.CLIENT_ID;
      const oauthRedirectUri = resolveOAuthRedirectUri(req);
      req.session.oauthRedirectUri = oauthRedirectUri;
      const redirectUri = encodeURIComponent(oauthRedirectUri);
      const scope = encodeURIComponent('identify guilds');
      const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}`;
      res.redirect(authUrl);
    });

    this.app.get('/auth/discord/callback', async (req, res) => {
      const { code } = req.query;

      if (!code) {
        return res.redirect('/dashboard?error=no_code');
      }

      try {
        const oauthRedirectUri = req.session?.oauthRedirectUri || resolveOAuthRedirectUri(req);
        if (req.session?.oauthRedirectUri) {
          delete req.session.oauthRedirectUri;
        }

        // Exchange code for access token
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({
            client_id: process.env.CLIENT_ID,
            client_secret: process.env.DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: oauthRedirectUri
          })
        });

        const tokenData = await tokenResponse.json();

        if (!tokenData.access_token) {
          return res.redirect('/dashboard?error=no_token');
        }

        // Get user info
        const userResponse = await fetch('https://discord.com/api/users/@me', {
          headers: {
            'Authorization': `Bearer ${tokenData.access_token}`
          }
        });

        const userData = await userResponse.json();

        // Store in session (do NOT persist access token â€” use transiently only)
        req.session.discordUser = {
          id: userData.id,
          username: userData.username,
          discriminator: userData.discriminator,
          avatar: userData.avatar
        };

        const returnTo = req.session.returnTo;
        delete req.session.returnTo;
        const safeReturn = returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
        res.redirect(safeReturn);
      } catch (error) {
        logger.error('OAuth callback error:', error);
        res.redirect('/dashboard?error=auth_failed');
      }
    });

    this.app.get('/auth/discord/logout', (req, res) => {
      req.session.destroy();
      res.redirect('/dashboard');
    });

    // ==================== USER API (DASHBOARD) ====================

    this.app.get('/api/user/me', async (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      try {
        const discordId = req.session.discordUser.id;
        const userInfo = await roleService.getUserInfo(discordId);
        const wallets = db.prepare('SELECT wallet_address, is_favorite, primary_wallet, created_at FROM wallets WHERE discord_id = ? ORDER BY is_favorite DESC, created_at ASC').all(discordId);
        const userPrefs = db.prepare('SELECT wallet_alert_identity_opt_out FROM users WHERE discord_id = ?').get(discordId) || {};
        const requestedGuildId = getRequestedGuildId(req, { allowFallback: true });
        
        // Get user's proposals
        const proposals = (hasProposalsGuildColumn() && requestedGuildId)
          ? db.prepare("SELECT * FROM proposals WHERE creator_id = ? AND guild_id = ? AND status NOT IN ('expired') ORDER BY created_at DESC").all(discordId, requestedGuildId)
          : db.prepare("SELECT * FROM proposals WHERE creator_id = ? AND status NOT IN ('expired') ORDER BY created_at DESC").all(discordId);
        
        // Get user's missions
        const missions = db.prepare(`
          SELECT m.*, mp.assigned_nft_name, mp.assigned_role, mp.points_awarded 
          FROM missions m
          JOIN mission_participants mp ON m.mission_id = mp.mission_id
          WHERE mp.participant_id = ? AND m.status IN (?, ?)
          ORDER BY mp.joined_at DESC
        `).all(discordId, 'recruiting', 'active');

        // Calculate total points
        const pointsResult = db.prepare('SELECT COALESCE(SUM(points_awarded), 0) as total FROM mission_participants WHERE participant_id = ?').get(discordId);

        res.json({
          success: true,
          user: {
            discordId,
            username: req.session.discordUser.username,
            avatar: req.session.discordUser.avatar,
            tier: userInfo ? userInfo.tier : 'None',
            votingPower: userInfo ? userInfo.voting_power : 0,
            totalNFTs: userInfo ? userInfo.total_nfts : 0,
            totalPoints: pointsResult.total,
            walletAlertIdentityOptOut: Number(userPrefs.wallet_alert_identity_opt_out || 0) === 1
          },
          wallets,
          proposals,
          missions
        });
      } catch (error) {
        logger.error('Error fetching user data:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/user/tickets', async (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }
      try {
        const discordId = req.session.discordUser.id;
        const guildId = getRequestedGuildId(req, { allowFallback: true });
        if (!guildId) return res.status(400).json({ success: false, message: 'Select a server first' });
        const tickets = ticketService.getAllTickets({ guildId, opener: discordId });
        res.json({ success: true, tickets });
      } catch (error) {
        logger.error('Error fetching user tickets:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/user/role-panels', async (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }
      try {
        const guildId = getRequestedGuildId(req, { allowFallback: true });
        if (!guildId) return res.status(400).json({ success: false, message: 'Select a server first' });
        const rolePanelService = require('../services/rolePanelService');
        const panels = rolePanelService.listPanels(guildId)
          .map(p => ({ ...p, roles: (p.roles || []).filter(r => r.enabled !== 0) }))
          .filter(p => (p.roles || []).length > 0);
        res.json({ success: true, panels });
      } catch (error) {
        logger.error('Error fetching user role panels:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/user/roles/toggle', async (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }
      try {
        const guildId = getRequestedGuildId(req, { allowFallback: true });
        const { roleId, panelId } = req.body || {};
        if (!guildId || !roleId) return res.status(400).json({ success: false, message: 'guild and role are required' });
        const guild = await fetchGuildById(guildId);
        if (!guild) return res.status(404).json({ success: false, message: 'Guild not found' });
        const member = await guild.members.fetch(req.session.discordUser.id).catch(() => null);
        if (!member) return res.status(404).json({ success: false, message: 'Member not found' });

        const rolePanelService = require('../services/rolePanelService');
        const panel = panelId ? rolePanelService.getPanel(parseInt(panelId), guildId) : rolePanelService.getPanelByRole(roleId, guildId);
        if (!panel) return res.status(400).json({ success: false, message: 'Panel not found' });
        if (!(panel.roles || []).some(r => r.role_id === roleId && r.enabled !== 0)) {
          return res.status(400).json({ success: false, message: 'Role not claimable in this panel' });
        }

        const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
        if (!role) return res.status(404).json({ success: false, message: 'Role not found in server' });

        const botMember = guild.members.me || await guild.members.fetch(this.client.user.id).catch(() => null);
        if (!botMember) return res.status(500).json({ success: false, message: 'Bot member not available' });
        if (!botMember.permissions.has('ManageRoles')) return res.status(403).json({ success: false, message: 'Bot lacks ManageRoles permission' });
        if (role.position >= botMember.roles.highest.position) return res.status(403).json({ success: false, message: 'Bot cannot manage this role (hierarchy)' });

        const hasRole = member.roles.cache.has(roleId);
        if (hasRole) {
          await member.roles.remove(role, 'Self-serve web role unclaim');
        } else {
          await member.roles.add(role, 'Self-serve web role claim');
        }

        if (!hasRole && panel.single_select === 1) {
          for (const r of panel.roles || []) {
            if (r.role_id === roleId) continue;
            if (member.roles.cache.has(r.role_id)) {
              const roleObj = guild.roles.cache.get(r.role_id);
              if (roleObj) await member.roles.remove(roleObj, 'Single-select panel enforcement (web)');
            }
          }
        }

        res.json({ success: true, action: hasRole ? 'removed' : 'added', roleName: role.name, message: `${hasRole ? 'Removed' : 'Added'} role: ${role.name}` });
      } catch (error) {
        logger.error('Error toggling user role via web:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/servers/me', async (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      if (!this.client) {
        return res.status(500).json({ success: false, message: 'Bot not initialized' });
      }

      try {
        const userId = req.session.discordUser.id;
        const isSuperadmin = superadminService.isSuperadmin(userId);
        const discordGuilds = await getDiscordUserGuilds(req);
        const botGuildIds = await getBotGuildIds();
        const managedServers = [];
        const unmanagedServers = [];

        // Superadmins can manage every tenant/server in this bot instance.
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

          // Also include any live bot guilds not yet in tenant table (edge case)
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

          // Superadmin should still see personal unmanaged candidates from Discord OAuth guild list
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
          return res.json({
            success: true,
            isSuperadmin,
            managedServers,
            unmanagedServers
          });
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
          if (!hasDiscordAdminPermission(guildSummary)) {
            continue;
          }

          const serverRecord = {
            guildId: guildSummary.id,
            name: guildSummary.name,
            icon: guildSummary.icon,
            permissions: guildSummary.permissions
          };

          if (botGuildIds.has(guildSummary.id)) {
            managedServers.push(serverRecord);
          } else {
            unmanagedServers.push(serverRecord);
          }
        }

        managedServers.sort((a, b) => a.name.localeCompare(b.name));
        unmanagedServers.sort((a, b) => a.name.localeCompare(b.name));

        res.json({
          success: true,
          isSuperadmin,
          managedServers,
          unmanagedServers
        });
      } catch (error) {
        logger.error('Error fetching user servers:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/servers/invite-link', async (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      try {
        const guildId = normalizeGuildId(req.query.guildId || '');
        const userId = req.session.discordUser.id;
        const isSuperadmin = superadminService.isSuperadmin(userId);
        const runtimeClientId = this.client?.application?.id || this.client?.user?.id || null;
        if (runtimeClientId && process.env.CLIENT_ID && process.env.CLIENT_ID !== runtimeClientId) {
          logger.warn(`[invite-link] CLIENT_ID mismatch detected. env=${process.env.CLIENT_ID} runtime=${runtimeClientId}. Using runtime id.`);
        }
        const clientId = runtimeClientId || process.env.CLIENT_ID;
        if (!clientId) {
          return res.status(500).json({ success: false, message: 'CLIENT_ID is not configured' });
        }

        if (guildId && !isSuperadmin) {
          const discordGuilds = await getDiscordUserGuilds(req);
          const guild = discordGuilds.find(entry => entry.id === guildId);
          if (!guild || !hasDiscordAdminPermission(guild)) {
            return res.status(403).json({ success: false, message: 'Admin permission required' });
          }
        }

        const permissions = process.env.BOT_INVITE_PERMISSIONS || '8';
        const baseUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${encodeURIComponent(permissions)}`;
        const redirectUrl = guildId
          ? `${baseUrl}&guild_id=${encodeURIComponent(guildId)}&disable_guild_select=true`
          : baseUrl;

        res.redirect(redirectUrl);
      } catch (error) {
        logger.error('Error building invite link:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/user/wallets/:address/favorite', (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      try {
        const discordId = req.session.discordUser.id;
        const walletAddress = req.params.address;

        const result = walletService.setFavoriteWallet(discordId, walletAddress);
        res.json(result);
      } catch (error) {
        logger.error('Error setting favorite wallet:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.delete('/api/user/wallets/:address', (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      try {
        const discordId = req.session.discordUser.id;
        const walletAddress = req.params.address;

        const result = walletService.removeWallet(discordId, walletAddress);
        res.json(result);
      } catch (error) {
        logger.error('Error removing wallet:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== USER VOTING ====================

    this.app.post('/api/user/vote', async (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      try {
        const discordId = req.session.discordUser.id;
        const username = req.session.discordUser.username;
        const { proposalId, choice } = req.body;

        if (!proposalId || !choice) {
          return res.status(400).json({ success: false, message: 'proposalId and choice are required' });
        }

        if (!['yes', 'no', 'abstain'].includes(choice.toLowerCase())) {
          return res.status(400).json({ success: false, message: 'Choice must be yes, no, or abstain' });
        }

        // Get user's voting power (castVote will use snapshot VP if available)
        const userInfo = await roleService.getUserInfo(discordId);
        if (!userInfo || !userInfo.voting_power || userInfo.voting_power < 1) {
          return res.status(403).json({ success: false, message: 'You need at least 1 verified NFT to vote' });
        }
        const result = proposalService.castVote(proposalId, discordId, choice.toLowerCase(), userInfo.voting_power);
        if (result.success) {
          // Update the Discord voting message with new tallies
          proposalService.updateVotingMessage(proposalId).catch(() => {});
        }
        res.json(result);
      } catch (error) {
        logger.error('Error casting vote via web:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Shared proposal input validation
    function validateProposalInput(body) {
      const { title, description } = body;
      if (!title?.trim()) return 'Title is required';
      if (title.length > 200) return 'Title must be 200 characters or less';
      if (!description?.trim()) return 'Description is required';
      if (description.length > 5000) return 'Description must be 5000 characters or less';
      return null;
    }

    // ==================== USER PROPOSAL CREATION ====================

    this.app.post('/api/user/proposals', async (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      try {
        const discordId = req.session.discordUser.id;
        const allowFallback = !tenantService.isMultitenantEnabled();
        const requestedGuildId = getRequestedGuildId(req, { allowFallback });
        const { title, description, category, costIndication } = req.body;
        if (!requestedGuildId) {
          return res.status(409).json({ success: false, message: 'Select a server to continue' });
        }

        const validationErr = validateProposalInput(req.body);
        if (validationErr) return res.status(400).json({ success: false, message: validationErr });

        const userInfo = await roleService.getUserInfo(discordId);
        if (!userInfo || !userInfo.voting_power || userInfo.voting_power < 1) {
          return res.status(403).json({ success: false, message: 'You need at least 1 verified NFT to create proposals' });
        }

        const result = proposalService.createProposal(discordId, {
          title,
          description,
          category: category || 'Other',
          costIndication: costIndication || null,
          guildId: requestedGuildId || ''
        });
        res.json(result);
      } catch (error) {
        logger.error('Error creating proposal via web:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== GOVERNANCE LIFECYCLE ENDPOINTS ====================

    // POST /api/governance/proposals â€” alias for user proposal creation (session auth)
    this.app.post('/api/governance/proposals', async (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }
      try {
        const discordId = req.session.discordUser.id;
        const allowFallback = !tenantService.isMultitenantEnabled();
        const requestedGuildId = getRequestedGuildId(req, { allowFallback });
        const { title, description, category, costIndication } = req.body;
        if (!requestedGuildId) {
          return res.status(409).json({ success: false, message: 'Select a server to continue' });
        }
        const validationErr = validateProposalInput(req.body);
        if (validationErr) return res.status(400).json({ success: false, message: validationErr });
        const userInfo = await roleService.getUserInfo(discordId);
        if (!userInfo || !userInfo.voting_power || userInfo.voting_power < 1) {
          return res.status(403).json({ success: false, message: 'You need at least 1 verified NFT to create proposals' });
        }
        const result = proposalService.createProposal(discordId, {
          title,
          description,
          category: category || 'Other',
          costIndication: costIndication || null,
          guildId: requestedGuildId || ''
        });
        res.json(result);
      } catch (error) {
        logger.error('Error creating proposal (governance):', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // POST /api/governance/proposals/:id/submit â€” author submits for review
    this.app.post('/api/governance/proposals/:id/submit', (req, res) => {
      if (!req.session.discordUser) return res.status(401).json({ success: false, message: 'Not authenticated' });
      try {
        const requestedGuildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
        if (!requestedGuildId) return res.status(409).json({ success: false, message: 'Select a server to continue' });
        if (!isProposalInGuildScope(req.params.id, requestedGuildId)) {
          return res.status(404).json({ success: false, message: 'Proposal not found' });
        }
        const result = proposalService.submitForReview(req.params.id, req.session.discordUser.id);
        res.json(result);
      } catch (error) {
        logger.error('Error submitting proposal for review:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // POST /api/governance/proposals/:id/support â€” add support (session auth)
    this.app.post('/api/governance/proposals/:id/support', async (req, res) => {
      if (!req.session.discordUser) return res.status(401).json({ success: false, message: 'Not authenticated' });
      try {
        const requestedGuildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
        if (!requestedGuildId) return res.status(409).json({ success: false, message: 'Select a server to continue' });
        if (!isProposalInGuildScope(req.params.id, requestedGuildId)) {
          return res.status(404).json({ success: false, message: 'Proposal not found' });
        }
        const result = proposalService.addSupporter(req.params.id, req.session.discordUser.id);
        res.json(result);
      } catch (error) {
        logger.error('Error adding support:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // GET /api/governance/proposals/:id/comments â€” public
    this.app.get('/api/governance/proposals/:id/comments', (req, res) => {
      try {
        const scopedGuildId = ensurePublicGovernanceScope(req, res);
        if (scopedGuildId === null) return;
        if (!isProposalInGuildScope(req.params.id, scopedGuildId)) {
          return res.status(404).json({ success: false, message: 'Proposal not found' });
        }
        const comments = proposalService.getComments(req.params.id);
        res.json({ success: true, comments });
      } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // POST /api/governance/proposals/:id/comments â€” session auth
    this.app.post('/api/governance/proposals/:id/comments', commentLimiter, (req, res) => {
      if (!req.session.discordUser) return res.status(401).json({ success: false, message: 'Not authenticated' });
      try {
        const requestedGuildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
        if (!requestedGuildId) return res.status(409).json({ success: false, message: 'Select a server to continue' });
        if (!isProposalInGuildScope(req.params.id, requestedGuildId)) {
          return res.status(404).json({ success: false, message: 'Proposal not found' });
        }
        const { content } = req.body;
        if (!content || !content.trim()) return res.status(400).json({ success: false, message: 'Content is required' });
        if (content.length > 1000) return res.status(400).json({ success: false, message: 'Comment must be 1000 characters or less' });
        const result = proposalService.addComment(req.params.id, req.session.discordUser.id, req.session.discordUser.username, content.trim());
        res.json(result);
      } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // POST /api/governance/proposals/:id/veto â€” council member veto vote
    this.app.post('/api/governance/proposals/:id/veto', async (req, res) => {
      if (!req.session.discordUser) return res.status(401).json({ success: false, message: 'Not authenticated' });
      try {
        const requestedGuildId = getRequestedGuildId(req, { allowFallback: !tenantService.isMultitenantEnabled() });
        if (!requestedGuildId) return res.status(409).json({ success: false, message: 'Select a server to continue' });
        if (!isProposalInGuildScope(req.params.id, requestedGuildId)) {
          return res.status(404).json({ success: false, message: 'Proposal not found' });
        }
        const { reason } = req.body;
        const result = proposalService.vetoProposal(req.params.id, req.session.discordUser.id, reason);
        res.json(result);
      } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== ADMIN CHECK ====================

    this.app.get('/api/user/is-admin', async (req, res) => {
      if (!req.session.discordUser) {
        return res.json({ isAdmin: false });
      }

      try {
        const access = await resolveAdminGuildAccess(req, { allowFallback: false });
        if (!access.ok) {
          return res.status(access.status).json({ isAdmin: false, message: access.message });
        }

        return res.json({ isAdmin: true });
      } catch (error) {
        logger.error('Admin check error:', error);
        return res.json({ isAdmin: false });
      }
    });

    this.app.get('/api/superadmin/me', (req, res) => {
      const userId = req.session?.discordUser?.id || null;

      res.json({
        success: true,
        userId,
        isRootSuperadmin: superadminService.isRootSuperadmin(userId),
        isSuperadmin: superadminService.isSuperadmin(userId)
      });
    });

    this.app.get('/api/superadmin/env-status', superadminGuard, (_req, res) => {
      res.json({
        mockMode: process.env.MOCK_MODE === 'true',
        heliusConfigured: !!process.env.HELIUS_API_KEY,
        solanaRpc: process.env.SOLANA_RPC_URL || 'default',
        nodeEnv: process.env.NODE_ENV || 'development',
        webhookSecretConfigured: !!getActivityWebhookSecret()
      });
    });

    // Global settings â€” no guild context required, superadmin only
    this.app.get('/api/superadmin/global-settings', superadminGuard, (req, res) => {
      try {
        const settings = settingsManager.getSettings();
        const ogRoleService = require('../services/ogRoleService');
        const ogCfg = ogRoleService.getConfig();
        res.json({
          success: true,
          settings: {
            moduleMicroVerifyEnabled: !!settings.moduleMicroVerifyEnabled,
            verificationReceiveWallet: settings.verificationReceiveWallet || process.env.VERIFICATION_RECEIVE_WALLET || '',
            verifyRequestTtlMinutes: settings.verifyRequestTtlMinutes || 15,
            pollIntervalSeconds: settings.pollIntervalSeconds || 30,
            verifyRateLimitMinutes: settings.verifyRateLimitMinutes || 5,
            maxPendingPerUser: settings.maxPendingPerUser || 1,
            chainEmojiMap: settings.chainEmojiMap || {},
            ogRoleId: ogCfg.roleId || '',
            ogRoleLimit: ogCfg.limit || 0,
          }
        });
      } catch (error) {
        logger.error('Error fetching global settings:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/superadmin/global-settings', superadminGuard, (req, res) => {
      try {
        const ALLOWED = [
          'moduleMicroVerifyEnabled', 'verificationReceiveWallet',
          'verifyRequestTtlMinutes', 'pollIntervalSeconds',
          'verifyRateLimitMinutes', 'maxPendingPerUser', 'chainEmojiMap'
        ];
        const patch = {};
        for (const key of ALLOWED) {
          if (req.body[key] !== undefined) patch[key] = req.body[key];
        }
        const result = settingsManager.updateSettings(patch);
        if (!result.success) return res.status(400).json(result);
        const afterSave = settingsManager.getSettings();

        // Sync microVerifyService config overrides in memory
        try {
          const microVerifyService = require('../services/microVerifyService');
          const syncMap = {
            moduleMicroVerifyEnabled: 'MICRO_VERIFY_ENABLED',
            verificationReceiveWallet: 'VERIFICATION_RECEIVE_WALLET',
            verifyRequestTtlMinutes: 'VERIFY_REQUEST_TTL_MINUTES',
            pollIntervalSeconds: 'POLL_INTERVAL_SECONDS',
          };
          const overrides = {};
          for (const [jsKey, envKey] of Object.entries(syncMap)) {
            if (patch[jsKey] !== undefined) overrides[envKey] = String(patch[jsKey]);
          }
          if (Object.keys(overrides).length) {
            microVerifyService.updateConfig(overrides);
            microVerifyService.stopPolling();
            microVerifyService.startPolling();
          }
        } catch (e) {
          logger.warn('microVerifyService sync warning:', e?.message || e);
        }

        logger.log(`[superadmin] global-settings updated by ${req.session?.discordUser?.id}: ${Object.keys(patch).join(', ')}`);
        res.json({ success: true, message: 'Global settings updated' });
      } catch (error) {
        logger.error('Error updating global settings:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/superadmin/admins', superadminGuard, (req, res) => {
      try {
        res.json({
          success: true,
          superadmins: superadminService.listSuperadmins()
        });
      } catch (error) {
        logger.error('Error fetching superadmins:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/superadmin/admins', superadminGuard, (req, res) => {
      try {
        const { userId } = req.body || {};
        if (!userId || !String(userId).trim()) {
          return res.status(400).json({ success: false, message: 'userId is required' });
        }

        const result = superadminService.addSuperadmin(userId, req.session.discordUser.id);
        if (!result.success) {
          return res.status(400).json(result);
        }

        res.json(result);
      } catch (error) {
        logger.error('Error adding superadmin:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.delete('/api/superadmin/admins/:userId', superadminGuard, (req, res) => {
      try {
        const result = superadminService.removeSuperadmin(req.params.userId, req.session.discordUser.id);
        if (!result.success) {
          const status = result.message === 'Cannot remove root superadmins' ? 403 : 400;
          return res.status(status).json(result);
        }

        res.json(result);
      } catch (error) {
        logger.error('Error removing superadmin:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/superadmin/identity/users', superadminGuard, (req, res) => {
      try {
        const q = req.query.q || '';
        const limit = req.query.limit;
        const offset = req.query.offset;
        const result = superadminIdentityService.listProfiles({ q, limit, offset });
        res.json({ success: true, ...result });
      } catch (error) {
        logger.error('Error listing superadmin identity users:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/superadmin/identity/users/:discordId', superadminGuard, (req, res) => {
      try {
        const profile = superadminIdentityService.getProfile(req.params.discordId);
        if (!profile) {
          return res.status(404).json({ success: false, message: 'User not found' });
        }
        res.json({ success: true, profile });
      } catch (error) {
        logger.error('Error getting superadmin identity profile:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/superadmin/identity/users/:discordId/flags', superadminGuard, (req, res) => {
      try {
        const result = superadminIdentityService.setFlags({
          discordId: req.params.discordId,
          trustedIdentity: req.body?.trustedIdentity,
          manualVerified: req.body?.manualVerified,
          notes: req.body?.notes,
          username: req.body?.username,
          actorId: req.session?.discordUser?.id || null,
        });
        if (!result.success) {
          return res.status(400).json(result);
        }
        res.json(result);
      } catch (error) {
        logger.error('Error updating superadmin identity flags:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/superadmin/identity/users/:discordId/wallets', superadminGuard, (req, res) => {
      try {
        const result = superadminIdentityService.linkWallet({
          discordId: req.params.discordId,
          walletAddress: req.body?.walletAddress,
          username: req.body?.username,
          primaryWallet: req.body?.primaryWallet,
          favoriteWallet: req.body?.favoriteWallet,
          actorId: req.session?.discordUser?.id || null,
          metadata: {
            source: 'superadmin_portal',
            reason: req.body?.reason || null,
          },
        });
        if (!result.success) {
          return res.status(400).json(result);
        }
        res.json(result);
      } catch (error) {
        logger.error('Error linking wallet via superadmin identity:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.delete('/api/superadmin/identity/users/:discordId/wallets/:walletAddress', superadminGuard, (req, res) => {
      try {
        const walletAddress = decodeURIComponent(req.params.walletAddress || '');
        const result = superadminIdentityService.unlinkWallet({
          discordId: req.params.discordId,
          walletAddress,
          actorId: req.session?.discordUser?.id || null,
          metadata: { source: 'superadmin_portal' },
        });
        if (!result.success) {
          const status = result.message === 'User not found' ? 404 : 400;
          return res.status(status).json(result);
        }
        res.json(result);
      } catch (error) {
        logger.error('Error unlinking wallet via superadmin identity:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/superadmin/identity/audit', superadminGuard, (req, res) => {
      try {
        const auditLogs = superadminIdentityService.listAudit({
          discordId: req.query.discordId || '',
          limit: req.query.limit,
          offset: req.query.offset,
        });
        res.json({ success: true, auditLogs });
      } catch (error) {
        logger.error('Error reading superadmin identity audit logs:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/superadmin/tenants', superadminGuard, (req, res) => {
      try {
        const result = tenantService.listTenants({
          q: req.query.q,
          status: req.query.status,
          page: req.query.page,
          pageSize: req.query.pageSize
        });

        res.json({
          success: true,
          tenants: result.tenants,
          pagination: result.pagination
        });
      } catch (error) {
        logger.error('Error fetching tenants:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    const logSuperadminTenantAction = (req, _res, next) => {
      const activeGuildId = normalizeGuildId(req.get(REQUEST_GUILD_HEADER));
      const targetGuildId = normalizeGuildId(req.params.guildId);
      if (activeGuildId && targetGuildId && activeGuildId !== targetGuildId) {
        logger.log(`[tenant-cross] superadmin=${req.session.discordUser.id} route=${req.method} ${req.originalUrl} active=${activeGuildId} target=${targetGuildId}`);
      }
      next();
    };

    this.app.get('/api/superadmin/tenants/:guildId/audit', superadminGuard, logSuperadminTenantAction, (req, res) => {
      try {
        const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10), 1), 100);
        const logs = tenantService.getTenantAuditLogs(req.params.guildId, limit);

        res.json({
          success: true,
          auditLogs: logs
        });
      } catch (error) {
        logger.error('Error fetching tenant audit logs:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/superadmin/tenants/:guildId', superadminGuard, logSuperadminTenantAction, async (req, res) => {
      try {
        const tenant = tenantService.getTenant(req.params.guildId);
        if (!tenant) {
          return res.status(404).json({ success: false, message: 'Tenant not found' });
        }

        const guild = await fetchGuildById(req.params.guildId);
        const fallbackLogo = guildIconUrl(guild);
        const branding = {
          ...(tenant.branding || {}),
          logo_url: tenant?.branding?.logo_url || fallbackLogo || null
        };

        res.json({
          success: true,
          tenant: {
            ...tenant,
            branding
          }
        });
      } catch (error) {
        logger.error('Error fetching tenant:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/superadmin/limits/catalog', superadminGuard, (_req, res) => {
      try {
        const plans = getPlanKeys().map(planKey => {
          const preset = getPlanPreset(planKey);
          return {
            key: planKey,
            label: preset?.label || planKey,
            description: preset?.description || '',
            billing: preset?.billing || null,
            moduleLimits: entitlementService.getPlanModuleLimits(planKey),
          };
        });

        res.json({
          success: true,
          plans,
          definitions: entitlementService.getLimitDefinitions(),
        });
      } catch (error) {
        logger.error('Error fetching limits catalog:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/superadmin/monetization/templates', superadminGuard, (_req, res) => {
      try {
        const templates = monetizationTemplateService.listTemplates();
        res.json({ success: true, templates });
      } catch (error) {
        logger.error('Error fetching monetization templates:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/superadmin/tenants/:guildId/template-preview', superadminGuard, logSuperadminTenantAction, (req, res) => {
      try {
        const templateKey = String(req.query?.templateKey || '').trim();
        if (!templateKey) {
          return res.status(400).json({ success: false, message: 'templateKey is required' });
        }

        const result = monetizationTemplateService.previewTemplate(
          req.params.guildId,
          templateKey
        );

        if (!result.success) {
          return res.status(400).json(result);
        }

        res.json(result);
      } catch (error) {
        logger.error('Error previewing monetization template:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/superadmin/tenants/:guildId/apply-template', superadminGuard, logSuperadminTenantAction, (req, res) => {
      try {
        const templateKey = String(req.body?.templateKey || '').trim();
        if (!templateKey) {
          return res.status(400).json({ success: false, message: 'templateKey is required' });
        }

        const result = monetizationTemplateService.applyTemplate(
          req.params.guildId,
          templateKey,
          req.session?.discordUser?.id || 'unknown'
        );

        if (!result.success) {
          return res.status(400).json(result);
        }

        res.json(result);
      } catch (error) {
        logger.error('Error applying monetization template:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/superadmin/tenants/:guildId/rollback-template', superadminGuard, logSuperadminTenantAction, (req, res) => {
      try {
        const result = monetizationTemplateService.rollbackLastTemplate(
          req.params.guildId,
          req.session?.discordUser?.id || 'unknown'
        );

        if (!result.success) {
          return res.status(400).json(result);
        }

        res.json(result);
      } catch (error) {
        logger.error('Error rolling back monetization template:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/superadmin/tenants/:guildId/limits', superadminGuard, logSuperadminTenantAction, (req, res) => {
      try {
        const snapshot = entitlementService.getTenantLimitSnapshot(req.params.guildId);
        if (!snapshot) {
          return res.status(404).json({ success: false, message: 'Tenant not found' });
        }

        res.json({ success: true, limits: snapshot });
      } catch (error) {
        logger.error('Error fetching tenant limits:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/superadmin/tenants/:guildId/limits', superadminGuard, logSuperadminTenantAction, (req, res) => {
      try {
        const guildId = req.params.guildId;
        const before = entitlementService.getTenantLimitSnapshot(guildId);
        if (!before) {
          return res.status(404).json({ success: false, message: 'Tenant not found' });
        }

        const updates = [];
        if (req.body && typeof req.body === 'object' && req.body.moduleKey && req.body.limitKey) {
          updates.push({
            moduleKey: req.body.moduleKey,
            limitKey: req.body.limitKey,
            limitValue: req.body.limitValue,
          });
        } else if (req.body && typeof req.body === 'object' && req.body.overrides && typeof req.body.overrides === 'object') {
          for (const [moduleKey, limitMap] of Object.entries(req.body.overrides)) {
            if (!limitMap || typeof limitMap !== 'object') continue;
            for (const [limitKey, limitValue] of Object.entries(limitMap)) {
              updates.push({ moduleKey, limitKey, limitValue });
            }
          }
        }

        if (updates.length === 0) {
          return res.status(400).json({ success: false, message: 'No valid limit updates provided' });
        }

        for (const update of updates) {
          const result = entitlementService.setTenantModuleOverride(
            guildId,
            update.moduleKey,
            update.limitKey,
            update.limitValue
          );
          if (!result.success) {
            return res.status(400).json(result);
          }
        }

        const after = entitlementService.getTenantLimitSnapshot(guildId);
        tenantService.logAudit(guildId, req.session?.discordUser?.id || 'unknown', 'set_module_limits', before, after);
        res.json({ success: true, limits: after });
      } catch (error) {
        logger.error('Error updating tenant limits:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/superadmin/tenants/:guildId/plan', superadminGuard, logSuperadminTenantAction, (req, res) => {
      try {
        const result = tenantService.setTenantPlan(
          req.params.guildId,
          req.body?.plan,
          req.session.discordUser.id
        );

        if (!result.success) {
          return res.status(400).json(result);
        }

        res.json(result);
      } catch (error) {
        logger.error('Error updating tenant plan:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/superadmin/tenants/:guildId/modules', superadminGuard, logSuperadminTenantAction, (req, res) => {
      try {
        const { moduleKey, enabled } = req.body || {};
        if (!moduleKey) {
          return res.status(400).json({ success: false, message: 'moduleKey is required' });
        }

        const result = tenantService.setTenantModule(
          req.params.guildId,
          moduleKey,
          enabled,
          req.session.discordUser.id
        );

        if (!result.success) {
          return res.status(400).json(result);
        }

        res.json(result);
      } catch (error) {
        logger.error('Error updating tenant module:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/superadmin/tenants/:guildId/status', superadminGuard, logSuperadminTenantAction, (req, res) => {
      try {
        const result = tenantService.setTenantStatus(
          req.params.guildId,
          req.body?.status,
          req.session.discordUser.id
        );

        if (!result.success) {
          return res.status(400).json(result);
        }

        res.json(result);
      } catch (error) {
        logger.error('Error updating tenant status:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/superadmin/tenants/:guildId/mock-data', superadminGuard, logSuperadminTenantAction, (req, res) => {
      try {
        const result = tenantService.setTenantMockData(
          req.params.guildId,
          !!req.body?.enabled,
          req.session.discordUser.id
        );

        if (!result.success) {
          return res.status(400).json(result);
        }

        res.json(result);
      } catch (error) {
        logger.error('Error updating tenant mock-data flag:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/superadmin/tenants/:guildId/logo-upload', superadminGuard, logSuperadminTenantAction, async (req, res) => {
      try {
        const guildId = req.params.guildId;
        const { dataUrl } = req.body || {};
        if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
          return res.status(400).json({ success: false, message: 'dataUrl (image) is required' });
        }

        const match = dataUrl.match(/^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/i);
        if (!match) {
          return res.status(400).json({ success: false, message: 'Unsupported image format' });
        }

        const mime = match[1].toLowerCase();
        const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
        const b64 = match[3];
        const buffer = Buffer.from(b64, 'base64');
        const maxBytes = 2 * 1024 * 1024;
        if (buffer.length > maxBytes) {
          return res.status(400).json({ success: false, message: 'Logo too large (max 2MB)' });
        }

        const uploadDir = path.join(__dirname, 'public', 'uploads', 'tenant-logos');
        fs.mkdirSync(uploadDir, { recursive: true });
        const safeGuildId = normalizeGuildId(guildId);
        const fileName = `${safeGuildId}-${Date.now()}.${ext}`;
        const filePath = path.join(uploadDir, fileName);
        fs.writeFileSync(filePath, buffer);

        const publicUrl = `/uploads/tenant-logos/${fileName}`;
        const result = tenantService.updateTenantBranding(guildId, { logo_url: publicUrl }, req.session.discordUser.id);
        if (!result.success) {
          return res.status(400).json(result);
        }

        return res.json({ success: true, logo_url: publicUrl });
      } catch (error) {
        logger.error('Error uploading tenant logo:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/superadmin/tenants/:guildId/branding', superadminGuard, logSuperadminTenantAction, async (req, res) => {
      try {
        const guildId = req.params.guildId;
        const ALLOWED_BRANDING_FIELDS = ['displayName', 'description', 'logoUrl', 'primaryColor', 'supportUrl', 'bot_display_name', 'brand_emoji', 'brand_color', 'display_name', 'primary_color', 'secondary_color', 'logo_url', 'icon_url', 'support_url'];
        const patch = {};
        for (const key of ALLOWED_BRANDING_FIELDS) {
          if ((req.body || {})[key] !== undefined) patch[key] = req.body[key];
        }
        const result = tenantService.updateTenantBranding(
          guildId,
          patch,
          req.session.discordUser.id
        );

        if (!result.success) {
          return res.status(400).json(result);
        }

        // Best-effort: apply tenant bot display name as guild-specific bot nickname
        // (Discord global username cannot be changed per server.)
        if (patch.bot_display_name && this.client) {
          try {
            const guild = await this.client.guilds.fetch(guildId).catch(() => null);
            const me = guild ? await guild.members.fetchMe().catch(() => null) : null;
            if (me) {
              await me.setNickname(String(patch.bot_display_name).slice(0, 32));
            }
          } catch (e) {
            logger.warn(`Could not set bot nickname for guild ${guildId}: ${e.message}`);
          }
        }

        res.json(result);
      } catch (error) {
        logger.error('Error updating tenant branding:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== SUPERADMIN SYSTEM STATUS ====================

    this.app.get('/api/superadmin/system-status', superadminGuard, async (req, res) => {
      try {
        const cpus = os.cpus();
        const cpuModel = cpus[0]?.model || 'Unknown';
        const cpuCount = cpus.length;

        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const memPct = Math.round((usedMem / totalMem) * 100);

        const uptimeSecs = os.uptime();
        const uptimeHours = Math.floor(uptimeSecs / 3600);
        const uptimeMins = Math.floor((uptimeSecs % 3600) / 60);

        const nodeMemory = process.memoryUsage();

        const getDisk = () => new Promise((resolve) => {
          exec('df -BM / | tail -1', (err, stdout) => {
            if (err) { resolve(null); return; }
            const parts = stdout.trim().split(/\s+/);
            resolve({ total: parts[1], used: parts[2], available: parts[3], pct: parts[4] });
          });
        });
        const getPm2 = () => new Promise((resolve) => {
          exec('pm2 jlist 2>/dev/null || echo []', (err, stdout) => {
            if (err) { resolve([]); return; }
            try {
              const pm2List = JSON.parse(stdout.trim());
              resolve(pm2List.map(p => ({
                name: p.name,
                status: p.pm2_env?.status || 'unknown',
                uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : null,
                restarts: p.pm2_env?.restart_time || 0,
                memory: p.monit?.memory || 0,
                cpu: p.monit?.cpu || 0,
              })));
            } catch (_) { resolve([]); }
          });
        });

        const [disk, pm2Processes] = await Promise.all([getDisk(), getPm2()]);

        res.json({
          cpu: { model: cpuModel, cores: cpuCount },
          memory: { total: totalMem, used: usedMem, free: freeMem, pct: memPct },
          node: { heapUsed: nodeMemory.heapUsed, heapTotal: nodeMemory.heapTotal, rss: nodeMemory.rss, version: process.version },
          uptime: { seconds: uptimeSecs, display: `${uptimeHours}h ${uptimeMins}m` },
          disk,
          pm2: pm2Processes,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        logger.error('[SystemStatus]', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // ==================== SUPERADMIN ERA ASSIGNMENTS ====================

    this.app.get('/api/superadmin/eras', superadminGuard, (req, res) => {
      try {
        const eras = battleService.getAssignableEras();
        res.json({ success: true, eras });
      } catch (error) {
        logger.error('Error fetching eras:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch eras' });
      }
    });

    this.app.get('/api/superadmin/era-assignments', superadminGuard, (req, res) => {
      try {
        const assignments = db.prepare(`
          SELECT bea.*, t.guild_name
          FROM battle_era_assignments bea
          LEFT JOIN tenants t ON t.guild_id = bea.guild_id
          ORDER BY bea.assigned_at DESC
        `).all();
        res.json({ success: true, assignments });
      } catch (error) {
        logger.error('Error fetching era assignments:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch era assignments' });
      }
    });

    this.app.post('/api/superadmin/era-assignments', superadminGuard, (req, res) => {
      try {
        const { guildId, eraKey } = req.body;
        if (!guildId || !eraKey) {
          return res.status(400).json({ success: false, message: 'guildId and eraKey are required' });
        }
        const normalizedEraKey = battleService.normalizeEraKey(eraKey);
        if (!BATTLE_ERAS[normalizedEraKey]) {
          return res.status(400).json({ success: false, message: 'Unknown era key' });
        }
        if (!battleService.isEraAssignable(normalizedEraKey)) {
          return res.status(400).json({ success: false, message: 'Era is not assignable via superadmin panel' });
        }
        db.prepare(`
          INSERT OR IGNORE INTO battle_era_assignments (guild_id, era_key, assigned_by)
          VALUES (?, ?, ?)
        `).run(guildId, normalizedEraKey, req.session.discordUser.id);
        res.json({ success: true, message: `Era "${normalizedEraKey}" assigned to guild ${guildId}` });
      } catch (error) {
        logger.error('Error assigning era:', error);
        res.status(500).json({ success: false, message: 'Failed to assign era' });
      }
    });

    this.app.delete('/api/superadmin/era-assignments/:guildId/:eraKey', superadminGuard, (req, res) => {
      try {
        const { guildId, eraKey } = req.params;
        const normalizedEraKey = battleService.normalizeEraKey(eraKey);
        const result = db.prepare('DELETE FROM battle_era_assignments WHERE guild_id = ? AND era_key = ?').run(guildId, normalizedEraKey);
        if (result.changes === 0) {
          return res.status(404).json({ success: false, message: 'Assignment not found' });
        }
        res.json({ success: true, message: `Era "${normalizedEraKey}" revoked from guild ${guildId}` });
      } catch (error) {
        logger.error('Error revoking era:', error);
        res.status(500).json({ success: false, message: 'Failed to revoke era' });
      }
    });

    this.app.post('/api/superadmin/nft-activity/replay', superadminGuard, async (req, res) => {
      try {
        const txSignature = String(req.body?.txSignature || req.body?.tx || '').trim();
        if (!txSignature) {
          return res.status(400).json({ success: false, message: 'txSignature is required' });
        }

        const result = await nftActivityService.replayEventByTx(txSignature);
        if (!result.success) {
          return res.status(404).json(result);
        }
        return res.json(result);
      } catch (error) {
        logger.error('Error replaying nft activity event:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== ADMIN API ====================

    const adminAuthMiddleware = async (req, res, next) => {
      try {
        const access = await resolveAdminGuildAccess(req, { allowFallback: false });
        if (!access.ok) {
          return res.status(access.status).json({ success: false, message: access.message });
        }

        req.guildId = access.guildId;
        req.guild = access.guild;
        req.guildName = access.guild?.name || null;
        req.isSuperadmin = access.isSuperadmin;
        next();
      } catch (error) {
        logger.error('Admin auth error:', error);
        res.status(500).json({ success: false, message: 'Authorization check failed' });
      }
    };

    this.app.get('/api/admin/env-status', adminAuthMiddleware, (req, res) => {
      res.json({
        mockMode: process.env.MOCK_MODE === 'true',
        heliusConfigured: !!process.env.HELIUS_API_KEY,
        solanaRpc: process.env.SOLANA_RPC_URL || 'default',
        nodeEnv: process.env.NODE_ENV || 'development',
        webhookSecretConfigured: !!getActivityWebhookSecret()
      });
    });

    this.app.get('/api/admin/branding', adminAuthMiddleware, async (req, res) => {
      if (!ensureBrandingModule(req, res)) return;
      try {
        const tenant = tenantService.getTenantContext(req.guildId);
        const guild = req.guild || await fetchGuildById(req.guildId);
        const fallbackLogo = guildIconUrl(guild);
        const branding = {
          ...(tenant?.branding || {}),
          logo_url: (tenant?.branding?.logo_url || tenant?.branding?.icon_url || fallbackLogo || null),
          icon_url: (tenant?.branding?.icon_url || tenant?.branding?.logo_url || fallbackLogo || null)
        };
        res.json({ success: true, branding });
      } catch (error) {
        logger.error('Error fetching admin branding:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/admin/branding', adminAuthMiddleware, (req, res) => {
      if (!ensureBrandingModule(req, res)) return;
      try {
        const ALLOWED_BRANDING_FIELDS = ['bot_display_name', 'brand_emoji', 'brand_color', 'logo_url', 'support_url', 'footer_text', 'display_name', 'primary_color', 'secondary_color', 'icon_url', 'ticketing_color', 'selfserve_color', 'nfttracker_color', 'ticket_panel_title', 'ticket_panel_description', 'selfserve_panel_title', 'selfserve_panel_description', 'nfttracker_panel_title', 'nfttracker_panel_description'];
        const patch = {};
        for (const key of ALLOWED_BRANDING_FIELDS) {
          if (req.body[key] !== undefined) patch[key] = req.body[key];
        }
        const result = tenantService.updateTenantBranding(req.guildId, patch, req.session?.discordUser?.id || 'unknown');
        if (!result.success) return res.status(400).json(result);
        res.json({ success: true, branding: result.tenant?.branding || null });
      } catch (error) {
        logger.error('Error updating admin branding:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/admin/settings', adminAuthMiddleware, async (req, res) => {
      try {
        const settings = settingsManager.getSettings();
        const tenantContext = tenantService.getTenantContext(req.guildId);
        const multiTenantEnabled = tenantService.isMultitenantEnabled();
        
        // Smart load: DB override â†’ .env fallback
        const guild = req.guild || await fetchGuildById(req.guildId);
        const tenantLogoFallback = guildIconUrl(guild);

        const effectiveSettings = {
          ...settings,
          // Channel overrides: if empty in DB, use .env
          proposalsChannelId: settings.proposalsChannelId || process.env.PROPOSALS_CHANNEL_ID || '',
          votingChannelId: settings.votingChannelId || process.env.VOTING_CHANNEL_ID || '',
          resultsChannelId: settings.resultsChannelId || process.env.RESULTS_CHANNEL_ID || '',
          governanceLogChannelId: settings.governanceLogChannelId || process.env.GOVERNANCE_LOG_CHANNEL_ID || '',
          
          // Verification wallet
          verificationReceiveWallet: settings.verificationReceiveWallet || process.env.VERIFICATION_RECEIVE_WALLET || '',
          nftActivityWebhookSecret: req.isSuperadmin
            ? (settings.nftActivityWebhookSecret || process.env.NFT_ACTIVITY_WEBHOOK_SECRET || '')
            : '',

          // Tenant scaffold flags
          multiTenantEnabled,
          tenantEnabled: multiTenantEnabled && !!tenantContext.tenant,
          readOnlyManaged: multiTenantEnabled ? tenantContext.readOnlyManaged : false,
          tenantBranding: tenantContext.branding
            ? { ...tenantContext.branding, logo_url: tenantContext.branding.logo_url || tenantLogoFallback || null }
            : (tenantLogoFallback ? { logo_url: tenantLogoFallback } : null)
        };

        const ticketGuildSettings = ticketService.getGuildTicketSettings(req.guildId);
        if (ticketGuildSettings?.channelNameTemplate) {
          effectiveSettings.ticketChannelNameTemplate = ticketGuildSettings.channelNameTemplate;
        }

        // In multitenant mode, module enabled states come from tenant module entitlements
        if (multiTenantEnabled && tenantContext?.tenant && tenantContext.modules) {
          const minigamesEnabled = tenantContext.modules.minigames === undefined
            ? !!tenantContext.modules.battle
            : !!tenantContext.modules.minigames;
          effectiveSettings.moduleMinigamesEnabled = minigamesEnabled;
          effectiveSettings.moduleBattleEnabled = minigamesEnabled;
          effectiveSettings.moduleGovernanceEnabled = !!tenantContext.modules.governance;
          effectiveSettings.moduleVerificationEnabled = !!tenantContext.modules.verification;
          effectiveSettings.moduleMissionsEnabled = !!tenantContext.modules.heist;
          effectiveSettings.moduleTreasuryEnabled = !!tenantContext.modules.treasury;
          effectiveSettings.moduleWalletTrackerEnabled = tenantContext.modules.wallettracker === undefined
            ? !!tenantContext.modules.treasury
            : !!tenantContext.modules.wallettracker;
          effectiveSettings.moduleNftTrackerEnabled = !!tenantContext.modules.nfttracker;
          effectiveSettings.moduleTokenTrackerEnabled = !!tenantContext.modules.tokentracker;
          effectiveSettings.moduleBrandingEnabled = !!tenantContext.modules.branding;
          effectiveSettings.moduleRoleClaimEnabled = !!tenantContext.modules.selfserveroles;
          effectiveSettings.moduleTicketingEnabled = !!tenantContext.modules.ticketing;
          effectiveSettings.moduleEngagementEnabled = !!tenantContext.modules.engagement;
          // tenant-specific verification settings (avoid cross-tenant OG leakage)
          const tenantVerification = tenantService.getTenantVerificationSettings(req.guildId);
          if (tenantVerification.ogRoleId !== undefined) effectiveSettings.ogRoleId = tenantVerification.ogRoleId || '';
          if (tenantVerification.ogRoleLimit !== undefined) effectiveSettings.ogRoleLimit = tenantVerification.ogRoleLimit || 0;
          // Tell the frontend which module keys are actually assigned (exist in tenant_modules)
          const assignedModuleKeys = Object.keys(tenantContext.modules);
          if (assignedModuleKeys.includes('battle') && !assignedModuleKeys.includes('minigames')) {
            assignedModuleKeys.push('minigames');
          }
          effectiveSettings.assignedModuleKeys = assignedModuleKeys;
        }

        if (effectiveSettings.moduleWalletTrackerEnabled === undefined) {
          effectiveSettings.moduleWalletTrackerEnabled = effectiveSettings.moduleTreasuryEnabled;
        }
        if (effectiveSettings.moduleMinigamesEnabled === undefined) {
          effectiveSettings.moduleMinigamesEnabled = effectiveSettings.moduleBattleEnabled !== undefined
            ? !!effectiveSettings.moduleBattleEnabled
            : true;
        }
        if (effectiveSettings.moduleBattleEnabled === undefined) {
          effectiveSettings.moduleBattleEnabled = !!effectiveSettings.moduleMinigamesEnabled;
        }

        // ogRoleId lives in og-role.json (ogRoleService).
        // In multi-tenant mode the DB lookup often fails (tenant not provisioned);
        // in single-tenant mode settings.json never held it.
        // Always overlay from ogRoleService as the authoritative source when the
        // effective value is still empty after tenant/settings resolution.
        if (!effectiveSettings.ogRoleId) {
          try {
            const ogRoleService = require('../services/ogRoleService');
            const ogCfg = ogRoleService.getConfig();
            logger.log(`[OG-DEBUG] GET /api/admin/settings ogRoleService config: ${JSON.stringify(ogCfg)}`);
            if (ogCfg.roleId) {
              effectiveSettings.ogRoleId = ogCfg.roleId;
              effectiveSettings.ogRoleLimit = ogCfg.limit || 0;
            }
          } catch (e) {
            logger.warn('OG role config read warning:', e?.message || e);
          }
        }

        res.json({ success: true, settings: effectiveSettings });
      } catch (error) {
        logger.error('Error fetching settings:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/admin/plan', adminAuthMiddleware, (req, res) => {
      try {
        const tenantContext = tenantService.getTenantContext(req.guildId);
        const snapshot = billingService.getSubscriptionSnapshot(req.guildId);
        const plan = tenantContext?.planKey || snapshot?.plan || 'starter';

        res.json({
          success: true,
          plan,
          planLabel: snapshot?.planLabel || tenantContext?.planLabel || plan,
          status: snapshot?.status || tenantContext?.status || 'active',
          expiresAt: snapshot?.expiresAt || null,
          billing: snapshot?.billing || null,
          renewal: snapshot?.renewal || { options: [] }
        });
      } catch (error) {
        logger.error('Error fetching admin plan:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/admin/billing/options', adminAuthMiddleware, (req, res) => {
      try {
        const tenantContext = tenantService.getTenantContext(req.guildId);
        const requestedPlan = normalizeWebhookValue(req.query.plan) || tenantContext?.planKey || 'starter';
        const requestedInterval = normalizeWebhookValue(req.query.interval) || tenantContext?.billing?.billingInterval || 'monthly';
        const options = billingService.getRenewalOptions({
          guildId: req.guildId,
          planKey: requestedPlan,
          interval: requestedInterval
        });

        res.json({
          success: true,
          plan: requestedPlan,
          interval: requestedInterval,
          options,
          supportUrl: billingService.getSupportUrl(req.guildId)
        });
      } catch (error) {
        logger.error('Error fetching billing options:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/admin/settings', adminAuthMiddleware, (req, res) => {
      try {
        const ALLOWED_SETTINGS_FIELDS = [
          'proposalsChannelId', 'votingChannelId', 'resultsChannelId', 'governanceLogChannelId',
          'quorumPercentage', 'supportThreshold', 'voteDurationHours',
          'moduleGovernanceEnabled', 'moduleVerificationEnabled', 'moduleTreasuryEnabled', 'moduleWalletTrackerEnabled',
          'moduleNftTrackerEnabled', 'moduleTokenTrackerEnabled', 'moduleBrandingEnabled', 'moduleMissionsEnabled', 'moduleBattleEnabled', 'moduleMinigamesEnabled',
          'moduleTicketingEnabled', 'moduleRoleClaimEnabled', 'moduleEngagementEnabled',
          'battleRoundPauseMinSec', 'battleRoundPauseMaxSec', 'battleElitePrepSec', 'battleForcedEliminationIntervalRounds', 'battleDefaultEra',
          'baseVerifiedRoleId', 'autoResyncEnabled', 'ogRoleId', 'ogRoleLimit',
          'treasuryWalletAddress', 'treasuryRefreshInterval', 'txAlertChannelId',
          'txAlertEnabled', 'txAlertIncomingOnly', 'txAlertMinSol',
          'displayName', 'displayEmoji', 'displayColor',
          'verificationReceiveWallet', 'nftActivityWebhookSecret',
          'ticketAutoCloseEnabled', 'ticketAutoCloseInactiveHours', 'ticketAutoCloseWarningHours', 'ticketChannelNameTemplate',
          'chainEmojiMap',
        ];
        const sanitized = {};
        for (const key of ALLOWED_SETTINGS_FIELDS) {
          if (req.body[key] !== undefined) sanitized[key] = req.body[key];
        }

        // Micro-transfer verification settings are global -> superadmin-only writes
        if (!req.isSuperadmin) {
          delete sanitized.moduleMicroVerifyEnabled;
          delete sanitized.verificationReceiveWallet;
          delete sanitized.nftActivityWebhookSecret;
          delete sanitized.verifyRequestTtlMinutes;
          delete sanitized.pollIntervalSeconds;
          delete sanitized.verifyRateLimitMinutes;
          delete sanitized.maxPendingPerUser;
          delete sanitized.chainEmojiMap;
        }

        // In multi-tenant mode, module toggle states live in tenant_modules â€” NOT settings.json.
        // Route them through setTenantModule so reads from GET /api/admin/settings reflect the change.
        const multiTenantEnabled = tenantService.isMultitenantEnabled();
        if (multiTenantEnabled && req.guildId) {
          const tenantContext = tenantService.getTenantContext(req.guildId);
          if (tenantContext?.tenant) {
            const moduleFieldMap = {
              moduleBattleEnabled: 'minigames',
              moduleMinigamesEnabled: 'minigames',
              moduleGovernanceEnabled: 'governance',
              moduleVerificationEnabled: 'verification',
              moduleMissionsEnabled: 'heist',
              moduleTreasuryEnabled: 'treasury',
              moduleWalletTrackerEnabled: 'wallettracker',
              moduleNftTrackerEnabled: 'nfttracker',
              moduleTokenTrackerEnabled: 'tokentracker',
              moduleBrandingEnabled: 'branding',
              moduleRoleClaimEnabled: 'selfserveroles',
              moduleTicketingEnabled: 'ticketing',
              moduleEngagementEnabled: 'engagement',
            };
            for (const [field, moduleKey] of Object.entries(moduleFieldMap)) {
              if (sanitized[field] !== undefined) {
                // Only allow toggling modules that are actually assigned to this tenant
                if (tenantContext.modules) {
                  const requestedEnabled = !!sanitized[field];
                  if (moduleKey === 'minigames') {
                    if ('minigames' in tenantContext.modules) {
                      const updateResult = tenantService.setTenantModule(req.guildId, 'minigames', requestedEnabled, req.session?.discordUser?.id);
                      if (!updateResult.success) {
                        return res.status(400).json(updateResult);
                      }
                    }
                    if ('battle' in tenantContext.modules) {
                      const updateResult = tenantService.setTenantModule(req.guildId, 'battle', requestedEnabled, req.session?.discordUser?.id);
                      if (!updateResult.success) {
                        return res.status(400).json(updateResult);
                      }
                    }
                  } else if (moduleKey in tenantContext.modules) {
                    const updateResult = tenantService.setTenantModule(req.guildId, moduleKey, requestedEnabled, req.session?.discordUser?.id);
                    if (!updateResult.success) {
                      return res.status(400).json(updateResult);
                    }
                  }
                }
                delete sanitized[field]; // Remove from settings.json payload regardless
              }
            }

            // Tenant-specific OG settings (do not write globally)
            const ogPatch = {};
            if (sanitized.ogRoleId !== undefined) ogPatch.ogRoleId = sanitized.ogRoleId;
            if (sanitized.ogRoleLimit !== undefined) ogPatch.ogRoleLimit = sanitized.ogRoleLimit;
            if (Object.keys(ogPatch).length > 0) {
              tenantService.updateTenantVerificationSettings(req.guildId, ogPatch, req.session?.discordUser?.id || 'unknown');
              delete sanitized.ogRoleId;
              delete sanitized.ogRoleLimit;
            }

            // Sync OG role service from tenant settings directly (not global settings.json).
            // Same rule: only update when a real roleId was submitted.
            if (Object.keys(ogPatch).length > 0) {
              try {
                const ogRoleService = require('../services/ogRoleService');
                if (ogPatch.ogRoleId) {
                  ogRoleService.setRole(ogPatch.ogRoleId);
                  ogRoleService.setEnabled(true);
                }
                if (ogPatch.ogRoleLimit !== undefined && ogPatch.ogRoleId) {
                  ogRoleService.setLimit(ogPatch.ogRoleLimit || 1);
                }
              } catch (e) {
                logger.warn('OG role config sync warning (tenant):', e?.message || e);
              }
            }
          }
        }

        if (sanitized.ticketChannelNameTemplate !== undefined && req.guildId) {
          const ticketSettingsResult = ticketService.updateGuildTicketSettings(req.guildId, {
            channelNameTemplate: sanitized.ticketChannelNameTemplate
          });
          if (!ticketSettingsResult.success) {
            return res.status(400).json(ticketSettingsResult);
          }
          delete sanitized.ticketChannelNameTemplate;
        }

        const result = settingsManager.updateSettings(sanitized);

        // Sync OG role service with portal verification settings.
        // Runs in single-tenant mode AND as a fallback in multi-tenant when the
        // tenant DB lookup fails (e.g. tenant not provisioned / getTenantByGuildId error).
        if (!tenantService.isMultitenantEnabled() || !req.guildId || true) {
          try {
            const ogRoleService = require('../services/ogRoleService');
            // Only update ogRoleService when a real (non-empty) roleId was submitted.
            // Empty string = form had no role selected (common on first load before the
            // GET fix kicks in); never treat that as an intentional "clear".
            // To disable the OG role, use PUT /api/admin/og-role/config explicitly.
            const submittedOgRoleId = sanitized.ogRoleId;
            logger.log(`[OG-DEBUG] PUT /api/admin/settings ogRoleId received: "${submittedOgRoleId}" (raw body: "${req.body.ogRoleId}")`);
            if (submittedOgRoleId) {
              const setResult = ogRoleService.setRole(submittedOgRoleId);
              ogRoleService.setEnabled(true);
              logger.log(`[OG-DEBUG] ogRoleService.setRole("${submittedOgRoleId}") => ${JSON.stringify(setResult)}`);
              logger.log(`[OG-DEBUG] og-role.json after save: ${JSON.stringify(ogRoleService.getConfig())}`);
              if (sanitized.ogRoleLimit !== undefined) {
                ogRoleService.setLimit(sanitized.ogRoleLimit || 1);
              }
            } else {
              logger.log(`[OG-DEBUG] ogRoleId was empty/falsy â€” skipping ogRoleService update. Current config: ${JSON.stringify(ogRoleService.getConfig())}`);
            }
          } catch (e) {
            logger.warn('OG role config sync warning:', e?.message || e);
          }
        }

        res.json(result);
      } catch (error) {
        logger.error('Error updating settings:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Fetch Discord channels for dropdown selects
    this.app.get('/api/admin/discord/channels', adminAuthMiddleware, async (req, res) => {
      try {
        if (!this.client) {
          return res.status(500).json({ success: false, message: 'Bot not initialized' });
        }

        const guild = req.guild || await fetchGuildById(req.guildId);
        const channels = await guild.channels.fetch();

        const { ChannelType } = require('discord.js');
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

        res.json({ success: true, channels: channelList });
      } catch (error) {
        logger.error('Error fetching Discord channels:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch channels' });
      }
    });

    // Fetch Discord roles for dropdown selects
    this.app.get('/api/admin/discord/roles', adminAuthMiddleware, async (req, res) => {
      try {
        if (!this.client) {
          return res.status(500).json({ success: false, message: 'Bot not initialized' });
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

        res.json({ success: true, roles: roleList });
      } catch (error) {
        logger.error('Error fetching Discord roles:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch roles' });
      }
    });

    this.app.get('/api/admin/users', adminAuthMiddleware, async (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const totalCount = db.prepare('SELECT COUNT(DISTINCT discord_id) as cnt FROM users').get().cnt;
        const users = db.prepare(`
          SELECT u.*, COUNT(w.id) as wallet_count
          FROM users u
          LEFT JOIN wallets w ON u.discord_id = w.discord_id
          GROUP BY u.discord_id
          ORDER BY u.total_nfts DESC
          LIMIT ? OFFSET ?
        `).all(limit, offset);

        // Overlay voting power from role mappings (if any configured)
        const mappings = db.prepare('SELECT * FROM role_vp_mappings').all();
        if (mappings.length > 0 && this.client) {
          const guild = req.guild || this.client.guilds.cache.get(req.guildId) || await fetchGuildById(req.guildId);
          for (const user of users) {
            try {
              const member = guild ? await guild.members.fetch(user.discord_id).catch(() => null) : null;
              user.voting_power = roleService.getUserVotingPower(user.discord_id, member);
            } catch (e) {
              // keep DB value on error
            }
          }
        }

        res.json({ success: true, users, total: totalCount, limit, offset });
      } catch (error) {
        logger.error('Error fetching users:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/admin/users/:discordId', adminAuthMiddleware, (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        const { discordId } = req.params;
        const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
        const wallets = db.prepare('SELECT * FROM wallets WHERE discord_id = ?').all(discordId);
        const proposals = (hasProposalsGuildColumn() && req.guildId)
          ? db.prepare('SELECT * FROM proposals WHERE creator_id = ? AND guild_id = ?').all(discordId, req.guildId)
          : db.prepare('SELECT * FROM proposals WHERE creator_id = ?').all(discordId);
        const votes = db.prepare('SELECT * FROM votes WHERE voter_id = ?').all(discordId);
        const missions = db.prepare(`
          SELECT m.*, mp.assigned_nft_name, mp.points_awarded
          FROM missions m
          JOIN mission_participants mp ON m.mission_id = mp.mission_id
          WHERE mp.participant_id = ?
        `).all(discordId);

        res.json({
          success: true,
          user,
          wallets,
          proposals,
          votes,
          missions
        });
      } catch (error) {
        logger.error('Error fetching user details:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.delete('/api/admin/users/:discordId', adminAuthMiddleware, (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        const { discordId } = req.params;
        const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
        if (!user) {
          return res.status(404).json({ success: false, message: 'User not found' });
        }
        db.prepare('DELETE FROM wallets WHERE discord_id = ?').run(discordId);
        db.prepare('DELETE FROM votes WHERE voter_id = ?').run(discordId);
        db.prepare('DELETE FROM users WHERE discord_id = ?').run(discordId);
        logger.log(`Admin removed user ${discordId} (${user.username})`);
        res.json({ success: true, message: 'User removed' });
      } catch (error) {
        logger.error('Error removing user:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/admin/proposals', adminAuthMiddleware, (req, res) => {
      if (!ensureGovernanceModule(req, res)) return;
      try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const hasGuildScope = hasProposalsGuildColumn() && !!req.guildId;
        const totalCount = hasGuildScope
          ? db.prepare('SELECT COUNT(*) as cnt FROM proposals WHERE guild_id = ?').get(req.guildId).cnt
          : db.prepare('SELECT COUNT(*) as cnt FROM proposals').get().cnt;
        const proposals = hasGuildScope
          ? db.prepare('SELECT * FROM proposals WHERE guild_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(req.guildId, limit, offset)
          : db.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
        res.json({ success: true, proposals, total: totalCount, limit, offset });
      } catch (error) {
        logger.error('Error fetching proposals:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/proposals/:id/close', adminAuthMiddleware, async (req, res) => {
      if (!ensureGovernanceModule(req, res)) return;
      try {
        const { id } = req.params;
        if (!isProposalInGuildScope(id, req.guildId)) {
          return res.status(404).json({ success: false, message: 'Proposal not found' });
        }
        const result = await proposalService.closeVote(id);
        res.json(result);
      } catch (error) {
        logger.error('Error closing proposal:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Admin: approve proposal (pending_review â†’ supporting)
    this.app.post('/api/admin/governance/proposals/:id/approve', adminAuthMiddleware, (req, res) => {
      if (!ensureGovernanceModule(req, res)) return;
      try {
        if (!isProposalInGuildScope(req.params.id, req.guildId)) {
          return res.status(404).json({ success: false, message: 'Proposal not found' });
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
          return res.status(400).json({
            success: false,
            code: 'limit_exceeded',
            message: governanceLimit.message,
            limit: governanceLimit.limit,
            used: governanceLimit.used,
          });
        }

        const result = proposalService.approveProposal(req.params.id, req.session.discordUser.id);
        if (!result.success) {
          return res.status(400).json(result);
        }
        res.json(result);
      } catch (error) {
        logger.error('Error approving proposal:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Admin: hold proposal (pending_review â†’ on_hold)
    this.app.post('/api/admin/governance/proposals/:id/hold', adminAuthMiddleware, (req, res) => {
      if (!ensureGovernanceModule(req, res)) return;
      try {
        if (!isProposalInGuildScope(req.params.id, req.guildId)) {
          return res.status(404).json({ success: false, message: 'Proposal not found' });
        }
        const { reason } = req.body;
        const result = proposalService.holdProposal(req.params.id, req.session.discordUser.id, reason);
        res.json(result);
      } catch (error) {
        logger.error('Error holding proposal:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Admin: promote to voting (supporting â†’ voting, takes VP snapshot)
    this.app.post('/api/admin/governance/proposals/:id/promote', adminAuthMiddleware, async (req, res) => {
      if (!ensureGovernanceModule(req, res)) return;
      try {
        if (!isProposalInGuildScope(req.params.id, req.guildId)) {
          return res.status(404).json({ success: false, message: 'Proposal not found' });
        }
        const result = await proposalService.promoteToVoting(req.params.id, req.session.discordUser.id);
        res.json(result);
      } catch (error) {
        logger.error('Error promoting proposal:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Admin: conclude voting
    this.app.post('/api/admin/governance/proposals/:id/conclude', adminAuthMiddleware, async (req, res) => {
      if (!ensureGovernanceModule(req, res)) return;
      try {
        if (!isProposalInGuildScope(req.params.id, req.guildId)) {
          return res.status(404).json({ success: false, message: 'Proposal not found' });
        }
        const result = await proposalService.concludeProposal(req.params.id);
        res.json(result);
      } catch (error) {
        logger.error('Error concluding proposal:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Admin: emergency pause (Don + Consigliere only â€” caller must verify roles)
    this.app.post('/api/admin/governance/proposals/:id/pause', adminAuthMiddleware, (req, res) => {
      if (!ensureGovernanceModule(req, res)) return;
      try {
        if (!isProposalInGuildScope(req.params.id, req.guildId)) {
          return res.status(404).json({ success: false, message: 'Proposal not found' });
        }
        const result = proposalService.emergencyPause(req.params.id, req.session.discordUser.id);
        res.json(result);
      } catch (error) {
        logger.error('Error pausing proposal:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/admin/missions', adminAuthMiddleware, (req, res) => {
      if (!ensureHeistModule(req, res)) return;
      try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const hasGuildColumn = missionService.hasMissionsGuildColumn?.() === true;
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

        res.json({ success: true, missions: missionsWithParticipants, total: totalCount, limit, offset });
      } catch (error) {
        logger.error('Error fetching missions:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/missions/create', adminAuthMiddleware, (req, res) => {
      if (!ensureHeistModule(req, res)) return;
      try {
        const { title, description, requiredRoles, minTier, totalSlots, rewardPoints } = req.body;
        
        if (!title || !description || !totalSlots) {
          return res.status(400).json({ success: false, message: 'Missing required fields' });
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
        if (!result.success) return res.status(400).json(result);
        res.json(result);
      } catch (error) {
        logger.error('Error creating mission:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/missions/:id/start', adminAuthMiddleware, (req, res) => {
      if (!ensureHeistModule(req, res)) return;
      try {
        const { id } = req.params;
        const hasGuildColumn = missionService.hasMissionsGuildColumn?.() === true;
        const updateResult = hasGuildColumn
          ? db.prepare('UPDATE missions SET status = ?, start_time = CURRENT_TIMESTAMP WHERE mission_id = ? AND guild_id = ?').run('active', id, req.guildId)
          : db.prepare('UPDATE missions SET status = ?, start_time = CURRENT_TIMESTAMP WHERE mission_id = ?').run('active', id);
        if (!updateResult.changes) {
          return res.status(404).json({ success: false, message: 'Mission not found' });
        }
        
        logger.log(`Mission ${id} started by admin`);
        res.json({ success: true, message: 'Mission started' });
      } catch (error) {
        logger.error('Error starting mission:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/missions/:id/complete', adminAuthMiddleware, (req, res) => {
      if (!ensureHeistModule(req, res)) return;
      try {
        const { id } = req.params;
        const hasGuildColumn = missionService.hasMissionsGuildColumn?.() === true;
        const mission = hasGuildColumn
          ? db.prepare('SELECT * FROM missions WHERE mission_id = ? AND guild_id = ?').get(id, req.guildId)
          : db.prepare('SELECT * FROM missions WHERE mission_id = ?').get(id);
        
        if (!mission) {
          return res.status(404).json({ success: false, message: 'Mission not found' });
        }

        // Award points to all participants
        db.prepare('UPDATE mission_participants SET points_awarded = ? WHERE mission_id = ?').run(mission.reward_points, id);
        
        // Update mission status
        if (hasGuildColumn) {
          db.prepare('UPDATE missions SET status = ? WHERE mission_id = ? AND guild_id = ?').run('completed', id, req.guildId);
        } else {
          db.prepare('UPDATE missions SET status = ? WHERE mission_id = ?').run('completed', id);
        }
        
        logger.log(`Mission ${id} completed, ${mission.reward_points} points awarded to participants`);
        res.json({ success: true, message: 'Mission completed and points awarded' });
      } catch (error) {
        logger.error('Error completing mission:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Role configuration endpoints
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
      return {
        tiers: Array.isArray(tiers) ? tiers : [],
        traitRoles: Array.isArray(traitRoles) ? traitRoles : [],
        tokenRules: roleService.getTokenRoleRules(guildId)
      };
    };

    const saveTenantRoleConfig = (guildId, cfg) => {
      db.prepare(`
        INSERT INTO tenant_role_configs (guild_id, tiers_json, traits_json, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(guild_id) DO UPDATE SET
          tiers_json = excluded.tiers_json,
          traits_json = excluded.traits_json,
          updated_at = CURRENT_TIMESTAMP
      `).run(guildId, JSON.stringify(cfg.tiers || []), JSON.stringify(cfg.traitRoles || []));
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
      if (tenantService.isMultitenantEnabled() && hasProposalsGuildColumn() && !guildId) {
        res.status(400).json({
          success: false,
          message: 'guildId query parameter (or x-guild-id header) is required in multi-tenant mode'
        });
        return null;
      }
      return guildId;
    };

    this.app.get('/api/admin/roles/config', adminAuthMiddleware, (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
        const config = useTenantScoped
          ? getTenantRoleConfig(req.guildId)
          : {
            ...roleService.getRoleConfigSummary(),
            tokenRules: roleService.getTokenRoleRules(req.guildId || null)
          };
        res.json({ success: true, config });
      } catch (error) {
        logger.error('Error fetching role config:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Tier CRUD
    this.app.post('/api/admin/roles/tiers', adminAuthMiddleware, (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        const { name, minNFTs, maxNFTs, votingPower, roleId, collectionId } = req.body;
        
        if (!name || minNFTs === undefined || maxNFTs === undefined || votingPower === undefined) {
          return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
        const ruleCounts = getVerificationRuleCounts(req.guildId, {
          tenantScoped: useTenantScoped
        });
        const tierLimit = checkVerificationLimit(req.guildId, 'max_tiers', ruleCounts.tiers, 'verification collection rules');
        if (!tierLimit.success) {
          return res.status(400).json({
            success: false,
            code: 'limit_exceeded',
            message: tierLimit.message,
            limit: tierLimit.limit,
            used: tierLimit.used,
          });
        }

        const totalLimit = checkVerificationLimit(req.guildId, 'max_rules_total', ruleCounts.total, 'verification rules');
        if (!totalLimit.success) {
          return res.status(400).json({
            success: false,
            code: 'limit_exceeded',
            message: totalLimit.message,
            limit: totalLimit.limit,
            used: totalLimit.used,
          });
        }

        if (useTenantScoped) {
          const cfg = getTenantRoleConfig(req.guildId);
          if ((cfg.tiers || []).some(t => String(t.name).toLowerCase() === String(name).toLowerCase())) {
            return res.status(400).json({ success: false, message: 'Tier already exists' });
          }
          cfg.tiers.push({ name, minNFTs, maxNFTs, votingPower, roleId: roleId || null, collectionId: collectionId || null });
          saveTenantRoleConfig(req.guildId, cfg);
          return res.json({ success: true, message: 'Tier added' });
        }

        const result = roleService.addTier(name, minNFTs, maxNFTs, votingPower, roleId || null, collectionId || null);
        res.json(result);
      } catch (error) {
        logger.error('Error adding tier:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/admin/roles/tiers/:name', adminAuthMiddleware, (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        const { name } = req.params;
        const updates = req.body;

        const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
        if (useTenantScoped) {
          const cfg = getTenantRoleConfig(req.guildId);
          const idx = (cfg.tiers || []).findIndex(t => String(t.name).toLowerCase() === String(name).toLowerCase());
          if (idx < 0) return res.status(404).json({ success: false, message: 'Tier not found' });
          cfg.tiers[idx] = { ...cfg.tiers[idx], ...updates };
          saveTenantRoleConfig(req.guildId, cfg);
          return res.json({ success: true, message: 'Tier updated' });
        }

        const result = roleService.editTier(name, updates);
        res.json(result);
      } catch (error) {
        logger.error('Error editing tier:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.delete('/api/admin/roles/tiers/:name', adminAuthMiddleware, (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        const { name } = req.params;
        const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
        if (useTenantScoped) {
          const cfg = getTenantRoleConfig(req.guildId);
          const before = (cfg.tiers || []).length;
          cfg.tiers = (cfg.tiers || []).filter(t => String(t.name).toLowerCase() !== String(name).toLowerCase());
          if (cfg.tiers.length === before) return res.status(404).json({ success: false, message: 'Tier not found' });
          saveTenantRoleConfig(req.guildId, cfg);
          return res.json({ success: true, message: 'Tier deleted' });
        }

        const result = roleService.deleteTier(name);
        res.json(result);
      } catch (error) {
        logger.error('Error deleting tier:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Trait CRUD
    this.app.post('/api/admin/roles/traits', adminAuthMiddleware, (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        const { traitType, roleId, collectionId, description } = req.body;
        // Support traitValues array; fall back to single traitValue for backward compat
        const traitValues = req.body.traitValues || (req.body.traitValue ? [req.body.traitValue] : []);
        const traitValue = traitValues[0] || req.body.traitValue;

        if (!traitType || !traitValue || !roleId) {
          return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        if (!collectionId) {
          return res.status(400).json({ success: false, message: 'collectionId is required' });
        }

        const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
        const ruleCounts = getVerificationRuleCounts(req.guildId, { tenantScoped: useTenantScoped });
        const traitLimit = checkVerificationLimit(req.guildId, 'max_trait_rules', ruleCounts.traits, 'verification trait rules');
        if (!traitLimit.success) {
          return res.status(400).json({
            success: false,
            code: 'limit_exceeded',
            message: traitLimit.message,
            limit: traitLimit.limit,
            used: traitLimit.used,
          });
        }

        const totalLimit = checkVerificationLimit(req.guildId, 'max_rules_total', ruleCounts.total, 'verification rules');
        if (!totalLimit.success) {
          return res.status(400).json({
            success: false,
            code: 'limit_exceeded',
            message: totalLimit.message,
            limit: totalLimit.limit,
            used: totalLimit.used,
          });
        }

        if (useTenantScoped) {
          const cfg = getTenantRoleConfig(req.guildId);
          const exists = (cfg.traitRoles || []).some(t =>
            String(t.traitType || t.trait_type).toLowerCase() === String(traitType).toLowerCase() &&
            String(t.traitValue || t.trait_value).toLowerCase() === String(traitValue).toLowerCase()
          );
          if (exists) return res.status(400).json({ success: false, message: 'Trait rule already exists' });
          cfg.traitRoles.push({ traitType, traitValue, traitValues, roleId, collectionId, description: description || '' });
          saveTenantRoleConfig(req.guildId, cfg);
          return res.json({ success: true, message: 'Trait rule added' });
        }

        const result = roleService.addTrait(traitType, traitValue, roleId, description, collectionId);
        res.json(result);
      } catch (error) {
        logger.error('Error adding trait:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/admin/roles/traits/:traitType/:traitValue', adminAuthMiddleware, (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        const { traitType, traitValue } = req.params;
        const { roleId, collectionId, description } = req.body;
        // Support traitValues array; fall back to body traitValue or param traitValue
        const traitValues = req.body.traitValues || (req.body.traitValue ? [req.body.traitValue] : [traitValue]);
        const newTraitValue = req.body.traitValue || traitValues[0] || traitValue;
        const newTraitType = req.body.traitType || traitType;

        if (!roleId) {
          return res.status(400).json({ success: false, message: 'roleId is required' });
        }

        if (!collectionId) {
          return res.status(400).json({ success: false, message: 'collectionId is required' });
        }

        const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
        if (useTenantScoped) {
          const cfg = getTenantRoleConfig(req.guildId);
          const idx = (cfg.traitRoles || []).findIndex(t =>
            String(t.traitType || t.trait_type).toLowerCase() === String(traitType).toLowerCase() &&
            String(t.traitValue || t.trait_value).toLowerCase() === String(traitValue).toLowerCase()
          );
          if (idx < 0) return res.status(404).json({ success: false, message: 'Trait rule not found' });
          cfg.traitRoles[idx] = { ...cfg.traitRoles[idx], traitType: newTraitType, traitValue: newTraitValue, traitValues, roleId, collectionId, description: description || '' };
          saveTenantRoleConfig(req.guildId, cfg);
          return res.json({ success: true, message: 'Trait rule updated' });
        }

        const result = roleService.editTrait(traitType, traitValue, roleId, description, collectionId);
        res.json(result);
      } catch (error) {
        logger.error('Error editing trait:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.delete('/api/admin/roles/traits/:traitType/:traitValue', adminAuthMiddleware, (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        const { traitType, traitValue } = req.params;
        const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
        if (useTenantScoped) {
          const cfg = getTenantRoleConfig(req.guildId);
          const before = (cfg.traitRoles || []).length;
          cfg.traitRoles = (cfg.traitRoles || []).filter(t => !(
            String(t.traitType || t.trait_type).toLowerCase() === String(traitType).toLowerCase() &&
            String(t.traitValue || t.trait_value).toLowerCase() === String(traitValue).toLowerCase()
          ));
          if (cfg.traitRoles.length === before) return res.status(404).json({ success: false, message: 'Trait rule not found' });
          saveTenantRoleConfig(req.guildId, cfg);
          return res.json({ success: true, message: 'Trait rule deleted' });
        }

        const result = roleService.deleteTrait(traitType, traitValue);
        res.json(result);
      } catch (error) {
        logger.error('Error deleting trait:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/user/privacy/wallet-identity-opt-out', (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      try {
        const discordId = req.session.discordUser.id;
        const optOut = req.body?.optOut === true;

        // Ensure a users row exists for preference persistence.
        db.prepare(`
          INSERT OR IGNORE INTO users (discord_id, username, wallet_alert_identity_opt_out)
          VALUES (?, ?, ?)
        `).run(discordId, req.session.discordUser.username || 'Web User', optOut ? 1 : 0);

        db.prepare(`
          UPDATE users
          SET wallet_alert_identity_opt_out = ?, updated_at = datetime('now')
          WHERE discord_id = ?
        `).run(optOut ? 1 : 0, discordId);

        res.json({ success: true, optOut });
      } catch (error) {
        logger.error('Error updating wallet identity privacy preference:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Token role rule CRUD
    this.app.get('/api/admin/roles/tokens', adminAuthMiddleware, (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        const rules = roleService.getTokenRoleRules(req.guildId || null);
        res.json({ success: true, rules });
      } catch (error) {
        logger.error('Error fetching token role rules:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/roles/tokens', adminAuthMiddleware, (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        const { tokenMint, tokenSymbol, minAmount, maxAmount, roleId, enabled } = req.body || {};
        if (!tokenMint || !roleId || minAmount === undefined || minAmount === null) {
          return res.status(400).json({ success: false, message: 'tokenMint, roleId, and minAmount are required' });
        }

        const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
        const ruleCounts = getVerificationRuleCounts(req.guildId, { tenantScoped: useTenantScoped });
        const totalLimit = checkVerificationLimit(req.guildId, 'max_rules_total', ruleCounts.total, 'verification rules');
        if (!totalLimit.success) {
          return res.status(400).json({
            success: false,
            code: 'limit_exceeded',
            message: totalLimit.message,
            limit: totalLimit.limit,
            used: totalLimit.used,
          });
        }

        const result = roleService.addTokenRoleRule({
          guildId: req.guildId || '',
          tokenMint,
          tokenSymbol: tokenSymbol || null,
          minAmount,
          maxAmount: maxAmount === undefined ? null : maxAmount,
          roleId,
          enabled: enabled !== false
        });
        if (!result.success) return res.status(400).json(result);
        res.json(result);
      } catch (error) {
        logger.error('Error adding token role rule:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/admin/roles/tokens/:id', adminAuthMiddleware, (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        const result = roleService.updateTokenRoleRule(req.params.id, req.body || {}, req.guildId || null);
        if (!result.success) return res.status(400).json(result);
        res.json(result);
      } catch (error) {
        logger.error('Error updating token role rule:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.delete('/api/admin/roles/tokens/:id', adminAuthMiddleware, (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        const result = roleService.removeTokenRoleRule(req.params.id, req.guildId || null);
        if (!result.success) return res.status(404).json(result);
        res.json(result);
      } catch (error) {
        logger.error('Error deleting token role rule:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Role sync endpoint
    this.app.post('/api/admin/roles/sync', adminAuthMiddleware, async (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        if (!this.client) {
          return res.status(500).json({ success: false, message: 'Bot not initialized' });
        }

        const { discordId } = req.body;
        const guild = req.guild || await fetchGuildById(req.guildId);
        if (!guild) {
          return res.status(404).json({ success: false, message: 'Server not found' });
        }

        if (discordId) {
          // Sync single user
          await roleService.updateUserRoles(discordId, req.session.discordUser?.username, req.guildId);
          const syncResult = await roleService.syncUserDiscordRoles(guild, discordId, req.guildId);
          return res.json(syncResult);
        } else {
          // Sync all users
          const allUsers = await roleService.getAllVerifiedUsers(guild);
          let syncedCount = 0;
          let errorCount = 0;

          for (const user of allUsers) {
            try {
              await roleService.updateUserRoles(user.discord_id, user.username, guild.id);
              const syncResult = await roleService.syncUserDiscordRoles(guild, user.discord_id, guild.id);
              
              if (syncResult.success) {
                syncedCount++;
              } else {
                errorCount++;
              }
            } catch (error) {
              logger.error(`Error syncing user ${user.discord_id}:`, error);
              errorCount++;
            }
          }

          res.json({ 
            success: true, 
            message: `Synced ${syncedCount} users, ${errorCount} errors`,
            syncedCount,
            errorCount
          });
        }
      } catch (error) {
        logger.error('Error syncing roles:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== OG ROLE API ====================

    this.app.get('/api/admin/og-role/config', adminAuthMiddleware, async (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        const ogRoleService = require('../services/ogRoleService');
        const guild = req.guild || await fetchGuildById(req.guildId);
        
        const status = await ogRoleService.getStatus(guild);
        res.json({ success: true, config: status });
      } catch (error) {
        logger.error('Error fetching OG role config:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/admin/og-role/config', adminAuthMiddleware, (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        const ogRoleService = require('../services/ogRoleService');
        const { enabled, roleId, limit } = req.body;
        
        let result = { success: true };
        
        if (enabled !== undefined) {
          result = ogRoleService.setEnabled(enabled);
          if (!result.success) return res.json(result);
        }
        
        if (roleId !== undefined) {
          result = ogRoleService.setRole(roleId);
          if (!result.success) return res.json(result);
        }
        
        if (limit !== undefined) {
          result = ogRoleService.setLimit(limit);
          if (!result.success) return res.json(result);
        }
        
        res.json({ success: true, message: 'OG role config updated' });
      } catch (error) {
        logger.error('Error updating OG role config:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/og-role/sync', adminAuthMiddleware, async (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        const ogRoleService = require('../services/ogRoleService');
        const { fullSync } = req.body;
        const guild = req.guild || await fetchGuildById(req.guildId);
        
        const result = await ogRoleService.syncRoles(guild, fullSync || false);
        res.json(result);
      } catch (error) {
        logger.error('Error syncing OG roles:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== ROLE CLAIM API ====================

    this.app.get('/api/admin/role-claim/config', adminAuthMiddleware, async (req, res) => {
      if (!ensureSelfServeRolesModule(req, res)) return;
      try {
        const roleClaimService = require('../services/roleClaimService');
        const guild = req.guild || await fetchGuildById(req.guildId);
        
        const status = await roleClaimService.getRoleStatus(guild);
        res.json(status);
      } catch (error) {
        logger.error('Error fetching role claim config:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/role-claim/add', adminAuthMiddleware, async (req, res) => {
      if (!ensureSelfServeRolesModule(req, res)) return;
      try {
        const roleClaimService = require('../services/roleClaimService');
        const { roleId, label } = req.body;
        
        if (!roleId) {
          return res.status(400).json({ success: false, message: 'roleId is required' });
        }
        
        // Validate role first
        const guild = req.guild || await fetchGuildById(req.guildId);
        const validation = await roleClaimService.validateRole(guild, roleId);
        
        if (!validation.valid) {
          return res.json({ success: false, message: validation.message });
        }
        
        const result = roleClaimService.addRole(roleId, label);
        res.json(result);
      } catch (error) {
        logger.error('Error adding claimable role:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.delete('/api/admin/role-claim/:roleId', adminAuthMiddleware, (req, res) => {
      if (!ensureSelfServeRolesModule(req, res)) return;
      try {
        const roleClaimService = require('../services/roleClaimService');
        const { roleId } = req.params;

        const result = roleClaimService.removeRole(roleId);
        res.json(result);
      } catch (error) {
        logger.error('Error removing claimable role:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/role-claim/:roleId/toggle', adminAuthMiddleware, (req, res) => {
      if (!ensureSelfServeRolesModule(req, res)) return;
      try {
        const roleClaimService = require('../services/roleClaimService');
        const { roleId } = req.params;
        const { enabled } = req.body;
        const result = roleClaimService.updateRole(roleId, { enabled: !!enabled });
        res.json(result);
      } catch (error) {
        logger.error('Error toggling claimable role:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/roles/post-panel', adminAuthMiddleware, async (req, res) => {
      if (!ensureSelfServeRolesModule(req, res)) return;
      try {
        const roleClaimService = require('../services/roleClaimService');
        const { createBrandedPanelEmbed } = require('../services/embedBranding');
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
        const fs = require('fs');
        const panelConfigPath = require('path').join(__dirname, '..', 'config', 'role-claim-panels.json');

        const { channelId, title, description } = req.body;
        if (!channelId) return res.status(400).json({ success: false, message: 'channelId is required' });

        const roles = roleClaimService.getClaimableRoles();
        if (!roles || roles.length === 0) {
          return res.status(400).json({ success: false, message: 'No enabled claimable roles configured' });
        }

        const channel = this.client.channels.cache.get(channelId);
        if (!channel) return res.status(400).json({ success: false, message: 'Channel not found' });

        const embed = createBrandedPanelEmbed({
          guildId: req.guildId || channel.guild?.id || '',
          moduleKey: 'selfserve',
          panelTitle: title || 'ðŸŽ–ï¸ Get Your Roles',
          description: description || 'Click a button below to claim or unclaim a community role.',
          defaultColor: '#6366f1',
          defaultFooter: 'Powered by Guild Pilot',
          fallbackLogoUrl: this.client?.user?.displayAvatarURL?.() || null,
          useThumbnail: false,
        });

        const rows = [];
        for (let i = 0; i < roles.length && rows.length < 5; i += 5) {
          const row = new ActionRowBuilder();
          const chunk = roles.slice(i, i + 5);
          for (const role of chunk) {
            row.addComponents(
              new ButtonBuilder()
                .setCustomId(`claim_role_${role.roleId}`)
                .setLabel(role.label || role.roleId)
                .setStyle(ButtonStyle.Secondary)
            );
          }
          rows.push(row);
        }

        let panelConfig = {};
        try { panelConfig = JSON.parse(fs.readFileSync(panelConfigPath, 'utf8')); } catch (e) { /* first time */ }

        let action = 'posted';
        const existingMsgId = panelConfig[channelId];
        if (existingMsgId) {
          try {
            const existingMsg = await channel.messages.fetch(existingMsgId);
            await existingMsg.edit({ embeds: [embed], components: rows });
            action = 'updated';
          } catch (e) {
            const msg = await channel.send({ embeds: [embed], components: rows });
            panelConfig[channelId] = msg.id;
            action = 'posted';
          }
        } else {
          const msg = await channel.send({ embeds: [embed], components: rows });
          panelConfig[channelId] = msg.id;
        }

        fs.writeFileSync(panelConfigPath, JSON.stringify(panelConfig, null, 2));
        res.json({ success: true, messageId: panelConfig[channelId], action });
      } catch (error) {
        logger.error('Error posting role claim panel:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== VERIFICATION PANEL API ====================

    this.app.get('/api/admin/verification/panel', adminAuthMiddleware, (req, res) => {
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
          return res.json({ success: true, panel: null });
        }

        res.json({
          success: true,
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
        });
      } catch (error) {
        logger.error('Error loading verification panel config:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/verification/panel/post', adminAuthMiddleware, async (req, res) => {
      if (!ensureVerificationModule(req, res)) return;
      try {
        ensureVerificationPanelsSchema();
        if (!this.client) {
          return res.status(500).json({ success: false, message: 'Bot not initialized' });
        }

        const { createBrandedPanelEmbed } = require('../services/embedBranding');
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

        const existing = db.prepare(`
          SELECT guild_id, channel_id, message_id, title, description, color
          FROM verification_panels
          WHERE guild_id = ?
          LIMIT 1
        `).get(req.guildId);

        const channelId = String(req.body?.channelId || existing?.channel_id || '').trim();
        if (!channelId) {
          return res.status(400).json({ success: false, message: 'channelId is required' });
        }

        const title = String(req.body?.title || existing?.title || 'ðŸ”— Verify your wallet!').trim();
        const description = String(
          req.body?.description
          || existing?.description
          || 'To get access to community roles, verify your wallet by clicking the button below.'
        ).trim();
        const color = String(req.body?.color || existing?.color || '#FFD700').trim() || '#FFD700';

        const channel = this.client.channels.cache.get(channelId) || await this.client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.send) {
          return res.status(400).json({ success: false, message: 'Channel not found or not writable' });
        }
        if (String(channel.guild?.id || '') !== String(req.guildId || '')) {
          return res.status(400).json({ success: false, message: 'Selected channel must belong to the active server' });
        }

        const webUrl = process.env.WEB_URL || 'http://localhost:3000';
        const embed = createBrandedPanelEmbed({
          guildId: req.guildId || channel.guild?.id || '',
          moduleKey: 'verification',
          panelTitle: title,
          description,
          defaultColor: color,
          defaultFooter: 'Powered by Guild Pilot',
          fallbackLogoUrl: this.client?.user?.displayAvatarURL?.() || null,
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
              .setURL(`${webUrl}/verify`),
            new ButtonBuilder()
              .setLabel('Get Help')
              .setStyle(ButtonStyle.Link)
              .setURL('https://the-solpranos.com/help')
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

        return res.json({ success: true, action, channelId, messageId });
      } catch (error) {
        logger.error('Error posting verification panel from web:', error);
        return res.status(500).json({ success: false, message: 'Failed to post verification panel' });
      }
    });

    // ==================== ROLE PANELS API (multi-panel self-serve roles) ====================

    this.app.get('/api/admin/role-panels', adminAuthMiddleware, (req, res) => {
      if (!ensureSelfServeRolesModule(req, res)) return;
      try {
        const rolePanelService = require('../services/rolePanelService');
        const panels = rolePanelService.listPanels(req.guildId);
        res.json({ success: true, panels });
      } catch (e) {
        logger.error('Error listing role panels:', e);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/role-panels', adminAuthMiddleware, (req, res) => {
      if (!ensureSelfServeRolesModule(req, res)) return;
      try {
        const rolePanelService = require('../services/rolePanelService');
        const { title, description, channelId, singleSelect } = req.body;
        const result = rolePanelService.createPanel({ guildId: req.guildId || '', title, description, channelId, singleSelect });
        if (!result.success) return res.status(400).json(result);
        res.json(result);
      } catch (e) {
        logger.error('Error creating role panel:', e);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/admin/role-panels/:id', adminAuthMiddleware, (req, res) => {
      if (!ensureSelfServeRolesModule(req, res)) return;
      try {
        const rolePanelService = require('../services/rolePanelService');
        const { title, description, channelId, singleSelect } = req.body;
        const result = rolePanelService.updatePanel(parseInt(req.params.id), { title, description, channelId, singleSelect }, req.guildId);
        res.json(result);
      } catch (e) {
        logger.error('Error updating role panel:', e);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.delete('/api/admin/role-panels/:id', adminAuthMiddleware, (req, res) => {
      if (!ensureSelfServeRolesModule(req, res)) return;
      try {
        const rolePanelService = require('../services/rolePanelService');
        const result = rolePanelService.deletePanel(parseInt(req.params.id), req.guildId);
        res.json(result);
      } catch (e) {
        logger.error('Error deleting role panel:', e);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/role-panels/:id/roles', adminAuthMiddleware, async (req, res) => {
      if (!ensureSelfServeRolesModule(req, res)) return;
      try {
        const rolePanelService = require('../services/rolePanelService');
        const { roleId, label } = req.body;
        if (!roleId) return res.status(400).json({ success: false, message: 'roleId is required' });
        // Validate the Discord role exists and is manageable
        const guild = req.guild || await fetchGuildById(req.guildId);
        const gRole = guild.roles.cache.get(roleId);
        if (!gRole) return res.status(400).json({ success: false, message: 'Role not found in this server' });
        const result = rolePanelService.addRole(parseInt(req.params.id), { roleId, label: label || gRole.name }, req.guildId);
        res.json(result);
      } catch (e) {
        logger.error('Error adding role to panel:', e);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.delete('/api/admin/role-panels/:id/roles/:roleId', adminAuthMiddleware, (req, res) => {
      if (!ensureSelfServeRolesModule(req, res)) return;
      try {
        const rolePanelService = require('../services/rolePanelService');
        const result = rolePanelService.removeRole(parseInt(req.params.id), req.params.roleId, req.guildId);
        res.json(result);
      } catch (e) {
        logger.error('Error removing role from panel:', e);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/admin/role-panels/:id/roles/:roleId', adminAuthMiddleware, (req, res) => {
      if (!ensureSelfServeRolesModule(req, res)) return;
      try {
        const rolePanelService = require('../services/rolePanelService');
        const { label, enabled } = req.body;
        const result = rolePanelService.updateRole(parseInt(req.params.id), req.params.roleId, { label, enabled }, req.guildId);
        res.json(result);
      } catch (e) {
        logger.error('Error updating role in panel:', e);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/role-panels/:id/post', adminAuthMiddleware, async (req, res) => {
      if (!ensureSelfServeRolesModule(req, res)) return;
      try {
        const rolePanelService = require('../services/rolePanelService');
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
        const { createBrandedPanelEmbed } = require('../services/embedBranding');
        const panelId = parseInt(req.params.id);
        const panel = rolePanelService.getPanel(panelId, req.guildId);
        if (!panel) return res.status(404).json({ success: false, message: 'Panel not found' });

        const { channelId } = req.body;
        const targetChannelId = channelId || panel.channel_id;
        if (!targetChannelId) return res.status(400).json({ success: false, message: 'channelId is required' });

        const enabledRoles = panel.roles.filter(r => r.enabled !== 0);
        if (!enabledRoles.length) return res.status(400).json({ success: false, message: 'No enabled roles on this panel' });

        const channel = this.client.channels.cache.get(targetChannelId) || await this.client.channels.fetch(targetChannelId).catch(() => null);
        if (!channel) return res.status(400).json({ success: false, message: 'Channel not found' });

        const embed = createBrandedPanelEmbed({
          guildId: req.guildId,
          moduleKey: 'selfserve',
          panelTitle: panel.title || 'ðŸŽ–ï¸ Get Your Roles',
          description: panel.description || 'Click a button below to claim or unclaim a community role.',
          defaultColor: '#6366f1',
          defaultFooter: 'Powered by Guild Pilot',
          fallbackLogoUrl: this.client?.user?.displayAvatarURL?.() || null,
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
          } catch {
            const msg = await channel.send({ embeds: [embed], components: rows });
            rolePanelService.updatePanel(panelId, { channelId: targetChannelId, messageId: msg.id });
          }
        } else {
          const msg = await channel.send({ embeds: [embed], components: rows });
          rolePanelService.updatePanel(panelId, { channelId: targetChannelId, messageId: msg.id });
        }

        res.json({ success: true, action });
      } catch (e) {
        logger.error('Error posting role panel:', e);
        res.status(500).json({ success: false, message: 'Failed to post panel' });
      }
    });

    // ==================== TREASURY API ====================

    // ==================== WALLET VERIFICATION ====================

    // Generate a challenge nonce for signature verification
    this.app.post('/api/verify/challenge', (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      try {
        const nonce = require('crypto').randomBytes(16).toString('hex');
        const message = `Solpranos Wallet Verification\nUser: ${req.session.discordUser.username}\nNonce: ${nonce}`;
        req.session.verifyChallenge = { message, nonce, createdAt: Date.now() };
        res.json({ success: true, message });
      } catch (error) {
        logger.error('Error generating challenge:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Session-aware signature verify (wallet address extracted from signature context)
    this.app.post('/api/verify/signature', async (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      try {
        const { walletAddress, signature } = req.body;
        const discordId = req.session.discordUser.id;

        if (!walletAddress || !signature) {
          return res.status(400).json({ success: false, message: 'Missing walletAddress or signature' });
        }

        // Validate challenge exists and isn't expired (5 min TTL)
        const challenge = req.session.verifyChallenge;
        if (!challenge || (Date.now() - challenge.createdAt) > 5 * 60 * 1000) {
          return res.status(400).json({ success: false, message: 'Challenge expired. Please try again.' });
        }

        const isValid = this.verifySignature(walletAddress, signature, challenge.message);
        if (!isValid) {
          return res.status(400).json({ success: false, message: 'Invalid signature. Make sure you signed with the correct wallet.' });
        }

        // Clear challenge after use
        delete req.session.verifyChallenge;

        const existingWallet = db.prepare('SELECT * FROM wallets WHERE wallet_address = ?').get(walletAddress);
        if (existingWallet) {
          if (existingWallet.discord_id === discordId) {
            return res.json({ success: true, message: 'Wallet already linked to your account' });
          }
          return res.status(400).json({ success: false, message: 'This wallet is already linked to another account' });
        }

        const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
        if (!user) {
          db.prepare('INSERT INTO users (discord_id, username) VALUES (?, ?)').run(discordId, req.session.discordUser.username || 'Web User');
        }

        const walletCount = db.prepare('SELECT COUNT(*) as count FROM wallets WHERE discord_id = ?').get(discordId).count;
        const isFavorite = walletCount === 0 ? 1 : 0;
        const isPrimary = walletCount === 0 ? 1 : 0;

        db.prepare('INSERT INTO wallets (discord_id, wallet_address, primary_wallet, is_favorite) VALUES (?, ?, ?, ?)').run(
          discordId, walletAddress, isPrimary, isFavorite
        );

        // Trigger role update
        try {
          const guild = req.guild || await fetchGuildById(req.guildId);
          await roleService.updateUserRoles(discordId, req.session.discordUser.username, req.guildId || null);
          if (guild) {
            await roleService.syncUserDiscordRoles(guild, discordId, req.guildId || null);
          }
        } catch (roleErr) {
          logger.error('Role update after verify failed (non-fatal):', roleErr);
        }

        // Auto-assign OG role on first verification (same behavior as walletService.linkWallet)
        if (isPrimary) {
          walletService.triggerOGRoleAssignment(
            discordId,
            req.session.discordUser.username || 'Web User',
            req.guildId || null
          );
        }

        logger.log(`Web signature verification: User ${discordId} linked wallet ${walletAddress}`);
        res.json({ success: true, message: 'Wallet verified successfully!' });
      } catch (error) {
        logger.error('Error in signature verification:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Legacy verify endpoint (kept for API consumers â€” requires session auth)
    this.app.post('/api/verify', async (req, res) => {
      if (!req.session?.discordUser?.id) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      try {
        const discordId = req.session.discordUser.id; // ignore body discordId
        const { walletAddress, signature } = req.body;

        if (!walletAddress || !signature) {
          return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Validate challenge from session (must use /api/verify/challenge first)
        const challenge = req.session.verifyChallenge;
        if (!challenge || (Date.now() - challenge.createdAt) > 5 * 60 * 1000) {
          return res.status(400).json({ success: false, message: 'Challenge expired. Request a new challenge first.' });
        }

        const isValid = this.verifySignature(walletAddress, signature, challenge.message);

        // Clear challenge after use
        delete req.session.verifyChallenge;

        if (!isValid) {
          return res.status(400).json({ success: false, message: 'Invalid signature' });
        }

        const existingWallet = db.prepare('SELECT * FROM wallets WHERE wallet_address = ?').get(walletAddress);
        
        if (existingWallet) {
          if (existingWallet.discord_id === discordId) {
            return res.json({ success: true, message: 'Wallet already linked to your account' });
          }
          return res.status(400).json({ success: false, message: 'This wallet is already linked to another account' });
        }

        const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
        if (!user) {
          db.prepare('INSERT INTO users (discord_id, username) VALUES (?, ?)').run(discordId, 'Web User');
        }

        const walletCount = db.prepare('SELECT COUNT(*) as count FROM wallets WHERE discord_id = ?').get(discordId).count;
        const isFavorite = walletCount === 0 ? 1 : 0;
        const isPrimary = walletCount === 0 ? 1 : 0;

        db.prepare('INSERT INTO wallets (discord_id, wallet_address, primary_wallet, is_favorite) VALUES (?, ?, ?, ?)').run(
          discordId, 
          walletAddress, 
          isPrimary,
          isFavorite
        );

        try {
          const guild = req.guild || await fetchGuildById(req.guildId);
          await roleService.updateUserRoles(discordId, 'Web User', req.guildId || null);
          if (guild) {
            await roleService.syncUserDiscordRoles(guild, discordId, req.guildId || null);
          }
        } catch (roleErr) {
          logger.error('Role update after legacy verify failed (non-fatal):', roleErr);
        }

        // Auto-assign OG role on first verification (same behavior as walletService.linkWallet)
        if (isPrimary) {
          walletService.triggerOGRoleAssignment(
            discordId,
            req.session.discordUser?.username || 'Web User',
            req.guildId || null
          );
        }

        logger.log(`Web verification: User ${discordId} linked wallet ${walletAddress}`);

        res.json({ success: true, message: 'Wallet verified successfully', isFavorite });
      } catch (error) {
        logger.error('Error verifying wallet:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/wallets/:discordId', (req, res) => {
      if (!req.session?.discordUser?.id) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }
      if (req.session.discordUser.id !== req.params.discordId) {
        return res.status(403).json({ success: false, message: 'Forbidden' });
      }

      try {
        const { discordId } = req.params;

        const wallets = db.prepare('SELECT wallet_address, is_favorite, primary_wallet, created_at FROM wallets WHERE discord_id = ? ORDER BY is_favorite DESC, created_at ASC').all(discordId);

        res.json({ success: true, wallets });
      } catch (error) {
        logger.error('Error fetching wallets:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/wallets/:discordId/favorite', (req, res) => {
      if (!req.session?.discordUser?.id) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }
      if (req.session.discordUser.id !== req.params.discordId) {
        return res.status(403).json({ success: false, message: 'Forbidden' });
      }

      try {
        const { discordId } = req.params;
        const { walletAddress } = req.body;

        if (!walletAddress) {
          return res.status(400).json({ success: false, message: 'Wallet address required' });
        }

        const wallet = db.prepare('SELECT * FROM wallets WHERE discord_id = ? AND wallet_address = ?').get(discordId, walletAddress);
        
        if (!wallet) {
          return res.status(404).json({ success: false, message: 'Wallet not found' });
        }

        db.prepare('UPDATE wallets SET is_favorite = 0 WHERE discord_id = ?').run(discordId);
        db.prepare('UPDATE wallets SET is_favorite = 1 WHERE discord_id = ? AND wallet_address = ?').run(discordId, walletAddress);

        logger.log(`User ${discordId} set favorite wallet: ${walletAddress}`);

        res.json({ success: true, message: 'Favorite wallet updated' });
      } catch (error) {
        logger.error('Error setting favorite wallet:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== MICRO-TRANSFER VERIFICATION ====================

    this.app.post('/api/micro-verify/request', (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      try {
        const discordId = req.session.discordUser.id;
        const username = req.session.discordUser.username;

        const result = microVerifyService.createRequest(discordId, username, req.guildId || '');
        res.json(result);
      } catch (error) {
        logger.error('Error creating micro-verify request:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/micro-verify/status', (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      try {
        const discordId = req.session.discordUser.id;
        const result = microVerifyService.getPendingRequest(discordId);
        
        if (result.success) {
          const request = result.request;
          const expiresAt = new Date(request.expires_at);
          const timeLeftMs = expiresAt - new Date();
          const timeLeftMinutes = Math.max(0, Math.floor(timeLeftMs / 1000 / 60));

          res.json({
            success: true,
            request: {
              id: request.id,
              amount: request.expected_amount,
              destinationWallet: request.destination_wallet,
              expiresAt: request.expires_at,
              timeLeftMinutes,
              status: request.status
            }
          });
        } else {
          res.json({ success: false, message: result.message });
        }
      } catch (error) {
        logger.error('Error getting micro-verify status:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/micro-verify/check-now', async (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }
      try {
        const discordId = req.session.discordUser.id;
        const result = await microVerifyService.checkNow(discordId);
        res.json(result);
      } catch (error) {
        logger.error('Error in check-now:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/micro-verify/config', (req, res) => {
      try {
        const config = microVerifyService.getConfig();
        res.json({
          success: true,
          enabled: config.enabled,
          ttlMinutes: config.ttlMinutes
        });
      } catch (error) {
        logger.error('Error getting micro-verify config:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== ENGAGEMENT & POINTS ====================

    this.app.get('/api/admin/engagement/config', adminAuthMiddleware, (req, res) => {
      if (!ensureEngagementModule(req, res)) return;
      try {
        const guildId = req.guildId;
        const eng = require('../services/engagementService');
        res.json({ success: true, config: eng.getConfig(guildId) });
      } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    this.app.put('/api/admin/engagement/config', adminAuthMiddleware, (req, res) => {
      if (!ensureEngagementModule(req, res)) return;
      try {
        const guildId = req.guildId;
        const eng = require('../services/engagementService');
        const allowed = ['enabled','points_message','points_reaction','cooldown_message_mins','cooldown_reaction_daily'];
        const patch = {};
        for (const k of allowed) { if (req.body[k] !== undefined) patch[k] = req.body[k]; }
        const updated = eng.setConfig(guildId, patch);
        res.json({ success: true, config: updated });
      } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    this.app.get('/api/admin/engagement/leaderboard', adminAuthMiddleware, (req, res) => {
      if (!ensureEngagementModule(req, res)) return;
      try {
        const guildId = req.guildId;
        const limit = Math.min(parseInt(req.query.limit || '25', 10), 100);
        const eng = require('../services/engagementService');
        res.json({ success: true, leaderboard: eng.getLeaderboard(guildId, limit) });
      } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    this.app.get('/api/admin/engagement/shop', adminAuthMiddleware, (req, res) => {
      if (!ensureEngagementModule(req, res)) return;
      try {
        const guildId = req.guildId;
        const eng = require('../services/engagementService');
        res.json({ success: true, items: eng.getShopItems(guildId) });
      } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    this.app.post('/api/admin/engagement/shop', adminAuthMiddleware, (req, res) => {
      if (!ensureEngagementModule(req, res)) return;
      try {
        const guildId = req.guildId;
        const { name, description, type, cost, roleId, codes, quantity } = req.body;
        if (!name || cost == null) return res.status(400).json({ success: false, message: 'name and cost are required' });
        const eng = require('../services/engagementService');
        const result = eng.addShopItem(guildId, { name, description, type: type || 'role', cost: parseInt(cost, 10), roleId, codes, quantity_remaining: quantity != null ? parseInt(quantity, 10) : -1 });
        if (!result?.success) return res.status(400).json(result || { success: false, message: 'Failed to create shop item' });
        res.json(result);
      } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    this.app.delete('/api/admin/engagement/shop/:id', adminAuthMiddleware, (req, res) => {
      if (!ensureEngagementModule(req, res)) return;
      try {
        const guildId = req.guildId;
        const itemId = parseInt(req.params.id, 10);
        const eng = require('../services/engagementService');
        res.json(eng.removeShopItem(guildId, itemId));
      } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    // ==================== NFT ACTIVITY ADMIN CONFIG ====================

    this.app.get('/api/admin/nft-activity/events', adminAuthMiddleware, (req, res) => {
      if (!ensureNftTrackerModule(req, res)) return;
      try {
        const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
        const events = nftActivityService.listEventsForGuild(req.guildId, limit);
        res.json({ success: true, events });
      } catch (error) {
        logger.error('Error fetching nft activity events:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/admin/nft-activity/config', adminAuthMiddleware, (req, res) => {
      if (!ensureNftTrackerModule(req, res)) return;
      try {
        const config = nftActivityService.getAlertConfig();
        if (!config) return res.status(500).json({ success: false, message: 'Failed to load NFT activity config' });
        res.json({ success: true, config });
      } catch (error) {
        logger.error('Error getting NFT activity config:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/admin/nft-activity/config', adminAuthMiddleware, (req, res) => {
      if (!ensureNftTrackerModule(req, res)) return;
      try {
        const { enabled, channelId, eventTypes, minSol } = req.body;
        const result = nftActivityService.updateAlertConfig({ enabled, channelId, eventTypes, minSol });
        if (!result.success) return res.status(400).json(result);
        res.json({ success: true, message: 'NFT activity config updated' });
      } catch (error) {
        logger.error('Error updating NFT activity config:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== NFT TRACKER COLLECTIONS (per-collection config) ====================

    this.app.get('/api/admin/nft-tracker/collections', adminAuthMiddleware, (req, res) => {
      if (!ensureNftTrackerModule(req, res)) return;
      try {
        const collections = nftActivityService.getTrackedCollections(req.guildId);
        res.json({ success: true, collections });
      } catch (error) {
        logger.error('Error getting tracked collections:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/nft-tracker/collections', adminAuthMiddleware, (req, res) => {
      if (!ensureNftTrackerModule(req, res)) return;
      try {
        const { collectionAddress, collectionName, channelId, trackMint, trackSale, trackList, trackDelist, trackTransfer, trackBid, meSymbol } = req.body;
        const result = nftActivityService.addTrackedCollection({ guildId: req.guildId, collectionAddress, collectionName, channelId, trackMint, trackSale, trackList, trackDelist, trackTransfer, trackBid, meSymbol });
        if (!result.success) return res.status(400).json(result);
        nftActivityService.syncAddressToHelius(collectionAddress, 'add').catch(() => {});
        res.json(result);
      } catch (error) {
        logger.error('Error adding tracked collection:', error);
        res.status(500).json({ success: false, message: 'Failed to add tracked collection', detail: error?.message || 'unknown_error' });
      }
    });

    this.app.delete('/api/admin/nft-tracker/collections/:id', adminAuthMiddleware, (req, res) => {
      if (!ensureNftTrackerModule(req, res)) return;
      try {
        // Look up collection address before deleting so we can unsync from Helius
        const collections = nftActivityService.getTrackedCollections(req.guildId);
        const collection = collections && collections.find(c => String(c.id) === String(req.params.id));
        const result = nftActivityService.removeTrackedCollection(req.params.id, req.guildId);
        if (!result.success) return res.status(400).json(result);
        if (collection && collection.collection_address) {
          nftActivityService.syncAddressToHelius(collection.collection_address, 'remove').catch(() => {});
        }
        res.json(result);
      } catch (error) {
        logger.error('Error removing tracked collection:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/admin/nft-tracker/collections/:id', adminAuthMiddleware, (req, res) => {
      if (!ensureNftTrackerModule(req, res)) return;
      try {
        const result = nftActivityService.updateTrackedCollection(req.params.id, req.body, req.guildId);
        if (!result.success) return res.status(400).json(result);
        res.json(result);
      } catch (error) {
        logger.error('Error updating tracked collection:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    const registerTokenTrackerRoutes = (basePath) => {
      this.app.get(`${basePath}/tokens`, adminAuthMiddleware, (req, res) => {
        if (!ensureTokenTrackerModule(req, res)) return;
        try {
          const trackedWalletsService = require('../services/trackedWalletsService');
          const tokens = trackedWalletsService.getTrackedTokens(req.guildId || null);
          res.json({ success: true, tokens });
        } catch (error) {
          logger.error(`Error getting tracked tokens (${basePath}):`, error);
          res.status(500).json({ success: false, message: 'Internal server error' });
        }
      });

      this.app.post(`${basePath}/tokens`, adminAuthMiddleware, (req, res) => {
        if (!ensureTokenTrackerModule(req, res)) return;
        try {
          const trackedWalletsService = require('../services/trackedWalletsService');
          const {
            tokenMint,
            tokenSymbol,
            tokenName,
            decimals,
            enabled,
            alertChannelId,
            alertChannelIds,
            alertBuys,
            alertSells,
            alertTransfers,
            minAlertAmount,
          } = req.body || {};
          const result = trackedWalletsService.addTrackedToken({
            guildId: req.guildId || '',
            tokenMint,
            tokenSymbol: tokenSymbol || null,
            tokenName: tokenName || null,
            decimals: decimals === undefined ? null : decimals,
            enabled: enabled !== false,
            alertChannelId: alertChannelId || null,
            alertChannelIds: Array.isArray(alertChannelIds) ? alertChannelIds : null,
            alertBuys: alertBuys !== false,
            alertSells: alertSells !== false,
            alertTransfers: alertTransfers === true,
            minAlertAmount: minAlertAmount === undefined ? 0 : minAlertAmount,
          });
          if (!result.success) return res.status(400).json(result);
          res.json(result);
        } catch (error) {
          logger.error(`Error adding tracked token (${basePath}):`, error);
          res.status(500).json({ success: false, message: 'Internal server error' });
        }
      });

      this.app.put(`${basePath}/tokens/:id`, adminAuthMiddleware, (req, res) => {
        if (!ensureTokenTrackerModule(req, res)) return;
        try {
          const trackedWalletsService = require('../services/trackedWalletsService');
          const updates = {};
          const body = req.body || {};
          if (body.tokenMint !== undefined) updates.tokenMint = body.tokenMint;
          if (body.tokenSymbol !== undefined) updates.tokenSymbol = body.tokenSymbol;
          if (body.tokenName !== undefined) updates.tokenName = body.tokenName;
          if (body.decimals !== undefined) updates.decimals = body.decimals;
          if (body.enabled !== undefined) updates.enabled = !!body.enabled;
          if (body.alertChannelId !== undefined) updates.alertChannelId = body.alertChannelId || null;
          if (body.alertChannelIds !== undefined) updates.alertChannelIds = Array.isArray(body.alertChannelIds) ? body.alertChannelIds : [];
          if (body.alertBuys !== undefined) updates.alertBuys = !!body.alertBuys;
          if (body.alertSells !== undefined) updates.alertSells = !!body.alertSells;
          if (body.alertTransfers !== undefined) updates.alertTransfers = !!body.alertTransfers;
          if (body.minAlertAmount !== undefined) updates.minAlertAmount = body.minAlertAmount;

          const result = trackedWalletsService.updateTrackedToken(req.params.id, updates, req.guildId || null);
          if (!result.success) return res.status(400).json(result);
          res.json(result);
        } catch (error) {
          logger.error(`Error updating tracked token (${basePath}):`, error);
          res.status(500).json({ success: false, message: 'Internal server error' });
        }
      });

      this.app.delete(`${basePath}/tokens/:id`, adminAuthMiddleware, (req, res) => {
        if (!ensureTokenTrackerModule(req, res)) return;
        try {
          const trackedWalletsService = require('../services/trackedWalletsService');
          const result = trackedWalletsService.removeTrackedToken(req.params.id, req.guildId || null);
          if (!result.success) return res.status(400).json(result);
          res.json(result);
        } catch (error) {
          logger.error(`Error removing tracked token (${basePath}):`, error);
          res.status(500).json({ success: false, message: 'Internal server error' });
        }
      });

      this.app.get(`${basePath}/token-events`, adminAuthMiddleware, (req, res) => {
        if (!ensureTokenTrackerModule(req, res)) return;
        try {
          const trackedWalletsService = require('../services/trackedWalletsService');
          const limit = Number(req.query.limit || 30);
          const events = trackedWalletsService.listTrackedTokenEvents(req.guildId || null, limit);
          res.json({ success: true, events });
        } catch (error) {
          logger.error(`Error listing tracked token events (${basePath}):`, error);
          res.status(500).json({ success: false, message: 'Internal server error' });
        }
      });
    };

    // Dedicated token tracker API paths
    registerTokenTrackerRoutes('/api/admin/token-tracker');

    // ==================== TICKET MANAGEMENT (admin) ====================

    this.app.get('/api/admin/tickets/categories', adminAuthMiddleware, (req, res) => {
      if (!ensureTicketingModule(req, res)) return;
      try {
        const categories = ticketService.getAllCategories(req.guildId);
        res.json({ success: true, categories });
      } catch (error) {
        logger.error('Error fetching ticket categories:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/tickets/categories', adminAuthMiddleware, (req, res) => {
      if (!ensureTicketingModule(req, res)) return;
      try {
        const { name, emoji, description, parentChannelId, closedParentChannelId, allowedRoleIds, handlerRoleIds, pingRoleIds, templateFields } = req.body;
        if (!name) return res.status(400).json({ success: false, message: 'Name is required' });
        const result = ticketService.addCategory({ name, emoji, description, parentChannelId, closedParentChannelId, allowedRoleIds, handlerRoleIds, pingRoleIds, templateFields }, req.guildId);
        if (!result.success) return res.status(400).json(result);
        res.json(result);
      } catch (error) {
        logger.error('Error adding ticket category:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/admin/tickets/categories/:id', adminAuthMiddleware, (req, res) => {
      if (!ensureTicketingModule(req, res)) return;
      try {
        const result = ticketService.updateCategory(parseInt(req.params.id), req.body, req.guildId);
        if (!result.success) return res.status(400).json(result);
        res.json(result);
      } catch (error) {
        logger.error('Error updating ticket category:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.delete('/api/admin/tickets/categories/:id', adminAuthMiddleware, (req, res) => {
      if (!ensureTicketingModule(req, res)) return;
      try {
        const result = ticketService.deleteCategory(parseInt(req.params.id), req.guildId);
        if (!result.success) return res.status(400).json(result);
        res.json(result);
      } catch (error) {
        logger.error('Error deleting ticket category:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/admin/tickets', adminAuthMiddleware, (req, res) => {
      if (!ensureTicketingModule(req, res)) return;
      try {
        const { status, statuses, category, opener, q, from, to } = req.query;
        const statusList = typeof statuses === 'string' && statuses.trim()
          ? statuses.split(',').map(s => s.trim()).filter(Boolean)
          : undefined;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const allTickets = ticketService.getAllTickets({
          guildId: req.guildId || '',
          status,
          statuses: statusList,
          category: category ? parseInt(category) : undefined,
          opener,
          q,
          from,
          to
        });
        const totalCount = allTickets.length;
        const tickets = allTickets.slice(offset, offset + limit);
        res.json({ success: true, tickets, total: totalCount, limit, offset });
      } catch (error) {
        logger.error('Error fetching tickets:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/admin/tickets/:id/transcript', adminAuthMiddleware, async (req, res) => {
      if (!ensureTicketingModule(req, res)) return;
      try {
        const ticket = ticketService.getTicketById(parseInt(req.params.id), req.guildId);
        if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
        const result = await ticketService.getTranscript(ticket.channel_id);
        if (!result.success) return res.status(404).json(result);
        res.json(result);
      } catch (error) {
        logger.error('Error fetching ticket transcript:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/tickets/panel', adminAuthMiddleware, async (req, res) => {
      if (!ensureTicketingModule(req, res)) return;
      try {
        const { channelId, title, description } = req.body;
        if (!channelId) return res.status(400).json({ success: false, message: 'channelId is required' });
        const result = await ticketService.postOrUpdatePanel(channelId, { title, description }, req.guildId);
        if (!result.success) return res.status(400).json(result);
        res.json(result);
      } catch (error) {
        logger.error('Error posting ticket panel:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== BILLING ENTITLEMENT WEBHOOK ====================

    this.app.post('/api/billing/webhook/entitlement', (req, res) => {
      try {
        const configuredSecret = process.env.ENTITLEMENT_WEBHOOK_SECRET;
        if (!configuredSecret) {
          return res.status(503).json({ success: false, message: 'Entitlement webhook is not configured' });
        }

        const providedSecret = normalizeWebhookValue(req.get('x-entitlement-secret'));
        if (!timingSafeEquals(providedSecret, configuredSecret)) {
          return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const payload = req.body && typeof req.body === 'object' ? req.body : {};
        const normalizedPayload = {
          eventType: normalizeWebhookValue(payload.eventType),
          customerId: normalizeWebhookValue(payload.customerId),
          guildId: normalizeWebhookValue(payload.guildId),
          plan: normalizeWebhookValue(payload.plan),
          status: normalizeWebhookValue(payload.status),
          provider: normalizeWebhookValue(payload.provider),
          subscriptionId: normalizeWebhookValue(payload.subscriptionId || payload.subscription_id),
          billingInterval: normalizeWebhookValue(payload.billingInterval || payload.billing_interval || payload.interval),
          currentPeriodStart: payload.currentPeriodStart ?? payload.current_period_start ?? payload.periodStart ?? null,
          currentPeriodEnd: payload.currentPeriodEnd ?? payload.current_period_end ?? payload.periodEnd ?? payload.expiresAt ?? null,
          cancelAtPeriodEnd: payload.cancelAtPeriodEnd ?? payload.cancel_at_period_end,
          canceledAt: payload.canceledAt ?? payload.canceled_at ?? payload.cancelledAt ?? payload.cancelled_at ?? null,
          lastPaymentAt: payload.lastPaymentAt ?? payload.last_payment_at ?? payload.paidAt ?? payload.paymentAt ?? null,
          paymentStatus: normalizeWebhookValue(payload.paymentStatus || payload.payment_status),
          metadata: payload.metadata === undefined ? undefined : payload.metadata
        };
        const payloadHash = hashWebhookPayload(normalizedPayload);

        const existingEvent = db.prepare(`
          SELECT id, result
          FROM billing_entitlement_events
          WHERE payload_hash = ?
        `).get(payloadHash);

        if (existingEvent) {
          return res.json({
            success: true,
            duplicate: true,
            eventId: existingEvent.id,
            result: existingEvent.result
          });
        }

        const normalizedEventType = normalizedPayload.eventType.toLowerCase();
        const normalizedStatus = normalizedPayload.status.toLowerCase();
        const normalizedPlan = normalizeWebhookValue(normalizedPayload.plan).toLowerCase();
        const successMarkers = new Set(['approved', 'success', 'paid', 'active', 'trialing']);
        const suspendedMarkers = new Set(['cancelled', 'canceled', 'past_due', 'suspended', 'unpaid', 'payment_failed', 'expired']);
        const actionMarkers = new Set([normalizedEventType, normalizedStatus].filter(Boolean));
        const shouldApplyPlan = Array.from(actionMarkers).some(marker => successMarkers.has(marker));
        const shouldSuspend = Array.from(actionMarkers).some(marker => suspendedMarkers.has(marker));

        let result = 'ignored';

        if (!normalizedPayload.guildId || !normalizedPayload.eventType || !normalizedPayload.status) {
          result = 'invalid:missing_required_fields';
        } else if (shouldApplyPlan) {
          if (!normalizedPayload.plan) {
            result = 'invalid:missing_plan';
          } else {
            const planResult = tenantService.setTenantPlan(
              normalizedPayload.guildId,
              normalizedPayload.plan,
              'billing-entitlement-webhook'
            );

            if (!planResult.success) {
              result = `error:${planResult.message || 'plan_update_failed'}`;
            } else {
              result = `applied_plan:${normalizedPlan}`;
              // Subscription became valid -> mark tenant active as part of billing recovery.
              tenantService.setTenantStatus(
                normalizedPayload.guildId,
                'active',
                'billing-entitlement-webhook'
              );
            }
          }
        } else if (shouldSuspend) {
          // Remove paid entitlements on failed/cancelled payments by downgrading to Starter.
          const downgradeResult = tenantService.setTenantPlan(
            normalizedPayload.guildId,
            'starter',
            'billing-entitlement-webhook'
          );
          const statusResult = tenantService.setTenantStatus(
            normalizedPayload.guildId,
            'suspended',
            'billing-entitlement-webhook'
          );

          if (!downgradeResult.success) {
            result = `error:${downgradeResult.message || 'downgrade_failed'}`;
          } else if (!statusResult.success) {
            result = `error:${statusResult.message || 'status_update_failed'}`;
          } else {
            result = 'suspended:downgraded_to_starter';
          }
        }

        try {
          billingService.upsertFromEntitlement(normalizedPayload, result);
        } catch (billingError) {
          logger.warn('Billing metadata upsert failed:', billingError?.message || billingError);
        }

        const insertResult = db.prepare(`
          INSERT INTO billing_entitlement_events (
            guild_id,
            customer_id,
            event_type,
            payload_hash,
            payload_json,
            result,
            processed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
          normalizedPayload.guildId || null,
          normalizedPayload.customerId || null,
          normalizedPayload.eventType || null,
          payloadHash,
          JSON.stringify(stableJson(normalizedPayload)),
          result
        );

        return res.json({
          success: true,
          eventId: insertResult.lastInsertRowid,
          result
        });
      } catch (error) {
        if (error && String(error.message || error).includes('UNIQUE constraint failed: billing_entitlement_events.payload_hash')) {
          const payload = req.body && typeof req.body === 'object' ? req.body : {};
          const normalizedPayload = {
            eventType: normalizeWebhookValue(payload.eventType),
            customerId: normalizeWebhookValue(payload.customerId),
            guildId: normalizeWebhookValue(payload.guildId),
            plan: normalizeWebhookValue(payload.plan),
            status: normalizeWebhookValue(payload.status),
            provider: normalizeWebhookValue(payload.provider),
            subscriptionId: normalizeWebhookValue(payload.subscriptionId || payload.subscription_id),
            billingInterval: normalizeWebhookValue(payload.billingInterval || payload.billing_interval || payload.interval),
            currentPeriodStart: payload.currentPeriodStart ?? payload.current_period_start ?? payload.periodStart ?? null,
            currentPeriodEnd: payload.currentPeriodEnd ?? payload.current_period_end ?? payload.periodEnd ?? payload.expiresAt ?? null,
            cancelAtPeriodEnd: payload.cancelAtPeriodEnd ?? payload.cancel_at_period_end,
            canceledAt: payload.canceledAt ?? payload.canceled_at ?? payload.cancelledAt ?? payload.cancelled_at ?? null,
            lastPaymentAt: payload.lastPaymentAt ?? payload.last_payment_at ?? payload.paidAt ?? payload.paymentAt ?? null,
            paymentStatus: normalizeWebhookValue(payload.paymentStatus || payload.payment_status),
            metadata: payload.metadata === undefined ? undefined : payload.metadata
          };
          const duplicateHash = hashWebhookPayload(normalizedPayload);
          const duplicateEvent = db.prepare(`
            SELECT id, result
            FROM billing_entitlement_events
            WHERE payload_hash = ?
          `).get(duplicateHash);

          return res.json({
            success: true,
            duplicate: true,
            eventId: duplicateEvent?.id || null,
            result: duplicateEvent?.result || 'duplicate'
          });
        }

        logger.error('Error in entitlement webhook:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== NFT / TOKEN ACTIVITY WEBHOOKS (optional external source) ====================

    const verifyActivityWebhookAuth = (req) => {
      const configuredSecret = getActivityWebhookSecret();
      if (!configuredSecret) {
        return { ok: false, status: 503, payload: { error: 'Webhook not configured' } };
      }

      const providedRaw = req.headers['authorization'] || req.headers['x-webhook-secret'];
      const provided = normalizeWebhookSecretHeader(providedRaw);
      if (!provided || !timingSafeEquals(provided, configuredSecret)) {
        return { ok: false, status: 401, payload: { success: false, message: 'Unauthorized' } };
      }

      return { ok: true };
    };

    this.app.post('/api/webhooks/nft-activity', async (req, res) => {
      try {
        const auth = verifyActivityWebhookAuth(req);
        if (!auth.ok) {
          return res.status(auth.status).json(auth.payload);
        }

        const events = Array.isArray(req.body) ? req.body : [req.body];
        let nftProcessed = 0;
        let nftIgnored = 0;
        for (const event of events) {
          const result = nftActivityService.ingestEvent(event, 'webhook');
          if (result.ignored) nftIgnored += 1;
          else if (result.success) nftProcessed += 1;
        }

        // Process token ingestion async so webhook ACK stays fast (prevents provider timeouts/retries).
        setImmediate(() => {
          trackedWalletsService.ingestWebhookBatch(events, { source: 'webhook' })
            .then(tokenSummary => {
              const ignoredReasonText = tokenSummary.ignored && tokenSummary.ignoredReasons
                ? ` reasons=${JSON.stringify(tokenSummary.ignoredReasons)}`
                : '';
              logger.log(
                `[activity-webhook] nft received=${events.length} processed=${nftProcessed} ignored=${nftIgnored};`
                + ` token processed=${tokenSummary.processed} ignored=${tokenSummary.ignored} failed=${tokenSummary.failed}`
                + ` inserted=${tokenSummary.insertedEvents} dup=${tokenSummary.duplicateEvents} alerts=${tokenSummary.sentAlerts}`
                + ignoredReasonText
              );
            })
            .catch(error => logger.error('Error in async token ingestion (nft-activity webhook):', error));
        });

        return res.json({
          success: true,
          nft: { received: events.length, processed: nftProcessed, ignored: nftIgnored },
          token: { queued: events.length },
        });
      } catch (error) {
        logger.error('Error in nft activity webhook:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/webhooks/token-activity', async (req, res) => {
      try {
        const auth = verifyActivityWebhookAuth(req);
        if (!auth.ok) {
          return res.status(auth.status).json(auth.payload);
        }

        const events = Array.isArray(req.body) ? req.body : [req.body];
        setImmediate(() => {
          trackedWalletsService.ingestWebhookBatch(events, { source: 'webhook-token-only' })
            .then(summary => {
              const ignoredReasonText = summary.ignored && summary.ignoredReasons
                ? ` reasons=${JSON.stringify(summary.ignoredReasons)}`
                : '';
              logger.log(
                `[token-webhook] received=${summary.received} processed=${summary.processed} ignored=${summary.ignored}`
                + ` failed=${summary.failed} inserted=${summary.insertedEvents} dup=${summary.duplicateEvents} alerts=${summary.sentAlerts}`
                + ignoredReasonText
              );
            })
            .catch(error => logger.error('Error in async token ingestion (token-activity webhook):', error));
        });
        return res.json({ success: true, queued: events.length });
      } catch (error) {
        logger.error('Error in token activity webhook:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

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


