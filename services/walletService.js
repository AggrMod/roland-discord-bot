const db = require('../database/db');
const logger = require('../utils/logger');
const clientProvider = require('../utils/clientProvider');

class WalletService {
  normalizeWallet(value) {
    return String(value || '').trim().toLowerCase();
  }

  normalizeGuild(value) {
    return String(value || '').trim();
  }

  triggerVaultBackfill(discordId, guildId, walletAddress) {
    try {
      const normalizedGuildId = String(guildId || '').trim();
      const normalizedDiscordId = String(discordId || '').trim();
      const normalizedWallet = String(walletAddress || '').trim();
      if (!normalizedGuildId || !normalizedDiscordId || !normalizedWallet) return;
      const vaultService = require('./vaultService');
      if (vaultService && typeof vaultService.onWalletLinked === 'function') {
        vaultService.onWalletLinked(normalizedGuildId, normalizedDiscordId, normalizedWallet);
      }
    } catch (error) {
      logger.warn('[vault] wallet backfill trigger warning:', error?.message || error);
    }
  }

  linkWallet(discordId, username, walletAddress, guildId = '') {
    try {
      // Wrap existence check + INSERT in a transaction to prevent race conditions
      const linkTransaction = db.transaction(() => {
        let user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);

        if (!user) {
          db.prepare('INSERT INTO users (discord_id, username) VALUES (?, ?)').run(discordId, username);
        }

        const existingWallet = db.prepare('SELECT * FROM wallets WHERE wallet_address = ?').get(walletAddress);

        if (existingWallet) {
          if (existingWallet.discord_id === discordId) {
            return { success: true, message: 'Wallet already linked to your account', isFirstWallet: false };
          }
          return { success: false, message: 'This wallet is already linked to another account' };
        }

        const walletCount = db.prepare('SELECT COUNT(*) as count FROM wallets WHERE discord_id = ?').get(discordId).count;
        const isPrimary = walletCount === 0 ? 1 : 0;
        const isFirstWallet = walletCount === 0;

        db.prepare('INSERT INTO wallets (discord_id, wallet_address, primary_wallet, is_favorite) VALUES (?, ?, ?, ?)')
          .run(discordId, walletAddress, isPrimary, isPrimary);

        return { success: true, message: 'Wallet linked successfully', isFirstWallet };
      });

      const result = linkTransaction();

      if (result.success && result.isFirstWallet) {
        logger.log(`Wallet ${walletAddress} linked to user ${discordId}`);
        this.triggerOGRoleAssignment(discordId, username, guildId);
        this.triggerVaultBackfill(discordId, guildId, walletAddress);
      } else if (result.success) {
        logger.log(`Wallet ${walletAddress} linked to user ${discordId}`);
        this.triggerVaultBackfill(discordId, guildId, walletAddress);
      }

      return result;
    } catch (error) {
      logger.error('Error linking wallet:', error);
      return { success: false, message: 'Failed to link wallet' };
    }
  }

  async triggerOGRoleAssignment(discordId, username, guildIdHint = '') {
    try {
      logger.log(`[OG-Role] Triggering assignment for ${username} (${discordId}), hint: ${guildIdHint}`);
      // Defer OG role assignment to avoid blocking verification
      setImmediate(async () => {
        try {
          const ogRoleService = require('./ogRoleService');
          const client = clientProvider.getClient();
          
          if (!client) {
            logger.warn(`[OG-Role] Discord client not available for user ${discordId}`);
            return;
          }

          const hintedGuildId = String(guildIdHint || '').trim();
          const candidateGuildIds = hintedGuildId
            ? [hintedGuildId]
            : Array.from(client.guilds.cache.keys());

          logger.log(`[OG-Role] Attempting assignment in ${candidateGuildIds.length} candidate guild(s) for ${discordId}`);

          let attempted = 0;
          let assigned = 0;

          for (const guildId of candidateGuildIds) {
            const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
            if (!guild) {
              logger.debug(`[OG-Role] Guild ${guildId} not found for ${discordId}`);
              continue;
            }

            // Only attempt where the user is actually in this guild.
            const member = guild.members.cache.get(discordId) || await guild.members.fetch(discordId).catch(() => null);
            if (!member) {
              logger.debug(`[OG-Role] Member ${discordId} not found in guild ${guild.name} (${guild.id})`);
              continue;
            }

            attempted += 1;
            logger.log(`[OG-Role] Checking eligibility for ${username} (${discordId}) in guild ${guild.name} (${guild.id})`);
            const result = await ogRoleService.assignOnVerification(guild, discordId, username);
            if (result?.assigned) {
              assigned += 1;
              logger.log(`[OG-Role] ✨ OG role auto-assigned to ${username} (${discordId}) in guild ${guild.id}`);
            } else {
              logger.log(`[OG-Role] Result for ${username} in ${guild.name}: ${result?.message || 'No assignment'}`);
            }
          }

          if (attempted === 0) {
            logger.debug(`OG role assignment skipped: member ${discordId} not found in candidate guilds`);
          } else if (assigned === 0) {
            logger.debug(`OG role assignment attempted for ${discordId} in ${attempted} guild(s), no assignment applied`);
          }
        } catch (error) {
          logger.error('Error in OG role auto-assignment:', error);
        }
      });
    } catch (error) {
      logger.error('Error triggering OG role assignment:', error);
    }
  }

  getLinkedWallets(discordId) {
    try {
      const wallets = db.prepare('SELECT wallet_address, primary_wallet FROM wallets WHERE discord_id = ? ORDER BY primary_wallet DESC').all(discordId);
      return wallets;
    } catch (error) {
      logger.error('Error fetching wallets:', error);
      return [];
    }
  }

  removeWallet(discordId, walletAddress) {
    try {
      const result = db.prepare('DELETE FROM wallets WHERE discord_id = ? AND wallet_address = ?').run(discordId, walletAddress);
      
      if (result.changes > 0) {
        logger.log(`Wallet ${walletAddress} removed from user ${discordId}`);
        return { success: true, message: 'Wallet removed successfully' };
      }
      return { success: false, message: 'Wallet not found' };
    } catch (error) {
      logger.error('Error removing wallet:', error);
      return { success: false, message: 'Failed to remove wallet' };
    }
  }

  getDelegatedWallets(discordId, guildId = '', { includeExpired = false } = {}) {
    try {
      const normalizedGuildId = this.normalizeGuild(guildId);
      const rows = db.prepare(`
        SELECT wd.cold_wallet_address, wd.delegate_wallet_address, wd.guild_id, wd.expires_at
        FROM wallet_delegations wd
        WHERE wd.discord_id = ?
          AND wd.status = 'active'
          AND (? = '' OR wd.guild_id = ? OR wd.guild_id = '')
          AND EXISTS (
            SELECT 1 FROM wallets w
            WHERE w.discord_id = wd.discord_id
              AND LOWER(w.wallet_address) = LOWER(wd.delegate_wallet_address)
          )
      `).all(discordId, normalizedGuildId, normalizedGuildId);
      const nowMs = Date.now();
      return rows
        .filter((row) => {
          if (includeExpired) return true;
          if (!row?.expires_at) return true;
          const expiresMs = Date.parse(row.expires_at);
          if (!Number.isFinite(expiresMs)) return true;
          return expiresMs > nowMs;
        })
        .map((row) => ({
          coldWalletAddress: String(row.cold_wallet_address || ''),
          delegateWalletAddress: String(row.delegate_wallet_address || ''),
          guildId: String(row.guild_id || ''),
          expiresAt: row.expires_at || null,
        }));
    } catch (error) {
      logger.error('Error fetching delegated wallets:', error);
      return [];
    }
  }

  addDelegatedWallet({
    discordId,
    guildId = '',
    delegateWalletAddress,
    coldWalletAddress,
    expiresAt = null,
    metadata = null,
  }) {
    try {
      const normalizedGuildId = this.normalizeGuild(guildId);
      const delegateWallet = this.normalizeWallet(delegateWalletAddress);
      const coldWallet = this.normalizeWallet(coldWalletAddress);
      if (!delegateWallet || !coldWallet) {
        return { success: false, message: 'delegateWalletAddress and coldWalletAddress are required' };
      }
      if (delegateWallet === coldWallet) {
        return { success: false, message: 'Cold wallet cannot be the same as delegate wallet' };
      }
      const ownsDelegateWallet = db.prepare(
        'SELECT 1 FROM wallets WHERE discord_id = ? AND LOWER(wallet_address) = LOWER(?)'
      ).get(discordId, delegateWallet);
      if (!ownsDelegateWallet) {
        return { success: false, message: 'Delegate wallet must be linked to your account first' };
      }

      db.prepare(`
        INSERT INTO wallet_delegations (
          discord_id, guild_id, delegate_wallet_address, cold_wallet_address, status, expires_at, metadata_json, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(discord_id, guild_id, cold_wallet_address)
        DO UPDATE SET
          delegate_wallet_address = excluded.delegate_wallet_address,
          status = 'active',
          expires_at = excluded.expires_at,
          metadata_json = excluded.metadata_json,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        String(discordId || '').trim(),
        normalizedGuildId,
        delegateWallet,
        coldWallet,
        expiresAt || null,
        metadata ? JSON.stringify(metadata) : null
      );
      logger.log(`Delegated wallet added for ${discordId}: ${coldWallet} via ${delegateWallet}${normalizedGuildId ? ` [guild ${normalizedGuildId}]` : ''}`);
      return { success: true };
    } catch (error) {
      logger.error('Error adding delegated wallet:', error);
      return { success: false, message: 'Failed to add delegated wallet' };
    }
  }

  revokeDelegatedWallet(discordId, coldWalletAddress, guildId = '') {
    try {
      const normalizedGuildId = this.normalizeGuild(guildId);
      const coldWallet = this.normalizeWallet(coldWalletAddress);
      const result = db.prepare(`
        UPDATE wallet_delegations
        SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
        WHERE discord_id = ?
          AND LOWER(cold_wallet_address) = LOWER(?)
          AND (? = '' OR guild_id = ?)
          AND status = 'active'
      `).run(String(discordId || '').trim(), coldWallet, normalizedGuildId, normalizedGuildId);
      if (!result.changes) {
        return { success: false, message: 'Delegation not found' };
      }
      logger.log(`Delegated wallet revoked for ${discordId}: ${coldWallet}${normalizedGuildId ? ` [guild ${normalizedGuildId}]` : ''}`);
      return { success: true };
    } catch (error) {
      logger.error('Error revoking delegated wallet:', error);
      return { success: false, message: 'Failed to revoke delegated wallet' };
    }
  }

  getAllUserWallets(discordId, guildId = '') {
    const directWallets = this.getLinkedWallets(discordId).map(w => String(w.wallet_address || '').trim()).filter(Boolean);
    const delegatedWallets = this.getDelegatedWallets(discordId, guildId).map(w => String(w.coldWalletAddress || '').trim()).filter(Boolean);
    return [...new Set([...directWallets, ...delegatedWallets])];
  }

  setFavoriteWallet(discordId, walletAddress) {
    try {
      // Verify wallet belongs to user
      const wallet = db.prepare('SELECT * FROM wallets WHERE discord_id = ? AND wallet_address = ?').get(discordId, walletAddress);
      
      if (!wallet) {
        return { success: false, message: 'Wallet not found' };
      }

      // Unset all favorites for this user
      db.prepare('UPDATE wallets SET is_favorite = 0 WHERE discord_id = ?').run(discordId);
      
      // Set new favorite
      db.prepare('UPDATE wallets SET is_favorite = 1 WHERE discord_id = ? AND wallet_address = ?').run(discordId, walletAddress);

      logger.log(`User ${discordId} set favorite wallet: ${walletAddress}`);
      return { success: true, message: 'Favorite wallet updated' };
    } catch (error) {
      logger.error('Error setting favorite wallet:', error);
      return { success: false, message: 'Failed to set favorite wallet' };
    }
  }

  getFavoriteWallet(discordId) {
    try {
      const wallet = db.prepare('SELECT wallet_address FROM wallets WHERE discord_id = ? AND is_favorite = 1').get(discordId);
      return wallet ? wallet.wallet_address : null;
    } catch (error) {
      logger.error('Error getting favorite wallet:', error);
      return null;
    }
  }

  removeAllWallets(discordId) {
    try {
      const result = db.prepare('DELETE FROM wallets WHERE discord_id = ?').run(discordId);
      logger.log(`Removed ${result.changes} wallets from user ${discordId}`);
      return { success: true, message: `${result.changes} wallets removed` };
    } catch (error) {
      logger.error('Error removing all wallets:', error);
      return { success: false, message: 'Failed to remove wallets' };
    }
  }
}

module.exports = new WalletService();
