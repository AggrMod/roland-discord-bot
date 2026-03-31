const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const CONFIG_FILE = path.join(__dirname, '../config/role-claim.json');

class RoleClaimService {
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
        claimableRoles: [],
        version: 1
      };
      
      this.saveConfig(defaultConfig);
      return defaultConfig;
    } catch (error) {
      logger.error('Error loading role claim config:', error);
      return {
        claimableRoles: [],
        version: 1
      };
    }
  }

  saveConfig(config) {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
      logger.log('Role claim config saved');
    } catch (error) {
      logger.error('Error saving role claim config:', error);
    }
  }

  getConfig() {
    return { ...this.config };
  }

  /**
   * Get all claimable roles
   */
  getClaimableRoles() {
    return this.config.claimableRoles.filter(r => r.enabled !== false);
  }

  /**
   * Get all roles (including disabled)
   */
  getAllRoles() {
    return [...this.config.claimableRoles];
  }

  /**
   * Add a claimable role
   */
  addRole(roleId, label) {
    try {
      // Check if role already exists
      const existing = this.config.claimableRoles.find(r => r.roleId === roleId);
      if (existing) {
        return { 
          success: false, 
          message: 'Role already in claimable list' 
        };
      }

      const newRole = {
        roleId,
        label: label || roleId,
        enabled: true,
        addedAt: new Date().toISOString()
      };

      this.config.claimableRoles.push(newRole);
      this.saveConfig(this.config);

      logger.log(`Added claimable role: ${label} (${roleId})`);
      return { 
        success: true, 
        message: `Added claimable role: ${label}`,
        role: newRole
      };
    } catch (error) {
      logger.error('Error adding claimable role:', error);
      return { 
        success: false, 
        message: 'Failed to add role' 
      };
    }
  }

  /**
   * Remove a claimable role
   */
  removeRole(roleId) {
    try {
      const index = this.config.claimableRoles.findIndex(r => r.roleId === roleId);
      if (index === -1) {
        return { 
          success: false, 
          message: 'Role not found in claimable list' 
        };
      }

      const removed = this.config.claimableRoles.splice(index, 1)[0];
      this.saveConfig(this.config);

      logger.log(`Removed claimable role: ${removed.label} (${roleId})`);
      return { 
        success: true, 
        message: `Removed claimable role: ${removed.label}` 
      };
    } catch (error) {
      logger.error('Error removing claimable role:', error);
      return { 
        success: false, 
        message: 'Failed to remove role' 
      };
    }
  }

  /**
   * Update a claimable role
   */
  updateRole(roleId, updates) {
    try {
      const role = this.config.claimableRoles.find(r => r.roleId === roleId);
      if (!role) {
        return { 
          success: false, 
          message: 'Role not found' 
        };
      }

      if (updates.label !== undefined) role.label = updates.label;
      if (updates.enabled !== undefined) role.enabled = updates.enabled;

      this.saveConfig(this.config);

      logger.log(`Updated claimable role: ${role.label} (${roleId})`);
      return { 
        success: true, 
        message: 'Role updated',
        role
      };
    } catch (error) {
      logger.error('Error updating claimable role:', error);
      return { 
        success: false, 
        message: 'Failed to update role' 
      };
    }
  }

  /**
   * Toggle role membership for a user
   */
  async toggleRole(guild, member, roleId) {
    try {
      const db = require('../database/db');
      
      // Check if role is in the guild's role panels (database-driven, not static config)
      const panelRole = db.prepare(`
        SELECT rpr.* FROM role_panel_roles rpr
        JOIN role_panels rp ON rp.id = rpr.panel_id
        WHERE rp.guild_id = ? AND rpr.role_id = ?
      `).get(guild.id, roleId);
      
      if (!panelRole) {
        return { 
          success: false, 
          message: 'This role is not available for claiming' 
        };
      }

      const role = guild.roles.cache.get(roleId);
      if (!role) {
        return { 
          success: false, 
          message: 'Role not found in server' 
        };
      }

      // Check bot can manage this role
      const botMember = guild.members.me;
      if (role.position >= botMember.roles.highest.position) {
        return { 
          success: false, 
          message: 'Bot cannot manage this role (role hierarchy)' 
        };
      }

      // Check if bot has permission to manage roles
      if (!botMember.permissions.has('ManageRoles')) {
        return { 
          success: false, 
          message: 'Bot lacks ManageRoles permission' 
        };
      }

      // Toggle role
      const hasRole = member.roles.cache.has(roleId);
      
      if (hasRole) {
        await member.roles.remove(role);
        logger.log(`User ${member.user.tag} unclaimed role: ${role.name}`);
        return {
          success: true,
          action: 'removed',
          message: `Removed role: ${role.name}`,
          roleName: role.name
        };
      } else {
        await member.roles.add(role);
        logger.log(`User ${member.user.tag} claimed role: ${role.name}`);
        return {
          success: true,
          action: 'added',
          message: `Added role: ${role.name}`,
          roleName: role.name
        };
      }
    } catch (error) {
      logger.error('Error toggling role:', error);
      return { 
        success: false, 
        message: 'Failed to toggle role: ' + error.message 
      };
    }
  }

  /**
   * Validate a role can be managed by bot
   */
  async validateRole(guild, roleId) {
    try {
      const role = guild.roles.cache.get(roleId);
      if (!role) {
        return { 
          valid: false, 
          message: 'Role not found in server' 
        };
      }

      const botMember = guild.members.me;
      if (role.position >= botMember.roles.highest.position) {
        return { 
          valid: false, 
          message: `Bot cannot manage "${role.name}" (hierarchy: bot's highest role is below this role)` 
        };
      }

      if (!botMember.permissions.has('ManageRoles')) {
        return { 
          valid: false, 
          message: 'Bot lacks ManageRoles permission' 
        };
      }

      // Warn about @everyone and managed roles
      if (role.id === guild.id) {
        return { 
          valid: false, 
          message: 'Cannot manage @everyone role' 
        };
      }

      if (role.managed) {
        return { 
          valid: false, 
          message: `"${role.name}" is managed by an integration and cannot be manually assigned` 
        };
      }

      return { 
        valid: true, 
        message: `Role "${role.name}" can be managed`,
        roleName: role.name 
      };
    } catch (error) {
      logger.error('Error validating role:', error);
      return { 
        valid: false, 
        message: 'Failed to validate role' 
      };
    }
  }

  /**
   * Get role status enriched with guild data
   */
  async getRoleStatus(guild) {
    try {
      const roles = [];

      for (const claimableRole of this.config.claimableRoles) {
        const role = guild.roles.cache.get(claimableRole.roleId);
        const validation = await this.validateRole(guild, claimableRole.roleId);

        roles.push({
          roleId: claimableRole.roleId,
          label: claimableRole.label,
          enabled: claimableRole.enabled !== false,
          exists: !!role,
          roleName: role ? role.name : 'Unknown',
          color: role ? role.hexColor : null,
          memberCount: role ? role.members.size : 0,
          manageable: validation.valid,
          validationMessage: validation.message
        });
      }

      return {
        success: true,
        roles,
        totalRoles: roles.length,
        enabledRoles: roles.filter(r => r.enabled).length
      };
    } catch (error) {
      logger.error('Error getting role status:', error);
      return {
        success: false,
        message: 'Failed to get role status',
        roles: []
      };
    }
  }
}

module.exports = new RoleClaimService();
