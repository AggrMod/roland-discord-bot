const db = require('../database/db');
const walletService = require('./walletService');
const nftService = require('./nftService');
const tokenService = require('./tokenService');
const logger = require('../utils/logger');

class RoleService {
  constructor() {
    this.traitRolesConfig = null;
    this.tiersConfig = null;
    this.collectionsConfig = null;
    this._roleSyncWarnCache = new Map();
    this._roleSyncWarnCooldownMs = parseInt(process.env.ROLE_SYNC_WARN_COOLDOWN_MS || '600000', 10);
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
      this.tiersConfig = require('../config/roles.json');
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

  async updateUserRoles(discordId, username, guildId = null) {
    try {
      const wallets = walletService.getAllUserWallets(discordId);
      
      if (wallets.length === 0) {
        logger.warn(`No wallets linked for user ${discordId}`);
        return { success: false, message: 'No wallets linked' };
      }

      const allNFTs = await nftService.getAllNFTsForWallets(wallets, { guildId });
      const tierInfo = this.getTierForNFTs(allNFTs, guildId);
      const scopedNFTCount = tierInfo.count;
      const tier = tierInfo.tier;
      const votingPower = tier ? (tier.votingPower || 0) : 0;
      const tokenRules = guildId
        ? this.getTokenRoleRules(guildId).filter(r => r.enabled !== false)
        : [];
      const trackedMints = [...new Set(tokenRules.map(r => String(r.tokenMint || '').trim()).filter(Boolean))];
      let totalTrackedTokens = 0;
      if (trackedMints.length > 0) {
        const tokenTotals = await tokenService.getAggregateBalancesForWallets(wallets, trackedMints, { guildId });
        totalTrackedTokens = Object.values(tokenTotals).reduce((sum, amount) => sum + Number(amount || 0), 0);
      }

      db.prepare(`
        UPDATE users 
        SET total_nfts = ?, total_tokens = ?, tier = ?, voting_power = ?, username = ?, updated_at = CURRENT_TIMESTAMP
        WHERE discord_id = ?
      `).run(scopedNFTCount, totalTrackedTokens, tier ? tier.name : null, votingPower, username, discordId);

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

  async getUserInfo(discordId) {
    try {
      const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
      if (user) {
        // If role_vp_mappings has any rows, override voting_power from role mappings
        const mappingCount = db.prepare('SELECT COUNT(*) as cnt FROM role_vp_mappings').get().cnt;
        if (mappingCount > 0) {
          user.voting_power = user.voting_power || 0; // keep DB value as fallback context
        }
      }
      return user;
    } catch (error) {
      logger.error('Error fetching user info:', error);
      return null;
    }
  }

  // ==================== VP DECOUPLING: Role → Voting Power Mappings ====================

  getRoleVPMappings() {
    try {
      return db.prepare('SELECT * FROM role_vp_mappings ORDER BY voting_power DESC').all();
    } catch (error) {
      logger.error('Error fetching role VP mappings:', error);
      return [];
    }
  }

  addRoleVPMapping(roleId, roleName, votingPower) {
    try {
      db.prepare(`
        INSERT OR REPLACE INTO role_vp_mappings (role_id, role_name, voting_power)
        VALUES (?, ?, ?)
      `).run(roleId, roleName || null, votingPower);
      logger.log(`Added/updated role VP mapping: ${roleName || roleId} → ${votingPower} VP`);
      return { success: true };
    } catch (error) {
      logger.error('Error adding role VP mapping:', error);
      return { success: false, message: 'Failed to add role VP mapping' };
    }
  }

  removeRoleVPMapping(roleId) {
    try {
      const result = db.prepare('DELETE FROM role_vp_mappings WHERE role_id = ?').run(roleId);
      if (result.changes === 0) {
        return { success: false, message: 'Mapping not found' };
      }
      logger.log(`Removed role VP mapping: ${roleId}`);
      return { success: true };
    } catch (error) {
      logger.error('Error removing role VP mapping:', error);
      return { success: false, message: 'Failed to remove role VP mapping' };
    }
  }

  getUserVotingPower(discordId, guildMember) {
    try {
      const mappings = db.prepare('SELECT * FROM role_vp_mappings').all();

      // If no mappings configured, fall back to tier-based VP from DB
      if (mappings.length === 0) {
        const user = db.prepare('SELECT voting_power FROM users WHERE discord_id = ?').get(discordId);
        return user ? user.voting_power : 0;
      }

      // Use highest VP among all matching roles the member has
      let highestVP = 0;
      if (guildMember && guildMember.roles && guildMember.roles.cache) {
        const memberRoleIds = new Set(guildMember.roles.cache.keys());
        for (const mapping of mappings) {
          if (memberRoleIds.has(mapping.role_id) && mapping.voting_power > highestVP) {
            highestVP = mapping.voting_power;
          }
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

      const changes = {
        added: [],
        removed: []
      };

      const wallets = walletService.getAllUserWallets(discordId);
      const allNFTs = await nftService.getAllNFTsForWallets(wallets, { guildId });

      // 1. Sync collection tier roles (based on configured rules only)
      const tierChanges = await this.syncTierRoles(member, allNFTs, guildId);
      changes.added.push(...tierChanges.added);
      changes.removed.push(...tierChanges.removed);

      // 2. Sync trait roles
      const traitChanges = await this.syncTraitRoles(member, allNFTs, guildId);
      changes.added.push(...traitChanges.added);
      changes.removed.push(...traitChanges.removed);

      // 3. Sync token balance roles
      const tokenChanges = await this.syncTokenRoles(member, wallets, guildId);
      changes.added.push(...tokenChanges.added);
      changes.removed.push(...tokenChanges.removed);

      // 4. Assign base verified role (unconditional for all verified users)
      const settingsManager = require('../config/settings');
      const baseVerifiedRoleId = settingsManager.getSettings().baseVerifiedRoleId;
      if (baseVerifiedRoleId) {
        try {
          if (!member.roles.cache.has(baseVerifiedRoleId)) {
            const baseRole = member.guild.roles.cache.get(baseVerifiedRoleId);
            if (baseRole) {
              await member.roles.add(baseRole);
              changes.added.push('Base Verified');
              logger.log(`Added base verified role to ${member.user.tag}`);
            } else {
              logger.warn(`Base verified role ${baseVerifiedRoleId} not found in guild`);
            }
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
        totalAdded: changes.added.length,
        totalRemoved: changes.removed.length
      };
    } catch (error) {
      logger.error(`Error syncing Discord roles for ${discordId}:`, error);
      return { success: false, message: 'Failed to sync roles', error: error.message };
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

  getTokenRoleRules(guildId = null) {
    try {
      if (guildId) {
        return db.prepare(`
          SELECT id, guild_id, token_mint, token_symbol, min_amount, max_amount, role_id, enabled, created_at, updated_at
          FROM token_role_rules
          WHERE guild_id = ?
          ORDER BY min_amount ASC, id ASC
        `).all(guildId).map(row => ({
          id: row.id,
          guildId: row.guild_id,
          tokenMint: row.token_mint,
          tokenSymbol: row.token_symbol || null,
          minAmount: Number(row.min_amount || 0),
          maxAmount: row.max_amount === null || row.max_amount === undefined ? null : Number(row.max_amount),
          roleId: row.role_id,
          enabled: Number(row.enabled || 0) === 1,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }));
      }

      return db.prepare(`
        SELECT id, guild_id, token_mint, token_symbol, min_amount, max_amount, role_id, enabled, created_at, updated_at
        FROM token_role_rules
        ORDER BY guild_id ASC, min_amount ASC, id ASC
      `).all().map(row => ({
        id: row.id,
        guildId: row.guild_id,
        tokenMint: row.token_mint,
        tokenSymbol: row.token_symbol || null,
        minAmount: Number(row.min_amount || 0),
        maxAmount: row.max_amount === null || row.max_amount === undefined ? null : Number(row.max_amount),
        roleId: row.role_id,
        enabled: Number(row.enabled || 0) === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
    } catch (error) {
      logger.error('Error fetching token role rules:', error);
      return [];
    }
  }

  addTokenRoleRule({ guildId, tokenMint, tokenSymbol = null, minAmount = 0, maxAmount = null, roleId, enabled = true }) {
    try {
      const normalizedGuild = String(guildId || '').trim();
      const normalizedMint = String(tokenMint || '').trim();
      const normalizedRole = String(roleId || '').trim();
      const normalizedSymbol = String(tokenSymbol || '').trim() || null;

      if (!normalizedGuild || !normalizedMint || !normalizedRole) {
        return { success: false, message: 'guildId, tokenMint, and roleId are required' };
      }

      const min = Number(minAmount || 0);
      const max = maxAmount === null || maxAmount === undefined || maxAmount === ''
        ? null
        : Number(maxAmount);
      if (!Number.isFinite(min) || min < 0) return { success: false, message: 'minAmount must be a non-negative number' };
      if (max !== null && (!Number.isFinite(max) || max < min)) return { success: false, message: 'maxAmount must be >= minAmount' };

      const result = db.prepare(`
        INSERT INTO token_role_rules (guild_id, token_mint, token_symbol, min_amount, max_amount, role_id, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(normalizedGuild, normalizedMint, normalizedSymbol, min, max, normalizedRole, enabled ? 1 : 0);

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

      const fieldMap = {
        tokenMint: 'token_mint',
        tokenSymbol: 'token_symbol',
        minAmount: 'min_amount',
        maxAmount: 'max_amount',
        roleId: 'role_id',
        enabled: 'enabled'
      };

      const setClauses = [];
      const params = [];
      for (const [key, value] of Object.entries(updates || {})) {
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
  async syncTierRoles(member, nfts, guildId = null) {
    const changes = { added: [], removed: [] };

    try {
      const allTiers = this.getEffectiveTiers(guildId).filter(t => t && t.roleId);
      const currentMemberRoleIds = new Set(member.roles.cache.keys());
      const allNFTs = Array.isArray(nfts) ? nfts : [];

      // Pre-count NFTs by collection key for fast tier evaluation
      const countsByCollection = new Map();
      for (const nft of allNFTs) {
        const key = nft?.collectionKey || null;
        if (!key) continue;
        countsByCollection.set(key, (countsByCollection.get(key) || 0) + 1);
      }

      for (const tier of allTiers) {
        const min = Number(tier.minNFTs || 0);
        const max = Number(tier.maxNFTs ?? Number.MAX_SAFE_INTEGER);
        const count = tier.collectionId
          ? (countsByCollection.get(tier.collectionId) || 0)
          : allNFTs.length;

        const shouldHave = count >= min && count <= max;
        const has = currentMemberRoleIds.has(tier.roleId);

        if (shouldHave && !has) {
          const role = member.guild.roles.cache.get(tier.roleId);
          if (role) {
            if (!this.canBotManageRole(member, role)) {
              const key = `tier:add:unmanaged:${guildId || member.guild.id}:${member.id}:${role.id}`;
              this.logRoleSyncWarnOnce(key, `Skipped adding unmanaged tier role ${role.name} (${role.id}) for ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            } else {
              await member.roles.add(role);
              changes.added.push(tier.name);
              logger.log(`Added tier role ${tier.name} to ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            }
          }
        } else if (!shouldHave && has) {
          const role = member.guild.roles.cache.get(tier.roleId);
          if (role) {
            if (this.isProtectedRole(role)) {
              const key = `tier:remove:protected:${guildId || member.guild.id}:${member.id}:${role.id}`;
              this.logRoleSyncWarnOnce(key, `Skipped removing protected role ${role.name} (${role.id}) from ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            } else if (!this.canBotManageRole(member, role)) {
              const key = `tier:remove:unmanaged:${guildId || member.guild.id}:${member.id}:${role.id}`;
              this.logRoleSyncWarnOnce(key, `Skipped removing unmanaged tier role ${role.name} (${role.id}) from ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            } else {
              await member.roles.remove(role);
              changes.removed.push(tier.name);
              logger.log(`Removed tier role ${tier.name} from ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            }
          }
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
  async syncTraitRoles(member, nfts, guildId = null) {
    const changes = { added: [], removed: [] };

    try {
      const traitRoles = this.getEffectiveTraitRoles(guildId);
      const currentMemberRoleIds = new Set(member.roles.cache.keys());

      // Extract traits from user's NFTs
      for (const traitRole of traitRoles) {
        if (!traitRole.roleId) {
          // Skip if roleId not configured
          continue;
        }

        // Filter NFTs by collection if trait rule specifies one
        let relevantNFTs = nfts;
        if (traitRole.trait_collection_id) {
          relevantNFTs = nfts.filter(nft => nft.collectionKey === traitRole.trait_collection_id);
        }
        const filteredTraits = this.extractTraitsFromNFTs(relevantNFTs);

        // Support multi-value traits (traitValues array) and legacy single traitValue
        const traitValues = Array.isArray(traitRole.traitValues) && traitRole.traitValues.length
          ? traitRole.traitValues
          : (traitRole.trait_values ? String(traitRole.trait_values).split(',').map(v => v.trim()).filter(Boolean)
          : [traitRole.trait_value].filter(Boolean));
        const shouldHave = traitValues.some(v => filteredTraits.has(`${traitRole.trait_type}:${v}`));
        const has = currentMemberRoleIds.has(traitRole.roleId);

        if (shouldHave && !has) {
          // Add trait role
          const role = member.guild.roles.cache.get(traitRole.roleId);
          if (role) {
            if (this.isProtectedRole(role)) {
              const key = `trait:add:protected:${guildId || member.guild.id}:${member.id}:${role.id}`;
              this.logRoleSyncWarnOnce(key, `Skipped adding protected role ${role.name} (${role.id}) via trait sync for ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            } else if (!this.canBotManageRole(member, role)) {
              const key = `trait:add:unmanaged:${guildId || member.guild.id}:${member.id}:${role.id}`;
              this.logRoleSyncWarnOnce(key, `Skipped adding unmanaged trait role ${role.name} (${role.id}) for ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            } else {
              await member.roles.add(role);
              changes.added.push(`${traitRole.trait_value}`);
              logger.log(`Added trait role ${traitRole.trait_value} to ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            }
          } else {
            logger.warn(`Trait role ${traitRole.roleId} not found in guild`);
          }
        } else if (!shouldHave && has) {
          // Remove trait role
          const role = member.guild.roles.cache.get(traitRole.roleId);
          if (role) {
            if (this.isProtectedRole(role)) {
              const key = `trait:remove:protected:${guildId || member.guild.id}:${member.id}:${role.id}`;
              this.logRoleSyncWarnOnce(key, `Skipped removing protected role ${role.name} (${role.id}) via trait sync for ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            } else if (!this.canBotManageRole(member, role)) {
              const key = `trait:remove:unmanaged:${guildId || member.guild.id}:${member.id}:${role.id}`;
              this.logRoleSyncWarnOnce(key, `Skipped removing unmanaged trait role ${role.name} (${role.id}) from ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            } else {
              await member.roles.remove(role);
              changes.removed.push(`${traitRole.trait_value}`);
              logger.log(`Removed trait role ${traitRole.trait_value} from ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            }
          }
        }
      }
    } catch (error) {
      logger.error('Error syncing trait roles:', error);
    }

    return changes;
  }

  /**
   * Sync token roles for a member based on configured SPL token balance rules
   */
  async syncTokenRoles(member, wallets, guildId = null) {
    const changes = { added: [], removed: [] };

    try {
      const tokenRules = this.getTokenRoleRules(guildId)
        .filter(rule => rule && rule.roleId && rule.tokenMint && rule.enabled !== false);
      if (tokenRules.length === 0) return changes;

      const currentMemberRoleIds = new Set(member.roles.cache.keys());
      const trackedMints = [...new Set(tokenRules.map(rule => String(rule.tokenMint || '').trim()).filter(Boolean))];
      const balancesByMint = await tokenService.getAggregateBalancesForWallets(wallets || [], trackedMints, { guildId });

      for (const rule of tokenRules) {
        const mint = String(rule.tokenMint || '').trim();
        const balance = Number(balancesByMint[mint] || 0);
        const min = Number(rule.minAmount || 0);
        const max = rule.maxAmount === null || rule.maxAmount === undefined ? Number.POSITIVE_INFINITY : Number(rule.maxAmount);
        const shouldHave = Number.isFinite(balance) && balance >= min && balance <= max;
        const has = currentMemberRoleIds.has(rule.roleId);

        const label = rule.tokenSymbol
          ? `${rule.tokenSymbol} (${mint.slice(0, 6)}...${mint.slice(-4)})`
          : `Token ${mint.slice(0, 6)}...${mint.slice(-4)}`;

        if (shouldHave && !has) {
          const role = member.guild.roles.cache.get(rule.roleId);
          if (role) {
            if (this.isProtectedRole(role)) {
              const key = `token:add:protected:${guildId || member.guild.id}:${member.id}:${role.id}`;
              this.logRoleSyncWarnOnce(key, `Skipped adding protected token role ${role.name} (${role.id}) for ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            } else if (!this.canBotManageRole(member, role)) {
              const key = `token:add:unmanaged:${guildId || member.guild.id}:${member.id}:${role.id}`;
              this.logRoleSyncWarnOnce(key, `Skipped adding unmanaged token role ${role.name} (${role.id}) for ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            } else {
              await member.roles.add(role);
              changes.added.push(label);
              logger.log(`Added token role ${label} to ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            }
          }
        } else if (!shouldHave && has) {
          const role = member.guild.roles.cache.get(rule.roleId);
          if (role) {
            if (this.isProtectedRole(role)) {
              const key = `token:remove:protected:${guildId || member.guild.id}:${member.id}:${role.id}`;
              this.logRoleSyncWarnOnce(key, `Skipped removing protected token role ${role.name} (${role.id}) from ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            } else if (!this.canBotManageRole(member, role)) {
              const key = `token:remove:unmanaged:${guildId || member.guild.id}:${member.id}:${role.id}`;
              this.logRoleSyncWarnOnce(key, `Skipped removing unmanaged token role ${role.name} (${role.id}) from ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            } else {
              await member.roles.remove(role);
              changes.removed.push(label);
              logger.log(`Removed token role ${label} from ${member.user.tag}${guildId ? ` [guild ${guildId}]` : ''}`);
            }
          }
        }
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
      const rolesConfig = require('../config/roles.json');
      
      const tier = rolesConfig.tiers.find(t => t.name === tierName);
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
    try {
      const member = await guild.members.fetch(userId);
      const rolesConfig = require('../config/roles.json');
      
      for (const tier of rolesConfig.tiers) {
        if (tier.roleId) {
          const role = guild.roles.cache.get(tier.roleId);
          if (role && member.roles.cache.has(tier.roleId)) {
            await member.roles.remove(role);
          }
        }
      }
      
      return { success: true };
    } catch (error) {
      logger.error('Error removing tier roles:', error);
      return { success: false };
    }
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
        minAmount: rule.minAmount,
        maxAmount: rule.maxAmount,
        roleId: rule.roleId,
        configured: !!rule.roleId,
        enabled: rule.enabled !== false
      });
    }

    return summary;
  }

  /**
   * CRUD operations for tiers
   */
  
  addTier(name, minNFTs, maxNFTs, votingPower, roleId = null, collectionId = null) {
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
      const overlap = this.tiersConfig.tiers.find(t => {
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
        collectionId: collectionId || null
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
  
  addTrait(traitType, traitValue, roleId, description = null, collectionId) {
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
        description: description || `Members holding NFTs with ${traitType}: ${traitValue}`
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

  editTrait(traitType, traitValue, roleId, description = null, collectionId) {
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
      if (description) {
        trait.description = description;
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
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(__dirname, '../config/roles.json');
    fs.writeFileSync(configPath, JSON.stringify(this.tiersConfig, null, 2), 'utf8');
    logger.log('Saved roles.json');
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
