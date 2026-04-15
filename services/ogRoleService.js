const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const logger = require('../utils/logger');
const tenantService = require('./tenantService');
const clientProvider = require('../utils/clientProvider');

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

  normalizeGuildId(guildOrId) {
    if (!guildOrId) return '';
    if (typeof guildOrId === 'string') return guildOrId.trim();
    if (typeof guildOrId === 'object' && guildOrId.id) return String(guildOrId.id).trim();
    return '';
  }

  isTenantScoped(guildOrId) {
    const guildId = this.normalizeGuildId(guildOrId);
    return !!guildId && tenantService.isMultitenantEnabled();
  }

  normalizeLimit(limit) {
    const num = parseInt(limit, 10);
    if (!Number.isFinite(num) || num < 1) return null;
    return num;
  }

  getTenantConfig(guildId) {
    const settings = tenantService.getTenantVerificationSettings(guildId);
    const parsedLimit = Number(settings?.ogRoleLimit || 0);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100;
    const roleId = settings?.ogRoleId ? String(settings.ogRoleId).trim() : null;
    return {
      enabled: !!roleId,
      roleId,
      limit,
      version: 2
    };
  }

  updateTenantConfig(guildId, patch = {}) {
    return tenantService.updateTenantVerificationSettings(guildId, patch, 'ogRoleService');
  }

  getScopedConfig(guildOrId = null) {
    const guildId = this.normalizeGuildId(guildOrId);
    if (this.isTenantScoped(guildId)) {
      return {
        tenantScoped: true,
        guildId,
        config: this.getTenantConfig(guildId)
      };
    }
    return {
      tenantScoped: false,
      guildId,
      config: { ...this.config }
    };
  }

  async resolveGuild(guildOrId) {
    if (guildOrId && typeof guildOrId === 'object' && guildOrId.id && guildOrId.members) {
      return guildOrId;
    }

    const guildId = this.normalizeGuildId(guildOrId);
    if (!guildId) return null;

    const client = clientProvider.getClient();
    if (!client) return null;
    return client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  }

  getConfig(guildOrId = null) {
    return { ...this.getScopedConfig(guildOrId).config };
  }

  setEnabled(enabled, guildOrId = null) {
    try {
      const scope = this.getScopedConfig(guildOrId);

      if (scope.tenantScoped) {
        if (enabled) {
          if (!scope.config.roleId) {
            return { success: false, message: 'Set an OG role first before enabling' };
          }
          return { success: true, message: 'OG role enabled' };
        }

        const result = this.updateTenantConfig(scope.guildId, { ogRoleId: null });
        if (!result?.success) {
          return { success: false, message: result?.message || 'Failed to disable OG role' };
        }
        logger.log(`OG role disabled for guild ${scope.guildId}`);
        return { success: true, message: 'OG role disabled' };
      }

      this.config.enabled = !!enabled;
      this.saveConfig(this.config);
      logger.log(`OG role ${enabled ? 'enabled' : 'disabled'}`);
      return { success: true, message: `OG role ${enabled ? 'enabled' : 'disabled'}` };
    } catch (error) {
      logger.error('Error setting OG role enabled:', error);
      return { success: false, message: 'Failed to update enabled status' };
    }
  }

  setRole(roleId, guildOrId = null) {
    try {
      const scope = this.getScopedConfig(guildOrId);
      const normalizedRoleId = roleId ? String(roleId).trim() : null;

      if (scope.tenantScoped) {
        const result = this.updateTenantConfig(scope.guildId, { ogRoleId: normalizedRoleId });
        if (!result?.success) {
          return { success: false, message: result?.message || 'Failed to update role' };
        }
        logger.log(`OG role set for guild ${scope.guildId}: ${normalizedRoleId || 'cleared'}`);
        return { success: true, message: 'OG role updated' };
      }

      this.config.roleId = normalizedRoleId;
      this.saveConfig(this.config);
      logger.log(`OG role set to: ${normalizedRoleId}`);
      return { success: true, message: 'OG role updated' };
    } catch (error) {
      logger.error('Error setting OG role:', error);
      return { success: false, message: 'Failed to update role' };
    }
  }

  setLimit(limit, guildOrId = null) {
    try {
      const normalizedLimit = this.normalizeLimit(limit);
      if (!normalizedLimit) {
        return { success: false, message: 'Limit must be a positive number' };
      }

      const scope = this.getScopedConfig(guildOrId);
      if (scope.tenantScoped) {
        const result = this.updateTenantConfig(scope.guildId, { ogRoleLimit: normalizedLimit });
        if (!result?.success) {
          return { success: false, message: result?.message || 'Failed to update limit' };
        }
        logger.log(`OG role limit set for guild ${scope.guildId}: ${normalizedLimit}`);
        return { success: true, message: `OG limit set to ${normalizedLimit}` };
      }

      this.config.limit = normalizedLimit;
      this.saveConfig(this.config);
      logger.log(`OG role limit set to: ${normalizedLimit}`);
      return { success: true, message: `OG limit set to ${normalizedLimit}` };
    } catch (error) {
      logger.error('Error setting OG role limit:', error);
      return { success: false, message: 'Failed to update limit' };
    }
  }

  async getEligibleUsers(guildOrId = null) {
    try {
      const scope = this.getScopedConfig(guildOrId);
      logger.debug(`[OG-Role] Getting eligible users for ${scope.guildId || 'global'}, scoped: ${scope.tenantScoped}, limit: ${scope.config.limit}`);

      if (!scope.config.enabled || !scope.config.roleId) {
        logger.debug(`[OG-Role] OG role disabled or missing roleId for ${scope.guildId || 'global'}`);
        return [];
      }

      if (!scope.tenantScoped) {
        return db.prepare(`
          SELECT u.discord_id, u.username, MIN(w.created_at) AS first_verified_at
          FROM users u
          JOIN wallets w ON u.discord_id = w.discord_id
          GROUP BY u.discord_id
          ORDER BY first_verified_at ASC
          LIMIT ?
        `).all(scope.config.limit);
      }

      const guild = await this.resolveGuild(guildOrId || scope.guildId);
      if (!guild) {
        logger.warn(`[OG-Role] Could not resolve guild for ID ${scope.guildId}`);
        return [];
      }

      // Optimization: Try to use user_tenant_memberships first as a filter
      // This ensures we only look at people who have actually 'checked in' to this specific tenant.
      const candidates = db.prepare(`
        SELECT u.discord_id, u.username, MIN(w.created_at) AS first_verified_at
        FROM users u
        JOIN wallets w ON u.discord_id = w.discord_id
        JOIN user_tenant_memberships utm ON u.discord_id = utm.discord_id
        WHERE utm.guild_id = ?
        GROUP BY u.discord_id
        ORDER BY first_verified_at ASC
        LIMIT ?
      `).all(guild.id, scope.config.limit * 2); // Fetch a few extra for safety

      if (candidates.length === 0) {
        logger.debug(`[OG-Role] No verifiers found in memberships for guild ${guild.id}`);
      }

      // Double check member status against Discord cache/fetch
      const eligible = [];
      for (const row of candidates) {
        const member = guild.members.cache.get(row.discord_id) || await guild.members.fetch(row.discord_id).catch(() => null);
        if (member) {
          eligible.push(row);
        }
        if (eligible.length >= scope.config.limit) break;
      }

      logger.debug(`[OG-Role] Found ${eligible.length} eligible OG users for guild ${guild.id}`);
      return eligible;
    } catch (error) {
      logger.error(`[OG-Role] Error getting eligible OG users:`, error);
      return [];
    }
  }

  async getCurrentHolders(guild, roleId = null) {
    try {
      const scopedRoleId = roleId || this.getScopedConfig(guild).config.roleId;
      if (!scopedRoleId) {
        return [];
      }

      const role = guild.roles.cache.get(scopedRoleId) || await guild.roles.fetch(scopedRoleId).catch(() => null);
      if (!role) {
        return [];
      }

      return Array.from(role.members.keys());
    } catch (error) {
      logger.error('Error getting current OG holders:', error);
      return [];
    }
  }

  async isEligible(discordId, guildOrId = null) {
    try {
      const scope = this.getScopedConfig(guildOrId);
      if (!scope.config.enabled || !scope.config.roleId) {
        logger.debug(`[OG-Role] Eligibility skip: Not enabled or no roleId for ${guildOrId}`);
        return false;
      }

      const eligible = await this.getEligibleUsers(guildOrId);
      const isIncluded = eligible.some(u => u.discord_id === discordId);
      
      if (!isIncluded) {
        logger.debug(`[OG-Role] User ${discordId} is not in the eligible list (limit ${scope.config.limit}) for ${guildOrId}`);
      }
      
      return isIncluded;
    } catch (error) {
      logger.error(`[OG-Role] Error checking OG eligibility for ${discordId}:`, error);
      return false;
    }
  }

  async syncRoles(guild, fullSync = false) {
    try {
      const scope = this.getScopedConfig(guild);
      const config = scope.config;
      if (!config.enabled || !config.roleId) {
        return {
          success: false,
          message: 'OG role not enabled or role not configured'
        };
      }

      const role = guild.roles.cache.get(config.roleId) || await guild.roles.fetch(config.roleId).catch(() => null);
      if (!role) {
        return {
          success: false,
          message: 'OG role not found in guild'
        };
      }

      const eligibleUsers = await this.getEligibleUsers(guild);
      const eligibleIds = new Set(eligibleUsers.map(u => u.discord_id));
      const currentHolders = await this.getCurrentHolders(guild, config.roleId);

      let added = 0;
      let removed = 0;
      let errors = 0;

      for (const user of eligibleUsers) {
        if (!currentHolders.includes(user.discord_id)) {
          try {
            const member = await guild.members.fetch(user.discord_id).catch(() => null);
            if (member) {
              await member.roles.add(role);
              added++;
              logger.log(`Added OG role to ${user.username} (${user.discord_id}) in guild ${guild.id}`);
            }
          } catch (error) {
            logger.error(`Failed to add OG role to ${user.discord_id}:`, error);
            errors++;
          }
        }
      }

      if (fullSync) {
        for (const holderId of currentHolders) {
          if (!eligibleIds.has(holderId)) {
            try {
              const member = await guild.members.fetch(holderId).catch(() => null);
              if (member) {
                await member.roles.remove(role);
                removed++;
                logger.log(`Removed OG role from ${holderId} in guild ${guild.id}`);
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
        message: 'Failed to sync OG roles'
      };
    }
  }

  async assignOnVerification(guild, discordId, username) {
    try {
      const scope = this.getScopedConfig(guild);
      const config = scope.config;
      
      logger.debug(`[OG-Role] assignOnVerification start: ${username} (${discordId}) in guild ${guild.name} (${guild.id})`);

      if (!config.enabled || !config.roleId) {
        logger.debug(`[OG-Role] OG role not enabled for guild ${guild.id}`);
        return { success: false, message: 'OG role not enabled' };
      }

      const eligible = await this.isEligible(discordId, guild);
      if (!eligible) {
        return { success: false, message: 'User not eligible for OG role' };
      }

      const role = guild.roles.cache.get(config.roleId) || await guild.roles.fetch(config.roleId).catch(() => null);
      if (!role) {
        logger.warn(`[OG-Role] OG role ${config.roleId} not found in guild ${guild.id}`);
        return { success: false, message: 'OG role not found' };
      }

      const member = await guild.members.fetch(discordId).catch(() => null);
      if (!member) {
        logger.warn(`[OG-Role] Member ${discordId} not found in guild ${guild.id}`);
        return { success: false, message: 'Member not found in guild' };
      }

      if (member.roles.cache.has(config.roleId)) {
        logger.debug(`[OG-Role] User ${username} already has OG role ${config.roleId}`);
        return { success: true, message: 'User already has OG role', alreadyHas: true };
      }

      await member.roles.add(role);
      logger.log(`[OG-Role] ✅ Auto-assigned OG role to ${username} (${discordId}) in guild ${guild.id}`);

      return {
        success: true,
        message: 'OG role assigned',
        assigned: true
      };
    } catch (error) {
      logger.error(`[OG-Role] Error assigning OG role to ${discordId} in guild ${guild.id}:`, error);
      return {
        success: false,
        message: `Failed to assign OG role: ${error.message}`
      };
    }
  }

  async getStatus(guild) {
    try {
      const scope = this.getScopedConfig(guild);
      const config = scope.config;
      const eligible = await this.getEligibleUsers(guild);
      const currentHolders = await this.getCurrentHolders(guild, config.roleId);

      let roleName = 'Not Set';
      if (config.roleId) {
        const role = guild.roles.cache.get(config.roleId) || await guild.roles.fetch(config.roleId).catch(() => null);
        roleName = role ? role.name : `Unknown (${config.roleId})`;
      }

      return {
        enabled: config.enabled,
        roleId: config.roleId,
        roleName,
        limit: config.limit,
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
      const fallback = this.getScopedConfig(guild).config;
      return {
        enabled: fallback.enabled,
        roleId: fallback.roleId,
        roleName: 'Error',
        limit: fallback.limit,
        eligibleCount: 0,
        currentHoldersCount: 0,
        eligible: []
      };
    }
  }
}

module.exports = new OGRoleService();
