const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const nacl = require('tweetnacl');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const db = require('../database/db');
const logger = require('../utils/logger');
const settingsManager = require('../config/settings');
const walletService = require('../services/walletService');
const roleService = require('../services/roleService');
const proposalService = require('../services/proposalService');
const missionService = require('../services/missionService');
const treasuryService = require('../services/treasuryService');
const microVerifyService = require('../services/microVerifyService');
const nftActivityService = require('../services/nftActivityService');

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
  }

  setupMiddleware() {
    // Trust proxy - CRITICAL for production (AWS ELB, Nginx, etc.)
    this.app.set('trust proxy', 1);

    // CORS for public API - explicitly configured for the-solpranos.com integration
    // Allows cross-origin requests for public endpoints
    this.app.use(cors({
      origin: [
        'https://the-solpranos.com',
        'https://www.the-solpranos.com',
        'http://localhost:3000',
        'http://localhost:5173' // Vite dev server
      ],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      exposedHeaders: ['X-Total-Count'], // For pagination
      maxAge: 86400 // 24 hours preflight cache
    }));

    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'public')));

    // Session management (in-memory for now - sufficient for most use cases)
    // TODO: Add persistent SQLite store later if needed
    this.app.use(session({
      secret: process.env.SESSION_SECRET || 'solpranos-secret-key-change-this-in-production',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      }
    }));
  }

  setupRoutes() {
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

    // Keep advanced admin dashboard accessible for deep management tools
    this.app.get('/admin-panel', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    });

    // ==================== FEATURE FLAGS ====================

    this.app.get('/api/features', (req, res) => {
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
      const scope = encodeURIComponent('identify');
      
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

        // Store in session
        req.session.discordUser = {
          id: userData.id,
          username: userData.username,
          discriminator: userData.discriminator,
          avatar: userData.avatar,
          accessToken: tokenData.access_token
        };

        const returnTo = req.session.returnTo || '/dashboard';
        delete req.session.returnTo;
        res.redirect(returnTo);
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
        const proposals = db.prepare('SELECT * FROM proposals WHERE creator_id = ? AND status IN (?, ?) ORDER BY created_at DESC').all(discordId, 'draft', 'voting');
        
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

        // Get user's voting power
        const userInfo = await roleService.getUserInfo(discordId);
        if (!userInfo || !userInfo.voting_power || userInfo.voting_power < 1) {
          return res.status(403).json({ success: false, message: 'You need at least 1 verified NFT to vote' });
        }
        const result = proposalService.castVote(proposalId, discordId, choice.toLowerCase(), userInfo.voting_power);
        res.json(result);
      } catch (error) {
        logger.error('Error casting vote via web:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== USER PROPOSAL CREATION ====================

    this.app.post('/api/user/proposals', async (req, res) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      try {
        const discordId = req.session.discordUser.id;
        const username = req.session.discordUser.username;
        const { title, description } = req.body;

        if (!title || !description) {
          return res.status(400).json({ success: false, message: 'Title and description are required' });
        }

        if (title.length > 200) {
          return res.status(400).json({ success: false, message: 'Title must be 200 characters or less' });
        }

        if (description.length > 2000) {
          return res.status(400).json({ success: false, message: 'Description must be 2000 characters or less' });
        }

        // Check user has voting power (at least 1 verified NFT)
        const userInfo = await roleService.getUserInfo(discordId);
        if (!userInfo || !userInfo.voting_power || userInfo.voting_power < 1) {
          return res.status(403).json({ success: false, message: 'You need at least 1 verified NFT to create proposals' });
        }

        // Get user's primary wallet for the proposal
        const primaryWallet = db.prepare('SELECT wallet_address FROM wallets WHERE discord_id = ? AND is_favorite = 1').get(discordId);
        const walletAddr = primaryWallet ? primaryWallet.wallet_address : '';
        const result = proposalService.createProposal(discordId, walletAddr, title, description);
        res.json(result);
      } catch (error) {
        logger.error('Error creating proposal via web:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // ==================== ADMIN CHECK ====================

    this.app.get('/api/user/is-admin', async (req, res) => {
      if (!req.session.discordUser) {
        return res.json({ isAdmin: false });
      }

      if (!this.client) {
        return res.json({ isAdmin: false });
      }

      try {
        const guildId = process.env.GUILD_ID;
        const guild = await this.client.guilds.fetch(guildId);
        const member = await guild.members.fetch(req.session.discordUser.id);
        return res.json({ isAdmin: member.permissions.has('Administrator') });
      } catch (error) {
        logger.error('Admin check error:', error);
        return res.json({ isAdmin: false });
      }
    });

    // ==================== ADMIN API ====================

    const adminAuthMiddleware = async (req, res, next) => {
      if (!req.session.discordUser) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      if (!this.client) {
        return res.status(500).json({ success: false, message: 'Bot not initialized' });
      }

      try {
        const guildId = process.env.GUILD_ID;
        const guild = await this.client.guilds.fetch(guildId);
        const member = await guild.members.fetch(req.session.discordUser.id);
        
        if (!member.permissions.has('Administrator')) {
          return res.status(403).json({ success: false, message: 'Admin permission required' });
        }

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
        webhookSecretConfigured: !!process.env.NFT_ACTIVITY_WEBHOOK_SECRET
      });
    });

    this.app.get('/api/admin/settings', adminAuthMiddleware, (req, res) => {
      try {
        const settings = settingsManager.getSettings();
        
        // Smart load: DB override → .env fallback
        const effectiveSettings = {
          ...settings,
          // Channel overrides: if empty in DB, use .env
          proposalsChannelId: settings.proposalsChannelId || process.env.PROPOSALS_CHANNEL_ID || '',
          votingChannelId: settings.votingChannelId || process.env.VOTING_CHANNEL_ID || '',
          resultsChannelId: settings.resultsChannelId || process.env.RESULTS_CHANNEL_ID || '',
          governanceLogChannelId: settings.governanceLogChannelId || process.env.GOVERNANCE_LOG_CHANNEL_ID || '',
          
          // Verification wallet
          verificationReceiveWallet: settings.verificationReceiveWallet || process.env.VERIFICATION_RECEIVE_WALLET || '',
          nftActivityWebhookSecret: settings.nftActivityWebhookSecret || process.env.NFT_ACTIVITY_WEBHOOK_SECRET || ''
        };
        
        res.json({ success: true, settings: effectiveSettings });
      } catch (error) {
        logger.error('Error fetching settings:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.put('/api/admin/settings', adminAuthMiddleware, (req, res) => {
      try {
        const result = settingsManager.updateSettings(req.body);
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

        const guildId = process.env.GUILD_ID;
        const guild = await this.client.guilds.fetch(guildId);
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

        const channelList = channels
          .filter(ch => ch && textTypes.includes(ch.type))
          .map(ch => ({
            id: ch.id,
            name: ch.name,
            type: threadTypes.includes(ch.type) ? 'thread' : 'text',
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

        const guildId = process.env.GUILD_ID;
        const guild = await this.client.guilds.fetch(guildId);
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

    this.app.get('/api/admin/users', adminAuthMiddleware, (req, res) => {
      try {
        const users = db.prepare(`
          SELECT u.*, COUNT(w.id) as wallet_count
          FROM users u
          LEFT JOIN wallets w ON u.discord_id = w.discord_id
          GROUP BY u.discord_id
          ORDER BY u.total_nfts DESC
        `).all();

        res.json({ success: true, users });
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
        const proposals = db.prepare('SELECT * FROM proposals ORDER BY created_at DESC').all();
        res.json({ success: true, proposals });
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

    this.app.get('/api/admin/missions', adminAuthMiddleware, (req, res) => {
      try {
        const missions = db.prepare('SELECT * FROM missions ORDER BY created_at DESC').all();
        const missionsWithParticipants = missions.map(m => {
          const participants = db.prepare('SELECT * FROM mission_participants WHERE mission_id = ?').all(m.mission_id);
          return { ...m, participants };
        });

        res.json({ success: true, missions: missionsWithParticipants });
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
    this.app.get('/api/admin/roles/config', adminAuthMiddleware, (req, res) => {
      try {
        const config = roleService.getRoleConfigSummary();
        res.json({ success: true, config });
      } catch (error) {
        logger.error('Error fetching role config:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Tier CRUD
    this.app.post('/api/admin/roles/tiers', adminAuthMiddleware, (req, res) => {
      try {
        const { name, minNFTs, maxNFTs, votingPower, roleId } = req.body;
        
        if (!name || minNFTs === undefined || maxNFTs === undefined || votingPower === undefined) {
          return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const result = roleService.addTier(name, minNFTs, maxNFTs, votingPower, roleId || null);
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
        const { traitType, traitValue, roleId, collectionId, description } = req.body;

        if (!traitType || !traitValue || !roleId) {
          return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        if (!collectionId) {
          return res.status(400).json({ success: false, message: 'collectionId is required' });
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

        if (!roleId) {
          return res.status(400).json({ success: false, message: 'roleId is required' });
        }

        if (!collectionId) {
          return res.status(400).json({ success: false, message: 'collectionId is required' });
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
        const guildId = process.env.GUILD_ID;
        const guild = await this.client.guilds.fetch(guildId);

        if (discordId) {
          // Sync single user
          await roleService.updateUserRoles(discordId);
          const syncResult = await roleService.syncUserDiscordRoles(guild, discordId);
          return res.json(syncResult);
        } else {
          // Sync all users
          const allUsers = roleService.getAllVerifiedUsers();
          let syncedCount = 0;
          let errorCount = 0;

          for (const user of allUsers) {
            try {
              await roleService.updateUserRoles(user.discord_id, user.username);
              const syncResult = await roleService.syncUserDiscordRoles(guild, user.discord_id);
              
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
        const guildId = process.env.GUILD_ID;
        const guild = await this.client.guilds.fetch(guildId);
        
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
        const guildId = process.env.GUILD_ID;
        const guild = await this.client.guilds.fetch(guildId);
        
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
        const guildId = process.env.GUILD_ID;
        const guild = await this.client.guilds.fetch(guildId);
        
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
        const guildId = process.env.GUILD_ID;
        const guild = await this.client.guilds.fetch(guildId);
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

    // ==================== TREASURY API ====================

    // Public treasury endpoint (no wallet address exposed)
    this.app.get('/api/public/treasury', (req, res) => {
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
        const { enabled, solanaWallet, refreshHours } = req.body;
        const result = treasuryService.updateConfig({ enabled, solanaWallet, refreshHours });
        res.json(result);
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

    this.app.get('/api/public/proposals/active', (req, res) => {
      try {
        const proposals = db.prepare('SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC').all('voting');
        
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
            creator: p.creator_id,
            votes,
            quorum: {
              required: p.quorum_threshold,
              current: quorumPercentage
            },
            deadline: p.end_time
          };
        });

        res.json({ success: true, proposals: enrichedProposals });
      } catch (error) {
        logger.error('Error fetching active proposals:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/public/proposals/concluded', (req, res) => {
      try {
        const proposals = db.prepare('SELECT * FROM proposals WHERE status IN (?, ?, ?) ORDER BY created_at DESC').all('passed', 'rejected', 'quorum_not_met');
        
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
            creator: p.creator_id,
            votes,
            quorum: {
              required: p.quorum_threshold,
              current: quorumPercentage
            },
            startTime: p.start_time,
            endTime: p.end_time
          };
        });

        res.json({ success: true, proposals: enrichedProposals });
      } catch (error) {
        logger.error('Error fetching concluded proposals:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/public/proposals/:id', (req, res) => {
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
            creator: proposal.creator_id,
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

    this.app.get('/api/public/stats', (req, res) => {
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

    this.app.get('/api/public/missions/active', (req, res) => {
      try {
        const missions = db.prepare('SELECT * FROM missions WHERE status IN (?, ?) ORDER BY created_at DESC').all('recruiting', 'active');
        
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
              participantId: p.participant_id,
              nftName: p.assigned_nft_name,
              role: p.assigned_role
            })),
            createdAt: m.created_at
          };
        });

        res.json({ success: true, missions: enrichedMissions });
      } catch (error) {
        logger.error('Error fetching active missions:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/public/missions/completed', (req, res) => {
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
              participantId: p.participant_id,
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

    this.app.get('/api/public/missions/:id', (req, res) => {
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
              participantId: p.participant_id,
              walletAddress: p.wallet_address,
              nftMint: p.assigned_nft_mint,
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

    this.app.get('/api/public/leaderboard', (req, res) => {
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
            discordId: entry.discord_id,
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

    this.app.get('/api/public/leaderboard/:userId', (req, res) => {
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
            discordId: userPoints.discord_id,
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
          await roleService.updateUserRoles(discordId, req.session.discordUser.username);
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

    // Legacy verify endpoint (kept for API consumers)
    this.app.post('/api/verify', async (req, res) => {
      try {
        const { discordId, walletAddress, signature, message } = req.body;

        if (!discordId || !walletAddress || !signature || !message) {
          return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const isValid = this.verifySignature(walletAddress, signature, message);
        
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

        logger.log(`Web verification: User ${discordId} linked wallet ${walletAddress}`);

        res.json({ success: true, message: 'Wallet verified successfully', isFavorite });
      } catch (error) {
        logger.error('Error verifying wallet:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    this.app.get('/api/wallets/:discordId', (req, res) => {
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

        const result = microVerifyService.createRequest(discordId, username);
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

    // ==================== NFT ACTIVITY WEBHOOK (optional external source) ====================

    this.app.post('/api/webhooks/nft-activity', (req, res) => {
      try {
        const configuredSecret = process.env.NFT_ACTIVITY_WEBHOOK_SECRET;
        if (configuredSecret) {
          const provided = req.headers['x-webhook-secret'];
          if (provided !== configuredSecret) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
          }
        }

        const event = req.body || {};
        const result = nftActivityService.ingestEvent(event, 'webhook');

        if (!result.success && !result.ignored) {
          return res.status(400).json({ success: false, message: result.message || 'Invalid event' });
        }

        return res.json({ success: true, ignored: !!result.ignored });
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
