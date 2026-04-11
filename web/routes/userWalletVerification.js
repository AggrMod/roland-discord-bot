const express = require('express');
const crypto = require('crypto');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createUserWalletVerificationRouter({
  logger,
  db,
  getBranding,
  fetchGuildById,
  roleService,
  walletService,
  verifySignature,
}) {
  const router = express.Router();

  const requireUser = (req, res) => {
    if (req.session?.discordUser) return true;
    res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    return false;
  };

  const triggerOgRoleBestEffort = (req, discordId, username) => {
    const guildId = String(req.guildId || '').trim();
    if (!guildId) return;
    try {
      walletService.triggerOGRoleAssignment(discordId, username || 'Web User', guildId);
    } catch (error) {
      logger.warn('OG role trigger warning (non-fatal):', error?.message || error);
    }
  };

  const refreshUserRoles = async (req, discordId, username) => {
    const guild = req.guild || await fetchGuildById(req.guildId);
    await roleService.updateUserRoles(discordId, username, req.guildId || null);
    if (guild) {
      await roleService.syncUserDiscordRoles(guild, discordId, req.guildId || null);
    }
  };

  router.post('/api/verify/challenge', (req, res) => {
    if (!requireUser(req, res)) return;

    try {
      const nonce = crypto.randomBytes(16).toString('hex');
      const branding = getBranding(req.guildId || '', 'verification');
      const brandName = String(branding?.brandName || branding?.displayName || 'Guild Pilot').trim() || 'Guild Pilot';
      const message = `${brandName} Wallet Verification\nUser: ${req.session.discordUser.username}\nNonce: ${nonce}`;
      req.session.verifyChallenge = { message, nonce, createdAt: Date.now() };
      return res.json(toSuccessResponse({ message }));
    } catch (routeError) {
      logger.error('Error generating challenge:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/verify/signature', async (req, res) => {
    if (!requireUser(req, res)) return;

    try {
      const { walletAddress, signature } = req.body || {};
      const discordId = req.session.discordUser.id;

      if (!walletAddress || !signature) {
        return res.status(400).json(toErrorResponse('Missing walletAddress or signature', 'VALIDATION_ERROR'));
      }

      const challenge = req.session.verifyChallenge;
      if (!challenge || (Date.now() - challenge.createdAt) > 5 * 60 * 1000) {
        return res.status(400).json(toErrorResponse('Challenge expired. Please try again.', 'VALIDATION_ERROR'));
      }

      const isValid = verifySignature(walletAddress, signature, challenge.message);
      if (!isValid) {
        return res.status(400).json(toErrorResponse('Invalid signature. Make sure you signed with the correct wallet.', 'VALIDATION_ERROR'));
      }

      delete req.session.verifyChallenge;

      const existingWallet = db.prepare('SELECT * FROM wallets WHERE wallet_address = ?').get(walletAddress);
      if (existingWallet) {
        if (existingWallet.discord_id === discordId) {
          try {
            await refreshUserRoles(req, discordId, req.session.discordUser.username || 'Web User');
            triggerOgRoleBestEffort(req, discordId, req.session.discordUser.username || 'Web User');
          } catch (roleErr) {
            logger.error('Role refresh after verify-existing failed (non-fatal):', roleErr);
          }
          return res.json(toSuccessResponse({ message: 'Wallet already linked. Verification status refreshed.' }));
        }
        return res.status(400).json(toErrorResponse('This wallet is already linked to another account', 'VALIDATION_ERROR'));
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

      try {
        await refreshUserRoles(req, discordId, req.session.discordUser.username || 'Web User');
      } catch (roleErr) {
        logger.error('Role update after verify failed (non-fatal):', roleErr);
      }

      // Always attempt OG assignment in guild context (safe no-op if not eligible/already assigned).
      triggerOgRoleBestEffort(req, discordId, req.session.discordUser.username || 'Web User');

      logger.log(`Web signature verification: User ${discordId} linked wallet ${walletAddress}`);
      return res.json(toSuccessResponse({ message: 'Wallet verified successfully!' }));
    } catch (routeError) {
      logger.error('Error in signature verification:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/verify', async (req, res) => {
    if (!req.session?.discordUser?.id) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }

    try {
      const discordId = req.session.discordUser.id;
      const { walletAddress, signature } = req.body || {};

      if (!walletAddress || !signature) {
        return res.status(400).json(toErrorResponse('Missing required fields', 'VALIDATION_ERROR'));
      }

      const challenge = req.session.verifyChallenge;
      if (!challenge || (Date.now() - challenge.createdAt) > 5 * 60 * 1000) {
        return res.status(400).json(toErrorResponse('Challenge expired. Request a new challenge first.', 'VALIDATION_ERROR'));
      }

      const isValid = verifySignature(walletAddress, signature, challenge.message);
      delete req.session.verifyChallenge;

      if (!isValid) {
        return res.status(400).json(toErrorResponse('Invalid signature', 'VALIDATION_ERROR'));
      }

      const existingWallet = db.prepare('SELECT * FROM wallets WHERE wallet_address = ?').get(walletAddress);
      if (existingWallet) {
        if (existingWallet.discord_id === discordId) {
          try {
            await refreshUserRoles(req, discordId, req.session.discordUser?.username || 'Web User');
            triggerOgRoleBestEffort(req, discordId, req.session.discordUser?.username || 'Web User');
          } catch (roleErr) {
            logger.error('Role refresh after legacy verify-existing failed (non-fatal):', roleErr);
          }
          return res.json(toSuccessResponse({ message: 'Wallet already linked. Verification status refreshed.' }));
        }
        return res.status(400).json(toErrorResponse('This wallet is already linked to another account', 'VALIDATION_ERROR'));
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
        await refreshUserRoles(req, discordId, 'Web User');
      } catch (roleErr) {
        logger.error('Role update after legacy verify failed (non-fatal):', roleErr);
      }

      // Always attempt OG assignment in guild context (safe no-op if not eligible/already assigned).
      triggerOgRoleBestEffort(req, discordId, req.session.discordUser?.username || 'Web User');

      logger.log(`Web verification: User ${discordId} linked wallet ${walletAddress}`);
      return res.json(toSuccessResponse({ message: 'Wallet verified successfully', isFavorite }));
    } catch (routeError) {
      logger.error('Error verifying wallet:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/wallets/:discordId', (req, res) => {
    if (!req.session?.discordUser?.id) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    if (req.session.discordUser.id !== req.params.discordId) {
      return res.status(403).json(toErrorResponse('Forbidden', 'FORBIDDEN'));
    }

    try {
      const { discordId } = req.params;
      const wallets = db.prepare('SELECT wallet_address, is_favorite, primary_wallet, created_at FROM wallets WHERE discord_id = ? ORDER BY is_favorite DESC, created_at ASC').all(discordId);
      return res.json(toSuccessResponse({ wallets }));
    } catch (routeError) {
      logger.error('Error fetching wallets:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/wallets/:discordId/favorite', (req, res) => {
    if (!req.session?.discordUser?.id) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    if (req.session.discordUser.id !== req.params.discordId) {
      return res.status(403).json(toErrorResponse('Forbidden', 'FORBIDDEN'));
    }

    try {
      const { discordId } = req.params;
      const { walletAddress } = req.body || {};

      if (!walletAddress) {
        return res.status(400).json(toErrorResponse('Wallet address required', 'VALIDATION_ERROR'));
      }

      const wallet = db.prepare('SELECT * FROM wallets WHERE discord_id = ? AND wallet_address = ?').get(discordId, walletAddress);
      if (!wallet) {
        return res.status(404).json(toErrorResponse('Wallet not found', 'NOT_FOUND'));
      }

      db.prepare('UPDATE wallets SET is_favorite = 0 WHERE discord_id = ?').run(discordId);
      db.prepare('UPDATE wallets SET is_favorite = 1 WHERE discord_id = ? AND wallet_address = ?').run(discordId, walletAddress);

      logger.log(`User ${discordId} set favorite wallet: ${walletAddress}`);
      return res.json(toSuccessResponse({ message: 'Favorite wallet updated' }));
    } catch (routeError) {
      logger.error('Error setting favorite wallet:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createUserWalletVerificationRouter;
