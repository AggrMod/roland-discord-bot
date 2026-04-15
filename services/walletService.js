const db = require('../database/db');
const logger = require('../utils/logger');
const clientProvider = require('../utils/clientProvider');

class WalletService {
  linkWallet(discordId, username, walletAddress, guildId = '') {
    try {
      // Wrap existence check + INSERT in a transaction to prevent race conditions
      const linkTransaction = db.transaction(() => {
        let user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);

        if (!user) {
          db.prepare('INSERT INTO users (discord_id, username) VALUES (?, ?)').run(discordId, username);
        }

        const existingWallet = db.prepare('SELECT * FROM wallets WHERE wallet_address = ?').get(walletAddress);

        if (existingWallet) {
          if (existingWallet.discord_id === discordId) {
            return { success: true, message: 'Wallet already linked to your account', isFirstWallet: false };
          }
          return { success: false, message: 'This wallet is already linked to another account' };
        }

        const walletCount = db.prepare('SELECT COUNT(*) as count FROM wallets WHERE discord_id = ?').get(discordId).count;
        const isPrimary = walletCount === 0 ? 1 : 0;
        const isFirstWallet = walletCount === 0;

        db.prepare('INSERT INTO wallets (discord_id, wallet_address, primary_wallet) VALUES (?, ?, ?)').run(discordId, walletAddress, isPrimary);

        return { success: true, message: 'Wallet linked successfully', isFirstWallet };
      });

      const result = linkTransaction();

      if (result.success && result.isFirstWallet) {
        logger.log(`Wallet ${walletAddress} linked to user ${discordId}`);
        this.triggerOGRoleAssignment(discordId, username, guildId);
      } else if (result.success) {
        logger.log(`Wallet ${walletAddress} linked to user ${discordId}`);
      }

      return result;
    } catch (error) {
      logger.error('Error linking wallet:', error);
      return { success: false, message: 'Failed to link wallet' };
    }
  }

  async triggerOGRoleAssignment(discordId, username, guildIdHint = '') {
    try {
      logger.log(`[OG-Role] Triggering assignment for ${username} (${discordId}), hint: ${guildIdHint}`);
      // Defer OG role assignment to avoid blocking verification
      setImmediate(async () => {
        try {
          const ogRoleService = require('./ogRoleService');
          const client = clientProvider.getClient();
          
          if (!client) {
            logger.warn(`[OG-Role] Discord client not available for user ${discordId}`);
            return;
          }

          const hintedGuildId = String(guildIdHint || '').trim();
          const candidateGuildIds = hintedGuildId
            ? [hintedGuildId]
            : Array.from(client.guilds.cache.keys());

          logger.log(`[OG-Role] Attempting assignment in ${candidateGuildIds.length} candidate guild(s) for ${discordId}`);

          let attempted = 0;
          let assigned = 0;

          for (const guildId of candidateGuildIds) {
            const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
            if (!guild) {
              logger.debug(`[OG-Role] Guild ${guildId} not found for ${discordId}`);
              continue;
            }

            // Only attempt where the user is actually in this guild.
            const member = guild.members.cache.get(discordId) || await guild.members.fetch(discordId).catch(() => null);
            if (!member) {
              logger.debug(`[OG-Role] Member ${discordId} not found in guild ${guild.name} (${guild.id})`);
              continue;
            }

            attempted += 1;
            logger.log(`[OG-Role] Checking eligibility for ${username} (${discordId}) in guild ${guild.name} (${guild.id})`);
            const result = await ogRoleService.assignOnVerification(guild, discordId, username);
            if (result?.assigned) {
              assigned += 1;
              logger.log(`[OG-Role] ✨ OG role auto-assigned to ${username} (${discordId}) in guild ${guild.id}`);
            } else {
              logger.log(`[OG-Role] Result for ${username} in ${guild.name}: ${result?.message || 'No assignment'}`);
            }
          }

          if (attempted === 0) {
            logger.debug(`OG role assignment skipped: member ${discordId} not found in candidate guilds`);
          } else if (assigned === 0) {
            logger.debug(`OG role assignment attempted for ${discordId} in ${attempted} guild(s), no assignment applied`);
          }
        } catch (error) {
          logger.error('Error in OG role auto-assignment:', error);
        }
      });
    } catch (error) {
      logger.error('Error triggering OG role assignment:', error);
    }
  }

  getLinkedWallets(discordId) {
    try {
      const wallets = db.prepare('SELECT wallet_address, primary_wallet FROM wallets WHERE discord_id = ? ORDER BY primary_wallet DESC').all(discordId);
      return wallets;
    } catch (error) {
      logger.error('Error fetching wallets:', error);
      return [];
    }
  }

  removeWallet(discordId, walletAddress) {
    try {
      const result = db.prepare('DELETE FROM wallets WHERE discord_id = ? AND wallet_address = ?').run(discordId, walletAddress);
      
      if (result.changes > 0) {
        logger.log(`Wallet ${walletAddress} removed from user ${discordId}`);
        return { success: true, message: 'Wallet removed successfully' };
      }
      return { success: false, message: 'Wallet not found' };
    } catch (error) {
      logger.error('Error removing wallet:', error);
      return { success: false, message: 'Failed to remove wallet' };
    }
  }

  getAllUserWallets(discordId) {
    return this.getLinkedWallets(discordId).map(w => w.wallet_address);
  }

  setFavoriteWallet(discordId, walletAddress) {
    try {
      // Verify wallet belongs to user
      const wallet = db.prepare('SELECT * FROM wallets WHERE discord_id = ? AND wallet_address = ?').get(discordId, walletAddress);
      
      if (!wallet) {
        return { success: false, message: 'Wallet not found' };
      }

      // Unset all favorites for this user
      db.prepare('UPDATE wallets SET is_favorite = 0 WHERE discord_id = ?').run(discordId);
      
      // Set new favorite
      db.prepare('UPDATE wallets SET is_favorite = 1 WHERE discord_id = ? AND wallet_address = ?').run(discordId, walletAddress);

      logger.log(`User ${discordId} set favorite wallet: ${walletAddress}`);
      return { success: true, message: 'Favorite wallet updated' };
    } catch (error) {
      logger.error('Error setting favorite wallet:', error);
      return { success: false, message: 'Failed to set favorite wallet' };
    }
  }

  getFavoriteWallet(discordId) {
    try {
      const wallet = db.prepare('SELECT wallet_address FROM wallets WHERE discord_id = ? AND is_favorite = 1').get(discordId);
      return wallet ? wallet.wallet_address : null;
    } catch (error) {
      logger.error('Error getting favorite wallet:', error);
      return null;
    }
  }

  removeAllWallets(discordId) {
    try {
      const result = db.prepare('DELETE FROM wallets WHERE discord_id = ?').run(discordId);
      logger.log(`Removed ${result.changes} wallets from user ${discordId}`);
      return { success: true, message: `${result.changes} wallets removed` };
    } catch (error) {
      logger.error('Error removing all wallets:', error);
      return { success: false, message: 'Failed to remove wallets' };
    }
  }
}

module.exports = new WalletService();
