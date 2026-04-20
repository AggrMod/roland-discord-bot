const bs58Module = require('bs58');
const db = require('../database/db');
const logger = require('../utils/logger');

const bs58 = bs58Module.default || bs58Module;

function normalizeDiscordId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeUsername(value, fallback = 'Unknown') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function normalizeWalletAddress(value) {
  return String(value || '').trim();
}

function normalizeBool(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  return 0;
}

function isValidSolanaAddress(address) {
  try {
    const decoded = bs58.decode(String(address || '').trim());
    return decoded.length === 32;
  } catch (_) {
    return false;
  }
}

function safeParseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

class SuperadminIdentityService {
  ensureUserRecord(discordId, username = 'Unknown') {
    const normalizedDiscordId = normalizeDiscordId(discordId);
    if (!normalizedDiscordId) return false;

    const existing = db.prepare('SELECT discord_id FROM users WHERE discord_id = ?').get(normalizedDiscordId);
    if (existing) {
      return true;
    }

    db.prepare(`
      INSERT INTO users (discord_id, username)
      VALUES (?, ?)
    `).run(normalizedDiscordId, normalizeUsername(username, normalizedDiscordId));
    return true;
  }

  getIdentityFlags(discordId) {
    const normalizedDiscordId = normalizeDiscordId(discordId);
    if (!normalizedDiscordId) {
      return {
        trustedIdentity: false,
        manualVerified: false,
        notes: '',
        updatedBy: null,
        createdAt: null,
        updatedAt: null,
      };
    }

    const row = db.prepare(`
      SELECT trusted_identity, manual_verified, notes, updated_by, created_at, updated_at
      FROM superadmin_user_identity_flags
      WHERE discord_id = ?
    `).get(normalizedDiscordId);

    if (!row) {
      return {
        trustedIdentity: false,
        manualVerified: false,
        notes: '',
        updatedBy: null,
        createdAt: null,
        updatedAt: null,
      };
    }

    return {
      trustedIdentity: Number(row.trusted_identity || 0) === 1,
      manualVerified: Number(row.manual_verified || 0) === 1,
      notes: row.notes || '',
      updatedBy: row.updated_by || null,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
    };
  }

  listProfiles({ q = '', limit = 25, offset = 0 } = {}) {
    const normalizedLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const normalizedOffset = Math.max(Number(offset) || 0, 0);
    const normalizedQuery = String(q || '').trim();
    const likeQuery = `%${normalizedQuery.toLowerCase()}%`;

    const queryWhere = normalizedQuery
      ? `
        WHERE LOWER(u.discord_id) LIKE ?
           OR LOWER(u.username) LIKE ?
           OR EXISTS (
             SELECT 1 FROM wallets wq
             WHERE wq.discord_id = u.discord_id
               AND LOWER(wq.wallet_address) LIKE ?
           )
      `
      : '';

    const users = normalizedQuery
      ? db.prepare(`
          SELECT
            u.discord_id,
            u.username,
            COUNT(w.id) AS wallet_count,
            COALESCE(f.trusted_identity, 0) AS trusted_identity,
            COALESCE(f.manual_verified, 0) AS manual_verified,
            f.updated_at AS flags_updated_at
          FROM users u
          LEFT JOIN wallets w ON w.discord_id = u.discord_id
          LEFT JOIN superadmin_user_identity_flags f ON f.discord_id = u.discord_id
          ${queryWhere}
          GROUP BY u.discord_id
          ORDER BY (COALESCE(f.manual_verified, 0) + COALESCE(f.trusted_identity, 0)) DESC, wallet_count DESC, u.updated_at DESC
          LIMIT ? OFFSET ?
        `).all(likeQuery, likeQuery, likeQuery, normalizedLimit, normalizedOffset)
      : db.prepare(`
          SELECT
            u.discord_id,
            u.username,
            COUNT(w.id) AS wallet_count,
            COALESCE(f.trusted_identity, 0) AS trusted_identity,
            COALESCE(f.manual_verified, 0) AS manual_verified,
            f.updated_at AS flags_updated_at
          FROM users u
          LEFT JOIN wallets w ON w.discord_id = u.discord_id
          LEFT JOIN superadmin_user_identity_flags f ON f.discord_id = u.discord_id
          GROUP BY u.discord_id
          ORDER BY (COALESCE(f.manual_verified, 0) + COALESCE(f.trusted_identity, 0)) DESC, wallet_count DESC, u.updated_at DESC
          LIMIT ? OFFSET ?
        `).all(normalizedLimit, normalizedOffset);

    const totalRow = normalizedQuery
      ? db.prepare(`
          SELECT COUNT(1) AS total
          FROM users u
          WHERE LOWER(u.discord_id) LIKE ?
             OR LOWER(u.username) LIKE ?
             OR EXISTS (
               SELECT 1 FROM wallets wq
               WHERE wq.discord_id = u.discord_id
                 AND LOWER(wq.wallet_address) LIKE ?
             )
        `).get(likeQuery, likeQuery, likeQuery)
      : db.prepare('SELECT COUNT(1) AS total FROM users').get();

    return {
      users: users.map(row => ({
        discordId: row.discord_id,
        username: row.username,
        walletCount: Number(row.wallet_count || 0),
        trustedIdentity: Number(row.trusted_identity || 0) === 1,
        manualVerified: Number(row.manual_verified || 0) === 1,
        flagsUpdatedAt: row.flags_updated_at || null,
      })),
      total: Number(totalRow?.total || 0),
      limit: normalizedLimit,
      offset: normalizedOffset,
    };
  }

  getProfile(discordId) {
    const normalizedDiscordId = normalizeDiscordId(discordId);
    if (!normalizedDiscordId) return null;

    const user = db.prepare(`
      SELECT discord_id, username, total_nfts, total_tokens, tier, created_at, updated_at
      FROM users
      WHERE discord_id = ?
    `).get(normalizedDiscordId);
    if (!user) return null;

    const wallets = db.prepare(`
      SELECT wallet_address, primary_wallet, is_favorite, created_at
      FROM wallets
      WHERE discord_id = ?
      ORDER BY primary_wallet DESC, is_favorite DESC, created_at ASC
    `).all(normalizedDiscordId);

    const flags = this.getIdentityFlags(normalizedDiscordId);

    return {
      user: {
        discordId: user.discord_id,
        username: user.username,
        totalNfts: Number(user.total_nfts || 0),
        totalTokens: Number(user.total_tokens || 0),
        tier: user.tier || null,
        createdAt: user.created_at || null,
        updatedAt: user.updated_at || null,
      },
      flags,
      wallets: wallets.map(wallet => ({
        walletAddress: wallet.wallet_address,
        primaryWallet: Number(wallet.primary_wallet || 0) === 1,
        favoriteWallet: Number(wallet.is_favorite || 0) === 1,
        createdAt: wallet.created_at || null,
      })),
    };
  }

  writeAudit({
    discordId = null,
    walletAddress = null,
    action,
    actorId = null,
    before = null,
    after = null,
    metadata = null,
  }) {
    try {
      db.prepare(`
        INSERT INTO superadmin_identity_audit_logs (
          discord_id,
          wallet_address,
          action,
          actor_id,
          before_json,
          after_json,
          metadata_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalizeDiscordId(discordId) || null,
        normalizeWalletAddress(walletAddress) || null,
        String(action || 'unknown').slice(0, 120),
        normalizeDiscordId(actorId) || null,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        metadata ? JSON.stringify(metadata) : null
      );
    } catch (error) {
      logger.error('Error writing superadmin identity audit log:', error);
    }
  }

  setFlags({ discordId, trustedIdentity, manualVerified, notes = '', actorId, username = null }) {
    const normalizedDiscordId = normalizeDiscordId(discordId);
    if (!normalizedDiscordId) {
      return { success: false, message: 'discordId is required' };
    }

    try {
      const operation = db.transaction(() => {
        this.ensureUserRecord(normalizedDiscordId, username || normalizedDiscordId);

        const before = this.getIdentityFlags(normalizedDiscordId);
        const trusted = normalizeBool(trustedIdentity);
        const manual = normalizeBool(manualVerified);
        const normalizedNotes = String(notes || '').trim().slice(0, 2000);

        db.prepare(`
          INSERT INTO superadmin_user_identity_flags (
            discord_id,
            trusted_identity,
            manual_verified,
            notes,
            updated_by
          )
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(discord_id) DO UPDATE SET
            trusted_identity = excluded.trusted_identity,
            manual_verified = excluded.manual_verified,
            notes = excluded.notes,
            updated_by = excluded.updated_by,
            updated_at = CURRENT_TIMESTAMP
        `).run(
          normalizedDiscordId,
          trusted,
          manual,
          normalizedNotes,
          normalizeDiscordId(actorId) || null
        );

        const after = this.getIdentityFlags(normalizedDiscordId);
        this.writeAudit({
          discordId: normalizedDiscordId,
          action: 'set_identity_flags',
          actorId,
          before,
          after,
        });
      });

      operation();
      return { success: true, profile: this.getProfile(normalizedDiscordId) };
    } catch (error) {
      logger.error('Error setting superadmin identity flags:', error);
      return { success: false, message: 'Failed to update identity flags' };
    }
  }

  ensureProfile({ discordId, username = null, actorId = null, metadata = {} } = {}) {
    const normalizedDiscordId = normalizeDiscordId(discordId);
    if (!normalizedDiscordId) {
      return { success: false, message: 'discordId is required' };
    }

    try {
      const operation = db.transaction(() => {
        const before = this.getProfile(normalizedDiscordId);
        this.ensureUserRecord(normalizedDiscordId, username || normalizedDiscordId);
        const after = this.getProfile(normalizedDiscordId);

        this.writeAudit({
          discordId: normalizedDiscordId,
          action: 'ensure_user_profile',
          actorId,
          before,
          after,
          metadata,
        });

        return { success: true, profile: after };
      });

      return operation();
    } catch (error) {
      logger.error('Error ensuring superadmin identity profile:', error);
      return { success: false, message: 'Failed to ensure identity profile' };
    }
  }

  linkWallet({
    discordId,
    walletAddress,
    actorId,
    username = null,
    primaryWallet = false,
    favoriteWallet = false,
    metadata = {},
  }) {
    const normalizedDiscordId = normalizeDiscordId(discordId);
    const normalizedWallet = normalizeWalletAddress(walletAddress);

    if (!normalizedDiscordId) return { success: false, message: 'discordId is required' };
    if (!normalizedWallet) return { success: false, message: 'walletAddress is required' };
    if (!isValidSolanaAddress(normalizedWallet)) {
      return { success: false, message: 'Invalid Solana wallet address' };
    }

    try {
      const operation = db.transaction(() => {
        this.ensureUserRecord(normalizedDiscordId, username || normalizedDiscordId);
        const before = this.getProfile(normalizedDiscordId);

        const existingWallet = db.prepare(`
          SELECT discord_id, wallet_address, primary_wallet, is_favorite
          FROM wallets
          WHERE wallet_address = ?
        `).get(normalizedWallet);

        if (existingWallet && existingWallet.discord_id !== normalizedDiscordId) {
          return {
            success: false,
            message: `Wallet is already linked to Discord user ${existingWallet.discord_id}`,
          };
        }

        const walletCountRow = db.prepare(`
          SELECT COUNT(1) AS count
          FROM wallets
          WHERE discord_id = ?
        `).get(normalizedDiscordId);
        const walletCount = Number(walletCountRow?.count || 0);
        const shouldPrimary = normalizeBool(primaryWallet) === 1 || walletCount === 0;
        const shouldFavorite = normalizeBool(favoriteWallet) === 1 || walletCount === 0;

        if (!existingWallet) {
          db.prepare(`
            INSERT INTO wallets (discord_id, wallet_address, primary_wallet, is_favorite)
            VALUES (?, ?, ?, ?)
          `).run(
            normalizedDiscordId,
            normalizedWallet,
            shouldPrimary ? 1 : 0,
            shouldFavorite ? 1 : 0
          );
        } else {
          db.prepare(`
            UPDATE wallets
            SET primary_wallet = CASE WHEN ? = 1 THEN 1 ELSE primary_wallet END,
                is_favorite = CASE WHEN ? = 1 THEN 1 ELSE is_favorite END
            WHERE wallet_address = ?
          `).run(shouldPrimary ? 1 : 0, shouldFavorite ? 1 : 0, normalizedWallet);
        }

        if (shouldPrimary) {
          db.prepare(`
            UPDATE wallets
            SET primary_wallet = CASE WHEN wallet_address = ? THEN 1 ELSE 0 END
            WHERE discord_id = ?
          `).run(normalizedWallet, normalizedDiscordId);
        }

        if (shouldFavorite) {
          db.prepare(`
            UPDATE wallets
            SET is_favorite = CASE WHEN wallet_address = ? THEN 1 ELSE 0 END
            WHERE discord_id = ?
          `).run(normalizedWallet, normalizedDiscordId);
        }

        const after = this.getProfile(normalizedDiscordId);
        this.writeAudit({
          discordId: normalizedDiscordId,
          walletAddress: normalizedWallet,
          action: existingWallet ? 'update_wallet_link' : 'link_wallet',
          actorId,
          before,
          after,
          metadata,
        });

        return { success: true, profile: after };
      });

      return operation();
    } catch (error) {
      logger.error('Error linking wallet via superadmin override:', error);
      return { success: false, message: 'Failed to link wallet' };
    }
  }

  unlinkWallet({ discordId, walletAddress, actorId, metadata = {} }) {
    const normalizedDiscordId = normalizeDiscordId(discordId);
    const normalizedWallet = normalizeWalletAddress(walletAddress);
    if (!normalizedDiscordId || !normalizedWallet) {
      return { success: false, message: 'discordId and walletAddress are required' };
    }

    try {
      const operation = db.transaction(() => {
        const before = this.getProfile(normalizedDiscordId);
        if (!before) {
          return { success: false, message: 'User not found' };
        }

        const target = db.prepare(`
          SELECT wallet_address, primary_wallet, is_favorite
          FROM wallets
          WHERE discord_id = ? AND wallet_address = ?
        `).get(normalizedDiscordId, normalizedWallet);

        if (!target) {
          return { success: false, message: 'Wallet not linked to this user' };
        }

        db.prepare('DELETE FROM wallets WHERE discord_id = ? AND wallet_address = ?').run(normalizedDiscordId, normalizedWallet);

        if (Number(target.primary_wallet || 0) === 1) {
          const nextPrimary = db.prepare(`
            SELECT wallet_address
            FROM wallets
            WHERE discord_id = ?
            ORDER BY is_favorite DESC, created_at ASC
            LIMIT 1
          `).get(normalizedDiscordId);

          if (nextPrimary?.wallet_address) {
            db.prepare(`
              UPDATE wallets
              SET primary_wallet = CASE WHEN wallet_address = ? THEN 1 ELSE 0 END
              WHERE discord_id = ?
            `).run(nextPrimary.wallet_address, normalizedDiscordId);
          }
        }

        if (Number(target.is_favorite || 0) === 1) {
          const nextFavorite = db.prepare(`
            SELECT wallet_address
            FROM wallets
            WHERE discord_id = ?
            ORDER BY primary_wallet DESC, created_at ASC
            LIMIT 1
          `).get(normalizedDiscordId);

          if (nextFavorite?.wallet_address) {
            db.prepare(`
              UPDATE wallets
              SET is_favorite = CASE WHEN wallet_address = ? THEN 1 ELSE 0 END
              WHERE discord_id = ?
            `).run(nextFavorite.wallet_address, normalizedDiscordId);
          }
        }

        const after = this.getProfile(normalizedDiscordId);
        this.writeAudit({
          discordId: normalizedDiscordId,
          walletAddress: normalizedWallet,
          action: 'unlink_wallet',
          actorId,
          before,
          after,
          metadata,
        });

        return { success: true, profile: after };
      });

      return operation();
    } catch (error) {
      logger.error('Error unlinking wallet via superadmin override:', error);
      return { success: false, message: 'Failed to unlink wallet' };
    }
  }

  listAudit({ discordId = '', limit = 20, offset = 0 } = {}) {
    const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 200);
    const normalizedOffset = Math.max(Number(offset) || 0, 0);
    const normalizedDiscordId = normalizeDiscordId(discordId);

    const rows = normalizedDiscordId
      ? db.prepare(`
          SELECT id, discord_id, wallet_address, action, actor_id, before_json, after_json, metadata_json, created_at
          FROM superadmin_identity_audit_logs
          WHERE discord_id = ?
          ORDER BY id DESC
          LIMIT ? OFFSET ?
        `).all(normalizedDiscordId, normalizedLimit, normalizedOffset)
      : db.prepare(`
          SELECT id, discord_id, wallet_address, action, actor_id, before_json, after_json, metadata_json, created_at
          FROM superadmin_identity_audit_logs
          ORDER BY id DESC
          LIMIT ? OFFSET ?
        `).all(normalizedLimit, normalizedOffset);

    const actorIds = [...new Set(rows.map(row => normalizeDiscordId(row.actor_id)).filter(Boolean))];
    const actorNameMap = new Map();
    if (actorIds.length) {
      const placeholders = actorIds.map(() => '?').join(',');
      const actorRows = db.prepare(`
        SELECT discord_id, username
        FROM users
        WHERE discord_id IN (${placeholders})
      `).all(...actorIds);
      for (const row of actorRows) {
        const actorId = normalizeDiscordId(row.discord_id);
        if (!actorId) continue;
        actorNameMap.set(actorId, normalizeUsername(row.username, actorId));
      }
    }

    return rows.map(row => ({
      id: Number(row.id),
      discordId: row.discord_id || null,
      walletAddress: row.wallet_address || null,
      action: row.action || 'unknown',
      actorId: row.actor_id || null,
      actorDisplayName: actorNameMap.get(normalizeDiscordId(row.actor_id)) || null,
      before: safeParseJson(row.before_json, null),
      after: safeParseJson(row.after_json, null),
      metadata: safeParseJson(row.metadata_json, null),
      createdAt: row.created_at || null,
    }));
  }
}

module.exports = new SuperadminIdentityService();
