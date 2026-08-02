const express = require('express');
const crypto = require('crypto');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');
const { maskAddress } = require('../../utils/mask');
const { getChain, normalizeAddress, listSupportedChains } = require('../../utils/chainIdentity');
const evmService = require('../../services/evmService');

function createUserWalletVerificationRouter({
  logger,
  db,
  getBranding,
  fetchGuildById,
  roleService,
  walletService,
  vaultService,
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

  const triggerVaultBackfillBestEffort = (req, discordId, walletAddress) => {
    try {
      const guildId = String(req.guildId || '').trim();
      const service = vaultService || require('../../services/vaultService');
      if (!guildId || !service || typeof service.onWalletLinked !== 'function') return;
      service.onWalletLinked(guildId, discordId, walletAddress);
    } catch (error) {
      logger.warn('Vault wallet-link backfill trigger warning (non-fatal):', error?.message || error);
    }
  };

  const verificationSessionHash = (req) => crypto
    .createHash('sha256')
    .update(String(req.sessionID || ''))
    .digest('hex');

  const resolveVerificationOrigin = (req) => {
    const configured = String(process.env.WEB_URL || '').trim();
    const candidate = configured || `${req.protocol || 'https'}://${String(req.get('host') || '').trim()}`;
    try {
      return new URL(candidate).origin;
    } catch (_error) {
      return '';
    }
  };

  router.get('/api/verify/chains', (_req, res) => res.json(toSuccessResponse({
    chains: listSupportedChains().map(chain => ({
      chainId: chain.chainId,
      family: chain.family,
      name: chain.name,
      nativeSymbol: chain.nativeSymbol,
      hexChainId: chain.hexChainId || null,
    })),
  })));

  router.post('/api/verify/challenge', (req, res) => {
    if (!requireUser(req, res)) return;

    try {
      const chain = getChain(req.body?.chain || 'solana:mainnet');
      const walletAddress = normalizeAddress(req.body?.walletAddress, chain?.chainId);
      if (!chain || !walletAddress) {
        return res.status(400).json(toErrorResponse('A supported chain and valid wallet address are required', 'VALIDATION_ERROR'));
      }
      const discordId = String(req.session.discordUser.id || '').trim();
      const guildId = String(req.guildId || '').trim();
      const origin = resolveVerificationOrigin(req);
      if (!origin) {
        return res.status(500).json(toErrorResponse('Wallet verification origin is not configured', 'CONFIG_ERROR'));
      }

      const challengeId = crypto.randomBytes(24).toString('hex');
      const nonce = crypto.randomBytes(24).toString('hex');
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + (5 * 60 * 1000));
      const branding = getBranding(req.guildId || '', 'verification');
      const brandName = String(branding?.brandName || branding?.displayName || 'GuildPilot')
        .replace(/[\r\n]+/g, ' ')
        .trim()
        .slice(0, 80) || 'GuildPilot';
      const verificationUri = `${origin}/app?section=wallets`;
      const message = chain.family === 'evm'
        ? [
          `${new URL(origin).host} wants you to sign in with your Ethereum account:`,
          walletAddress,
          '',
          `Link this ${chain.name} wallet to your Discord account on ${brandName}.`,
          '',
          `URI: ${verificationUri}`,
          'Version: 1',
          `Chain ID: ${chain.numericChainId}`,
          `Nonce: ${nonce}`,
          `Issued At: ${issuedAt.toISOString()}`,
          `Expiration Time: ${expiresAt.toISOString()}`,
          `Request ID: ${challengeId}`,
        ].join('\n')
        : [
          `${brandName} wants you to verify this Solana wallet:`,
          walletAddress,
          '',
          'Purpose: Link this wallet to your Discord account',
          `URI: ${verificationUri}`,
          `Chain: ${chain.chainId}`,
          `Discord ID: ${discordId}`,
          `Guild ID: ${guildId || 'none'}`,
          `Nonce: ${nonce}`,
          `Issued At: ${issuedAt.toISOString()}`,
          `Expiration Time: ${expiresAt.toISOString()}`,
          `Request ID: ${challengeId}`,
        ].join('\n');

      db.prepare(`
        DELETE FROM wallet_verification_challenges
        WHERE expires_at <= CURRENT_TIMESTAMP
           OR (discord_id = ? AND session_hash = ? AND consumed_at IS NULL)
      `).run(discordId, verificationSessionHash(req));
      db.prepare(`
        INSERT INTO wallet_verification_challenges (
          challenge_id, session_hash, discord_id, guild_id, chain_family, chain_id,
          wallet_address, message, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        challengeId,
        verificationSessionHash(req),
        discordId,
        guildId,
        chain.family,
        chain.chainId,
        walletAddress,
        message,
        expiresAt.toISOString()
      );

      return res.json(toSuccessResponse({ message, challengeId, expiresAt: expiresAt.toISOString(), chain: chain.chainId }));
    } catch (routeError) {
      logger.error('Error generating challenge:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  const verifyWalletSignature = async (req, res) => {
    if (!requireUser(req, res)) return;

    try {
      const chain = getChain(req.body?.chain || 'solana:mainnet');
      const walletAddress = normalizeAddress(req.body?.walletAddress, chain?.chainId);
      const signature = String(req.body?.signature || '').trim();
      const challengeId = String(req.body?.challengeId || '').trim();
      const discordId = String(req.session.discordUser.id || '').trim();
      const guildId = String(req.guildId || '').trim();

      if (!chain || !walletAddress || !signature || signature.length > 1024 || !/^[a-f0-9]{48}$/.test(challengeId)) {
        return res.status(400).json(toErrorResponse('Missing or invalid wallet verification fields', 'VALIDATION_ERROR'));
      }

      const consumeChallenge = db.transaction(() => {
        const challenge = db.prepare(`
          SELECT * FROM wallet_verification_challenges
          WHERE challenge_id = ?
            AND session_hash = ?
            AND discord_id = ?
            AND guild_id = ?
            AND chain_family = ?
            AND chain_id = ?
            AND wallet_address = ?
            AND consumed_at IS NULL
            AND expires_at > CURRENT_TIMESTAMP
          LIMIT 1
        `).get(challengeId, verificationSessionHash(req), discordId, guildId, chain.family, chain.chainId, walletAddress);
        if (!challenge) return null;
        const consumed = db.prepare(`
          UPDATE wallet_verification_challenges
          SET consumed_at = CURRENT_TIMESTAMP, attempts = attempts + 1
          WHERE challenge_id = ? AND consumed_at IS NULL
        `).run(challengeId);
        return consumed.changes === 1 ? challenge : null;
      });
      const challenge = consumeChallenge();
      if (!challenge) {
        return res.status(400).json(toErrorResponse('Challenge is invalid, expired, or already used. Request a new challenge.', 'VALIDATION_ERROR'));
      }

      const isValid = chain.family === 'evm'
        ? evmService.verifyWalletSignature({ address: walletAddress, signature, message: challenge.message })
        : verifySignature(walletAddress, signature, challenge.message);
      if (!isValid) {
        return res.status(400).json(toErrorResponse('Invalid signature. Make sure you signed with the correct wallet.', 'VALIDATION_ERROR'));
      }

      const existingWallet = db.prepare('SELECT * FROM wallets WHERE chain_family = ? AND wallet_address = ?')
        .get(chain.family, walletAddress);
      if (existingWallet) {
        if (existingWallet.discord_id === discordId) {
          if (chain.family === 'solana') triggerVaultBackfillBestEffort(req, discordId, walletAddress);
          try {
            await refreshUserRoles(req, discordId, req.session.discordUser.username || 'Web User');
            if (chain.family === 'solana') {
              triggerOgRoleBestEffort(req, discordId, req.session.discordUser.username || 'Web User');
            }
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

      const linkResult = walletService.linkWallet(
        discordId,
        req.session.discordUser.username || 'Web User',
        walletAddress,
        req.guildId || '',
        chain.chainId
      );
      if (!linkResult?.success) {
        return res.status(400).json(toErrorResponse(linkResult?.message || 'Failed to link wallet', 'VALIDATION_ERROR'));
      }

      try {
        await refreshUserRoles(req, discordId, req.session.discordUser.username || 'Web User');
      } catch (roleErr) {
        logger.error('Role update after verify failed (non-fatal):', roleErr);
      }

      // Always attempt OG assignment in guild context (safe no-op if not eligible/already assigned).
      if (chain.family === 'solana') {
        triggerOgRoleBestEffort(req, discordId, req.session.discordUser.username || 'Web User');
      }

      logger.log(`Web signature verification: User ${discordId} linked wallet ${maskAddress(walletAddress)}`);
      return res.json(toSuccessResponse({
        message: `${chain.name} wallet verified successfully!`,
        isFavorite: !!linkResult?.isFirstWallet,
        chain: chain.chainId,
      }));
    } catch (routeError) {
      logger.error('Error in signature verification:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  };

  router.post('/api/verify/signature', verifyWalletSignature);
  router.post('/api/verify', verifyWalletSignature);

  router.get('/api/wallets/:discordId', (req, res) => {
    if (!req.session?.discordUser?.id) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    if (req.session.discordUser.id !== req.params.discordId) {
      return res.status(403).json(toErrorResponse('Forbidden', 'FORBIDDEN'));
    }

    try {
      const { discordId } = req.params;
      const wallets = db.prepare(`
        SELECT wallet_address, chain_family, chain_id, is_favorite, primary_wallet, created_at
        FROM wallets
        WHERE discord_id = ?
        ORDER BY is_favorite DESC, created_at ASC
      `).all(discordId);
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

      logger.log(`User ${discordId} set favorite wallet: ${maskAddress(walletAddress)}`);
      return res.json(toSuccessResponse({ message: 'Favorite wallet updated' }));
    } catch (routeError) {
      logger.error('Error setting favorite wallet:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.get('/api/wallets/:discordId/delegations', (req, res) => {
    if (!req.session?.discordUser?.id) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    if (req.session.discordUser.id !== req.params.discordId) {
      return res.status(403).json(toErrorResponse('Forbidden', 'FORBIDDEN'));
    }
    try {
      return res.json(toSuccessResponse({
        delegations: [],
        disabled: true,
        message: 'Cold wallet delegation is disabled for security review. Link wallets directly for verification.',
      }));
    } catch (routeError) {
      logger.error('Error fetching wallet delegations:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/wallets/:discordId/delegations', (req, res) => {
    if (!req.session?.discordUser?.id) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    if (req.session.discordUser.id !== req.params.discordId) {
      return res.status(403).json(toErrorResponse('Forbidden', 'FORBIDDEN'));
    }
    return res.status(410).json(toErrorResponse(
      'Cold wallet delegation is disabled for security review. Please link wallets directly.',
      'DELEGATION_DISABLED'
    ));
  });

  router.delete('/api/wallets/:discordId/delegations/:coldWalletAddress', (req, res) => {
    if (!req.session?.discordUser?.id) {
      return res.status(401).json(toErrorResponse('Not authenticated', 'UNAUTHORIZED'));
    }
    if (req.session.discordUser.id !== req.params.discordId) {
      return res.status(403).json(toErrorResponse('Forbidden', 'FORBIDDEN'));
    }
    try {
      const { discordId } = req.params;
      const guildId = String(req.guildId || '').trim();
      const coldWalletAddress = decodeURIComponent(String(req.params.coldWalletAddress || '').trim());
      const result = walletService.revokeDelegatedWallet(discordId, coldWalletAddress, guildId);
      if (!result.success) {
        return res.status(404).json(toErrorResponse(result.message || 'Delegation not found', 'NOT_FOUND'));
      }
      return res.json(toSuccessResponse({ message: 'Delegation revoked' }));
    } catch (routeError) {
      logger.error('Error revoking wallet delegation:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createUserWalletVerificationRouter;
