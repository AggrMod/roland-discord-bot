const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createAdminSettingsRouter({
  logger,
  adminAuthMiddleware,
  settingsManager,
  tenantService,
  fetchGuildById,
  guildIconUrl,
  ticketService,
}) {
  const router = express.Router();

  router.get('/api/admin/settings', adminAuthMiddleware, async (req, res) => {
    try {
      const settings = settingsManager.getSettings();
      const tenantContext = tenantService.getTenantContext(req.guildId);
      const multiTenantEnabled = tenantService.isMultitenantEnabled();

      const guild = req.guild || await fetchGuildById(req.guildId);
      const tenantLogoFallback = guildIconUrl(guild);

      const effectiveSettings = {
        ...settings,
        proposalsChannelId: settings.proposalsChannelId || process.env.PROPOSALS_CHANNEL_ID || '',
        votingChannelId: settings.votingChannelId || process.env.VOTING_CHANNEL_ID || '',
        resultsChannelId: settings.resultsChannelId || process.env.RESULTS_CHANNEL_ID || '',
        governanceLogChannelId: settings.governanceLogChannelId || process.env.GOVERNANCE_LOG_CHANNEL_ID || '',
        verificationReceiveWallet: settings.verificationReceiveWallet || process.env.VERIFICATION_RECEIVE_WALLET || '',
        nftActivityWebhookSecret: req.isSuperadmin
          ? (settings.nftActivityWebhookSecret || process.env.NFT_ACTIVITY_WEBHOOK_SECRET || '')
          : '',
        multiTenantEnabled,
        tenantEnabled: multiTenantEnabled && !!tenantContext.tenant,
        readOnlyManaged: multiTenantEnabled ? tenantContext.readOnlyManaged : false,
        tenantBranding: tenantContext.branding
          ? { ...tenantContext.branding, logo_url: tenantContext.branding.logo_url || tenantLogoFallback || null }
          : (tenantLogoFallback ? { logo_url: tenantLogoFallback } : null)
      };

      const ticketGuildSettings = ticketService.getGuildTicketSettings(req.guildId);
      if (ticketGuildSettings?.channelNameTemplate) {
        effectiveSettings.ticketChannelNameTemplate = ticketGuildSettings.channelNameTemplate;
      }

      if (multiTenantEnabled && tenantContext?.tenant && tenantContext.modules) {
        const minigamesEnabled = tenantContext.modules.minigames === undefined
          ? !!tenantContext.modules.battle
          : !!tenantContext.modules.minigames;
        effectiveSettings.moduleMinigamesEnabled = minigamesEnabled;
        effectiveSettings.moduleBattleEnabled = minigamesEnabled;
        effectiveSettings.moduleGovernanceEnabled = !!tenantContext.modules.governance;
        effectiveSettings.moduleVerificationEnabled = !!tenantContext.modules.verification;
        effectiveSettings.moduleMissionsEnabled = !!tenantContext.modules.heist;
        effectiveSettings.moduleTreasuryEnabled = !!tenantContext.modules.treasury;
        effectiveSettings.moduleWalletTrackerEnabled = tenantContext.modules.wallettracker === undefined
          ? !!tenantContext.modules.treasury
          : !!tenantContext.modules.wallettracker;
        effectiveSettings.moduleInviteTrackerEnabled = !!tenantContext.modules.invites;
        effectiveSettings.moduleNftTrackerEnabled = !!tenantContext.modules.nfttracker;
        effectiveSettings.moduleTokenTrackerEnabled = !!tenantContext.modules.tokentracker;
        effectiveSettings.moduleBrandingEnabled = !!tenantContext.modules.branding;
        effectiveSettings.moduleRoleClaimEnabled = !!tenantContext.modules.selfserveroles;
        effectiveSettings.moduleTicketingEnabled = !!tenantContext.modules.ticketing;
        effectiveSettings.moduleEngagementEnabled = !!tenantContext.modules.engagement;
        effectiveSettings.moduleAiAssistantEnabled = !!tenantContext.modules.aiassistant;
        const tenantVerification = tenantService.getTenantVerificationSettings(req.guildId);
        if (tenantVerification.ogRoleId !== undefined) effectiveSettings.ogRoleId = tenantVerification.ogRoleId || '';
        if (tenantVerification.ogRoleLimit !== undefined) effectiveSettings.ogRoleLimit = tenantVerification.ogRoleLimit || 0;
        if (tenantVerification.baseVerifiedRoleId !== undefined) effectiveSettings.baseVerifiedRoleId = tenantVerification.baseVerifiedRoleId || '';
        const tenantBattleSettings = tenantService.getTenantBattleSettings(req.guildId);
        if (tenantBattleSettings.battleRoundPauseMinSec !== null) effectiveSettings.battleRoundPauseMinSec = tenantBattleSettings.battleRoundPauseMinSec;
        if (tenantBattleSettings.battleRoundPauseMaxSec !== null) effectiveSettings.battleRoundPauseMaxSec = tenantBattleSettings.battleRoundPauseMaxSec;
        if (tenantBattleSettings.battleElitePrepSec !== null) effectiveSettings.battleElitePrepSec = tenantBattleSettings.battleElitePrepSec;
        if (tenantBattleSettings.battleForcedEliminationIntervalRounds !== null) effectiveSettings.battleForcedEliminationIntervalRounds = tenantBattleSettings.battleForcedEliminationIntervalRounds;
        if (tenantBattleSettings.battleDefaultEra) effectiveSettings.battleDefaultEra = tenantBattleSettings.battleDefaultEra;
        const assignedModuleKeys = Object.keys(tenantContext.modules);
        if (assignedModuleKeys.includes('battle') && !assignedModuleKeys.includes('minigames')) {
          assignedModuleKeys.push('minigames');
        }
        effectiveSettings.assignedModuleKeys = assignedModuleKeys;
      }

      if (effectiveSettings.moduleWalletTrackerEnabled === undefined) {
        effectiveSettings.moduleWalletTrackerEnabled = effectiveSettings.moduleTreasuryEnabled;
      }
      if (effectiveSettings.moduleMinigamesEnabled === undefined) {
        effectiveSettings.moduleMinigamesEnabled = effectiveSettings.moduleBattleEnabled !== undefined
          ? !!effectiveSettings.moduleBattleEnabled
          : true;
      }
      if (effectiveSettings.moduleBattleEnabled === undefined) {
        effectiveSettings.moduleBattleEnabled = !!effectiveSettings.moduleMinigamesEnabled;
      }

      if (!effectiveSettings.ogRoleId) {
        try {
          const ogRoleService = require('../../services/ogRoleService');
          const ogCfg = ogRoleService.getConfig(req.guildId || null);
          logger.log(`[OG-DEBUG] GET /api/admin/settings ogRoleService config: ${JSON.stringify(ogCfg)}`);
          if (ogCfg.roleId) {
            effectiveSettings.ogRoleId = ogCfg.roleId;
            effectiveSettings.ogRoleLimit = ogCfg.limit || 0;
          }
        } catch (e) {
          logger.warn('OG role config read warning:', e?.message || e);
        }
      }

      return res.json(toSuccessResponse({ settings: effectiveSettings }));
    } catch (routeError) {
      logger.error('Error fetching settings:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.put('/api/admin/settings', adminAuthMiddleware, (req, res) => {
    try {
      const ALLOWED_SETTINGS_FIELDS = [
        'proposalsChannelId', 'votingChannelId', 'resultsChannelId', 'governanceLogChannelId',
        'quorumPercentage', 'governanceQuorum', 'supportThreshold', 'supportWindowHours', 'voteDurationDays', 'voteDurationHours',
        'moduleGovernanceEnabled', 'moduleVerificationEnabled', 'moduleTreasuryEnabled', 'moduleWalletTrackerEnabled',
        'moduleInviteTrackerEnabled',
        'moduleNftTrackerEnabled', 'moduleTokenTrackerEnabled', 'moduleBrandingEnabled', 'moduleMissionsEnabled', 'moduleBattleEnabled', 'moduleMinigamesEnabled',
        'moduleTicketingEnabled', 'moduleRoleClaimEnabled', 'moduleEngagementEnabled', 'moduleAiAssistantEnabled',
        'battleRoundPauseMinSec', 'battleRoundPauseMaxSec', 'battleElitePrepSec', 'battleForcedEliminationIntervalRounds', 'battleDefaultEra',
        'baseVerifiedRoleId', 'autoResyncEnabled', 'ogRoleId', 'ogRoleLimit',
        'treasuryWalletAddress', 'treasuryRefreshInterval', 'txAlertChannelId',
        'txAlertEnabled', 'txAlertIncomingOnly', 'txAlertMinSol',
        'displayName', 'displayEmoji', 'displayColor',
        'verificationReceiveWallet', 'nftActivityWebhookSecret',
        'ticketAutoCloseEnabled', 'ticketAutoCloseInactiveHours', 'ticketAutoCloseWarningHours', 'ticketChannelNameTemplate',
        'chainEmojiMap',
      ];
      const sanitized = {};
      for (const key of ALLOWED_SETTINGS_FIELDS) {
        if (req.body[key] !== undefined) sanitized[key] = req.body[key];
      }
      if (sanitized.voteDurationDays === undefined && sanitized.voteDurationHours !== undefined) {
        const voteDurationHours = Number(sanitized.voteDurationHours);
        if (Number.isFinite(voteDurationHours) && voteDurationHours > 0) {
          sanitized.voteDurationDays = Math.max(1, Math.round(voteDurationHours / 24));
        }
      }
      delete sanitized.voteDurationHours;

      if (sanitized.quorumPercentage !== undefined && sanitized.governanceQuorum === undefined) {
        sanitized.governanceQuorum = sanitized.quorumPercentage;
      }
      if (sanitized.governanceQuorum !== undefined && sanitized.quorumPercentage === undefined) {
        sanitized.quorumPercentage = sanitized.governanceQuorum;
      }

      if (!req.isSuperadmin) {
        delete sanitized.moduleMicroVerifyEnabled;
        delete sanitized.verificationReceiveWallet;
        delete sanitized.nftActivityWebhookSecret;
        delete sanitized.verifyRequestTtlMinutes;
        delete sanitized.pollIntervalSeconds;
        delete sanitized.verifyRateLimitMinutes;
        delete sanitized.maxPendingPerUser;
        delete sanitized.chainEmojiMap;
      }

      const multiTenantEnabled = tenantService.isMultitenantEnabled();
      if (multiTenantEnabled && req.guildId) {
        const tenantContext = tenantService.getTenantContext(req.guildId);
        if (!tenantContext?.tenant) {
          delete sanitized.ogRoleId;
          delete sanitized.ogRoleLimit;
          delete sanitized.baseVerifiedRoleId;
          delete sanitized.battleRoundPauseMinSec;
          delete sanitized.battleRoundPauseMaxSec;
          delete sanitized.battleElitePrepSec;
          delete sanitized.battleForcedEliminationIntervalRounds;
          delete sanitized.battleDefaultEra;
        }
        if (tenantContext?.tenant) {
          const canToggleTenantModules = !!req.isSuperadmin || !tenantContext.readOnlyManaged;
          const moduleFieldMap = {
            moduleBattleEnabled: 'minigames',
            moduleMinigamesEnabled: 'minigames',
            moduleGovernanceEnabled: 'governance',
            moduleVerificationEnabled: 'verification',
            moduleMissionsEnabled: 'heist',
            moduleTreasuryEnabled: 'treasury',
            moduleWalletTrackerEnabled: 'wallettracker',
            moduleInviteTrackerEnabled: 'invites',
            moduleNftTrackerEnabled: 'nfttracker',
            moduleTokenTrackerEnabled: 'tokentracker',
            moduleBrandingEnabled: 'branding',
            moduleRoleClaimEnabled: 'selfserveroles',
            moduleTicketingEnabled: 'ticketing',
            moduleEngagementEnabled: 'engagement',
            moduleAiAssistantEnabled: 'aiassistant',
          };
          for (const [field, moduleKey] of Object.entries(moduleFieldMap)) {
            if (sanitized[field] !== undefined) {
              if (!canToggleTenantModules) {
                delete sanitized[field];
                continue;
              }
              if (tenantContext.modules) {
                const requestedEnabled = !!sanitized[field];
                if (moduleKey === 'minigames') {
                  if ('minigames' in tenantContext.modules) {
                    const updateResult = tenantService.setTenantModule(req.guildId, 'minigames', requestedEnabled, req.session?.discordUser?.id);
                    if (!updateResult.success) {
                      return res.status(400).json(toErrorResponse(updateResult.message || 'Failed to update module', 'VALIDATION_ERROR', null, updateResult));
                    }
                  }
                  if ('battle' in tenantContext.modules) {
                    const updateResult = tenantService.setTenantModule(req.guildId, 'battle', requestedEnabled, req.session?.discordUser?.id);
                    if (!updateResult.success) {
                      return res.status(400).json(toErrorResponse(updateResult.message || 'Failed to update module', 'VALIDATION_ERROR', null, updateResult));
                    }
                  }
                } else if (moduleKey in tenantContext.modules) {
                  const updateResult = tenantService.setTenantModule(req.guildId, moduleKey, requestedEnabled, req.session?.discordUser?.id);
                  if (!updateResult.success) {
                    return res.status(400).json(toErrorResponse(updateResult.message || 'Failed to update module', 'VALIDATION_ERROR', null, updateResult));
                  }
                }
              }
              delete sanitized[field];
            }
          }

          const tenantVerificationPatch = {};
          if (sanitized.ogRoleId !== undefined) tenantVerificationPatch.ogRoleId = sanitized.ogRoleId;
          if (sanitized.ogRoleLimit !== undefined) tenantVerificationPatch.ogRoleLimit = sanitized.ogRoleLimit;
          if (sanitized.baseVerifiedRoleId !== undefined) tenantVerificationPatch.baseVerifiedRoleId = sanitized.baseVerifiedRoleId;
          if (Object.keys(tenantVerificationPatch).length > 0) {
            tenantService.updateTenantVerificationSettings(req.guildId, tenantVerificationPatch, req.session?.discordUser?.id || 'unknown');
            delete sanitized.ogRoleId;
            delete sanitized.ogRoleLimit;
            delete sanitized.baseVerifiedRoleId;
          }

          const tenantBattlePatch = {};
          if (sanitized.battleRoundPauseMinSec !== undefined) tenantBattlePatch.battleRoundPauseMinSec = sanitized.battleRoundPauseMinSec;
          if (sanitized.battleRoundPauseMaxSec !== undefined) tenantBattlePatch.battleRoundPauseMaxSec = sanitized.battleRoundPauseMaxSec;
          if (sanitized.battleElitePrepSec !== undefined) tenantBattlePatch.battleElitePrepSec = sanitized.battleElitePrepSec;
          if (sanitized.battleForcedEliminationIntervalRounds !== undefined) tenantBattlePatch.battleForcedEliminationIntervalRounds = sanitized.battleForcedEliminationIntervalRounds;
          if (sanitized.battleDefaultEra !== undefined) tenantBattlePatch.battleDefaultEra = sanitized.battleDefaultEra;
          if (Object.keys(tenantBattlePatch).length > 0) {
            const battleSettingsResult = tenantService.updateTenantBattleSettings(
              req.guildId,
              tenantBattlePatch,
              req.session?.discordUser?.id || 'unknown'
            );
            if (!battleSettingsResult.success) {
              return res.status(400).json(toErrorResponse(battleSettingsResult.message || 'Failed to update battle settings', 'VALIDATION_ERROR', null, battleSettingsResult));
            }
            delete sanitized.battleRoundPauseMinSec;
            delete sanitized.battleRoundPauseMaxSec;
            delete sanitized.battleElitePrepSec;
            delete sanitized.battleForcedEliminationIntervalRounds;
            delete sanitized.battleDefaultEra;
          }

          if (Object.keys(tenantVerificationPatch).length > 0) {
            try {
              const ogRoleService = require('../../services/ogRoleService');
              if (tenantVerificationPatch.ogRoleId) {
                ogRoleService.setRole(tenantVerificationPatch.ogRoleId, req.guildId);
                ogRoleService.setEnabled(true, req.guildId);
              }
              if (tenantVerificationPatch.ogRoleLimit !== undefined && tenantVerificationPatch.ogRoleId) {
                ogRoleService.setLimit(tenantVerificationPatch.ogRoleLimit || 1, req.guildId);
              }
            } catch (e) {
              logger.warn('OG role config sync warning (tenant):', e?.message || e);
            }
          }
        }
      }

      if (sanitized.ticketChannelNameTemplate !== undefined && req.guildId) {
        const ticketSettingsResult = ticketService.updateGuildTicketSettings(req.guildId, {
          channelNameTemplate: sanitized.ticketChannelNameTemplate
        });
        if (!ticketSettingsResult.success) {
          return res.status(400).json(toErrorResponse(ticketSettingsResult.message || 'Failed to update ticketing settings', 'VALIDATION_ERROR', null, ticketSettingsResult));
        }
        delete sanitized.ticketChannelNameTemplate;
      }

      const result = settingsManager.updateSettings(sanitized);

      if (!tenantService.isMultitenantEnabled() || !req.guildId) {
        try {
          const ogRoleService = require('../../services/ogRoleService');
          const submittedOgRoleId = sanitized.ogRoleId;
          logger.log(`[OG-DEBUG] PUT /api/admin/settings ogRoleId received: "${submittedOgRoleId}" (raw body: "${req.body.ogRoleId}")`);
          if (submittedOgRoleId) {
            const setResult = ogRoleService.setRole(submittedOgRoleId);
            ogRoleService.setEnabled(true);
            logger.log(`[OG-DEBUG] ogRoleService.setRole("${submittedOgRoleId}") => ${JSON.stringify(setResult)}`);
            logger.log(`[OG-DEBUG] og-role.json after save: ${JSON.stringify(ogRoleService.getConfig())}`);
            if (sanitized.ogRoleLimit !== undefined) {
              ogRoleService.setLimit(sanitized.ogRoleLimit || 1);
            }
          } else {
            logger.log(`[OG-DEBUG] ogRoleId was empty/falsy — skipping ogRoleService update. Current config: ${JSON.stringify(ogRoleService.getConfig())}`);
          }
        } catch (e) {
          logger.warn('OG role config sync warning:', e?.message || e);
        }
      }

      if (result?.success === false) {
        return res.status(400).json(toErrorResponse(result.message || 'Failed to update settings', 'VALIDATION_ERROR', null, result));
      }
      return res.json(toSuccessResponse(result || { message: 'Settings updated' }));
    } catch (routeError) {
      logger.error('Error updating settings:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createAdminSettingsRouter;
