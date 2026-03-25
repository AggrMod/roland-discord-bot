const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const logger = require('../utils/logger');

const CONFIG_FILE = path.join(__dirname, '../config/og-role.json');

class OGRoleService {
  constructor() {
    this.config = this.loadConfig();
  }

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        return JSON.parse(data);
      }
      
      // Create default config
      const defaultConfig = {
        enabled: false,
        roleId: null,
        limit: 100,
        version: 1
      };
      
      this.saveConfig(defaultConfig);
      return defaultConfig;
    } catch (error) {
      logger.error('Error loading OG role config:', error);
      return {
        enabled: false,
        roleId: null,
        limit: 100,
        version: 1
      };
    }
  }

  saveConfig(config) {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
      logger.log('OG role config saved');
    } catch (error) {
      logger.error('Error saving OG role config:', error);
    }
  }

  getConfig() {
    return { ...this.config };
  }

  setEnabled(enabled) {
    try {
      this.config.enabled = !!enabled;
      this.saveConfig(this.config);
      logger.log(`OG role ${enabled ? 'enabled' : 'disabled'}`);
      return { success: true, message: `OG role ${enabled ? 'enabled' : 'disabled'}` };
    } catch (error) {
      logger.error('Error setting OG role enabled:', error);
      return { success: false, message: 'Failed to update enabled status' };
    }
  }

  setRole(roleId) {
    try {
      this.config.roleId = roleId;
      this.saveConfig(this.config);
      logger.log(`OG role set to: ${roleId}`);
      return { success: true, message: 'OG role updated' };
    } catch (error) {
      logger.error('Error setting OG role:', error);
      return { success: false, message: 'Failed to update role' };
    }
  }

  setLimit(limit) {
    try {
      const numLimit = parseInt(limit);
      if (isNaN(numLimit) || numLimit < 1) {
        return { success: false, message: 'Limit must be a positive number' };
      }
      
      this.config.limit = numLimit;
      this.saveConfig(this.config);
      logger.log(`OG role limit set to: ${numLimit}`);
      return { success: true, message: `OG limit set to ${numLimit}` };
    } catch (error) {
      logger.error('Error setting OG role limit:', error);
      return { success: false, message: 'Failed to update limit' };
    }
  }

  /**
   * Get eligible OG users (first X by verification timestamp)
   * Returns users sorted by verification timestamp (earliest first)
   */
  getEligibleUsers() {
    try {
      if (!this.config.enabled || !this.config.roleId) {
        return [];
      }

      // Get users sorted by their first wallet creation timestamp
      const eligibleUsers = db.prepare(`
        SELECT u.discord_id, u.username, MIN(w.created_at) as first_verified_at
        FROM users u
        JOIN wallets w ON u.discord_id = w.discord_id
        GROUP BY u.discord_id
        ORDER BY first_verified_at ASC
        LIMIT ?
      `).all(this.config.limit);

      return eligibleUsers;
    } catch (error) {
      logger.error('Error getting eligible OG users:', error);
      return [];
    }
  }

  /**
   * Get current OG role holders from Discord
   */
  async getCurrentHolders(guild) {
    try {
      if (!this.config.roleId) {
        return [];
      }

      const role = guild.roles.cache.get(this.config.roleId);
      if (!role) {
        return [];
      }

      return Array.from(role.members.keys());
    } catch (error) {
      logger.error('Error getting current OG holders:', error);
      return [];
    }
  }

  /**
   * Check if a user is eligible for OG role
   */
  async isEligible(discordId) {
    try {
      if (!this.config.enabled || !this.config.roleId) {
        return false;
      }

      const eligible = this.getEligibleUsers();
      return eligible.some(u => u.discord_id === discordId);
    } catch (error) {
      logger.error('Error checking OG eligibility:', error);
      return false;
    }
  }

  /**
   * Sync OG role to eligible users
   * Only adds to users who should have it, never removes unless in fullSync mode
   */
  async syncRoles(guild, fullSync = false) {
    try {
      if (!this.config.enabled || !this.config.roleId) {
        return { 
          success: false, 
          message: 'OG role not enabled or role not configured' 
        };
      }

      const role = guild.roles.cache.get(this.config.roleId);
      if (!role) {
        return { 
          success: false, 
          message: 'OG role not found in guild' 
        };
      }

      const eligibleUsers = this.getEligibleUsers();
      const eligibleIds = new Set(eligibleUsers.map(u => u.discord_id));
      const currentHolders = await this.getCurrentHolders(guild);

      let added = 0;
      let removed = 0;
      let errors = 0;

      // Add role to eligible users who don't have it
      for (const user of eligibleUsers) {
        if (!currentHolders.includes(user.discord_id)) {
          try {
            const member = await guild.members.fetch(user.discord_id).catch(() => null);
            if (member) {
              await member.roles.add(role);
              added++;
              logger.log(`Added OG role to ${user.username} (${user.discord_id})`);
            }
          } catch (error) {
            logger.error(`Failed to add OG role to ${user.discord_id}:`, error);
            errors++;
          }
        }
      }

      // In fullSync mode, remove from users who shouldn't have it
      if (fullSync) {
        for (const holderId of currentHolders) {
          if (!eligibleIds.has(holderId)) {
            try {
              const member = await guild.members.fetch(holderId).catch(() => null);
              if (member) {
                await member.roles.remove(role);
                removed++;
                logger.log(`Removed OG role from ${holderId}`);
              }
            } catch (error) {
              logger.error(`Failed to remove OG role from ${holderId}:`, error);
              errors++;
            }
          }
        }
      }

      const message = `OG role sync complete: +${added} added${fullSync ? `, -${removed} removed` : ''}, ${errors} errors`;
      logger.log(message);

      return {
        success: true,
        message,
        added,
        removed,
        errors,
        eligible: eligibleUsers.length
      };
    } catch (error) {
      logger.error('Error syncing OG roles:', error);
      return {
        success: false,
        message: 'Failed to sync OG roles',
        error: error.message
      };
    }
  }

  /**
   * Auto-assign OG role on verification if eligible
   * Called from verification flow
   */
  async assignOnVerification(guild, discordId, username) {
    try {
      if (!this.config.enabled || !this.config.roleId) {
        return { success: false, message: 'OG role not enabled' };
      }

      const eligible = await this.isEligible(discordId);
      if (!eligible) {
        return { success: false, message: 'User not eligible for OG role' };
      }

      const role = guild.roles.cache.get(this.config.roleId);
      if (!role) {
        return { success: false, message: 'OG role not found' };
      }

      const member = await guild.members.fetch(discordId).catch(() => null);
      if (!member) {
        return { success: false, message: 'Member not found in guild' };
      }

      // Check if already has role
      if (member.roles.cache.has(this.config.roleId)) {
        return { success: true, message: 'User already has OG role', alreadyHas: true };
      }

      await member.roles.add(role);
      logger.log(`Auto-assigned OG role to ${username} (${discordId}) on verification`);

      return {
        success: true,
        message: 'OG role assigned',
        assigned: true
      };
    } catch (error) {
      logger.error('Error assigning OG role on verification:', error);
      return {
        success: false,
        message: 'Failed to assign OG role',
        error: error.message
      };
    }
  }

  /**
   * Get status summary for display
   */
  async getStatus(guild) {
    try {
      const eligible = this.getEligibleUsers();
      const currentHolders = await this.getCurrentHolders(guild);

      let roleName = 'Not Set';
      if (this.config.roleId) {
        const role = guild.roles.cache.get(this.config.roleId);
        roleName = role ? role.name : `Unknown (${this.config.roleId})`;
      }

      return {
        enabled: this.config.enabled,
        roleId: this.config.roleId,
        roleName,
        limit: this.config.limit,
        eligibleCount: eligible.length,
        currentHoldersCount: currentHolders.length,
        eligible: eligible.slice(0, 10).map(u => ({
          discordId: u.discord_id,
          username: u.username,
          verifiedAt: u.first_verified_at
        }))
      };
    } catch (error) {
      logger.error('Error getting OG status:', error);
      return {
        enabled: this.config.enabled,
        roleId: this.config.roleId,
        roleName: 'Error',
        limit: this.config.limit,
        eligibleCount: 0,
        currentHoldersCount: 0,
        eligible: []
      };
    }
  }
}

module.exports = new OGRoleService();
