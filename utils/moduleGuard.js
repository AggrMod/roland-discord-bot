const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const TOGGLES_PATH = path.join(__dirname, '../config/module-toggles.json');

class ModuleGuard {
  constructor() {
    this.toggles = this.loadToggles();
  }

  loadToggles() {
    try {
      if (!fs.existsSync(TOGGLES_PATH)) {
        const defaults = {
          verificationEnabled: true,
          governanceEnabled: true,
          treasuryEnabled: true,
          battleEnabled: true,
          heistEnabled: false
        };
        fs.writeFileSync(TOGGLES_PATH, JSON.stringify(defaults, null, 2));
        return defaults;
      }
      const data = fs.readFileSync(TOGGLES_PATH, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      logger.error('Error loading module toggles:', error);
      return {
        verificationEnabled: true,
        governanceEnabled: true,
        treasuryEnabled: true,
        battleEnabled: true,
        heistEnabled: false
      };
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

  isModuleEnabled(moduleName) {
    const key = `${moduleName}Enabled`;
    return this.toggles[key] === true;
  }

  setModuleEnabled(moduleName, enabled) {
    const key = `${moduleName}Enabled`;
    if (this.toggles.hasOwnProperty(key)) {
      this.toggles[key] = enabled;
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

    if (guildId) {
      try {
        const tenantService = require('../services/tenantService');
        if (tenantService.isMultitenantEnabled()) {
          enabled = tenantService.isModuleEnabled(guildId, moduleName);
        }
      } catch (error) {
        logger.warn(`Falling back to global module toggle for ${moduleName}: ${error.message}`);
      }
    }

    if (enabled) {
      return true;
    }

    const moduleNames = {
      verification: 'Verification',
      governance: 'Governance',
      treasury: 'Treasury',
      battle: 'Battle',
      heist: 'Heist'
    };

    const displayName = moduleNames[moduleName] || moduleName;

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
}

// Singleton instance
const moduleGuard = new ModuleGuard();

module.exports = moduleGuard;
