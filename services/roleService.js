const db = require('../database/db');
const walletService = require('./walletService');
const nftService = require('./nftService');
const vpService = require('./vpService');
const logger = require('../utils/logger');

class RoleService {
  async updateUserRoles(discordId, username) {
    try {
      const wallets = walletService.getAllUserWallets(discordId);
      
      if (wallets.length === 0) {
        logger.warn(`No wallets linked for user ${discordId}`);
        return { success: false, message: 'No wallets linked' };
      }

      const totalNFTs = await nftService.countNFTsForWallets(wallets);
      const tier = vpService.getTierForNFTCount(totalNFTs);
      const votingPower = vpService.calculateVotingPower(totalNFTs);

      db.prepare(`
        UPDATE users 
        SET total_nfts = ?, tier = ?, voting_power = ?, username = ?, updated_at = CURRENT_TIMESTAMP
        WHERE discord_id = ?
      `).run(totalNFTs, tier ? tier.name : null, votingPower, username, discordId);

      logger.log(`Updated user ${discordId}: ${totalNFTs} NFTs, Tier: ${tier ? tier.name : 'None'}, VP: ${votingPower}`);

      return {
        success: true,
        totalNFTs,
        tier: tier ? tier.name : 'None',
        votingPower
      };
    } catch (error) {
      logger.error('Error updating user roles:', error);
      return { success: false, message: 'Failed to update roles' };
    }
  }

  async getUserInfo(discordId) {
    try {
      const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
      return user;
    } catch (error) {
      logger.error('Error fetching user info:', error);
      return null;
    }
  }

  async assignDiscordRole(guild, userId, tierName) {
    try {
      const member = await guild.members.fetch(userId);
      const rolesConfig = require('../config/roles.json');
      
      const tier = rolesConfig.tiers.find(t => t.name === tierName);
      if (!tier || !tier.roleId) {
        logger.warn(`No Discord role configured for tier: ${tierName}`);
        return { success: false, message: 'Role not configured' };
      }

      const role = guild.roles.cache.get(tier.roleId);
      if (!role) {
        logger.warn(`Discord role not found: ${tier.roleId}`);
        return { success: false, message: 'Role not found in server' };
      }

      await member.roles.add(role);
      logger.log(`Assigned Discord role ${tierName} to user ${userId}`);
      
      return { success: true };
    } catch (error) {
      logger.error('Error assigning Discord role:', error);
      return { success: false, message: 'Failed to assign role' };
    }
  }

  async removeAllTierRoles(guild, userId) {
    try {
      const member = await guild.members.fetch(userId);
      const rolesConfig = require('../config/roles.json');
      
      for (const tier of rolesConfig.tiers) {
        if (tier.roleId) {
          const role = guild.roles.cache.get(tier.roleId);
          if (role && member.roles.cache.has(tier.roleId)) {
            await member.roles.remove(role);
          }
        }
      }
      
      return { success: true };
    } catch (error) {
      logger.error('Error removing tier roles:', error);
      return { success: false };
    }
  }
}

module.exports = new RoleService();
