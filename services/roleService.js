const db = require('../database/db');
const walletService = require('./walletService');
const nftService = require('./nftService');
const tokenService = require('./tokenService');
const evmService = require('./evmService');
const entitlementService = require('./entitlementService');
const tenantService = require('./tenantService');
const settingsManager = require('../config/settings');
const logger = require('../utils/logger');
const { getChain, normalizeAddress } = require('../utils/chainIdentity');
let ogRoleService = null; // Lazy load to avoid circular deps

class RoleService {
  constructor() {
    this.traitRolesConfig = null;
    this.tiersConfig = null;
    this.collectionsConfig = null;
    this._roleSyncWarnCache = new Map();
    this._roleSyncWarnCooldownMs = parseInt(process.env.ROLE_SYNC_WARN_COOLDOWN_MS || '600000', 10);
    this._hasRoleVPGuildColumn = null;
  }

  normalizeGuildId(guildId) {
    return String(guildId || '').trim();
  }

  hasRoleVPGuildColumn() {
    if (this._hasRoleVPGuildColumn !== null) return this._hasRoleVPGuildColumn;
    try {
      const columns = db.prepare('PRAGMA table_info(role_vp_mappings)').all();
      this._hasRoleVPGuildColumn = columns.some(c => String(c?.name || '').toLowerCase() === 'guild_id');
    } catch (_error) {
      this._hasRoleVPGuildColumn = false;
    }
    return this._hasRoleVPGuildColumn;
  }

  logRoleSyncWarnOnce(cacheKey, message) {
    const now = Date.now();
    const lastAt = this._roleSyncWarnCache.get(cacheKey) || 0;
    if ((now - lastAt) < this._roleSyncWarnCooldownMs) {
      return;
    }
    this._roleSyncWarnCache.set(cacheKey, now);

    // Keep the cache bounded over long uptimes.
    if (this._roleSyncWarnCache.size > 5000) {
      const cutoff = now - this._roleSyncWarnCooldownMs;
      for (const [k, t] of this._roleSyncWarnCache.entries()) {
        if (t < cutoff) {
          this._roleSyncWarnCache.delete(k);
        }
      }
    }

    logger.warn(message);
  }

  isProtectedRole(role) {
    try {
      if (!role || !role.permissions) return false;
      // Never auto-manage server-admin level roles from verification sync
      return role.permissions.has('Administrator') || role.permissions.has('ManageGuild');
    } catch {
      return false;
    }
  }

  canBotManageRole(member, role) {
    try {
      if (!member || !role) return false;
      if (role.managed) return false; // integration-managed role
      if (role.id === member.guild.id) return false; // @everyone
      const me = member.guild?.members?.me;
      if (!me) return false;
      return me.roles.highest.position > role.position;
    } catch {
      return false;
    }
  }

  loadConfigs() {
    try {
      const settings = settingsManager.getSettings ? settingsManager.getSettings() : {};
      this.tiersConfig = {
        tiers: Array.isArray(settings?.tiers) ? settings.tiers : [],
        characterRoles: Array.isArray(settings?.characterRoles) ? settings.characterRoles : []
      };
      this.traitRolesConfig = require('../config/trait-roles.json');
      
      try {
        this.collectionsConfig = require('../config/collections.json');
      } catch (error) {
        logger.warn('Collections config not found, creating default');
        this.collectionsConfig = { collections: [] };
        this.saveCollectionsConfig();
      }
      
      logger.log('Role configs loaded successfully');
    } catch (error) {
      logger.error('Error loading role configs:', error);
      this.tiersConfig = { tiers: [] };
      this.traitRolesConfig = { traitRoles: [] };
      this.collectionsConfig = { collections: [] };
    }
  }

  getVerificationWalletRecords(discordId, guildId = null) {
    // Security hard-disable: only directly linked wallets may affect verification.
    // Cold/delegated wallet claims are not safe enough for V1 because users could
    // add arbitrary wallets without proving control of the cold wallet itself.
    return walletService.getLinkedWallets(discordId)
      .map(wallet => {
        const chain = getChain(wallet?.chain_id || (wallet?.chain_family === 'evm' ? '' : 'solana:mainnet'));
        // Legacy Solana rows predate chain metadata and were already verified at
        // insertion time. Keep their stored address intact for compatibility;
        // EVM rows still require strict checksum/address normalization.
        const rawAddress = String(wallet?.wallet_address || '').trim();
        const address = chain?.family === 'evm'
          ? normalizeAddress(rawAddress, chain.chainId)
          : rawAddress;
        if (!chain || !address) return null;
        return {
          address,
          chainFamily: chain.family,
          chainId: chain.chainId,
          primary: Number(wallet?.primary_wallet || 0) === 1,
        };
      })
      .filter(Boolean);
  }

  getVerificationWallets(discordId, guildId = null) {
    return this.getVerificationWalletRecords(discordId, guildId)
      .filter(wallet => wallet.chainFamily === 'solana')
      .map(wallet => wallet.address);
  }

  getRuleChain(rule = {}) {
    return getChain(rule.chainId || rule.chain_id || rule.chain || 'solana:mainnet') || getChain('solana:mainnet');
  }

  getCollectionDisplayName(guildId, chainValue, collectionId, fallback = '') {
    const normalizedGuildId = String(guildId || '').trim();
    const rawCollectionId = String(collectionId || '').trim();
    const chain = getChain(chainValue || 'solana:mainnet');
    if (!rawCollectionId) return String(fallback || 'NFT collection').trim();

    try {
      if (normalizedGuildId && chain) {
        const addressClause = chain.family === 'evm'
          ? 'LOWER(TRIM(collection_address)) = LOWER(TRIM(?))'
          : 'TRIM(collection_address) = TRIM(?)';
        const tracked = db.prepare(`
          SELECT collection_name
          FROM nft_tracked_collections
          WHERE guild_id = ? AND chain_id = ? AND ${addressClause}
          ORDER BY enabled DESC, id ASC
          LIMIT 1
        `).get(normalizedGuildId, chain.chainId, rawCollectionId);
        const trackedName = String(tracked?.collection_name || '').trim();
        if (trackedName) return trackedName;
      }

      if (chain?.family === 'solana') {
        if (!this.collectionsConfig) this.loadConfigs();
        const catalogEntry = (this.collectionsConfig?.collections || [])
          .find(collection => String(collection?.id || '').trim() === rawCollectionId);
        const catalogName = String(catalogEntry?.name || '').trim();
        if (catalogName) return catalogName;
      }
    } catch (error) {
      logger.warn(`Failed to resolve collection display name for ${rawCollectionId}: ${error?.message || error}`);
    }

    return String(fallback || '').trim() || `${rawCollectionId.slice(0, 6)}...${rawCollectionId.slice(-4)}`;
  }

  async updateUserRoles(discordId, username, guildId = null) {
    try {
      const walletRecords = this.getVerificationWalletRecords(discordId, guildId || '');
      const wallets = walletRecords.filter(wallet => wallet.chainFamily === 'solana').map(wallet => wallet.address);
      
      if (walletRecords.length === 0) {
        logger.warn(`No wallets linked for user ${discordId}`);
        return { success: false, message: 'No wallets linked' };
      }

      const nftSnapshot = wallets.length
        ? await nftService.getAllNFTsForWalletsWithHealth(wallets, { guildId })
        : { nfts: [], health: null };
      const allNFTs = Array.isArray(nftSnapshot?.nfts) ? nftSnapshot.nfts : [];
      const nftHealth = nftSnapshot?.health || null;
      if (nftHealth?.hadFailureWithoutCache) {
        logger.error(`Skipping user stats update for ${discordId}: NFT provider degraded (no safe cache)${guildId ? ` [guild ${guildId}]` : ''}`);
        return {
          success: false,
          skipped: true,
          reason: 'nft_provider_degraded',
          message: 'NFT provider degraded; skipped user stats update to prevent data corruption'
        };
      }
      const tierInfo = this.getTierForNFTs(allNFTs, guildId);
      const scopedNFTCount = tierInfo.count;
      const tier = tierInfo.tier;
      const votingPower = tier ? (tier.votingPower || 0) : 0;
      const tokenRules = guildId
        ? this.getTokenRoleRules(guildId).filter(r => r.enabled !== false)
        : [];
      let totalTrackedTokens = 0;
      if (tokenRules.length > 0) {
        const tokenBalances = await this.getTokenRuleBalances(walletRecords, tokenRules, guildId);
        const uniqueBalances = new Map();
        for (const rule of tokenRules) {
          const chain = this.getRuleChain(rule);
          const result = tokenBalances.get(rule);
          if (!result?.healthy) continue;
          uniqueBalances.set(`${chain.chainId}:${String(rule.tokenMint || '').toLowerCase()}`, Number(result.balance || 0));
        }
        totalTrackedTokens = [...uniqueBalances.values()].reduce((sum, amount) => sum + amount, 0);
      }

      db.prepare(`
        UPDATE users 
        SET total_nfts = ?, total_tokens = ?, tier = ?, voting_power = ?, username = ?, updated_at = CURRENT_TIMESTAMP
        WHERE discord_id = ?
      `).run(scopedNFTCount, totalTrackedTokens, tier ? tier.name : null, votingPower, username, discordId);

      if (guildId) {
        this.recordTenantMembership(discordId, guildId, 'verification_status');
      }

      logger.log(`Updated user ${discordId}: scopedNFTs=${scopedNFTCount} (raw=${allNFTs.length}), trackedTokens=${totalTrackedTokens.toFixed(4)}, Tier: ${tier ? tier.name : 'None'}, VP: ${votingPower}${guildId ? ` [guild ${guildId}]` : ''}`);

      return {
        success: true,
        totalNFTs: scopedNFTCount,
        totalTokens: totalTrackedTokens,
        rawNFTs: allNFTs.length,
        tier: tier ? tier.name : 'None',
        votingPower
      };
    } catch (error) {
      logger.error('Error updating user roles:', error);
      return { success: false, message: 'Failed to update roles' };
    }
  }

  async getUserInfo(discordId, guildId = null, guildMember = null) {
    try {
      const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
      if (!user) return null;
      const normalizedGuildId = this.normalizeGuildId(guildId);
      if (normalizedGuildId && guildMember) {
        user.voting_power = this.getUserVotingPower(discordId, guildMember, normalizedGuildId);
      }
      return user;
    } catch (error) {
      logger.error('Error fetching user info:', error);
      return null;
    }
  }

  // ==================== VP DECOUPLING: Role -> Voting Power Mappings ====================

  getRoleVPMappings(guildId = null, guild = null) {
    try {
      const normalizedGuildId = this.normalizeGuildId(guildId);
      const filterLegacyMappingsForGuild = (rows) => {
        if (!normalizedGuildId) return rows;
        if (!(guild && guild.roles && guild.roles.cache)) return rows;
        const roleIdsInGuild = new Set(guild.roles.cache.keys());
        return rows.filter(row => roleIdsInGuild.has(String(row.role_id || '').trim()));
      };

      if (this.hasRoleVPGuildColumn()) {
        if (normalizedGuildId) {
          const scopedRows = db.prepare('SELECT * FROM role_vp_mappings WHERE guild_id = ? ORDER BY voting_power DESC').all(normalizedGuildId);
          const legacyRows = db.prepare("SELECT * FROM role_vp_mappings WHERE COALESCE(guild_id, '') = '' ORDER BY voting_power DESC").all();
          const filteredLegacyRows = filterLegacyMappingsForGuild(legacyRows);
          if (scopedRows.length === 0) {
            return filteredLegacyRows;
          }
          const scopedRoleIds = new Set(scopedRows.map(row => String(row.role_id || '').trim()).filter(Boolean));
          const mergedRows = [...scopedRows];
          for (const row of filteredLegacyRows) {
            const roleId = String(row.role_id || '').trim();
            if (!roleId || scopedRoleIds.has(roleId)) continue;
            mergedRows.push(row);
          }
          return mergedRows;
        }
        return db.prepare("SELECT * FROM role_vp_mappings WHERE COALESCE(guild_id, '') = '' ORDER BY voting_power DESC").all();
      }
      const allRows = db.prepare('SELECT * FROM role_vp_mappings ORDER BY voting_power DESC').all();
      return filterLegacyMappingsForGuild(allRows);
    } catch (error) {
      logger.error('Error fetching role VP mappings:', error);
      return [];
    }
  }

  addRoleVPMapping(roleId, roleName, votingPower, guildId = null) {
    try {
      const normalizedGuildId = this.normalizeGuildId(guildId);
      if (this.hasRoleVPGuildColumn()) {
        if (!normalizedGuildId) {
          return { success: false, message: 'guildId is required for VP mappings' };
        }
        db.prepare(`
          INSERT OR REPLACE INTO role_vp_mappings (guild_id, role_id, role_name, voting_power)
          VALUES (?, ?, ?, ?)
        `).run(normalizedGuildId, roleId, roleName || null, votingPower);
      } else {
        db.prepare(`
          INSERT OR REPLACE INTO role_vp_mappings (role_id, role_name, voting_power)
          VALUES (?, ?, ?)
        `).run(roleId, roleName || null, votingPower);
      }
      logger.log(`Added/updated role VP mapping: ${roleName || roleId} -> ${votingPower} VP${normalizedGuildId ? ` [guild ${normalizedGuildId}]` : ''}`);
      return { success: true };
    } catch (error) {
      logger.error('Error adding role VP mapping:', error);
      return { success: false, message: 'Failed to add role VP mapping' };
    }
  }

  removeRoleVPMapping(roleId, guildId = null) {
    try {
      const normalizedGuildId = this.normalizeGuildId(guildId);
      const result = this.hasRoleVPGuildColumn()
        ? db.prepare('DELETE FROM role_vp_mappings WHERE role_id = ? AND guild_id = ?').run(roleId, normalizedGuildId)
        : db.prepare('DELETE FROM role_vp_mappings WHERE role_id = ?').run(roleId);
      if (result.changes === 0) {
        return { success: false, message: 'Mapping not found' };
      }
      logger.log(`Removed role VP mapping: ${roleId}${normalizedGuildId ? ` [guild ${normalizedGuildId}]` : ''}`);
      return { success: true };
    } catch (error) {
      logger.error('Error removing role VP mapping:', error);
      return { success: false, message: 'Failed to remove role VP mapping' };
    }
  }

  getUserVotingPower(discordId, guildMember, guildId = null) {
    try {
      const mappings = this.getRoleVPMappings(guildId, guildMember?.guild || null);

      // If no mappings configured, fall back to tier-based VP from DB
      if (mappings.length === 0) {
        const user = db.prepare('SELECT voting_power FROM users WHERE discord_id = ?').get(discordId);
        return user ? user.voting_power : 0;
      }

      if (!(guildMember && guildMember.roles && guildMember.roles.cache)) {
        const user = db.prepare('SELECT voting_power FROM users WHERE discord_id = ?').get(discordId);
        return user ? user.voting_power : 0;
      }

      // Use highest VP among all matching roles the member has
      let highestVP = 0;
      const memberRoleIds = new Set(guildMember.roles.cache.keys());
      for (const mapping of mappings) {
        if (memberRoleIds.has(mapping.role_id) && mapping.voting_power > highestVP) {
          highestVP = mapping.voting_power;
        }
      }

      return highestVP;
    } catch (error) {
      logger.error('Error computing user voting power:', error);
      return 0;
    }
  }
  /**
   * Sync all Discord roles for a user (both tier and trait roles)
   * This is the main entry point for comprehensive role sync
   */
  async syncUserDiscordRoles(guild, discordId, guildId = guild?.id || null) {
    try {
      const member = await guild.members.fetch(discordId).catch(() => null);
      if (!member) {
        logger.warn(`Member ${discordId} not found in guild ${guild?.id || guildId || 'unknown'}`);
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

      if (guildId) {
        this.recordTenantMembership(discordId, guildId, 'verification_sync');
      }

      const changes = {
        added: [],
        removed: [],
        granted: []
      };
      const currentMemberRoleIds = new Set(member.roles.cache.keys());

      const walletRecords = this.getVerificationWalletRecords(discordId, guildId || '');
      const wallets = walletRecords.filter(wallet => wallet.chainFamily === 'solana').map(wallet => wallet.address);
      const nftSnapshot = wallets.length
        ? await nftService.getAllNFTsForWalletsWithHealth(wallets, { guildId })
        : { nfts: [], health: null };
      const allNFTs = Array.isArray(nftSnapshot?.nfts) ? nftSnapshot.nfts : [];
      const nftHealth = nftSnapshot?.health || null;

      if (nftHealth?.hadFailureWithoutCache) {
        logger.error(`Aborted role sync for ${discordId}: NFT provider degraded (no safe cache)${guildId ? ` [guild ${guildId}]` : ''}`);
        return {
          success: false,
          skipped: true,
          reason: 'nft_provider_degraded',
          message: 'Role sync skipped because NFT provider data is currently unreliable'
        };
      }

      // 1. Sync collection tier roles (based on configured rules only)
      const tierChanges = await this.syncTierRoles(member, allNFTs, guildId, currentMemberRoleIds);
      changes.added.push(...tierChanges.added);
      changes.removed.push(...tierChanges.removed);
      changes.granted.push(...(tierChanges.granted || []));

      // 2. Sync EVM collection roles using verified wallets on each configured chain.
      const evmTierChanges = await this.syncEvmCollectionRoles(member, walletRecords, guildId, currentMemberRoleIds);
      changes.added.push(...evmTierChanges.added);
      changes.removed.push(...evmTierChanges.removed);
      changes.granted.push(...(evmTierChanges.granted || []));

      // 3. Sync Solana trait roles.
      const traitChanges = await this.syncTraitRoles(member, allNFTs, guildId, currentMemberRoleIds);
      changes.added.push(...traitChanges.added);
      changes.removed.push(...traitChanges.removed);
      changes.granted.push(...(traitChanges.granted || []));

      // 4. Sync SPL and ERC-20 token balance roles.
      const tokenChanges = await this.syncTokenRoles(member, walletRecords, guildId, currentMemberRoleIds);
      changes.added.push(...tokenChanges.added);
      changes.removed.push(...tokenChanges.removed);
      changes.granted.push(...(tokenChanges.granted || []));

      // 5. Sync OG role (if applicable)
      if (!ogRoleService) ogRoleService = require('./ogRoleService');
      const ogResult = await ogRoleService.assignOnVerification(guild, discordId, userInfo.username);
      if (ogResult?.assigned) {
        changes.added.push('OG Role');
      }

      // 6. Assign base verified role (unconditional for all verified users)
      const settingsManager = require('../config/settings');
      let baseVerifiedRoleId = settingsManager.getSettings().baseVerifiedRoleId;
      if (guildId && tenantService.isMultitenantEnabled()) {
        const tenantVerification = tenantService.getTenantVerificationSettings(guildId);
        if (tenantVerification?.baseVerifiedRoleId !== undefined) {
          baseVerifiedRoleId = tenantVerification.baseVerifiedRoleId || '';
        }
      }
      if (baseVerifiedRoleId) {
        try {
          if (!currentMemberRoleIds.has(baseVerifiedRoleId)) {
            const baseRole = member.guild.roles.cache.get(baseVerifiedRoleId);
            if (baseRole) {
              await member.roles.add(baseRole);
              currentMemberRoleIds.add(baseVerifiedRoleId);
              changes.added.push('Base Verified');
              logger.log(`Added base verified role to ${member.user.tag}`);
            } else {
              logger.warn(`Base verified role ${baseVerifiedRoleId} not found in guild`);
            }
          }
          const baseRole = member.guild.roles.cache.get(baseVerifiedRoleId);
          if (baseRole && currentMemberRoleIds.has(baseVerifiedRoleId)) {
            changes.granted.push({
              roleId: baseRole.id,
              roleName: baseRole.name,
              kind: 'wallet',
              assetName: 'Verified wallet',
            });
          }
        } catch (err) {
          logger.error(`Error assigning base verified role to ${discordId}:`, err);
        }
      }

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
        grantedRoles: changes.granted,
        totalAdded: changes.added.length,
        totalRemoved: changes.removed.length
      };
    } catch (error) {
      logger.error(`Error syncing Discord roles for ${discordId}:`, error);
      return { success: false, message: 'Failed to sync roles' };
    }
  }

  recordTenantMembership(discordId, guildId, source = 'verification_sync') {
    const normalizedDiscordId = String(discordId || '').trim();
    const normalizedGuildId = String(guildId || '').trim();
    if (!normalizedDiscordId || !normalizedGuildId) return;

    try {
      db.prepare(`
        INSERT INTO user_tenant_memberships (discord_id, guild_id, source, last_verified_at, created_at, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(discord_id, guild_id) DO UPDATE SET
          source = excluded.source,
          last_verified_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      `).run(normalizedDiscordId, normalizedGuildId, String(source || 'verification_sync').slice(0, 64));
    } catch (error) {
      logger.warn(`Failed to record user_tenant_membership for ${normalizedDiscordId} in guild ${normalizedGuildId}: ${error?.message || error}`);
    }
  }

  getEffectiveTiers(guildId = null) {
    try {
      // Tenant-strict mode: if guild is provided, only use that guild's saved verification tiers
      if (guildId) {
        const row = db.prepare('SELECT tiers_json FROM tenant_role_configs WHERE guild_id = ?').get(guildId);
        if (row?.tiers_json) {
          const parsed = JSON.parse(row.tiers_json);
          if (Array.isArray(parsed)) {
            return parsed;
          }
        }
        // No tenant tier config -> touch nothing for safety
        return [];
      }
    } catch (e) {
      logger.warn(`Failed to load tenant tier config for guild ${guildId}: ${e.message}`);
      if (guildId) return [];
    }

    // Global fallback only when no guild context is provided
    return (this.tiersConfig?.tiers || []);
  }

  getEffectiveTraitRoles(guildId = null) {
    try {
      // Tenant-strict mode: if guild is provided, only use that guild's saved verification trait rules
      if (guildId) {
        const row = db.prepare('SELECT traits_json FROM tenant_role_configs WHERE guild_id = ?').get(guildId);
        if (row?.traits_json) {
          const parsed = JSON.parse(row.traits_json);
          if (Array.isArray(parsed)) {
            return parsed;
          }
        }
        return [];
      }
    } catch (e) {
      logger.warn(`Failed to load tenant trait config for guild ${guildId}: ${e.message}`);
      if (guildId) return [];
    }

    return (this.traitRolesConfig?.traitRoles || []);
  }

  toBooleanFlag(value, defaultValue = false) {
    if (value === null || value === undefined) return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
      if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
    }
    return defaultValue;
  }

  isRuleNeverRemove(rule) {
    if (!rule || typeof rule !== 'object') return false;
    return this.toBooleanFlag(
      rule.neverRemove ?? rule.never_remove ?? rule.keepOnLoss ?? rule.keep_on_loss,
      false
    );
  }

  getTokenRoleRules(guildId = null) {
    try {
      if (guildId) {
        return db.prepare(`
          SELECT id, guild_id, chain_family, chain_id, token_mint, token_symbol, min_amount, max_amount, role_id, enabled, never_remove, created_at, updated_at
          FROM token_role_rules
          WHERE guild_id = ?
          ORDER BY min_amount ASC, id ASC
        `).all(guildId).map(row => ({
          id: row.id,
          guildId: row.guild_id,
          chainFamily: row.chain_family || 'solana',
          chainId: row.chain_id || 'solana:mainnet',
          tokenMint: row.token_mint,
          tokenSymbol: row.token_symbol || null,
          minAmount: Number(row.min_amount || 0),
          maxAmount: row.max_amount === null || row.max_amount === undefined ? null : Number(row.max_amount),
          roleId: row.role_id,
          enabled: Number(row.enabled || 0) === 1,
          neverRemove: this.toBooleanFlag(row.never_remove, false),
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }));
      }

      return db.prepare(`
        SELECT id, guild_id, chain_family, chain_id, token_mint, token_symbol, min_amount, max_amount, role_id, enabled, never_remove, created_at, updated_at
        FROM token_role_rules
        ORDER BY guild_id ASC, min_amount ASC, id ASC
      `).all().map(row => ({
        id: row.id,
        guildId: row.guild_id,
        chainFamily: row.chain_family || 'solana',
        chainId: row.chain_id || 'solana:mainnet',
        tokenMint: row.token_mint,
        tokenSymbol: row.token_symbol || null,
        minAmount: Number(row.min_amount || 0),
        maxAmount: row.max_amount === null || row.max_amount === undefined ? null : Number(row.max_amount),
        roleId: row.role_id,
        enabled: Number(row.enabled || 0) === 1,
        neverRemove: this.toBooleanFlag(row.never_remove, false),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
    } catch (error) {
      logger.error('Error fetching token role rules:', error);
      return [];
    }
  }

  addTokenRoleRule({ guildId, chain: chainValue = 'solana:mainnet', tokenMint, tokenSymbol = null, minAmount = 0, maxAmount = null, roleId, enabled = true, neverRemove = false }) {
    try {
      const normalizedGuild = String(guildId || '').trim();
      const chain = getChain(chainValue);
      const rawMint = String(tokenMint || '').trim();
      const normalizedMint = chain?.family === 'evm' ? normalizeAddress(rawMint, chain.chainId) : rawMint;
      const normalizedRole = String(roleId || '').trim();
      const normalizedSymbol = String(tokenSymbol || '').trim() || null;
      const normalizedNeverRemove = this.toBooleanFlag(neverRemove, false);

      if (!normalizedGuild || !chain || !normalizedMint || !normalizedRole) {
        return { success: false, message: 'guildId, a supported chain, valid tokenMint, and roleId are required' };
      }

      const min = Number(minAmount || 0);
      const max = maxAmount === null || maxAmount === undefined || maxAmount === ''
        ? null
        : Number(maxAmount);
      if (!Number.isFinite(min) || min < 0) return { success: false, message: 'minAmount must be a non-negative number' };
      if (max !== null && (!Number.isFinite(max) || max < min)) return { success: false, message: 'maxAmount must be >= minAmount' };

      const countRow = db.prepare(`
        SELECT COUNT(1) AS count
        FROM token_role_rules
        WHERE guild_id = ?
      `).get(normalizedGuild);
      const limitCheck = entitlementService.enforceLimit({
        guildId: normalizedGuild,
        moduleKey: 'verification',
        limitKey: 'max_token_rules',
        currentCount: Number(countRow?.count || 0),
        incrementBy: 1,
        itemLabel: 'token role rules',
      });
      if (!limitCheck.success) {
        return {
          success: false,
          code: 'limit_exceeded',
          message: limitCheck.message,
          limit: limitCheck.limit,
          used: limitCheck.used,
        };
      }

      const result = db.prepare(`
        INSERT INTO token_role_rules (guild_id, chain_family, chain_id, token_mint, token_symbol, min_amount, max_amount, role_id, enabled, never_remove)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(normalizedGuild, chain.family, chain.chainId, normalizedMint, normalizedSymbol, min, max, normalizedRole, enabled ? 1 : 0, normalizedNeverRemove ? 1 : 0);

      return { success: true, id: Number(result.lastInsertRowid) };
    } catch (error) {
      if (error?.message?.includes('UNIQUE constraint')) {
        return { success: false, message: 'Token rule already exists for this role in this server' };
      }
      logger.error('Error adding token role rule:', error);
      return { success: false, message: 'Failed to add token role rule' };
    }
  }

  updateTokenRoleRule(ruleId, updates = {}, guildId = null) {
    try {
      const id = Number(ruleId);
      if (!Number.isFinite(id)) return { success: false, message: 'Invalid rule id' };

      const existing = guildId
        ? db.prepare('SELECT * FROM token_role_rules WHERE id = ? AND guild_id = ?').get(id, String(guildId))
        : db.prepare('SELECT * FROM token_role_rules WHERE id = ?').get(id);
      if (!existing) return { success: false, message: 'Token rule not found' };

      const targetChain = getChain(updates.chain || updates.chainId || updates.chain_id || existing.chain_id || 'solana:mainnet');
      const rawMint = String(updates.tokenMint ?? existing.token_mint ?? '').trim();
      const targetMint = targetChain?.family === 'evm' ? normalizeAddress(rawMint, targetChain.chainId) : rawMint;
      if (!targetChain || !targetMint) return { success: false, message: 'A supported chain and valid token address are required' };

      const fieldMap = {
        tokenSymbol: 'token_symbol',
        minAmount: 'min_amount',
        maxAmount: 'max_amount',
        roleId: 'role_id',
        enabled: 'enabled',
        neverRemove: 'never_remove',
        never_remove: 'never_remove'
      };

      const setClauses = [];
      const params = [targetChain.family, targetChain.chainId, targetMint];
      setClauses.push('chain_family = ?', 'chain_id = ?', 'token_mint = ?');
      for (const [key, value] of Object.entries(updates || {})) {
        if (['chain', 'chainId', 'chain_id', 'tokenMint'].includes(key)) continue;
        const col = fieldMap[key];
        if (!col) continue;

        if (key === 'minAmount') {
          const min = Number(value);
          if (!Number.isFinite(min) || min < 0) return { success: false, message: 'minAmount must be a non-negative number' };
          setClauses.push(`${col} = ?`);
          params.push(min);
          continue;
        }
        if (key === 'maxAmount') {
          const max = value === null || value === undefined || value === '' ? null : Number(value);
          if (max !== null && !Number.isFinite(max)) return { success: false, message: 'maxAmount must be a number or null' };
          setClauses.push(`${col} = ?`);
          params.push(max);
          continue;
        }
        if (key === 'enabled') {
          setClauses.push(`${col} = ?`);
          params.push(value ? 1 : 0);
          continue;
        }
        if (key === 'neverRemove' || key === 'never_remove') {
          setClauses.push(`${col} = ?`);
          params.push(this.toBooleanFlag(value, false) ? 1 : 0);
          continue;
        }
        setClauses.push(`${col} = ?`);
        params.push(value === null ? null : String(value).trim());
      }

      if (!setClauses.length) return { success: false, message: 'No valid updates provided' };
      setClauses.push('updated_at = CURRENT_TIMESTAMP');

      if (guildId) {
        params.push(id, String(guildId));
        const info = db.prepare(`
          UPDATE token_role_rules
          SET ${setClauses.join(', ')}
          WHERE id = ? AND guild_id = ?
        `).run(...params);
        if (!info.changes) return { success: false, message: 'Token rule not found' };
        return { success: true };
      }

      params.push(id);
      const info = db.prepare(`
        UPDATE token_role_rules
        SET ${setClauses.join(', ')}
        WHERE id = ?
      `).run(...params);
      if (!info.changes) return { success: false, message: 'Token rule not found' };
      return { success: true };
    } catch (error) {
      logger.error('Error updating token role rule:', error);
      return { success: false, message: 'Failed to update token role rule' };
    }
  }

  removeTokenRoleRule(ruleId, guildId = null) {
    try {
      const id = Number(ruleId);
      if (!Number.isFinite(id)) return { success: false, message: 'Invalid rule id' };

      let result;
      if (guildId) {
        result = db.prepare('DELETE FROM token_role_rules WHERE id = ? AND guild_id = ?').run(id, String(guildId));
      } else {
        result = db.prepare('DELETE FROM token_role_rules WHERE id = ?').run(id);
      }

      if (!result.changes) return { success: false, message: 'Token rule not found' };
      return { success: true };
    } catch (error) {
      logger.error('Error removing token role rule:', error);
      return { success: false, message: 'Failed to remove token role rule' };
    }
  }

  getTierForNFTs(nfts, guildId = null) {
    const tiers = this.getEffectiveTiers(guildId);
    if (!Array.isArray(tiers) || tiers.length === 0) {
      return { tier: null, count: Array.isArray(nfts) ? nfts.length : 0 };
    }

    const allNFTs = Array.isArray(nfts) ? nfts : [];
    const countsByCollection = new Map();
    for (const nft of allNFTs) {
      const key = nft?.collectionKey || null;
      if (!key) continue;
      countsByCollection.set(key, (countsByCollection.get(key) || 0) + 1);
    }

    const sorted = [...tiers].sort((a, b) => (Number(a.minNFTs || 0) - Number(b.minNFTs || 0)));
    let matched = null;
    let matchedCount = 0;

    for (const tier of sorted) {
      const min = Number(tier.minNFTs || 0);
      const max = Number(tier.maxNFTs ?? Number.MAX_SAFE_INTEGER);
      const count = tier.collectionId
        ? (countsByCollection.get(tier.collectionId) || 0)
        : allNFTs.length;

      if (count >= min && count <= max) {
        matched = tier;
        matchedCount = count;
      }
    }

    // If no tier range matched, return highest tier for overflow if applicable
    if (!matched) {
      const last = sorted[sorted.length - 1];
      const count = last?.collectionId ? (countsByCollection.get(last.collectionId) || 0) : allNFTs.length;
      if (count >= Number(last?.minNFTs || 0)) {
        return { tier: last, count };
      }
      return { tier: null, count };
    }

    return { tier: matched, count: matchedCount };
  }

  /**
   * Sync tier roles for a member
   * Applies rules exactly as configured in Verification settings.
   */
  async syncTierRoles(member, nfts, guildId = null, currentMemberRoleIds = null) {
    const changes = { added: [], removed: [], granted: [] };

    try {
      const allTiers = this.getEffectiveTiers(guildId)
        .filter(t => t && t.roleId && this.getRuleChain(t).family === 'solana');
      const liveRoleIds = currentMemberRoleIds || new Set(member.roles.cache.keys());
      const allNFTs = Array.isArray(nfts) ? nfts : [];

      // Pre-count NFTs by collection key for fast tier evaluation
      const countsByCollection = new Map();
      for (const nft of allNFTs) {
        const key = nft?.collectionKey || null;
        if (!key) continue;
        countsByCollection.set(key, (countsByCollection.get(key) || 0) + 1);
      }

      const roleStates = new Map();

      for (const tier of allTiers) {
        const roleId = String(tier.roleId || '').trim();
        if (!roleId) continue;

        const min = Number(tier.minNFTs || 0);
        const max = Number(tier.maxNFTs ?? Number.MAX_SAFE_INTEGER);
        const count = tier.collectionId
          ? (countsByCollection.get(tier.collectionId) || 0)
          : allNFTs.length;

        const shouldHave = count >= min && count <= max;
        const existing = roleStates.get(roleId) || {
          shouldHave: false,
          neverRemove: false,
          labels: [],
          matches: []
        };
        existing.shouldHave = existing.shouldHave || shouldHave;
        existing.neverRemove = existing.neverRemove || this.isRuleNeverRemove(tier);
        if (tier.name) existing.labels.push(String(tier.name));
        if (shouldHave) {
          existing.matches.push({
            kind: 'nft',
            chainName: 'Solana',
            assetName: String(tier.collectionName || tier.collection_name || '').trim()
              || this.getCollectionDisplayName(guildId, 'solana:mainnet', tier.collectionId, tier.name),
            balance: count,
            min,
            max,
            unit: 'NFTs',
          });
        }
        roleStates.set(roleId, existing);
      }

        for (const [roleId, state] of roleStates.entries()) {
          const has = liveRoleIds.has(roleId);
          const role = member.guild.roles.cache.get(roleId);
          if (!role) continue;

        const label = state.labels[0] || role.name || roleId;

        if (state.shouldHave && !has) {
          if (!this.canBotManageRole(member, role)) {
            const key = `tier:add:unmanaged:${guildId || member.guild.id}:${member.id}:${role.id}`;
            this.logRoleSyncWarnOnce(key, `Skipped adding unmanaged tier role ${role.name} (${role.id}) for ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            } else {
              await member.roles.add(role);
              liveRoleIds.add(roleId);
              changes.added.push(label);
              logger.log(`Added tier role ${label} to ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            }
        } else if (!state.shouldHave && has) {
          if (state.neverRemove) {
            const key = `tier:remove:override:${guildId || member.guild.id}:${member.id}:${role.id}`;
            this.logRoleSyncWarnOnce(key, `Skipped removing tier role ${role.name} (${role.id}) from ${member.user.tag} due to rule override${guildId ? ` [guild ${guildId}]` : ''}`);
            continue;
          }
          if (this.isProtectedRole(role)) {
            const key = `tier:remove:protected:${guildId || member.guild.id}:${member.id}:${role.id}`;
            this.logRoleSyncWarnOnce(key, `Skipped removing protected role ${role.name} (${role.id}) from ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
          } else if (!this.canBotManageRole(member, role)) {
            const key = `tier:remove:unmanaged:${guildId || member.guild.id}:${member.id}:${role.id}`;
            this.logRoleSyncWarnOnce(key, `Skipped removing unmanaged tier role ${role.name} (${role.id}) from ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            } else {
              await member.roles.remove(role);
              liveRoleIds.delete(roleId);
              changes.removed.push(label);
              logger.log(`Removed tier role ${label} from ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            }
        }
        if (state.shouldHave && liveRoleIds.has(roleId)) {
          changes.granted.push(...(state.matches || []).map(match => ({
            ...match,
            roleId: role.id,
            roleName: role.name,
          })));
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
  async syncTraitRoles(member, nfts, guildId = null, currentMemberRoleIds = null) {
    const changes = { added: [], removed: [], granted: [] };

    try {
      const traitRoles = this.getEffectiveTraitRoles(guildId)
        .filter(rule => this.getRuleChain(rule).family === 'solana');
      const liveRoleIds = currentMemberRoleIds || new Set(member.roles.cache.keys());
      const roleStates = new Map();
      const allNFTs = Array.isArray(nfts) ? nfts : [];

      // Extract traits from user's NFTs
      for (const traitRole of traitRoles) {
        if (!traitRole.roleId) {
          // Skip if roleId not configured
          continue;
        }
        const traitType = String(traitRole.trait_type || traitRole.traitType || '').trim();
        if (!traitType) continue;

        // Filter NFTs by collection if trait rule specifies one
        let relevantNFTs = allNFTs;
        const traitCollectionId = traitRole.trait_collection_id || traitRole.collectionId || null;
        if (traitCollectionId) {
          relevantNFTs = allNFTs.filter(nft => nft.collectionKey === traitCollectionId);
        }
        const filteredTraits = this.extractTraitsFromNFTs(relevantNFTs);

        // Support multi-value traits (traitValues array) and legacy single traitValue
        const traitValues = Array.isArray(traitRole.traitValues) && traitRole.traitValues.length
          ? traitRole.traitValues
          : (traitRole.trait_values ? String(traitRole.trait_values).split(',').map(v => v.trim()).filter(Boolean)
          : [traitRole.trait_value || traitRole.traitValue].filter(Boolean));
        const shouldHave = traitValues.some(v => filteredTraits.has(`${traitType}:${v}`));
        const roleId = String(traitRole.roleId || '').trim();
        const label = `${traitType || 'Trait'}:${traitValues.join('|') || '-'}`;

        const existing = roleStates.get(roleId) || {
          shouldHave: false,
          neverRemove: false,
          labels: [],
          matches: []
        };
        existing.shouldHave = existing.shouldHave || shouldHave;
        existing.neverRemove = existing.neverRemove || this.isRuleNeverRemove(traitRole);
        existing.labels.push(label);
        if (shouldHave) {
          existing.matches.push({
            kind: 'trait',
            chainName: 'Solana',
            assetName: String(traitRole.collectionName || traitRole.collection_name || '').trim()
              || this.getCollectionDisplayName(guildId, 'solana:mainnet', traitCollectionId, 'NFT collection'),
            trait: `${traitType}: ${traitValues.join(' or ')}`,
          });
        }
        roleStates.set(roleId, existing);
      }

        for (const [roleId, state] of roleStates.entries()) {
          const has = liveRoleIds.has(roleId);
          const role = member.guild.roles.cache.get(roleId);
          if (!role) {
            logger.warn(`Trait role ${roleId} not found in guild`);
          continue;
        }
        const label = state.labels[0] || role.name || roleId;

        if (state.shouldHave && !has) {
          if (this.isProtectedRole(role)) {
            const key = `trait:add:protected:${guildId || member.guild.id}:${member.id}:${role.id}`;
            this.logRoleSyncWarnOnce(key, `Skipped adding protected role ${role.name} (${role.id}) via trait sync for ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
          } else if (!this.canBotManageRole(member, role)) {
            const key = `trait:add:unmanaged:${guildId || member.guild.id}:${member.id}:${role.id}`;
            this.logRoleSyncWarnOnce(key, `Skipped adding unmanaged trait role ${role.name} (${role.id}) for ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            } else {
              await member.roles.add(role);
              liveRoleIds.add(roleId);
              changes.added.push(label);
              logger.log(`Added trait role ${label} to ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            }
        } else if (!state.shouldHave && has) {
          if (state.neverRemove) {
            const key = `trait:remove:override:${guildId || member.guild.id}:${member.id}:${role.id}`;
            this.logRoleSyncWarnOnce(key, `Skipped removing trait role ${role.name} (${role.id}) from ${member.user.tag} due to rule override${guildId ? ` [guild ${guildId}]` : ''}`);
            continue;
          }
          if (this.isProtectedRole(role)) {
            const key = `trait:remove:protected:${guildId || member.guild.id}:${member.id}:${role.id}`;
            this.logRoleSyncWarnOnce(key, `Skipped removing protected role ${role.name} (${role.id}) via trait sync for ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
          } else if (!this.canBotManageRole(member, role)) {
            const key = `trait:remove:unmanaged:${guildId || member.guild.id}:${member.id}:${role.id}`;
            this.logRoleSyncWarnOnce(key, `Skipped removing unmanaged trait role ${role.name} (${role.id}) from ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            } else {
              await member.roles.remove(role);
              liveRoleIds.delete(roleId);
              changes.removed.push(label);
              logger.log(`Removed trait role ${label} from ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            }
        }
        if (state.shouldHave && liveRoleIds.has(roleId)) {
          changes.granted.push(...(state.matches || []).map(match => ({
            ...match,
            roleId: role.id,
            roleName: role.name,
          })));
        }
      }
    } catch (error) {
      logger.error('Error syncing trait roles:', error);
    }

    return changes;
  }

  async applyChainRoleStates(member, roleStates, liveRoleIds, changes, guildId, kind) {
    for (const [roleId, state] of roleStates.entries()) {
      const has = liveRoleIds.has(roleId);
      const role = member.guild.roles.cache.get(roleId);
      if (!role) continue;
      const label = state.labels?.[0] || role.name || roleId;

      if (state.shouldHave && !has) {
        if (this.isProtectedRole(role) || !this.canBotManageRole(member, role)) {
          const reason = this.isProtectedRole(role) ? 'protected' : 'unmanaged';
          this.logRoleSyncWarnOnce(
            `${kind}:add:${reason}:${guildId || member.guild.id}:${member.id}:${role.id}`,
            `Skipped adding ${reason} ${kind} role ${role.name} (${role.id}) for ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`
          );
          continue;
        }
        await member.roles.add(role);
        liveRoleIds.add(roleId);
        changes.added.push(label);
        logger.log(`Added ${kind} role ${label} to ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
        continue;
      }

      if (!state.shouldHave && has) {
        if (state.uncertain) {
          this.logRoleSyncWarnOnce(
            `${kind}:remove:uncertain:${guildId || member.guild.id}:${member.id}:${role.id}`,
            `Skipped removing ${kind} role ${role.name} (${role.id}) because an on-chain balance check failed${guildId ? ` [guild ${guildId}]` : ''}`
          );
          continue;
        }
        if (state.neverRemove || this.isProtectedRole(role) || !this.canBotManageRole(member, role)) continue;
        await member.roles.remove(role);
        liveRoleIds.delete(roleId);
        changes.removed.push(label);
        logger.log(`Removed ${kind} role ${label} from ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
      }
    }
  }

  async syncEvmCollectionRoles(member, walletRecords, guildId = null, currentMemberRoleIds = null) {
    const changes = { added: [], removed: [], granted: [] };
    const rules = this.getEffectiveTiers(guildId)
      .filter(rule => rule && rule.roleId && rule.collectionId && this.getRuleChain(rule).family === 'evm');
    if (!rules.length) return changes;

    const liveRoleIds = currentMemberRoleIds || new Set(member.roles.cache.keys());
    const roleStates = new Map();
    const balanceCache = new Map();

    for (const rule of rules) {
      const chain = this.getRuleChain(rule);
      const collection = normalizeAddress(rule.collectionId, chain.chainId);
      const standard = String(rule.nftStandard || rule.nft_standard || 'erc721').toLowerCase();
      const tokenId = rule.tokenId ?? rule.token_id ?? null;
      const addresses = (walletRecords || [])
        .filter(wallet => wallet.chainId === chain.chainId)
        .map(wallet => wallet.address);
      const cacheKey = `${chain.chainId}:${String(collection).toLowerCase()}:${standard}:${tokenId ?? ''}`;
      let result = balanceCache.get(cacheKey);

      if (!result) {
        if (!collection) {
          result = { healthy: false, balance: 0 };
        } else if (!addresses.length) {
          result = { healthy: true, balance: 0 };
        } else {
          const checks = await Promise.allSettled(addresses.map(address => (
            evmService.getNftBalance(address, collection, chain.chainId, { standard, tokenId })
          )));
          const failed = checks.some(check => check.status === 'rejected');
          const balance = checks
            .filter(check => check.status === 'fulfilled')
            .reduce((sum, check) => sum + Number(check.value?.balance || 0), 0);
          result = { healthy: !failed, balance };
        }
        balanceCache.set(cacheKey, result);
      }

      const min = Number(rule.minNFTs || 0);
      const max = rule.maxNFTs === null || rule.maxNFTs === undefined
        ? Number.POSITIVE_INFINITY
        : Number(rule.maxNFTs);
      const shouldHave = result.healthy && Number.isFinite(result.balance) && result.balance >= min && result.balance <= max;
      const roleId = String(rule.roleId || '').trim();
      const state = roleStates.get(roleId) || { shouldHave: false, neverRemove: false, uncertain: false, labels: [], matches: [] };
      state.shouldHave ||= shouldHave;
      state.neverRemove ||= this.isRuleNeverRemove(rule);
      state.uncertain ||= !result.healthy;
      if (shouldHave) {
        state.matches.push({
          kind: 'nft',
          chainName: chain.name,
          assetName: String(rule.collectionName || rule.collection_name || '').trim()
            || this.getCollectionDisplayName(guildId, chain.chainId, collection, rule.name || 'NFT collection'),
          balance: result.balance,
          min,
          max,
          unit: standard === 'erc1155' ? `ERC-1155 #${tokenId}` : 'NFTs',
        });
      }
      state.labels.push(`${rule.name || 'NFT holder'} · ${chain.name}`);
      roleStates.set(roleId, state);
    }

    await this.applyChainRoleStates(member, roleStates, liveRoleIds, changes, guildId, 'EVM NFT');
    for (const [roleId, state] of roleStates.entries()) {
      if (!state.shouldHave || !liveRoleIds.has(roleId)) continue;
      const role = member.guild.roles.cache.get(roleId);
      if (!role) continue;
      changes.granted.push(...(state.matches || []).map(match => ({
        ...match,
        roleId: role.id,
        roleName: role.name,
      })));
    }
    return changes;
  }

  async getTokenRuleBalances(walletRecords, tokenRules, guildId = null) {
    const results = new Map();
    const records = (Array.isArray(walletRecords) ? walletRecords : [])
      .map(wallet => typeof wallet === 'string'
        ? { address: wallet, chainFamily: 'solana', chainId: 'solana:mainnet' }
        : wallet)
      .filter(wallet => wallet?.address && wallet?.chainId);
    const solanaRules = tokenRules.filter(rule => this.getRuleChain(rule).family === 'solana');
    const solanaWallets = records.filter(wallet => wallet.chainFamily === 'solana').map(wallet => wallet.address);

    if (solanaRules.length) {
      const mints = [...new Set(solanaRules.map(rule => String(rule.tokenMint || '').trim()).filter(Boolean))];
      try {
        const balances = solanaWallets.length
          ? await tokenService.getAggregateBalancesForWallets(solanaWallets, mints, { guildId })
          : {};
        for (const rule of solanaRules) {
          results.set(rule, { healthy: true, balance: Number(balances[String(rule.tokenMint || '').trim()] || 0) });
        }
      } catch (error) {
        for (const rule of solanaRules) results.set(rule, { healthy: false, balance: 0, error });
      }
    }

    const evmCache = new Map();
    for (const rule of tokenRules.filter(item => this.getRuleChain(item).family === 'evm')) {
      const chain = this.getRuleChain(rule);
      const token = normalizeAddress(rule.tokenMint, chain.chainId);
      const addresses = records.filter(wallet => wallet.chainId === chain.chainId).map(wallet => wallet.address);
      const key = `${chain.chainId}:${String(token).toLowerCase()}`;
      let result = evmCache.get(key);
      if (!result) {
        if (!token) {
          result = { healthy: false, balance: 0 };
        } else if (!addresses.length) {
          result = { healthy: true, balance: 0 };
        } else {
          const checks = await Promise.allSettled(addresses.map(address => evmService.getTokenBalance(address, token, chain.chainId)));
          const failed = checks.some(check => check.status === 'rejected');
          const balance = checks
            .filter(check => check.status === 'fulfilled')
            .reduce((sum, check) => sum + Number(check.value?.formatted || 0), 0);
          result = { healthy: !failed, balance };
        }
        evmCache.set(key, result);
      }
      results.set(rule, result);
    }

    return results;
  }

  /**
   * Sync token roles for a member based on configured SPL or ERC-20 balances.
   */
  async syncTokenRoles(member, walletRecords, guildId = null, currentMemberRoleIds = null) {
    const changes = { added: [], removed: [], granted: [] };

    try {
      const tokenRules = this.getTokenRoleRules(guildId)
        .filter(rule => rule && rule.roleId && rule.tokenMint && rule.enabled !== false);
      if (tokenRules.length === 0) return changes;

      const liveRoleIds = currentMemberRoleIds || new Set(member.roles.cache.keys());
      const balancesByRule = await this.getTokenRuleBalances(walletRecords || [], tokenRules, guildId);
      const roleStates = new Map();

      for (const rule of tokenRules) {
        const mint = String(rule.tokenMint || '').trim();
        const balanceResult = balancesByRule.get(rule) || { healthy: false, balance: 0 };
        const balance = Number(balanceResult.balance || 0);
        const min = Number(rule.minAmount || 0);
        const max = rule.maxAmount === null || rule.maxAmount === undefined ? Number.POSITIVE_INFINITY : Number(rule.maxAmount);
        const shouldHave = balanceResult.healthy && Number.isFinite(balance) && balance >= min && balance <= max;
        const chain = this.getRuleChain(rule);

        const label = rule.tokenSymbol
          ? `${rule.tokenSymbol} · ${chain.name}`
          : `Token ${mint.slice(0, 6)}...${mint.slice(-4)} · ${chain.name}`;

        const roleId = String(rule.roleId || '').trim();
        const existing = roleStates.get(roleId) || {
          shouldHave: false,
          neverRemove: false,
          uncertain: false,
          labels: [],
          matches: []
        };
        existing.shouldHave = existing.shouldHave || shouldHave;
        existing.neverRemove = existing.neverRemove || this.isRuleNeverRemove(rule);
        existing.uncertain = existing.uncertain || !balanceResult.healthy;
        existing.labels.push(label);
        if (shouldHave) {
          existing.matches.push({
            kind: 'token',
            chainName: chain.name,
            assetName: String(rule.tokenSymbol || `Token ${mint.slice(0, 6)}...${mint.slice(-4)}`),
            balance,
            min,
            max,
            unit: rule.tokenSymbol ? String(rule.tokenSymbol) : 'tokens',
          });
        }
        roleStates.set(roleId, existing);
      }
      await this.applyChainRoleStates(member, roleStates, liveRoleIds, changes, guildId, 'token');
      for (const [roleId, state] of roleStates.entries()) {
        if (!state.shouldHave || !liveRoleIds.has(roleId)) continue;
        const role = member.guild.roles.cache.get(roleId);
        if (!role) continue;
        changes.granted.push(...(state.matches || []).map(match => ({
          ...match,
          roleId: role.id,
          roleName: role.name,
        })));
      }
    } catch (error) {
      logger.error('Error syncing token roles:', error);
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
      const scopedTiers = this.getEffectiveTiers(guild?.id) || [];
      const fallbackTiers = this.tiersConfig?.tiers || [];
      const tier = [...scopedTiers, ...fallbackTiers].find(t => t.name === tierName);
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
    return this.removeAllManagedVerificationRoles(guild, userId, guild?.id || null, { respectNeverRemove: true });
  }

  /**
   * Remove only verification-managed roles configured for the provided guild.
   * This intentionally avoids touching any roles outside configured verification rules.
   */
  async removeAllManagedVerificationRoles(guild, userId, guildId = null, options = {}) {
    try {
      if (!guild) {
        return { success: false, message: 'Guild is required' };
      }
      const member = await guild.members.fetch(userId);
      const effectiveGuildId = String(guildId || guild.id || '').trim();
      const respectNeverRemove = options.respectNeverRemove !== false;
      const managedRoles = this.getManagedVerificationRoleStates(effectiveGuildId);
      const removedRoleIds = [];
      const skippedRoleIds = [];

      for (const [roleId, state] of managedRoles.entries()) {
        if (!member.roles.cache.has(roleId)) continue;
        const role = guild.roles.cache.get(roleId);
        if (!role) continue;

        if (respectNeverRemove && state.neverRemove) {
          skippedRoleIds.push(roleId);
          continue;
        }
        if (this.isProtectedRole(role) || !this.canBotManageRole(member, role)) {
          skippedRoleIds.push(roleId);
          continue;
        }

        await member.roles.remove(role);
        removedRoleIds.push(roleId);
      }

      return {
        success: true,
        removedRoleIds,
        skippedRoleIds,
        managedRoleCount: managedRoles.size
      };
    } catch (error) {
      logger.error('Error removing tier roles:', error);
      return { success: false };
    }
  }

  getManagedVerificationRoleStates(guildId = null) {
    const states = new Map();
    const pushRule = (roleId, neverRemove = false) => {
      const normalizedRoleId = String(roleId || '').trim();
      if (!normalizedRoleId) return;
      const existing = states.get(normalizedRoleId) || { neverRemove: false };
      existing.neverRemove = existing.neverRemove || this.toBooleanFlag(neverRemove, false);
      states.set(normalizedRoleId, existing);
    };

    const tiers = this.getEffectiveTiers(guildId).filter(tier => tier && tier.roleId);
    for (const tier of tiers) {
      pushRule(tier.roleId, this.isRuleNeverRemove(tier));
    }

    const traits = this.getEffectiveTraitRoles(guildId).filter(rule => rule && rule.roleId);
    for (const trait of traits) {
      pushRule(trait.roleId, this.isRuleNeverRemove(trait));
    }

    const tokenRules = this.getTokenRoleRules(guildId)
      .filter(rule => rule && rule.roleId && rule.enabled !== false);
    for (const rule of tokenRules) {
      pushRule(rule.roleId, this.isRuleNeverRemove(rule));
    }

    return states;
  }

  /**
   * Get all verified users from database
   */
  async getAllVerifiedUsers(guild = null) {
    try {
      if (guild?.members) {
        const members = await guild.members.fetch().catch(() => guild.members.cache);
        const verifiedUsers = [];

        for (const member of members.values()) {
          const wallets = walletService.getLinkedWallets(member.id);
          if (wallets.length === 0) {
            continue;
          }

          verifiedUsers.push({
            discord_id: member.id,
            username: member.user?.username || member.displayName || member.id,
            guild_id: guild.id
          });
        }

        logger.log(`Resolved ${verifiedUsers.length} verified guild members for resync in ${guild.id}`);
        return verifiedUsers;
      }

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
      traitRoles: [],
      tokenRules: []
    };

    // Tier roles summary
    for (const tier of (this.tiersConfig.tiers || [])) {
      summary.tiers.push({
        name: tier.name,
        minNFTs: tier.minNFTs,
        maxNFTs: tier.maxNFTs,
        votingPower: tier.votingPower,
        roleId: tier.roleId,
        collectionId: tier.collectionId || null,
        chainFamily: this.getRuleChain(tier).family,
        chainId: this.getRuleChain(tier).chainId,
        nftStandard: tier.nftStandard || tier.nft_standard || (this.getRuleChain(tier).family === 'evm' ? 'erc721' : 'solana'),
        tokenId: tier.tokenId ?? tier.token_id ?? null,
        neverRemove: this.isRuleNeverRemove(tier),
        configured: !!tier.roleId
      });
    }

    // Trait roles summary
    for (const traitRole of (this.traitRolesConfig.traitRoles || [])) {
      summary.traitRoles.push({
        trait: `${traitRole.trait_type}: ${traitRole.trait_value}`,
        traitType: traitRole.trait_type,
        traitValue: traitRole.trait_value,
        roleId: traitRole.roleId,
        neverRemove: this.isRuleNeverRemove(traitRole),
        configured: !!traitRole.roleId,
        collectionId: traitRole.trait_collection_id || null,
        description: traitRole.description
      });
    }

    const tokenRules = this.getTokenRoleRules();
    for (const rule of tokenRules) {
      summary.tokenRules.push({
        id: rule.id,
        guildId: rule.guildId,
        tokenMint: rule.tokenMint,
        tokenSymbol: rule.tokenSymbol,
        chainFamily: rule.chainFamily,
        chainId: rule.chainId,
        minAmount: rule.minAmount,
        maxAmount: rule.maxAmount,
        roleId: rule.roleId,
        configured: !!rule.roleId,
        enabled: rule.enabled !== false,
        neverRemove: this.isRuleNeverRemove(rule)
      });
    }

    return summary;
  }

  /**
   * CRUD operations for tiers
   */
  
  addTier(name, minNFTs, maxNFTs, votingPower, roleId = null, collectionId = null, neverRemove = false, chainOptions = {}) {
    try {
      if (!this.tiersConfig) {
        this.loadConfigs();
      }

      // Check for duplicate name
      const existing = this.tiersConfig.tiers.find(t => t.name === name);
      if (existing) {
        return { success: false, message: `Tier "${name}" already exists` };
      }

      // Check for overlapping ranges
      const chainId = chainOptions.chainId || 'solana:mainnet';
      const overlap = this.tiersConfig.tiers.find(t => {
        if (this.getRuleChain(t).chainId !== chainId || String(t.collectionId || '') !== String(collectionId || '')) return false;
        return (minNFTs >= t.minNFTs && minNFTs <= t.maxNFTs) ||
               (maxNFTs >= t.minNFTs && maxNFTs <= t.maxNFTs) ||
               (minNFTs <= t.minNFTs && maxNFTs >= t.maxNFTs);
      });

      if (overlap) {
        return { 
          success: false, 
          message: `NFT range ${minNFTs}-${maxNFTs} overlaps with existing tier "${overlap.name}" (${overlap.minNFTs}-${overlap.maxNFTs})` 
        };
      }

      const newTier = {
        name,
        minNFTs,
        maxNFTs,
        votingPower,
        roleId,
        collectionId: collectionId || null,
        collectionName: String(chainOptions.collectionName || '').trim() || null,
        chainFamily: chainOptions.chainFamily || this.getRuleChain({ chainId }).family,
        chainId,
        nftStandard: chainOptions.nftStandard || (String(chainId).startsWith('eip155:') ? 'erc721' : 'solana'),
        tokenId: chainOptions.tokenId ?? null,
        neverRemove: this.toBooleanFlag(neverRemove, false)
      };

      this.tiersConfig.tiers.push(newTier);
      this.saveRolesConfig();
      
      logger.log(`Added tier: ${name} (${minNFTs}-${maxNFTs} NFTs, VP:${votingPower})`);
      return { success: true, tier: newTier };
    } catch (error) {
      logger.error('Error adding tier:', error);
      return { success: false, message: 'Failed to add tier' };
    }
  }

  editTier(name, updates) {
    try {
      if (!this.tiersConfig) {
        this.loadConfigs();
      }

      const tierIndex = this.tiersConfig.tiers.findIndex(t => t.name === name);
      if (tierIndex === -1) {
        return { success: false, message: `Tier "${name}" not found` };
      }

      const tier = this.tiersConfig.tiers[tierIndex];

      // Apply updates
      if (updates.minNFTs !== undefined) tier.minNFTs = updates.minNFTs;
      if (updates.maxNFTs !== undefined) tier.maxNFTs = updates.maxNFTs;
      if (updates.votingPower !== undefined) tier.votingPower = updates.votingPower;
      if (updates.roleId !== undefined) tier.roleId = updates.roleId;
      if (updates.collectionId !== undefined) tier.collectionId = updates.collectionId || null;
      if (updates.collectionName !== undefined || updates.collection_name !== undefined) {
        tier.collectionName = String(updates.collectionName ?? updates.collection_name ?? '').trim() || null;
      }
      if (updates.neverRemove !== undefined || updates.never_remove !== undefined) {
        tier.neverRemove = this.toBooleanFlag(updates.neverRemove ?? updates.never_remove, false);
      }

      // Validate updated range doesn't overlap with other tiers
      if (updates.minNFTs !== undefined || updates.maxNFTs !== undefined) {
        const overlap = this.tiersConfig.tiers.find((t, idx) => {
          if (idx === tierIndex) return false; // Skip self
          return (tier.minNFTs >= t.minNFTs && tier.minNFTs <= t.maxNFTs) ||
                 (tier.maxNFTs >= t.minNFTs && tier.maxNFTs <= t.maxNFTs) ||
                 (tier.minNFTs <= t.minNFTs && tier.maxNFTs >= t.maxNFTs);
        });

        if (overlap) {
          return { 
            success: false, 
            message: `Updated range ${tier.minNFTs}-${tier.maxNFTs} overlaps with tier "${overlap.name}" (${overlap.minNFTs}-${overlap.maxNFTs})` 
          };
        }
      }

      this.saveRolesConfig();
      
      logger.log(`Edited tier: ${name}`);
      return { success: true, tier };
    } catch (error) {
      logger.error('Error editing tier:', error);
      return { success: false, message: 'Failed to edit tier' };
    }
  }

  deleteTier(name) {
    try {
      if (!this.tiersConfig) {
        this.loadConfigs();
      }

      const tierIndex = this.tiersConfig.tiers.findIndex(t => t.name === name);
      if (tierIndex === -1) {
        return { success: false, message: `Tier "${name}" not found` };
      }

      this.tiersConfig.tiers.splice(tierIndex, 1);
      this.saveRolesConfig();
      
      logger.log(`Deleted tier: ${name}`);
      return { success: true };
    } catch (error) {
      logger.error('Error deleting tier:', error);
      return { success: false, message: 'Failed to delete tier' };
    }
  }

  /**
   * CRUD operations for trait mappings
   */
  
  addTrait(traitType, traitValue, roleId, description = null, collectionId, neverRemove = false) {
    try {
      if (!collectionId) {
        return { success: false, message: 'collectionId is required' };
      }

      if (!this.traitRolesConfig) {
        this.loadConfigs();
      }

      // Check for duplicate
      const existing = this.traitRolesConfig.traitRoles.find(
        t => t.trait_type === traitType && t.trait_value === traitValue
      );

      if (existing) {
        return {
          success: false,
          message: `Trait mapping already exists: ${traitType}: ${traitValue}`
        };
      }

      const newTrait = {
        trait_type: traitType,
        trait_value: traitValue,
        roleId,
        trait_collection_id: collectionId,
        description: description || `Members holding NFTs with ${traitType}: ${traitValue}`,
        neverRemove: this.toBooleanFlag(neverRemove, false)
      };

      this.traitRolesConfig.traitRoles.push(newTrait);
      this.saveTraitRolesConfig();

      logger.log(`Added trait mapping: ${traitType}:${traitValue} (collection: ${collectionId}) → ${roleId}`);
      return { success: true, trait: newTrait };
    } catch (error) {
      logger.error('Error adding trait:', error);
      return { success: false, message: 'Failed to add trait mapping' };
    }
  }

  editTrait(traitType, traitValue, roleId, description = null, collectionId, neverRemove = undefined) {
    try {
      if (!collectionId) {
        return { success: false, message: 'collectionId is required' };
      }

      if (!this.traitRolesConfig) {
        this.loadConfigs();
      }

      const trait = this.traitRolesConfig.traitRoles.find(
        t => t.trait_type === traitType && t.trait_value === traitValue
      );

      if (!trait) {
        return {
          success: false,
          message: `Trait mapping not found: ${traitType}: ${traitValue}`
        };
      }

      trait.roleId = roleId;
      trait.trait_collection_id = collectionId;
      if (description !== undefined) {
        trait.description = description || trait.description;
      }
      if (neverRemove !== undefined) {
        trait.neverRemove = this.toBooleanFlag(neverRemove, this.isRuleNeverRemove(trait));
      }

      this.saveTraitRolesConfig();

      logger.log(`Edited trait mapping: ${traitType}:${traitValue} (collection: ${collectionId}) → ${roleId}`);
      return { success: true, trait };
    } catch (error) {
      logger.error('Error editing trait:', error);
      return { success: false, message: 'Failed to edit trait mapping' };
    }
  }

  deleteTrait(traitType, traitValue) {
    try {
      if (!this.traitRolesConfig) {
        this.loadConfigs();
      }

      const traitIndex = this.traitRolesConfig.traitRoles.findIndex(
        t => t.trait_type === traitType && t.trait_value === traitValue
      );

      if (traitIndex === -1) {
        return { 
          success: false, 
          message: `Trait mapping not found: ${traitType}: ${traitValue}` 
        };
      }

      this.traitRolesConfig.traitRoles.splice(traitIndex, 1);
      this.saveTraitRolesConfig();
      
      logger.log(`Deleted trait mapping: ${traitType}:${traitValue}`);
      return { success: true };
    } catch (error) {
      logger.error('Error deleting trait:', error);
      return { success: false, message: 'Failed to delete trait mapping' };
    }
  }

  /**
   * Persist configs to disk
   */
  
  saveRolesConfig() {
    const settingsPayload = {};
    if (Array.isArray(this.tiersConfig?.tiers)) {
      settingsPayload.tiers = this.tiersConfig.tiers;
    }
    if (Array.isArray(this.tiersConfig?.characterRoles)) {
      settingsPayload.characterRoles = this.tiersConfig.characterRoles;
    }

    const result = settingsManager.updateSettings(settingsPayload);
    if (!result?.success) {
      throw new Error(result?.message || 'Failed to persist tier settings');
    }
    logger.log('Saved tier settings to settings.json');
  }

  saveTraitRolesConfig() {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(__dirname, '../config/trait-roles.json');
    fs.writeFileSync(configPath, JSON.stringify(this.traitRolesConfig, null, 2), 'utf8');
    logger.log('Saved trait-roles.json');
  }

  saveCollectionsConfig() {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(__dirname, '../config/collections.json');
    fs.writeFileSync(configPath, JSON.stringify(this.collectionsConfig, null, 2), 'utf8');
    logger.log('Saved collections.json');
  }

  /**
   * Collection management methods
   */

  getCollectionsSummary() {
    if (!this.collectionsConfig) {
      this.loadConfigs();
    }

    const summary = [];
    for (const collection of (this.collectionsConfig.collections || [])) {
      summary.push({
        id: collection.id,
        name: collection.name,
        roleId: collection.roleId,
        configured: !!collection.roleId,
        enabled: collection.enabled !== false,
        updateAuthority: collection.updateAuthority,
        firstVerifiedCreator: collection.firstVerifiedCreator,
        type: collection.type || 'slug',                      // Include type for display
        originalInput: collection.originalInput || collection.id  // Include original input
      });
    }

    return summary;
  }

  addCollection(id, name, roleId, updateAuthority = null, firstVerifiedCreator = null, type = 'slug', originalInput = null) {
    try {
      if (!this.collectionsConfig) {
        this.loadConfigs();
      }

      // Check for duplicate ID
      const existing = this.collectionsConfig.collections.find(c => c.id === id);
      if (existing) {
        return { success: false, message: `Collection "${id}" already exists` };
      }

      const newCollection = {
        id,
        name,
        updateAuthority,
        firstVerifiedCreator,
        roleId,
        enabled: true,
        type: type || 'slug',                    // Store type (slug or address)
        originalInput: originalInput || id,      // Store original input for reference
        description: `Members holding NFTs from ${name} collection`
      };

      this.collectionsConfig.collections.push(newCollection);
      this.saveCollectionsConfig();
      
      logger.log(`Added collection: ${name} (${id}) [type: ${type}]`);
      return { success: true, collection: newCollection };
    } catch (error) {
      logger.error('Error adding collection:', error);
      return { success: false, message: 'Failed to add collection' };
    }
  }

  editCollection(id, updates) {
    try {
      if (!this.collectionsConfig) {
        this.loadConfigs();
      }

      const collection = this.collectionsConfig.collections.find(c => c.id === id);
      if (!collection) {
        return { success: false, message: `Collection "${id}" not found` };
      }

      // Apply updates
      if (updates.name !== undefined) collection.name = updates.name;
      if (updates.roleId !== undefined) collection.roleId = updates.roleId;
      if (updates.updateAuthority !== undefined) collection.updateAuthority = updates.updateAuthority;
      if (updates.firstVerifiedCreator !== undefined) collection.firstVerifiedCreator = updates.firstVerifiedCreator;
      if (updates.enabled !== undefined) collection.enabled = updates.enabled;
      if (updates.description !== undefined) collection.description = updates.description;

      this.saveCollectionsConfig();
      
      logger.log(`Edited collection: ${id}`);
      return { success: true, collection };
    } catch (error) {
      logger.error('Error editing collection:', error);
      return { success: false, message: 'Failed to edit collection' };
    }
  }

  deleteCollection(id) {
    try {
      if (!this.collectionsConfig) {
        this.loadConfigs();
      }

      const collectionIndex = this.collectionsConfig.collections.findIndex(c => c.id === id);
      if (collectionIndex === -1) {
        return { success: false, message: `Collection "${id}" not found` };
      }

      this.collectionsConfig.collections.splice(collectionIndex, 1);
      this.saveCollectionsConfig();
      
      logger.log(`Deleted collection: ${id}`);
      return { success: true };
    } catch (error) {
      logger.error('Error deleting collection:', error);
      return { success: false, message: 'Failed to delete collection' };
    }
  }
}

module.exports = new RoleService();

