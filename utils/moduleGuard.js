const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { getCompatibleModuleKeys, getModuleDisplayName } = require('../config/moduleMetadata');

const TOGGLES_PATH = path.join(__dirname, '../config/module-toggles.json');
const DEFAULT_TOGGLES = Object.freeze({
  verificationEnabled: true,
  governanceEnabled: true,
  treasuryEnabled: true,
  wallettrackerEnabled: true,
  invitesEnabled: true,
  nfttrackerEnabled: true,
  tokentrackerEnabled: true,
  ticketingEnabled: true,
  engagementEnabled: true,
  aiassistantEnabled: false,
  selfserverolesEnabled: true,
  minigamesEnabled: true,
  battleEnabled: true,
  heistEnabled: false,
  vaultEnabled: false
});

class ModuleGuard {
  constructor() {
    this.toggles = this.loadToggles();
  }

  loadToggles() {
    try {
      if (!fs.existsSync(TOGGLES_PATH)) {
        fs.writeFileSync(TOGGLES_PATH, JSON.stringify(DEFAULT_TOGGLES, null, 2));
        return { ...DEFAULT_TOGGLES };
      }
      const data = fs.readFileSync(TOGGLES_PATH, 'utf8');
      const parsed = JSON.parse(data);
      return { ...DEFAULT_TOGGLES, ...(parsed || {}) };
    } catch (error) {
      logger.error('Error loading module toggles:', error);
      return { ...DEFAULT_TOGGLES };
    }
  }

  saveToggles() {
    try {
      fs.writeFileSync(TOGGLES_PATH, JSON.stringify(this.toggles, null, 2));
      logger.log('Module toggles saved');
      return true;
    } catch (error) {
      logger.error('Error saving module toggles:', error);
      return false;
    }
  }

  getModuleCompatibilityKeys(moduleName) {
    return getCompatibleModuleKeys(moduleName);
  }

  isModuleEnabled(moduleName) {
    const keys = this.getModuleCompatibilityKeys(moduleName);
    for (const moduleKey of keys) {
      if (this.toggles[`${moduleKey}Enabled`] === true) {
        return true;
      }
    }
    return false;
  }

  setModuleEnabled(moduleName, enabled) {
    const keys = this.getModuleCompatibilityKeys(moduleName);
    let updated = false;
    for (const moduleKey of keys) {
      const key = `${moduleKey}Enabled`;
      if (Object.prototype.hasOwnProperty.call(this.toggles, key)) {
        this.toggles[key] = enabled;
        updated = true;
      }
    }
    if (updated) {
      this.saveToggles();
      return true;
    }
    return false;
  }

  getAllToggles() {
    return { ...this.toggles };
  }

  /**
   * Check if module is enabled. If not, reply with friendly error.
   * Returns true if enabled, false if disabled (and sends reply).
   */
  async checkModuleEnabled(interaction, moduleName) {
    const guildId = interaction?.guildId || null;
    let enabled = this.isModuleEnabled(moduleName);
    const compatibleModuleKeys = this.getModuleCompatibilityKeys(moduleName);

    if (guildId) {
      try {
        const tenantService = require('../services/tenantService');
        if (tenantService.isMultitenantEnabled()) {
          enabled = compatibleModuleKeys.some(moduleKey => tenantService.isModuleEnabled(guildId, moduleKey));
        }
      } catch (error) {
        logger.warn(`Falling back to global module toggle for ${moduleName}: ${error.message}`);
      }
    }

    if (enabled) {
      return true;
    }

    const displayName = getModuleDisplayName(moduleName);

    const reply = {
      content: `🚫 The **${displayName}** business is closed right now. Talk to the Don if you need access.`,
      ephemeral: true
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(reply);
    } else {
      await interaction.reply(reply);
    }

    logger.log(`User ${interaction.user.tag} attempted to use disabled module: ${moduleName}`);
    return false;
  }

  /**
   * Admin check - returns true if user is admin, false otherwise (and sends reply)
   */
  async checkAdmin(interaction) {
    if (!interaction.member) {
      await interaction.reply({ 
        content: '❌ This command must be used in a server.', 
        ephemeral: true 
      });
      return false;
    }

    if (!interaction.member.permissions.has('Administrator')) {
      await interaction.reply({ 
        content: '❌ Only Family admins can use this command.', 
        ephemeral: true 
      });
      return false;
    }

    return true;
  }

  /**
   * Admin or Moderator check
   */
  async checkAdminOrModerator(interaction) {
    if (!interaction.member) {
      await interaction.reply({
        content: '❌ This command must be used in a server.',
        ephemeral: true
      });
      return false;
    }

    const perms = interaction.member.permissions;
    const allowed =
      perms.has('Administrator') ||
      perms.has('ManageGuild') ||
      perms.has('ManageMessages') ||
      perms.has('ModerateMembers') ||
      perms.has('KickMembers');

    if (!allowed) {
      await interaction.reply({
        content: '❌ Only Family admins or moderators can use this command.',
        ephemeral: true
      });
      return false;
    }

    return true;
  }
  /**
   * Plan tier check — returns true if guild is on minPlan or higher.
   * Tiers: starter(0) < growth(1) < pro(2) < enterprise(3)
   * In single-tenant mode (no multitenant), always passes.
   */
  async checkMinimumPlan(interaction, minPlan) {
    const TIER = { starter: 0, free: 0, growth: 1, pro: 2, enterprise: 3 };
    const minTier = TIER[minPlan] ?? 1;

    let planKey = 'starter';
    try {
      const tenantService = require('../services/tenantService');
      if (tenantService.isMultitenantEnabled && tenantService.isMultitenantEnabled()) {
        const guildId = interaction?.guildId;
        if (guildId) {
          const t = tenantService.getTenant ? tenantService.getTenant(guildId) : null;
          if (t && t.planKey) planKey = t.planKey;
        }
      } else {
        // Single-tenant: no plan enforcement
        return true;
      }
    } catch {
      return true; // Can't check plan → allow
    }

    const currentTier = TIER[planKey] ?? 0;
    if (currentTier >= minTier) return true;

    const planNames = {
      starter: 'Starter (Free)',
      growth: 'Growth ($19.99/server)',
      pro: 'Pro ($49.99/server)',
      enterprise: 'Enterprise (Contact Team)'
    };
    const reply = {
      content: `🔒 **${planNames[minPlan] || minPlan} plan required.**
This feature isn't available on your current plan. Upgrade at the Plans page in your GuildPilot portal.`,
      ephemeral: true,
    };
    if (interaction.deferred || interaction.replied) await interaction.editReply(reply);
    else await interaction.reply(reply);
    return false;
  }


}

// Singleton instance
const moduleGuard = new ModuleGuard();

module.exports = moduleGuard;
