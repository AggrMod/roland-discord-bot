const express = require('express');
const path = require('path');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const db = require('../database/db');
const logger = require('../utils/logger');

class WebServer {
  constructor() {
    this.app = express();
    this.port = process.env.WEB_PORT || 3000;
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'public')));
  }

  setupRoutes() {
    // Landing page
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
              margin-top: 20px;
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
            <h2>Wallet Verification</h2>
            <p>Link your Solana wallet to your Discord account</p>
            <a href="/verify">Get Started</a>
          </div>
        </body>
        </html>
      `);
    });

    // Verify page
    this.app.get('/verify', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'verify.html'));
    });

    // API: Verify wallet signature
    this.app.post('/api/verify', async (req, res) => {
      try {
        const { discordId, walletAddress, signature, message } = req.body;

        if (!discordId || !walletAddress || !signature || !message) {
          return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Verify signature
        const isValid = this.verifySignature(walletAddress, signature, message);
        
        if (!isValid) {
          return res.status(400).json({ success: false, message: 'Invalid signature' });
        }

        // Check if wallet is already linked
        const existingWallet = db.prepare('SELECT * FROM wallets WHERE wallet_address = ?').get(walletAddress);
        
        if (existingWallet) {
          if (existingWallet.discord_id === discordId) {
            return res.json({ success: true, message: 'Wallet already linked to your account' });
          }
          return res.status(400).json({ success: false, message: 'This wallet is already linked to another account' });
        }

        // Create user if doesn't exist
        const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
        if (!user) {
          db.prepare('INSERT INTO users (discord_id, username) VALUES (?, ?)').run(discordId, 'Web User');
        }

        // Check if this is the first wallet (auto-favorite)
        const walletCount = db.prepare('SELECT COUNT(*) as count FROM wallets WHERE discord_id = ?').get(discordId).count;
        const isFavorite = walletCount === 0 ? 1 : 0;
        const isPrimary = walletCount === 0 ? 1 : 0;

        // Link wallet
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

    // API: Get user's wallets
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

    // API: Set favorite wallet
    this.app.post('/api/wallets/:discordId/favorite', (req, res) => {
      try {
        const { discordId } = req.params;
        const { walletAddress } = req.body;

        if (!walletAddress) {
          return res.status(400).json({ success: false, message: 'Wallet address required' });
        }

        // Verify wallet belongs to user
        const wallet = db.prepare('SELECT * FROM wallets WHERE discord_id = ? AND wallet_address = ?').get(discordId, walletAddress);
        
        if (!wallet) {
          return res.status(404).json({ success: false, message: 'Wallet not found' });
        }

        // Unset all favorites for this user
        db.prepare('UPDATE wallets SET is_favorite = 0 WHERE discord_id = ?').run(discordId);
        
        // Set new favorite
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
