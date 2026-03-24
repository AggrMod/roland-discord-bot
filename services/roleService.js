const db = require('../database/db');
const walletService = require('./walletService');
const nftService = require('./nftService');
const vpService = require('./vpService');
const logger = require('../utils/logger');

class RoleService {
  constructor() {
    this.traitRolesConfig = null;
    this.tiersConfig = null;
  }

  loadConfigs() {
    try {
      this.tiersConfig = require('../config/roles.json');
      this.traitRolesConfig = require('../config/trait-roles.json');
      logger.log('Role configs loaded successfully');
    } catch (error) {
      logger.error('Error loading role configs:', error);
      this.tiersConfig = { tiers: [] };
      this.traitRolesConfig = { traitRoles: [] };
    }
  }

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

  /**
   * Sync all Discord roles for a user (both tier and trait roles)
   * This is the main entry point for comprehensive role sync
   */
  async syncUserDiscordRoles(guild, discordId) {
    try {
      const member = await guild.members.fetch(discordId).catch(() => null);
      if (!member) {
        logger.warn(`Member ${discordId} not found in guild ${guild.id}`);
        return { success: false, message: 'Member not found in guild' };
      }

      // Load configs if not already loaded
      if (!this.tiersConfig || !this.traitRolesConfig) {
        this.loadConfigs();
      }

      const userInfo = await this.getUserInfo(discordId);
      if (!userInfo) {
        logger.warn(`User info not found for ${discordId}`);
        return { success: false, message: 'User not found in database' };
      }

      const changes = {
        added: [],
        removed: []
      };

      // 1. Sync tier roles
      const tierChanges = await this.syncTierRoles(member, userInfo.tier);
      changes.added.push(...tierChanges.added);
      changes.removed.push(...tierChanges.removed);

      // 2. Sync trait roles
      const wallets = walletService.getAllUserWallets(discordId);
      const allNFTs = await nftService.getAllNFTsForWallets(wallets);
      const traitChanges = await this.syncTraitRoles(member, allNFTs);
      changes.added.push(...traitChanges.added);
      changes.removed.push(...traitChanges.removed);

      // Log changes
      if (changes.added.length > 0 || changes.removed.length > 0) {
        logger.log(`Role sync for ${discordId} (${member.user.tag}): +${changes.added.length} -${changes.removed.length}`);
        if (changes.added.length > 0) {
          logger.log(`  Added: ${changes.added.join(', ')}`);
        }
        if (changes.removed.length > 0) {
          logger.log(`  Removed: ${changes.removed.join(', ')}`);
        }
      }

      return { 
        success: true, 
        changes,
        totalAdded: changes.added.length,
        totalRemoved: changes.removed.length
      };
    } catch (error) {
      logger.error(`Error syncing Discord roles for ${discordId}:`, error);
      return { success: false, message: 'Failed to sync roles', error: error.message };
    }
  }

  /**
   * Sync tier roles for a member
   */
  async syncTierRoles(member, currentTierName) {
    const changes = { added: [], removed: [] };

    try {
      const allTiers = this.tiersConfig.tiers || [];
      const currentMemberRoleIds = new Set(member.roles.cache.keys());

      // Determine which tier role should be active
      let targetTierRoleId = null;
      if (currentTierName) {
        const tier = allTiers.find(t => t.name === currentTierName);
        if (tier && tier.roleId) {
          targetTierRoleId = tier.roleId;
        } else if (tier && !tier.roleId) {
          logger.warn(`Tier ${currentTierName} has no roleId configured`);
        }
      }

      // Remove all tier roles except the target
      for (const tier of allTiers) {
        if (tier.roleId) {
          const shouldHave = tier.roleId === targetTierRoleId;
          const has = currentMemberRoleIds.has(tier.roleId);

          if (shouldHave && !has) {
            // Add role
            const role = member.guild.roles.cache.get(tier.roleId);
            if (role) {
              await member.roles.add(role);
              changes.added.push(tier.name);
              logger.log(`Added tier role ${tier.name} to ${member.user.tag}`);
            }
          } else if (!shouldHave && has) {
            // Remove role
            const role = member.guild.roles.cache.get(tier.roleId);
            if (role) {
              await member.roles.remove(role);
              changes.removed.push(tier.name);
              logger.log(`Removed tier role ${tier.name} from ${member.user.tag}`);
            }
          }
        }
      }
    } catch (error) {
      logger.error('Error syncing tier roles:', error);
    }

    return changes;
  }

  /**
   * Sync trait roles for a member based on NFT attributes
   */
  async syncTraitRoles(member, nfts) {
    const changes = { added: [], removed: [] };

    try {
      const traitRoles = this.traitRolesConfig.traitRoles || [];
      const currentMemberRoleIds = new Set(member.roles.cache.keys());

      // Extract traits from user's NFTs
      const userTraits = this.extractTraitsFromNFTs(nfts);

      for (const traitRole of traitRoles) {
        if (!traitRole.roleId) {
          // Skip if roleId not configured
          continue;
        }

        const shouldHave = userTraits.has(`${traitRole.trait_type}:${traitRole.trait_value}`);
        const has = currentMemberRoleIds.has(traitRole.roleId);

        if (shouldHave && !has) {
          // Add trait role
          const role = member.guild.roles.cache.get(traitRole.roleId);
          if (role) {
            await member.roles.add(role);
            changes.added.push(`${traitRole.trait_value}`);
            logger.log(`Added trait role ${traitRole.trait_value} to ${member.user.tag}`);
          } else {
            logger.warn(`Trait role ${traitRole.roleId} not found in guild`);
          }
        } else if (!shouldHave && has) {
          // Remove trait role
          const role = member.guild.roles.cache.get(traitRole.roleId);
          if (role) {
            await member.roles.remove(role);
            changes.removed.push(`${traitRole.trait_value}`);
            logger.log(`Removed trait role ${traitRole.trait_value} from ${member.user.tag}`);
          }
        }
      }
    } catch (error) {
      logger.error('Error syncing trait roles:', error);
    }

    return changes;
  }

  /**
   * Extract unique traits from NFT array
   */
  extractTraitsFromNFTs(nfts) {
    const traits = new Set();

    for (const nft of nfts) {
      if (nft.attributes && Array.isArray(nft.attributes)) {
        for (const attr of nft.attributes) {
          if (attr.trait_type && attr.value) {
            traits.add(`${attr.trait_type}:${attr.value}`);
          }
        }
      }
    }

    return traits;
  }

  /**
   * Legacy method for backward compatibility
   */
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

  /**
   * Legacy method for backward compatibility
   */
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

  /**
   * Get all verified users from database
   */
  getAllVerifiedUsers() {
    try {
      const users = db.prepare('SELECT * FROM users WHERE total_nfts > 0').all();
      return users;
    } catch (error) {
      logger.error('Error fetching verified users:', error);
      return [];
    }
  }

  /**
   * Get role configuration summary for admin visibility
   */
  getRoleConfigSummary() {
    if (!this.tiersConfig || !this.traitRolesConfig) {
      this.loadConfigs();
    }

    const summary = {
      tiers: [],
      traitRoles: []
    };

    // Tier roles summary
    for (const tier of (this.tiersConfig.tiers || [])) {
      summary.tiers.push({
        name: tier.name,
        minNFTs: tier.minNFTs,
        maxNFTs: tier.maxNFTs,
        votingPower: tier.votingPower,
        roleId: tier.roleId,
        configured: !!tier.roleId
      });
    }

    // Trait roles summary
    for (const traitRole of (this.traitRolesConfig.traitRoles || [])) {
      summary.traitRoles.push({
        trait: `${traitRole.trait_type}: ${traitRole.trait_value}`,
        roleId: traitRole.roleId,
        configured: !!traitRole.roleId,
        description: traitRole.description
      });
    }

    return summary;
  }
}

module.exports = new RoleService();
