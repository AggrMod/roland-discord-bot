const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const ROLES_FILE = path.join(__dirname, 'roles.json');

class SettingsManager {
  constructor() {
    this.settings = null;
    this.loadSettings();
  }

  loadSettings() {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
        this.settings = JSON.parse(data);
        logger.log('Settings loaded from settings.json');
      } else {
        // Create from defaults
        this.resetDefaults();
        logger.log('Created settings.json from defaults');
      }
    } catch (error) {
      logger.error('Error loading settings:', error);
      this.resetDefaults();
    }
  }

  getSettings() {
    return { ...this.settings };
  }

  updateSettings(newSettings) {
    try {
      // Validate settings before applying
      if (newSettings.tiers) {
        for (const tier of newSettings.tiers) {
          if (!tier.name || tier.minNFTs === undefined || tier.maxNFTs === undefined || tier.votingPower === undefined) {
            return { success: false, message: 'Invalid tier configuration' };
          }
        }
      }

      if (newSettings.quorumPercentage !== undefined) {
        const quorum = parseFloat(newSettings.quorumPercentage);
        if (isNaN(quorum) || quorum < 0 || quorum > 100) {
          return { success: false, message: 'Quorum must be between 0 and 100' };
        }
      }

      if (newSettings.supportThreshold !== undefined) {
        const threshold = parseInt(newSettings.supportThreshold);
        if (isNaN(threshold) || threshold < 1) {
          return { success: false, message: 'Support threshold must be at least 1' };
        }
      }

      if (newSettings.voteDurationDays !== undefined) {
        const days = parseInt(newSettings.voteDurationDays);
        if (isNaN(days) || days < 1) {
          return { success: false, message: 'Vote duration must be at least 1 day' };
        }
      }

      // Merge with existing settings
      this.settings = { ...this.settings, ...newSettings };
      
      // Save to file
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.settings, null, 2));
      logger.log('Settings updated and saved');

      return { success: true, message: 'Settings updated successfully' };
    } catch (error) {
      logger.error('Error updating settings:', error);
      return { success: false, message: 'Failed to update settings' };
    }
  }

  updateTier(tierName, minNFTs, maxNFTs, votingPower) {
    try {
      const tierIndex = this.settings.tiers.findIndex(t => t.name === tierName);
      
      if (tierIndex === -1) {
        return { success: false, message: 'Tier not found' };
      }

      this.settings.tiers[tierIndex] = {
        ...this.settings.tiers[tierIndex],
        minNFTs: parseInt(minNFTs),
        maxNFTs: parseInt(maxNFTs),
        votingPower: parseInt(votingPower)
      };

      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.settings, null, 2));
      logger.log(`Tier ${tierName} updated`);

      return { success: true, message: `Tier ${tierName} updated successfully` };
    } catch (error) {
      logger.error('Error updating tier:', error);
      return { success: false, message: 'Failed to update tier' };
    }
  }

  resetDefaults() {
    try {
      const rolesData = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
      
      this.settings = {
        tiers: rolesData.tiers,
        characterRoles: rolesData.characterRoles || [],
        quorumPercentage: 25,
        supportThreshold: 4,
        voteDurationDays: 7
      };

      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.settings, null, 2));
      logger.log('Settings reset to defaults');

      return { success: true, message: 'Settings reset to defaults' };
    } catch (error) {
      logger.error('Error resetting to defaults:', error);
      return { success: false, message: 'Failed to reset settings' };
    }
  }

  getTier(tierName) {
    return this.settings.tiers.find(t => t.name === tierName);
  }

  getAllTiers() {
    return [...this.settings.tiers];
  }

  getQuorumPercentage() {
    return this.settings.quorumPercentage || 25;
  }

  getSupportThreshold() {
    return this.settings.supportThreshold || 4;
  }

  getVoteDurationDays() {
    return this.settings.voteDurationDays || 7;
  }
}

module.exports = new SettingsManager();
