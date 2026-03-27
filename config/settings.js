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

      // Battle timing (seconds, admin UI)
      if (newSettings.battleRoundPauseMinSec !== undefined) {
        const sec = parseFloat(newSettings.battleRoundPauseMinSec);
        if (isNaN(sec) || sec < 0 || sec > 120) {
          return { success: false, message: 'Battle round pause min must be between 0 and 120 seconds' };
        }
      }

      if (newSettings.battleRoundPauseMaxSec !== undefined) {
        const sec = parseFloat(newSettings.battleRoundPauseMaxSec);
        if (isNaN(sec) || sec < 0 || sec > 180) {
          return { success: false, message: 'Battle round pause max must be between 0 and 180 seconds' };
        }
      }

      if (newSettings.battleRoundPauseMinSec !== undefined && newSettings.battleRoundPauseMaxSec !== undefined) {
        if (parseFloat(newSettings.battleRoundPauseMinSec) > parseFloat(newSettings.battleRoundPauseMaxSec)) {
          return { success: false, message: 'Battle round pause min cannot exceed max' };
        }
      }

      if (newSettings.battleElitePrepSec !== undefined) {
        const sec = parseFloat(newSettings.battleElitePrepSec);
        if (isNaN(sec) || sec < 0 || sec > 300) {
          return { success: false, message: 'Elite prep delay must be between 0 and 300 seconds' };
        }
      }

      // Feature flags validation
      if (newSettings.verifyRequestTtlMinutes !== undefined) {
        const mins = parseInt(newSettings.verifyRequestTtlMinutes);
        if (isNaN(mins) || mins < 1 || mins > 1440) {
          return { success: false, message: 'Verify request TTL must be between 1 and 1440 minutes' };
        }
      }

      if (newSettings.pollIntervalSeconds !== undefined) {
        const secs = parseInt(newSettings.pollIntervalSeconds);
        if (isNaN(secs) || secs < 5 || secs > 300) {
          return { success: false, message: 'Poll interval must be between 5 and 300 seconds' };
        }
      }

      if (newSettings.verifyRateLimitMinutes !== undefined) {
        const mins = parseInt(newSettings.verifyRateLimitMinutes);
        if (isNaN(mins) || mins < 1 || mins > 60) {
          return { success: false, message: 'Verify rate limit must be between 1 and 60 minutes' };
        }
      }

      if (newSettings.maxPendingPerUser !== undefined) {
        const max = parseInt(newSettings.maxPendingPerUser);
        if (isNaN(max) || max < 1 || max > 10) {
          return { success: false, message: 'Max pending per user must be between 1 and 10' };
        }
      }

      // Module toggles are booleans - validate type
      const moduleKeys = [
        'moduleBattleEnabled',
        'moduleGovernanceEnabled',
        'moduleVerificationEnabled',
        'moduleMissionsEnabled',
        'moduleTreasuryEnabled',
        'moduleRoleResyncEnabled',
        'moduleMicroVerifyEnabled'
      ];
      
      for (const key of moduleKeys) {
        if (newSettings[key] !== undefined && typeof newSettings[key] !== 'boolean') {
          return { success: false, message: `${key} must be a boolean` };
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
        // Governance
        tiers: rolesData.tiers,
        characterRoles: rolesData.characterRoles || [],
        quorumPercentage: 25,
        supportThreshold: 4,
        voteDurationDays: 7,
        
        // Battle Timing
        battleRoundPauseMinSec: 5,
        battleRoundPauseMaxSec: 10,
        battleElitePrepSec: 12,
        
        // Module Toggles (per-module control)
        moduleBattleEnabled: true,
        moduleGovernanceEnabled: true,
        moduleVerificationEnabled: true,
        moduleMissionsEnabled: true,
        moduleTreasuryEnabled: true,
        moduleNftTrackerEnabled: true,
        moduleRoleResyncEnabled: true,
        moduleMicroVerifyEnabled: false,
        
        // Micro-Transfer Verification
        verificationReceiveWallet: '',
        nftActivityWebhookSecret: '',
        verifyRequestTtlMinutes: 15,
        pollIntervalSeconds: 30,
        verifyRateLimitMinutes: 5,
        maxPendingPerUser: 1,
        
        // Base Verified Role
        baseVerifiedRoleId: '',

        // Channel Overrides
        proposalsChannelId: '',
        votingChannelId: '',
        resultsChannelId: '',
        governanceLogChannelId: ''
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

  getBattleRoundPauseMinSec() {
    return Number.isFinite(this.settings.battleRoundPauseMinSec)
      ? this.settings.battleRoundPauseMinSec
      : 5;
  }

  getBattleRoundPauseMaxSec() {
    return Number.isFinite(this.settings.battleRoundPauseMaxSec)
      ? this.settings.battleRoundPauseMaxSec
      : 10;
  }

  getBattleElitePrepSec() {
    return Number.isFinite(this.settings.battleElitePrepSec)
      ? this.settings.battleElitePrepSec
      : 12;
  }
}

module.exports = new SettingsManager();
