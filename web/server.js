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
const ticketService = require('../services/ticketService');
const superadminService = require('../services/superadminService');
const superadminGuard = require('../middleware/superadminGuard');
const { BATTLE_ERAS } = require('../config/battleEras');
const battleService = require('../services/battleService');

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

class WebServer {
  constructor() {
    this.app = express();
    this.port = process.env.WEB_PORT || 3000;
    this.client = null; // Discord client reference
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

    // CORS for public API - explicitly configured for the-solpranos.com integration
    // Allows cross-origin requests for public endpoints
    const allowedOrigins = [
      process.env.WEB_URL,
      'https://the-solpranos.com',
      'https://www.the-solpranos.com',
      'https://discordbot.the-solpranos.com',
    ].filter(Boolean);
    if (process.env.NODE_ENV !== 'production') {
      allowedOrigins.push('http://localhost:3000', 'http://localhost:5173');
    }

    this.app.use(cors({
      origin: allowedOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', REQUEST_GUILD_HEADER, 'x-entitlement-secret'],
      exposedHeaders: ['X-Total-Count'], // For pagination
      maxAge: 86400 // 24 hours preflight cache
    }));

    this.app.use(require('cookie-parser')());
    this.app.use(express.json());
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
      keyGenerator: (req) => req.session?.discordUser?.id || (req.ip || '').replace(/^::ffff:/, ''),
      message: rateLimitMessage
    });

    this.app.use('/api/public/', publicApiLimiter);
    this.app.use('/auth/', authLimiter);
    this.app.use('/api/verify/', verifyLimiter);
    this.app.use('/api/micro-verify/', verifyLimiter);
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

    const getBotGuildIds = () => {
      if (!this.client) {
        return new Set();
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
          const botGuildIds = getBotGuildIds();
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

      const botGuildIds = getBotGuildIds();
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

    // ==================== API V1 (VERSIONED PUBLIC API) ====================

    const v1Router = require('./routes/v1');
    const { errorHandler, notFoundHandler } = require('../utils/apiErrorHandler');

    // Mount v1 API routes (standardized, versioned)
    this.app.use('/api/public/v1', v1Router);
    
    // ==================== PUBLIC PAGES ====================
    
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'portal.html'));
    });

    this.app.get('/verify', (req, res) => {
      // Unified UI: send verification flow to portal wallets section
      if (!req.session.discordUser) {
        req.session.returnTo = '/?section=wallets';
        return res.redirect('/auth/discord/login');
      }
      return res.redirect('/?section=wallets');
    });

    this.app.get('/dashboard', (req, res) => {
      // Redirect to portal for unified experience
      res.redirect('/?section=dashboard');
    });

    this.app.get('/admin', (req, res) => {
      // Redirect to portal admin section for unified UI
      res.redirect('/?section=admin');
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
      const clientId = process.env.CLIENT_ID;
      const redirectUri = encodeURIComponent(process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/discord/callback');
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
            redirect_uri: process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/discord/callback'
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

        // Store in session (do NOT persist access token — use transiently only)
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
        
        // Get user's proposals
        const proposals = db.prepare("SELECT * FROM proposals WHERE creator_id = ? AND status NOT IN ('expired') ORDER BY created_at DESC").all(discordId);
        
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
            totalPoints: pointsResult.total
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
        const botGuildIds = getBotGuildIds();
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
            managedSeen.add(guildId);

            const guild = await fetchGuildById(guildId);
            managedServers.push({
              guildId,
              name: guild?.name || tenant.guildName || `Server ${guildId}`,
              icon: guild?.icon || null,
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

      const guildId = normalizeGuildId(req.query.guildId);
      if (!guildId) {
        return res.status(400).json({ success: false, message: 'guildId is required' });
      }

      try {
        const discordGuilds = await getDiscordUserGuilds(req);
        const guild = discordGuilds.find(entry => entry.id === guildId);
        if (!guild || !hasDiscordAdminPermission(guild)) {
          return res.status(403).json({ success: false, message: 'Admin permission required' });
        }

        const clientId = process.env.CLIENT_ID;
        const permissions = process.env.BOT_INVITE_PERMISSIONS || '8';
        const redirectUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${encodeURIComponent(permissions)}&guild_id=${encodeURIComponent(guildId)}&disable_guild_select=true`;

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
        const { title, description, category, costIndication } = req.body;

        const validationErr = validateProposalInput(req.body);
        if (validationErr) return res.status(400).json({ success: false, message: validationErr });

        const userInfo = await roleService.getUserInfo(discordId);
        if (!userInfo || !userInfo.voting_power || userInfo.voting_power < 1) {
          return res.status(403).json({ success: false, message: 'You need at least 1 verified NFT to create proposals' });
        }

        const result = proposalService.createProposal(discordId, { title, description, category: category || 'Other', costIndication: costIndication || null });
        res.json(result);
      } catch (error) {
        logger.error('Error creating proposal via web:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== GOVERNANCE LIFECYCLE ENDPOINTS ====================

    // POST /api/governance/proposals — alias for user proposal creation (session auth)
    this.app.post('/api/governance/proposals', async (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }
      try {
        const discordId = req.session.discordUser.id;
        const { title, description, category, costIndication } = req.body;
        const validationErr = validateProposalInput(req.body);
        if (validationErr) return res.status(400).json({ success: false, message: validationErr });
        const userInfo = await roleService.getUserInfo(discordId);
        if (!userInfo || !userInfo.voting_power || userInfo.voting_power < 1) {
          return res.status(403).json({ success: false, message: 'You need at least 1 verified NFT to create proposals' });
        }
        const result = proposalService.createProposal(discordId, { title, description, category: category || 'Other', costIndication: costIndication || null });
        res.json(result);
      } catch (error) {
        logger.error('Error creating proposal (governance):', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // POST /api/governance/proposals/:id/submit — author submits for review
    this.app.post('/api/governance/proposals/:id/submit', (req, res) => {
      if (!req.session.discordUser) return res.status(401).json({ success: false, message: 'Not authenticated' });
      try {
        const result = proposalService.submitForReview(req.params.id, req.session.discordUser.id);
        res.json(result);
      } catch (error) {
        logger.error('Error submitting proposal for review:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // POST /api/governance/proposals/:id/support — add support (session auth)
    this.app.post('/api/governance/proposals/:id/support', async (req, res) => {
      if (!req.session.discordUser) return res.status(401).json({ success: false, message: 'Not authenticated' });
      try {
        const result = proposalService.addSupporter(req.params.id, req.session.discordUser.id);
        res.json(result);
      } catch (error) {
        logger.error('Error adding support:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // GET /api/governance/proposals/:id/comments — public
    this.app.get('/api/governance/proposals/:id/comments', (req, res) => {
      try {
        const comments = proposalService.getComments(req.params.id);
        res.json({ success: true, comments });
      } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // POST /api/governance/proposals/:id/comments — session auth
    this.app.post('/api/governance/proposals/:id/comments', commentLimiter, (req, res) => {
      if (!req.session.discordUser) return res.status(401).json({ success: false, message: 'Not authenticated' });
      try {
        const { content } = req.body;
        if (!content || !content.trim()) return res.status(400).json({ success: false, message: 'Content is required' });
        if (content.length > 1000) return res.status(400).json({ success: false, message: 'Comment must be 1000 characters or less' });
        const result = proposalService.addComment(req.params.id, req.session.discordUser.id, req.session.discordUser.username, content.trim());
        res.json(result);
      } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // POST /api/governance/proposals/:id/veto — council member veto vote
    this.app.post('/api/governance/proposals/:id/veto', async (req, res) => {
      if (!req.session.discordUser) return res.status(401).json({ success: false, message: 'Not authenticated' });
      try {
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

    // Global settings — no guild context required, superadmin only
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
        const exclusiveEras = Object.values(BATTLE_ERAS)
          .filter(e => e.exclusive)
          .map(e => ({ key: e.key, name: e.name, description: e.description }));
        res.json({ success: true, eras: exclusiveEras });
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
        if (!BATTLE_ERAS[eraKey]) {
          return res.status(400).json({ success: false, message: 'Unknown era key' });
        }
        if (!BATTLE_ERAS[eraKey].exclusive) {
          return res.status(400).json({ success: false, message: 'Era is not exclusive — already available to all guilds' });
        }
        db.prepare(`
          INSERT OR IGNORE INTO battle_era_assignments (guild_id, era_key, assigned_by)
          VALUES (?, ?, ?)
        `).run(guildId, eraKey, req.session.discordUser.id);
        res.json({ success: true, message: `Era "${eraKey}" assigned to guild ${guildId}` });
      } catch (error) {
        logger.error('Error assigning era:', error);
        res.status(500).json({ success: false, message: 'Failed to assign era' });
      }
    });

    this.app.delete('/api/superadmin/era-assignments/:guildId/:eraKey', superadminGuard, (req, res) => {
      try {
        const { guildId, eraKey } = req.params;
        const result = db.prepare('DELETE FROM battle_era_assignments WHERE guild_id = ? AND era_key = ?').run(guildId, eraKey);
        if (result.changes === 0) {
          return res.status(404).json({ success: false, message: 'Assignment not found' });
        }
        res.json({ success: true, message: `Era "${eraKey}" revoked from guild ${guildId}` });
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

    this.app.get('/api/admin/env-status', (req, res) => {
      if (!req.session?.discordUser) return res.status(401).json({ success: false, message: 'Not authenticated' });
      res.json({
        mockMode: process.env.MOCK_MODE === 'true',
        heliusConfigured: !!process.env.HELIUS_API_KEY,
        solanaRpc: process.env.SOLANA_RPC_URL || 'default',
        nodeEnv: process.env.NODE_ENV || 'development',
        webhookSecretConfigured: !!process.env.NFT_ACTIVITY_WEBHOOK_SECRET
      });
    });

    this.app.get('/api/admin/branding', adminAuthMiddleware, async (req, res) => {
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
      try {
        const ALLOWED_BRANDING_FIELDS = ['bot_display_name', 'brand_emoji', 'brand_color', 'logo_url', 'support_url', 'footer_text', 'display_name', 'primary_color', 'secondary_color', 'icon_url', 'ticketing_color', 'selfserve_color', 'nfttracker_color', 'ticket_panel_title', 'ticket_panel_description', 'selfserve_panel_title', 'selfserve_panel_description', 'nfttracker_panel_title', 'nfttracker_panel_description'];
        const patch = {};
        for (const key of ALLOWED_BRANDING_FIELDS) {
          if (req.body[key] !== undefined) patch[key] = req.body[key];
        }
        const result = tenantService.updateTenantBranding(req.guildId, patch, req.session?.discordUser?.id || 'unknown');
        if (!result.success) return res.status(400).json(result);
        res.json({ success: true, branding: result.branding || null });
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
        
        // Smart load: DB override → .env fallback
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
          nftActivityWebhookSecret: settings.nftActivityWebhookSecret || process.env.NFT_ACTIVITY_WEBHOOK_SECRET || '',

          // Tenant scaffold flags
          multiTenantEnabled,
          tenantEnabled: multiTenantEnabled && !!tenantContext.tenant,
          readOnlyManaged: multiTenantEnabled ? tenantContext.readOnlyManaged : false,
          tenantBranding: tenantContext.branding
            ? { ...tenantContext.branding, logo_url: tenantContext.branding.logo_url || tenantLogoFallback || null }
            : (tenantLogoFallback ? { logo_url: tenantLogoFallback } : null)
        };

        // In multitenant mode, module enabled states come from tenant module entitlements
        if (multiTenantEnabled && tenantContext?.tenant && tenantContext.modules) {
          effectiveSettings.moduleBattleEnabled = !!tenantContext.modules.battle;
          effectiveSettings.moduleGovernanceEnabled = !!tenantContext.modules.governance;
          effectiveSettings.moduleVerificationEnabled = !!tenantContext.modules.verification;
          effectiveSettings.moduleMissionsEnabled = !!tenantContext.modules.heist;
          effectiveSettings.moduleTreasuryEnabled = !!tenantContext.modules.treasury;
          effectiveSettings.moduleNftTrackerEnabled = !!tenantContext.modules.nfttracker;
          effectiveSettings.moduleBrandingEnabled = !!tenantContext.modules.branding;
          effectiveSettings.moduleRoleClaimEnabled = !!tenantContext.modules.selfserveroles;
          effectiveSettings.moduleTicketingEnabled = !!tenantContext.modules.ticketing;
          // tenant-specific verification settings (avoid cross-tenant OG leakage)
          const tenantVerification = tenantService.getTenantVerificationSettings(req.guildId);
          if (tenantVerification.ogRoleId !== undefined) effectiveSettings.ogRoleId = tenantVerification.ogRoleId || '';
          if (tenantVerification.ogRoleLimit !== undefined) effectiveSettings.ogRoleLimit = tenantVerification.ogRoleLimit || 0;
          // Tell the frontend which module keys are actually assigned (exist in tenant_modules)
          effectiveSettings.assignedModuleKeys = Object.keys(tenantContext.modules);
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

    this.app.put('/api/admin/settings', adminAuthMiddleware, (req, res) => {
      try {
        const ALLOWED_SETTINGS_FIELDS = [
          'proposalsChannelId', 'votingChannelId', 'resultsChannelId', 'governanceLogChannelId',
          'quorumPercentage', 'supportThreshold', 'voteDurationHours',
          'moduleGovernanceEnabled', 'moduleVerificationEnabled', 'moduleTreasuryEnabled',
          'moduleNftTrackerEnabled', 'moduleBrandingEnabled', 'moduleMissionsEnabled', 'moduleBattleEnabled',
          'moduleTicketingEnabled', 'moduleRoleClaimEnabled',
          'battleRoundPauseMinSec', 'battleRoundPauseMaxSec', 'battleElitePrepSec', 'battleDefaultEra',
          'baseVerifiedRoleId', 'autoResyncEnabled', 'ogRoleId', 'ogRoleLimit',
          'treasuryWalletAddress', 'treasuryRefreshInterval', 'txAlertChannelId',
          'txAlertEnabled', 'txAlertIncomingOnly', 'txAlertMinSol',
          'displayName', 'displayEmoji', 'displayColor',
          'verificationReceiveWallet', 'nftActivityWebhookSecret',
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

        // In multi-tenant mode, module toggle states live in tenant_modules — NOT settings.json.
        // Route them through setTenantModule so reads from GET /api/admin/settings reflect the change.
        const multiTenantEnabled = tenantService.isMultitenantEnabled();
        if (multiTenantEnabled && req.guildId) {
          const tenantContext = tenantService.getTenantContext(req.guildId);
          if (tenantContext?.tenant) {
            const moduleFieldMap = {
              moduleBattleEnabled: 'battle',
              moduleGovernanceEnabled: 'governance',
              moduleVerificationEnabled: 'verification',
              moduleMissionsEnabled: 'heist',
              moduleTreasuryEnabled: 'treasury',
              moduleNftTrackerEnabled: 'nfttracker',
              moduleBrandingEnabled: 'branding',
              moduleRoleClaimEnabled: 'selfserveroles',
              moduleTicketingEnabled: 'ticketing',
              moduleEngagementEnabled: 'engagement',
            };
            for (const [field, moduleKey] of Object.entries(moduleFieldMap)) {
              if (sanitized[field] !== undefined) {
                // Only allow toggling modules that are actually assigned to this tenant
                if (tenantContext.modules && moduleKey in tenantContext.modules) {
                  tenantService.setTenantModule(req.guildId, moduleKey, !!sanitized[field], req.session?.discordUser?.id);
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
              logger.log(`[OG-DEBUG] ogRoleId was empty/falsy — skipping ogRoleService update. Current config: ${JSON.stringify(ogRoleService.getConfig())}`);
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
      try {
        const { discordId } = req.params;
        const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
        const wallets = db.prepare('SELECT * FROM wallets WHERE discord_id = ?').all(discordId);
        const proposals = db.prepare('SELECT * FROM proposals WHERE creator_id = ?').all(discordId);
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
      try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const totalCount = db.prepare('SELECT COUNT(*) as cnt FROM proposals').get().cnt;
        const proposals = db.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
        res.json({ success: true, proposals, total: totalCount, limit, offset });
      } catch (error) {
        logger.error('Error fetching proposals:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/proposals/:id/close', adminAuthMiddleware, async (req, res) => {
      try {
        const { id } = req.params;
        const result = await proposalService.closeVote(id);
        res.json(result);
      } catch (error) {
        logger.error('Error closing proposal:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Admin: approve proposal (pending_review → supporting)
    this.app.post('/api/admin/governance/proposals/:id/approve', adminAuthMiddleware, (req, res) => {
      try {
        const result = proposalService.approveProposal(req.params.id, req.session.discordUser.id);
        res.json(result);
      } catch (error) {
        logger.error('Error approving proposal:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Admin: hold proposal (pending_review → on_hold)
    this.app.post('/api/admin/governance/proposals/:id/hold', adminAuthMiddleware, (req, res) => {
      try {
        const { reason } = req.body;
        const result = proposalService.holdProposal(req.params.id, req.session.discordUser.id, reason);
        res.json(result);
      } catch (error) {
        logger.error('Error holding proposal:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Admin: promote to voting (supporting → voting, takes VP snapshot)
    this.app.post('/api/admin/governance/proposals/:id/promote', adminAuthMiddleware, async (req, res) => {
      try {
        const result = await proposalService.promoteToVoting(req.params.id, req.session.discordUser.id);
        res.json(result);
      } catch (error) {
        logger.error('Error promoting proposal:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Admin: conclude voting
    this.app.post('/api/admin/governance/proposals/:id/conclude', adminAuthMiddleware, async (req, res) => {
      try {
        const result = await proposalService.concludeProposal(req.params.id);
        res.json(result);
      } catch (error) {
        logger.error('Error concluding proposal:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Admin: emergency pause (Don + Consigliere only — caller must verify roles)
    this.app.post('/api/admin/governance/proposals/:id/pause', adminAuthMiddleware, (req, res) => {
      try {
        const result = proposalService.emergencyPause(req.params.id, req.session.discordUser.id);
        res.json(result);
      } catch (error) {
        logger.error('Error pausing proposal:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/admin/missions', adminAuthMiddleware, (req, res) => {
      try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const totalCount = db.prepare('SELECT COUNT(*) as cnt FROM missions').get().cnt;
        const missions = db.prepare('SELECT * FROM missions ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
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
          rewardPoints || 0
        );

        res.json(result);
      } catch (error) {
        logger.error('Error creating mission:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/missions/:id/start', adminAuthMiddleware, (req, res) => {
      try {
        const { id } = req.params;
        
        db.prepare('UPDATE missions SET status = ?, start_time = CURRENT_TIMESTAMP WHERE mission_id = ?').run('active', id);
        
        logger.log(`Mission ${id} started by admin`);
        res.json({ success: true, message: 'Mission started' });
      } catch (error) {
        logger.error('Error starting mission:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/missions/:id/complete', adminAuthMiddleware, (req, res) => {
      try {
        const { id } = req.params;
        const mission = db.prepare('SELECT * FROM missions WHERE mission_id = ?').get(id);
        
        if (!mission) {
          return res.status(404).json({ success: false, message: 'Mission not found' });
        }

        // Award points to all participants
        db.prepare('UPDATE mission_participants SET points_awarded = ? WHERE mission_id = ?').run(mission.reward_points, id);
        
        // Update mission status
        db.prepare('UPDATE missions SET status = ? WHERE mission_id = ?').run('completed', id);
        
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
      if (!row) return { tiers: [], traitRoles: [] };
      let tiers = [];
      let traitRoles = [];
      try { tiers = JSON.parse(row.tiers_json || '[]'); } catch {}
      try { traitRoles = JSON.parse(row.traits_json || '[]'); } catch {}
      return { tiers: Array.isArray(tiers) ? tiers : [], traitRoles: Array.isArray(traitRoles) ? traitRoles : [] };
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

    this.app.get('/api/admin/roles/config', adminAuthMiddleware, (req, res) => {
      try {
        const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
        const config = useTenantScoped
          ? getTenantRoleConfig(req.guildId)
          : roleService.getRoleConfigSummary();
        res.json({ success: true, config });
      } catch (error) {
        logger.error('Error fetching role config:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Tier CRUD
    this.app.post('/api/admin/roles/tiers', adminAuthMiddleware, (req, res) => {
      try {
        const { name, minNFTs, maxNFTs, votingPower, roleId, collectionId } = req.body;
        
        if (!name || minNFTs === undefined || maxNFTs === undefined || votingPower === undefined) {
          return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const useTenantScoped = tenantService.isMultitenantEnabled() && !!req.guildId;
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

    // Role sync endpoint
    this.app.post('/api/admin/roles/sync', adminAuthMiddleware, async (req, res) => {
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
          panelTitle: title || '🎖️ Get Your Roles',
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

    // ==================== ROLE PANELS API (multi-panel self-serve roles) ====================

    this.app.get('/api/admin/role-panels', adminAuthMiddleware, (req, res) => {
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
      try {
        const rolePanelService = require('../services/rolePanelService');
        const { title, description, channelId, singleSelect } = req.body;
        const result = rolePanelService.createPanel({ guildId: req.guildId || '', title, description, channelId, singleSelect });
        res.json(result);
      } catch (e) {
        logger.error('Error creating role panel:', e);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/admin/role-panels/:id', adminAuthMiddleware, (req, res) => {
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
          panelTitle: panel.title || '🎖️ Get Your Roles',
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

    // Deprecation headers for legacy public API (superseded by /api/public/v1/)
    const deprecationHeaders = (req, res, next) => {
      res.set('Deprecation', 'true');
      res.set('Sunset', '2026-12-31');
      res.set('Link', '</api/public/v1/>; rel="successor-version"');
      next();
    };

    // Public treasury endpoint (no wallet address exposed)
    this.app.get('/api/public/treasury', deprecationHeaders, (req, res) => {
      try {
        const summary = treasuryService.getSummary();
        res.json(summary);
      } catch (error) {
        logger.error('Error fetching public treasury:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Admin treasury endpoints
    this.app.get('/api/admin/treasury', adminAuthMiddleware, (req, res) => {
      try {
        const summary = treasuryService.getAdminSummary();
        res.json(summary);
      } catch (error) {
        logger.error('Error fetching admin treasury:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/admin/treasury/config', adminAuthMiddleware, (req, res) => {
      try {
        const { enabled, solanaWallet, refreshHours, txAlertsEnabled, txAlertChannelId, txAlertIncomingOnly, txAlertMinSol, watchChannelId } = req.body;
        const result = treasuryService.updateConfig({ enabled, solanaWallet, refreshHours, txAlertsEnabled, txAlertChannelId, txAlertIncomingOnly, txAlertMinSol, watchChannelId });
        res.json(result);
        // Fire-and-forget: update watch panel if watchChannelId was included
        if (watchChannelId !== undefined && this.client) {
          treasuryService.postOrUpdateWatchPanel(this.client).catch(err => logger.error('Watch panel post after config save failed:', err));
        }
      } catch (error) {
        logger.error('Error updating treasury config:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/treasury/refresh', adminAuthMiddleware, async (req, res) => {
      try {
        const result = await treasuryService.fetchBalances();
        res.json(result);
      } catch (error) {
        logger.error('Error refreshing treasury:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Treasury multi-wallet management
    this.app.get('/api/admin/treasury/wallets', adminAuthMiddleware, (req, res) => {
      try {
        const wallets = treasuryService.listWallets(req.guildId);
        res.json({ success: true, wallets });
      } catch (error) {
        logger.error('Error listing treasury wallets:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/treasury/wallets', adminAuthMiddleware, (req, res) => {
      try {
        const { address, label } = req.body;
        if (!address) return res.status(400).json({ success: false, message: 'address is required' });
        const result = treasuryService.addWallet(address, label || '', req.guildId);
        if (!result.success) return res.status(400).json(result);
        res.json(result);
      } catch (error) {
        logger.error('Error adding treasury wallet:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/admin/treasury/wallets/:id', adminAuthMiddleware, (req, res) => {
      try {
        const { address, label, enabled } = req.body || {};
        const result = treasuryService.updateWallet(parseInt(req.params.id), { address, label, enabled }, req.guildId);
        if (!result.success) return res.status(400).json(result);
        res.json(result);
      } catch (error) {
        logger.error('Error updating treasury wallet:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.delete('/api/admin/treasury/wallets/:id', adminAuthMiddleware, (req, res) => {
      try {
        const result = treasuryService.removeWallet(parseInt(req.params.id), req.guildId);
        if (!result.success) return res.status(400).json(result);
        res.json(result);
      } catch (error) {
        logger.error('Error removing treasury wallet:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== ADMIN API - BATTLE ERAS ====================

    this.app.get('/api/admin/battle/eras', adminAuthMiddleware, (req, res) => {
      try {
        const guildId = req.guildId;
        // Always include mafia (built-in, non-exclusive)
        const available = Object.values(BATTLE_ERAS)
          .filter(e => !e.exclusive)
          .map(e => ({ key: e.key, name: e.name }));
        // Add eras assigned to this guild
        if (guildId) {
          const assigned = battleService.getAssignedEras(guildId);
          assigned.forEach(key => {
            if (!available.find(e => e.key === key) && BATTLE_ERAS[key]) {
              available.push({ key, name: BATTLE_ERAS[key].name });
            }
          });
        }
        res.json({ success: true, eras: available });
      } catch (error) {
        logger.error('Error fetching battle eras:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== ADMIN API - VP MAPPINGS ====================

    this.app.get('/api/admin/governance/vp-mappings', adminAuthMiddleware, (req, res) => {
      try {
        const mappings = roleService.getRoleVPMappings();
        res.json({ success: true, mappings });
      } catch (error) {
        logger.error('Error fetching VP mappings:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/governance/vp-mappings', adminAuthMiddleware, (req, res) => {
      try {
        const { roleId, roleName, votingPower } = req.body;
        if (!roleId || votingPower === undefined) {
          return res.status(400).json({ success: false, message: 'roleId and votingPower are required' });
        }
        const result = roleService.addRoleVPMapping(roleId, roleName, parseInt(votingPower));
        res.json(result);
      } catch (error) {
        logger.error('Error adding VP mapping:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.delete('/api/admin/governance/vp-mappings/:roleId', adminAuthMiddleware, (req, res) => {
      try {
        const result = roleService.removeRoleVPMapping(req.params.roleId);
        res.json(result);
      } catch (error) {
        logger.error('Error removing VP mapping:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== PUBLIC API - GOVERNANCE ====================

        this.app.get('/api/public/proposals/active', deprecationHeaders, (req, res) => {
      try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const totalCount = db.prepare("SELECT COUNT(*) as cnt FROM proposals WHERE status IN ('supporting', 'voting')").get().cnt;
        const proposals = db.prepare("SELECT * FROM proposals WHERE status IN ('supporting', 'voting') ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
        
        const enrichedProposals = proposals.map(p => {
          const votes = {
            yes: { vp: p.yes_vp, count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(p.proposal_id, 'yes').c },
            no: { vp: p.no_vp, count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(p.proposal_id, 'no').c },
            abstain: { vp: p.abstain_vp, count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(p.proposal_id, 'abstain').c }
          };

          const totalVoted = p.yes_vp + p.no_vp + p.abstain_vp;
          const quorumPercentage = p.total_vp > 0 ? Math.round((totalVoted / p.total_vp) * 100) : 0;

          return {
            proposalId: p.proposal_id,
            title: p.title,
            description: p.description,
            status: p.status,
            creator: p.creator_id ? p.creator_id.slice(0, 4) + '****' : null,
            votes,
            quorum: {
              required: p.quorum_threshold,
              current: quorumPercentage
            },
            deadline: p.end_time,
            category: p.category || 'Other',
            costIndication: p.cost_indication,
            paused: !!p.paused
          };
        });

        res.json({ success: true, proposals: enrichedProposals, total: totalCount, limit, offset });
      } catch (error) {
        logger.error('Error fetching active proposals:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/public/proposals/concluded', deprecationHeaders, (req, res) => {
      try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const totalCount = db.prepare("SELECT COUNT(*) as cnt FROM proposals WHERE status IN ('passed', 'rejected', 'quorum_not_met', 'concluded', 'vetoed')").get().cnt;
        const proposals = db.prepare("SELECT * FROM proposals WHERE status IN ('passed', 'rejected', 'quorum_not_met', 'concluded', 'vetoed') ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
        
        const enrichedProposals = proposals.map(p => {
          const votes = {
            yes: { vp: p.yes_vp, count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(p.proposal_id, 'yes').c },
            no: { vp: p.no_vp, count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(p.proposal_id, 'no').c },
            abstain: { vp: p.abstain_vp, count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(p.proposal_id, 'abstain').c }
          };

          const totalVoted = p.yes_vp + p.no_vp + p.abstain_vp;
          const quorumPercentage = p.total_vp > 0 ? Math.round((totalVoted / p.total_vp) * 100) : 0;

          return {
            proposalId: p.proposal_id,
            title: p.title,
            description: p.description,
            status: p.status,
            creator: p.creator_id ? p.creator_id.slice(0, 4) + '****' : null,
            votes,
            quorum: {
              required: p.quorum_threshold,
              current: quorumPercentage
            },
            startTime: p.start_time,
            endTime: p.end_time
          };
        });

        res.json({ success: true, proposals: enrichedProposals, total: totalCount, limit, offset });
      } catch (error) {
        logger.error('Error fetching concluded proposals:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/public/proposals/:id', deprecationHeaders, (req, res) => {
      try {
        const { id } = req.params;
        const proposal = db.prepare('SELECT * FROM proposals WHERE proposal_id = ?').get(id);
        
        if (!proposal) {
          return res.status(404).json({ success: false, message: 'Proposal not found' });
        }

        const votes = {
          yes: { vp: proposal.yes_vp, count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(id, 'yes').c },
          no: { vp: proposal.no_vp, count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(id, 'no').c },
          abstain: { vp: proposal.abstain_vp, count: db.prepare('SELECT COUNT(*) as c FROM votes WHERE proposal_id = ? AND vote_choice = ?').get(id, 'abstain').c }
        };

        const totalVoted = proposal.yes_vp + proposal.no_vp + proposal.abstain_vp;
        const quorumPercentage = proposal.total_vp > 0 ? Math.round((totalVoted / proposal.total_vp) * 100) : 0;

        res.json({
          success: true,
          proposal: {
            proposalId: proposal.proposal_id,
            title: proposal.title,
            description: proposal.description,
            status: proposal.status,
            creator: proposal.creator_id ? proposal.creator_id.slice(0, 4) + '****' : null,
            votes,
            quorum: {
              required: proposal.quorum_threshold,
              current: quorumPercentage
            },
            startTime: proposal.start_time,
            endTime: proposal.end_time,
            createdAt: proposal.created_at
          }
        });
      } catch (error) {
        logger.error('Error fetching proposal:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/public/stats', deprecationHeaders, (req, res) => {
      try {
        const totalProposals = db.prepare('SELECT COUNT(*) as count FROM proposals').get().count;
        const passedProposals = db.prepare('SELECT COUNT(*) as count FROM proposals WHERE status = ?').get('passed').count;
        const totalVotes = db.prepare('SELECT COUNT(*) as count FROM votes').get().count;
        const totalVP = db.prepare('SELECT COALESCE(SUM(voting_power), 0) as total FROM votes').get().total;
        const activeVoters = db.prepare('SELECT COUNT(DISTINCT voter_id) as count FROM votes').get().count;

        const passRate = totalProposals > 0 ? Math.round((passedProposals / totalProposals) * 100) : 0;

        res.json({
          success: true,
          stats: {
            totalProposals,
            passedProposals,
            passRate,
            totalVotes,
            totalVPUsed: totalVP,
            activeVoters
          }
        });
      } catch (error) {
        logger.error('Error fetching stats:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== PUBLIC API - HEIST/MISSIONS ====================

    this.app.get('/api/public/missions/active', deprecationHeaders, (req, res) => {
      try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const totalCount = db.prepare('SELECT COUNT(*) as cnt FROM missions WHERE status IN (?, ?)').get('recruiting', 'active').cnt;
        const missions = db.prepare('SELECT * FROM missions WHERE status IN (?, ?) ORDER BY created_at DESC LIMIT ? OFFSET ?').all('recruiting', 'active', limit, offset);
        
        const enrichedMissions = missions.map(m => {
          const participants = db.prepare('SELECT participant_id, assigned_nft_name, assigned_role FROM mission_participants WHERE mission_id = ?').all(m.mission_id);
          
          return {
            missionId: m.mission_id,
            title: m.title,
            description: m.description,
            status: m.status,
            totalSlots: m.total_slots,
            filledSlots: m.filled_slots,
            rewardPoints: m.reward_points,
            participants: participants.map(p => ({
              participantId: p.participant_id ? p.participant_id.slice(0, 4) + '****' : null,
              nftName: p.assigned_nft_name,
              role: p.assigned_role
            })),
            createdAt: m.created_at
          };
        });

        res.json({ success: true, missions: enrichedMissions, total: totalCount, limit, offset });
      } catch (error) {
        logger.error('Error fetching active missions:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/public/missions/completed', deprecationHeaders, (req, res) => {
      try {
        const missions = db.prepare('SELECT * FROM missions WHERE status = ? ORDER BY created_at DESC LIMIT 50').all('completed');
        
        const enrichedMissions = missions.map(m => {
          const participants = db.prepare('SELECT participant_id, assigned_nft_name, assigned_role, points_awarded FROM mission_participants WHERE mission_id = ?').all(m.mission_id);
          
          return {
            missionId: m.mission_id,
            title: m.title,
            description: m.description,
            status: m.status,
            totalSlots: m.total_slots,
            rewardPoints: m.reward_points,
            participants: participants.map(p => ({
              participantId: p.participant_id ? p.participant_id.slice(0, 4) + '****' : null,
              nftName: p.assigned_nft_name,
              role: p.assigned_role,
              pointsAwarded: p.points_awarded
            })),
            startTime: m.start_time,
            createdAt: m.created_at
          };
        });

        res.json({ success: true, missions: enrichedMissions });
      } catch (error) {
        logger.error('Error fetching completed missions:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/public/missions/:id', deprecationHeaders, (req, res) => {
      try {
        const { id } = req.params;
        const mission = db.prepare('SELECT * FROM missions WHERE mission_id = ?').get(id);
        
        if (!mission) {
          return res.status(404).json({ success: false, message: 'Mission not found' });
        }

        const participants = db.prepare('SELECT * FROM mission_participants WHERE mission_id = ?').all(id);

        res.json({
          success: true,
          mission: {
            missionId: mission.mission_id,
            title: mission.title,
            description: mission.description,
            status: mission.status,
            totalSlots: mission.total_slots,
            filledSlots: mission.filled_slots,
            rewardPoints: mission.reward_points,
            participants: participants.map(p => ({
              participantId: p.participant_id ? p.participant_id.slice(0, 4) + '****' : null,
              walletAddress: p.wallet_address ? p.wallet_address.slice(0, 4) + '...' + p.wallet_address.slice(-4) : null,
              nftName: p.assigned_nft_name,
              role: p.assigned_role,
              pointsAwarded: p.points_awarded,
              joinedAt: p.joined_at
            })),
            startTime: mission.start_time,
            createdAt: mission.created_at
          }
        });
      } catch (error) {
        logger.error('Error fetching mission:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/public/leaderboard', deprecationHeaders, (req, res) => {
      try {
        const leaderboard = db.prepare(`
          SELECT 
            u.discord_id,
            u.username,
            u.tier,
            COALESCE(SUM(mp.points_awarded), 0) as total_points,
            COUNT(DISTINCT mp.mission_id) as missions_completed
          FROM users u
          LEFT JOIN mission_participants mp ON u.discord_id = mp.participant_id
          GROUP BY u.discord_id
          HAVING total_points > 0
          ORDER BY total_points DESC
          LIMIT 100
        `).all();

        res.json({
          success: true,
          leaderboard: leaderboard.map((entry, index) => ({
            rank: index + 1,
            discordId: entry.discord_id ? entry.discord_id.slice(0, 4) + '****' : null,
            username: entry.username,
            tier: entry.tier,
            totalPoints: entry.total_points,
            missionsCompleted: entry.missions_completed
          }))
        });
      } catch (error) {
        logger.error('Error fetching leaderboard:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/public/leaderboard/:userId', deprecationHeaders, (req, res) => {
      try {
        const { userId } = req.params;
        
        const userPoints = db.prepare(`
          SELECT 
            u.discord_id,
            u.username,
            u.tier,
            COALESCE(SUM(mp.points_awarded), 0) as total_points,
            COUNT(DISTINCT mp.mission_id) as missions_completed
          FROM users u
          LEFT JOIN mission_participants mp ON u.discord_id = mp.participant_id
          WHERE u.discord_id = ?
          GROUP BY u.discord_id
        `).get(userId);

        if (!userPoints) {
          return res.json({
            success: true,
            user: {
              discordId: userId,
              totalPoints: 0,
              missionsCompleted: 0,
              rank: null
            }
          });
        }

        // Calculate rank
        const higherRanked = db.prepare(`
          SELECT COUNT(DISTINCT u.discord_id) as count
          FROM users u
          LEFT JOIN mission_participants mp ON u.discord_id = mp.participant_id
          GROUP BY u.discord_id
          HAVING COALESCE(SUM(mp.points_awarded), 0) > ?
        `).get(userPoints.total_points).count;

        res.json({
          success: true,
          user: {
            discordId: userPoints.discord_id ? userPoints.discord_id.slice(0, 4) + '****' : null,
            username: userPoints.username,
            tier: userPoints.tier,
            totalPoints: userPoints.total_points,
            missionsCompleted: userPoints.missions_completed,
            rank: higherRanked + 1
          }
        });
      } catch (error) {
        logger.error('Error fetching user leaderboard:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

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

        logger.log(`Web signature verification: User ${discordId} linked wallet ${walletAddress}`);
        res.json({ success: true, message: 'Wallet verified successfully!' });
      } catch (error) {
        logger.error('Error in signature verification:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Legacy verify endpoint (kept for API consumers — requires session auth)
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
      try {
        const guildId = req.session?.guildId;
        const eng = require('../services/engagementService');
        res.json({ success: true, config: eng.getConfig(guildId) });
      } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    this.app.put('/api/admin/engagement/config', adminAuthMiddleware, (req, res) => {
      try {
        const guildId = req.session?.guildId;
        const eng = require('../services/engagementService');
        const allowed = ['enabled','points_message','points_reaction','cooldown_message_mins','cooldown_reaction_daily'];
        const patch = {};
        for (const k of allowed) { if (req.body[k] !== undefined) patch[k] = req.body[k]; }
        const updated = eng.setConfig(guildId, patch);
        res.json({ success: true, config: updated });
      } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    this.app.get('/api/admin/engagement/leaderboard', adminAuthMiddleware, (req, res) => {
      try {
        const guildId = req.session?.guildId;
        const limit = Math.min(parseInt(req.query.limit || '25', 10), 100);
        const eng = require('../services/engagementService');
        res.json({ success: true, leaderboard: eng.getLeaderboard(guildId, limit) });
      } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    this.app.get('/api/admin/engagement/shop', adminAuthMiddleware, (req, res) => {
      try {
        const guildId = req.session?.guildId;
        const eng = require('../services/engagementService');
        res.json({ success: true, items: eng.getShopItems(guildId) });
      } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    this.app.post('/api/admin/engagement/shop', adminAuthMiddleware, (req, res) => {
      try {
        const guildId = req.session?.guildId;
        const { name, description, type, cost, roleId, codes, quantity } = req.body;
        if (!name || cost == null) return res.status(400).json({ success: false, message: 'name and cost are required' });
        const eng = require('../services/engagementService');
        const result = eng.addShopItem(guildId, { name, description, type: type || 'role', cost: parseInt(cost, 10), roleId, codes, quantity_remaining: quantity != null ? parseInt(quantity, 10) : -1 });
        res.json(result);
      } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    this.app.delete('/api/admin/engagement/shop/:id', adminAuthMiddleware, (req, res) => {
      try {
        const guildId = req.session?.guildId;
        const itemId = parseInt(req.params.id, 10);
        const eng = require('../services/engagementService');
        res.json(eng.removeShopItem(guildId, itemId));
      } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    // ==================== NFT ACTIVITY ADMIN CONFIG ====================

    this.app.get('/api/admin/nft-activity/events', adminAuthMiddleware, (req, res) => {
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
      try {
        const collections = nftActivityService.getTrackedCollections(req.guildId);
        res.json({ success: true, collections });
      } catch (error) {
        logger.error('Error getting tracked collections:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/nft-tracker/collections', adminAuthMiddleware, (req, res) => {
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
      try {
        const result = nftActivityService.updateTrackedCollection(req.params.id, req.body, req.guildId);
        if (!result.success) return res.status(400).json(result);
        res.json(result);
      } catch (error) {
        logger.error('Error updating tracked collection:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== TICKET MANAGEMENT (admin) ====================

    this.app.get('/api/admin/tickets/categories', adminAuthMiddleware, (req, res) => {
      try {
        const categories = ticketService.getAllCategories();
        res.json({ success: true, categories });
      } catch (error) {
        logger.error('Error fetching ticket categories:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.post('/api/admin/tickets/categories', adminAuthMiddleware, (req, res) => {
      try {
        const { name, emoji, description, parentChannelId, closedParentChannelId, allowedRoleIds, pingRoleIds, templateFields } = req.body;
        if (!name) return res.status(400).json({ success: false, message: 'Name is required' });
        const result = ticketService.addCategory({ name, emoji, description, parentChannelId, closedParentChannelId, allowedRoleIds, pingRoleIds, templateFields });
        if (!result.success) return res.status(400).json(result);
        res.json(result);
      } catch (error) {
        logger.error('Error adding ticket category:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/admin/tickets/categories/:id', adminAuthMiddleware, (req, res) => {
      try {
        const result = ticketService.updateCategory(parseInt(req.params.id), req.body);
        if (!result.success) return res.status(400).json(result);
        res.json(result);
      } catch (error) {
        logger.error('Error updating ticket category:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.delete('/api/admin/tickets/categories/:id', adminAuthMiddleware, (req, res) => {
      try {
        const result = ticketService.deleteCategory(parseInt(req.params.id));
        if (!result.success) return res.status(400).json(result);
        res.json(result);
      } catch (error) {
        logger.error('Error deleting ticket category:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/admin/tickets', adminAuthMiddleware, (req, res) => {
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
      try {
        const ticket = ticketService.getTicketById(parseInt(req.params.id));
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
        const successMarkers = new Set(['approved', 'success']);
        const suspendedMarkers = new Set(['cancelled', 'canceled', 'past_due', 'suspended']);
        const actionMarkers = new Set([normalizedEventType, normalizedStatus].filter(Boolean));
        const shouldApplyPlan = Array.from(actionMarkers).some(marker => successMarkers.has(marker));
        const shouldSuspend = Array.from(actionMarkers).some(marker => suspendedMarkers.has(marker));

        let result = 'ignored';

        if (!normalizedPayload.guildId || !normalizedPayload.customerId || !normalizedPayload.eventType || !normalizedPayload.status) {
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
              result = `applied_plan:${normalizedPayload.plan}`;
            }
          }
        } else if (shouldSuspend) {
          const statusResult = tenantService.setTenantStatus(
            normalizedPayload.guildId,
            'suspended',
            'billing-entitlement-webhook'
          );

          if (!statusResult.success) {
            result = `error:${statusResult.message || 'status_update_failed'}`;
          } else {
            result = 'suspended';
          }
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

    // ==================== NFT ACTIVITY WEBHOOK (optional external source) ====================

    this.app.post('/api/webhooks/nft-activity', (req, res) => {
      try {
        const configuredSecret = process.env.NFT_ACTIVITY_WEBHOOK_SECRET;
        if (!configuredSecret) {
          return res.status(503).json({ error: 'Webhook not configured' });
        }
        const provided = req.headers['authorization'] || req.headers['x-webhook-secret'];
        if (!provided || !timingSafeEquals(provided, configuredSecret)) {
          return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        // Helius sends an array of events
        const events = Array.isArray(req.body) ? req.body : [req.body];
        let processed = 0, ignored = 0;
        for (const event of events) {
          const result = nftActivityService.ingestEvent(event, 'webhook');
          if (result.ignored) ignored++;
          else if (result.success) processed++;
        }
        logger.log(`[nft-webhook] received ${events.length} events: ${processed} processed, ${ignored} ignored`);
        return res.json({ success: true, processed, ignored });
      } catch (error) {
        logger.error('Error in nft activity webhook:', error);
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
      logger.log(`🌐 Web server running on port ${this.port}`);
      logger.log(`🔗 Verification URL: http://localhost:${this.port}/verify`);
      logger.log(`📊 Dashboard URL: http://localhost:${this.port}/dashboard`);
      logger.log(`⚙️ Admin Portal URL: http://localhost:${this.port}/admin`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      logger.log('🛑 Web server stopped');
    }
  }
}

module.exports = WebServer;
