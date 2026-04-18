const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const DEFAULT_TIERS = [
  { name: 'Associate', minNFTs: 1, maxNFTs: 2, votingPower: 1, roleId: null },
  { name: 'Soldato', minNFTs: 3, maxNFTs: 6, votingPower: 3, roleId: null },
  { name: 'Capo', minNFTs: 7, maxNFTs: 14, votingPower: 6, roleId: null },
  { name: 'Elite', minNFTs: 15, maxNFTs: 49, votingPower: 10, roleId: null },
  { name: 'Underboss', minNFTs: 50, maxNFTs: 149, votingPower: 14, roleId: null },
  { name: 'Don', minNFTs: 150, maxNFTs: 999999, votingPower: 18, roleId: null }
];

const DEFAULT_CHARACTER_ROLES = [
  'The Hitman',
  'The Accountant',
  'The Driver',
  'The Enforcer',
  'The Don',
  'The Consigliere'
];

class SettingsManager {
  constructor() {
    this.settings = null;
    this.loadSettings();
  }

  getDefaultSettings() {
    return {
      // Governance
      tiers: DEFAULT_TIERS,
      characterRoles: DEFAULT_CHARACTER_ROLES,
      quorumPercentage: 25,
      supportThreshold: 4,
      voteDurationDays: 7,
      governanceQuorum: 25,
      staffTrusteesVP: 10,
      staffTrusteeRoles: ['Enforcer', 'Caporegime', 'Consigliere', 'Underboss', 'Don'],
      proposalCategories: ['Partnership', 'Treasury Allocation', 'Rule Change', 'Community Event', 'Other'],

      // Battle Timing
      battleRoundPauseMinSec: 5,
      battleRoundPauseMaxSec: 10,
      battleElitePrepSec: 12,
      battleForcedEliminationIntervalRounds: 3,

      // Module Toggles (per-module control)
      moduleBattleEnabled: true,
      moduleMinigamesEnabled: true,
      moduleGovernanceEnabled: true,
      moduleVerificationEnabled: true,
      moduleMissionsEnabled: true,
      moduleTreasuryEnabled: true,
      moduleNftTrackerEnabled: true,
      moduleTokenTrackerEnabled: true,
      moduleBrandingEnabled: true,
      moduleRoleResyncEnabled: true,
      moduleMicroVerifyEnabled: false,
      moduleRoleClaimEnabled: true,
      moduleTicketingEnabled: true,
      moduleEngagementEnabled: true,
      moduleAiAssistantEnabled: false,

      // Ticketing automation
      ticketAutoCloseEnabled: true,
      ticketAutoCloseInactiveHours: 168,
      ticketAutoCloseWarningHours: 24,
      ticketChannelNameTemplate: '{category}-{user}-{date}',

      // Micro-Transfer Verification
      verificationReceiveWallet: '',
      nftActivityWebhookSecret: '',
      aiAssistantApiKeyEncrypted: '',
      openaiApiKeyEncrypted: '',
      geminiApiKeyEncrypted: '',
      xClientId: '',
      xClientSecretEncrypted: '',
      xBearerTokenEncrypted: '',
      xPollingEnabled: false,
      xPollingIntervalSeconds: 300,
      aiAssistantDefaultProvider: 'openai',
      aiAssistantFallbackProvider: 'gemini',
      aiAssistantDefaultModelOpenai: 'gpt-5.4',
      aiAssistantDefaultModelGemini: 'gemini-2.0-flash',
      verifyRequestTtlMinutes: 15,
      pollIntervalSeconds: 30,
      verifyRateLimitMinutes: 5,
      maxPendingPerUser: 1,

      // Base Verified Role
      baseVerifiedRoleId: '',

      // Global chain emoji map (used by NFT tracker price display)
      chainEmojiMap: {
        solana: '<:1000042064:1488241763222290564>',
        ethereum: '⟠',
        base: '🔵',
        polygon: '🟣',
        arbitrum: '🔷',
        optimism: '🔴',
        bsc: '🟡',
        avalanche: '🔺'
      },

      // Channel Overrides
      proposalsChannelId: '',
      votingChannelId: '',
      resultsChannelId: '',
      governanceLogChannelId: '',
      missionLogChannelId: ''
    };
  }

  loadSettings() {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
        this.settings = { ...this.getDefaultSettings(), ...JSON.parse(data) };
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

      if (newSettings.battleForcedEliminationIntervalRounds !== undefined) {
        const rounds = parseInt(newSettings.battleForcedEliminationIntervalRounds, 10);
        if (isNaN(rounds) || rounds < 1 || rounds > 20) {
          return { success: false, message: 'Forced elimination interval must be between 1 and 20 rounds' };
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

      if (newSettings.ticketAutoCloseEnabled !== undefined && typeof newSettings.ticketAutoCloseEnabled !== 'boolean') {
        return { success: false, message: 'ticketAutoCloseEnabled must be a boolean' };
      }

      if (newSettings.ticketAutoCloseInactiveHours !== undefined) {
        const hours = parseInt(newSettings.ticketAutoCloseInactiveHours);
        if (isNaN(hours) || hours < 1 || hours > 8760) {
          return { success: false, message: 'Auto-close inactivity must be between 1 and 8760 hours' };
        }
      }

      if (newSettings.ticketAutoCloseWarningHours !== undefined) {
        const warning = parseInt(newSettings.ticketAutoCloseWarningHours);
        if (isNaN(warning) || warning < 0 || warning > 8760) {
          return { success: false, message: 'Auto-close warning must be between 0 and 8760 hours' };
        }
      }

      if (newSettings.ticketAutoCloseInactiveHours !== undefined || newSettings.ticketAutoCloseWarningHours !== undefined) {
        const mergedInactive = newSettings.ticketAutoCloseInactiveHours !== undefined
          ? parseInt(newSettings.ticketAutoCloseInactiveHours)
          : parseInt(this.settings.ticketAutoCloseInactiveHours ?? 168);
        const mergedWarning = newSettings.ticketAutoCloseWarningHours !== undefined
          ? parseInt(newSettings.ticketAutoCloseWarningHours)
          : parseInt(this.settings.ticketAutoCloseWarningHours ?? 24);
        if (!isNaN(mergedInactive) && !isNaN(mergedWarning) && mergedWarning > mergedInactive) {
          return { success: false, message: 'Auto-close warning cannot exceed auto-close inactivity hours' };
        }
      }

      if (newSettings.ticketChannelNameTemplate !== undefined) {
        const template = String(newSettings.ticketChannelNameTemplate || '').trim();
        if (!template) {
          return { success: false, message: 'ticketChannelNameTemplate cannot be empty' };
        }
        if (template.length > 120) {
          return { success: false, message: 'ticketChannelNameTemplate cannot exceed 120 characters' };
        }
      }

      if (newSettings.chainEmojiMap !== undefined) {
        if (!newSettings.chainEmojiMap || typeof newSettings.chainEmojiMap !== 'object' || Array.isArray(newSettings.chainEmojiMap)) {
          return { success: false, message: 'chainEmojiMap must be an object' };
        }
      }

      if (newSettings.aiAssistantDefaultProvider !== undefined) {
        const provider = String(newSettings.aiAssistantDefaultProvider || '').trim().toLowerCase();
        if (!['openai', 'gemini'].includes(provider)) {
          return { success: false, message: 'aiAssistantDefaultProvider must be "openai" or "gemini"' };
        }
      }

      if (newSettings.aiAssistantFallbackProvider !== undefined) {
        const fallback = String(newSettings.aiAssistantFallbackProvider || '').trim().toLowerCase();
        if (fallback && !['openai', 'gemini'].includes(fallback)) {
          return { success: false, message: 'aiAssistantFallbackProvider must be empty, "openai", or "gemini"' };
        }
      }

      if (newSettings.aiAssistantDefaultModelOpenai !== undefined) {
        const model = String(newSettings.aiAssistantDefaultModelOpenai || '').trim();
        if (model.length > 120) {
          return { success: false, message: 'aiAssistantDefaultModelOpenai is too long' };
        }
      }

      if (newSettings.aiAssistantDefaultModelGemini !== undefined) {
        const model = String(newSettings.aiAssistantDefaultModelGemini || '').trim();
        if (model.length > 120) {
          return { success: false, message: 'aiAssistantDefaultModelGemini is too long' };
        }
      }

      if (newSettings.xClientId !== undefined) {
        const clientId = String(newSettings.xClientId || '').trim();
        if (clientId.length > 200) {
          return { success: false, message: 'xClientId is too long' };
        }
      }

      if (newSettings.xPollingEnabled !== undefined && typeof newSettings.xPollingEnabled !== 'boolean') {
        return { success: false, message: 'xPollingEnabled must be a boolean' };
      }

      if (newSettings.xPollingIntervalSeconds !== undefined) {
        const secs = parseInt(newSettings.xPollingIntervalSeconds, 10);
        if (isNaN(secs) || secs < 60 || secs > 3600) {
          return { success: false, message: 'xPollingIntervalSeconds must be between 60 and 3600 seconds' };
        }
      }

      // Module toggles are booleans - validate type
      const moduleKeys = [
        'moduleBattleEnabled',
        'moduleMinigamesEnabled',
        'moduleGovernanceEnabled',
        'moduleVerificationEnabled',
        'moduleMissionsEnabled',
        'moduleTreasuryEnabled',
        'moduleNftTrackerEnabled',
        'moduleTokenTrackerEnabled',
        'moduleBrandingEnabled',
        'moduleRoleResyncEnabled',
        'moduleMicroVerifyEnabled',
        'moduleRoleClaimEnabled',
        'moduleTicketingEnabled',
        'moduleEngagementEnabled',
        'moduleAiAssistantEnabled'
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
      this.settings = this.getDefaultSettings();

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

  getBattleForcedEliminationIntervalRounds() {
    const rounds = parseInt(this.settings.battleForcedEliminationIntervalRounds, 10);
    return Number.isFinite(rounds)
      ? rounds
      : 3;
  }
}

module.exports = new SettingsManager();
