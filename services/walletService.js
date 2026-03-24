const db = require('../database/db');
const logger = require('../utils/logger');

class WalletService {
  linkWallet(discordId, username, walletAddress) {
    try {
      let user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
      
      if (!user) {
        db.prepare('INSERT INTO users (discord_id, username) VALUES (?, ?)').run(discordId, username);
      }

      const existingWallet = db.prepare('SELECT * FROM wallets WHERE wallet_address = ?').get(walletAddress);
      
      if (existingWallet) {
        if (existingWallet.discord_id === discordId) {
          return { success: true, message: 'Wallet already linked to your account' };
        }
        return { success: false, message: 'This wallet is already linked to another account' };
      }

      const walletCount = db.prepare('SELECT COUNT(*) as count FROM wallets WHERE discord_id = ?').get(discordId).count;
      const isPrimary = walletCount === 0 ? 1 : 0;

      db.prepare('INSERT INTO wallets (discord_id, wallet_address, primary_wallet) VALUES (?, ?, ?)').run(discordId, walletAddress, isPrimary);

      logger.log(`Wallet ${walletAddress} linked to user ${discordId}`);
      return { success: true, message: 'Wallet linked successfully' };
    } catch (error) {
      logger.error('Error linking wallet:', error);
      return { success: false, message: 'Failed to link wallet' };
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
}

module.exports = new WalletService();
