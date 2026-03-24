const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const db = require('../database/db');
const logger = require('../utils/logger');
const settingsManager = require('../config/settings');
const walletService = require('../services/walletService');
const roleService = require('../services/roleService');
const proposalService = require('../services/proposalService');
const missionService = require('../services/missionService');

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
    // CORS for public API
    this.app.use(cors({
      origin: ['https://the-solpranos.com', 'http://localhost:3000'],
      credentials: true
    }));

    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'public')));

    // Session management
    this.app.use(session({
      secret: process.env.SESSION_SECRET || 'solpranos-secret-key',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      }
    }));
  }

  setupRoutes() {
    // ==================== PUBLIC PAGES ====================
    
    this.app.get('/', (req, res) => {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Solpranos Wallet Verification</title>
          <style>
            body {
              margin: 0;
              padding: 0;
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
              color: #FFD700;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              text-align: center;
            }
            .container {
              max-width: 600px;
              padding: 40px;
              background: rgba(0, 0, 0, 0.6);
              border: 2px solid #FFD700;
              border-radius: 15px;
              box-shadow: 0 0 30px rgba(255, 215, 0, 0.3);
            }
            h1 {
              font-size: 3em;
              margin: 0;
              text-shadow: 0 0 10px rgba(255, 215, 0, 0.5);
            }
            p {
              font-size: 1.2em;
              color: #ccc;
              margin: 20px 0;
            }
            a {
              display: inline-block;
              margin: 10px;
              padding: 15px 40px;
              background: #FFD700;
              color: #000;
              text-decoration: none;
              font-weight: bold;
              border-radius: 5px;
              transition: all 0.3s;
            }
            a:hover {
              background: #FFC700;
              box-shadow: 0 0 20px rgba(255, 215, 0, 0.6);
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🎩 Solpranos</h1>
            <h2>Wallet Verification & Dashboard</h2>
            <p>Link your Solana wallet and manage your governance participation</p>
            <a href="/verify">Verify Wallet</a>
            <a href="/dashboard">Dashboard</a>
          </div>
        </body>
        </html>
      `);
    });

    this.app.get('/verify', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'verify.html'));
    });

    this.app.get('/dashboard', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    });

    this.app.get('/admin', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'admin.html'));
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

        res.redirect('/dashboard');
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

    this.app.get('/api/admin/settings', adminAuthMiddleware, (req, res) => {
      try {
        const settings = settingsManager.getSettings();
        res.json({ success: true, settings });
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

    // ==================== LEGACY WALLET VERIFICATION ====================

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
