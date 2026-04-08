const db = require('../database/db');
const logger = require('../utils/logger');
const entitlementService = require('./entitlementService');
const nftService = require('./nftService');
const tokenService = require('./tokenService');
const clientProvider = require('../utils/clientProvider');
const { applyEmbedBranding, getBranding } = require('./embedBranding');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2sW9gK5bN8wK5Y7vJgqS5M8X';
const STABLECOIN_MINTS = new Set([
  USDC_MINT.toLowerCase(),
  USDT_MINT.toLowerCase(),
]);
const TOKEN_ACTIVITY_POLL_LIMIT = Math.max(10, Math.min(50, Number(process.env.TRACKED_TOKEN_POLL_LIMIT || 25)));
const TOKEN_ACTIVITY_ALERT_CAP_PER_WALLET = Math.max(1, Math.min(25, Number(process.env.TRACKED_TOKEN_ALERT_CAP || 8)));
const SOL_DELTA_EPSILON = Number(process.env.TRACKED_TOKEN_SOL_EPSILON || 0.00001);
const STABLE_DELTA_EPSILON = Number(process.env.TRACKED_TOKEN_STABLE_EPSILON || 0.01);
const TOKEN_WEBHOOK_RETRY_MAX = Math.max(0, Math.min(6, Number(process.env.TRACKED_TOKEN_WEBHOOK_RETRY_MAX || 3)));
const TOKEN_WEBHOOK_RETRY_BASE_MS = Math.max(250, Number(process.env.TRACKED_TOKEN_WEBHOOK_RETRY_BASE_MS || 1500));
const TOKEN_WEBHOOK_DURABLE_RETRY_MAX = Math.max(1, Math.min(72, Number(process.env.TRACKED_TOKEN_DURABLE_RETRY_MAX || 24)));
const TOKEN_WEBHOOK_DURABLE_RETRY_BASE_MS = Math.max(5 * 1000, Number(process.env.TRACKED_TOKEN_DURABLE_RETRY_BASE_MS || 30 * 1000));
const TOKEN_WEBHOOK_DURABLE_RETRY_MAX_DELAY_MS = Math.max(TOKEN_WEBHOOK_DURABLE_RETRY_BASE_MS, Number(process.env.TRACKED_TOKEN_DURABLE_RETRY_MAX_DELAY_MS || 30 * 60 * 1000));
const TOKEN_WEBHOOK_DURABLE_RETRY_BATCH_SIZE = Math.max(1, Math.min(100, Number(process.env.TRACKED_TOKEN_DURABLE_RETRY_BATCH_SIZE || 20)));
const TRANSIENT_WEBHOOK_RETRY_REASONS = new Set(['tx_not_available', 'parsed_tx_fetch_failed']);

function safeToNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseUiAmount(entry) {
  const tokenAmount = entry?.uiTokenAmount || {};
  if (tokenAmount.uiAmountString !== undefined && tokenAmount.uiAmountString !== null) {
    const parsed = Number(tokenAmount.uiAmountString);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (tokenAmount.uiAmount !== undefined && tokenAmount.uiAmount !== null) {
    const parsed = Number(tokenAmount.uiAmount);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizeAddress(address) {
  return String(address || '').trim().toLowerCase();
}

function normalizeDiscordChannelId(channelId) {
  const normalized = String(channelId || '').trim();
  return /^\d{17,20}$/.test(normalized) ? normalized : '';
}

function normalizeDiscordChannelIds(values) {
  const input = Array.isArray(values)
    ? values
    : (typeof values === 'string' ? values.split(',') : []);
  const out = [];
  const seen = new Set();
  for (const entry of input) {
    const id = normalizeDiscordChannelId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function parseTrackedTokenAlertChannelIds(rawIds, fallbackId = null) {
  let parsed = [];
  if (Array.isArray(rawIds)) {
    parsed = normalizeDiscordChannelIds(rawIds);
  } else if (typeof rawIds === 'string' && rawIds.trim()) {
    try {
      const json = JSON.parse(rawIds);
      parsed = normalizeDiscordChannelIds(Array.isArray(json) ? json : []);
    } catch (_error) {
      parsed = normalizeDiscordChannelIds(rawIds);
    }
  }

  if (!parsed.length) {
    const fallback = normalizeDiscordChannelId(fallbackId);
    if (fallback) parsed = [fallback];
  }
  return parsed;
}

function isValidSolanaAddress(address) {
  try {
    const normalized = String(address || '').trim();
    if (!normalized) return false;
    new PublicKey(normalized);
    return true;
  } catch (_error) {
    return false;
  }
}

async function _getSolanaBalances(walletAddress) {
  try {
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');
    const pubkey = new PublicKey(walletAddress);

    const [lamports, tokenAccounts] = await Promise.all([
      connection.getBalance(pubkey),
      connection.getParsedTokenAccountsByOwner(pubkey, { mint: new PublicKey(USDC_MINT) })
    ]);

    const sol = lamports / LAMPORTS_PER_SOL;
    let usdc = 0;
    if (tokenAccounts.value.length > 0) {
      const info = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
      usdc = info.uiAmount || 0;
    }

    return { sol, usdc };
  } catch (e) {
    logger.warn('Could not fetch Solana balances:', e.message);
    return { sol: null, usdc: null };
  }
}

class TrackedWalletsService {
  constructor() {
    this.connection = tokenService.connection || new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
    this.invalidWalletWarned = new Set();
    this.webhookRetryKeys = new Set();
    this.webhookQueueSweepRunning = false;
    this.tokenImageCache = new Map();
    this.tokenImageCacheTtlMs = Math.max(60 * 1000, Number(process.env.TOKEN_IMAGE_CACHE_TTL_MS || 6 * 60 * 60 * 1000));
  }

  isTokenTrackerEnabled(guildId) {
    try {
      const tenantService = require('./tenantService');
      if (tenantService?.isMultitenantEnabled?.()) {
        return tenantService.isModuleEnabled(guildId, 'tokentracker');
      }
    } catch (_error) {}

    try {
      const settingsManager = require('../config/settings');
      return settingsManager.getSettings().moduleTokenTrackerEnabled !== false;
    } catch (_error) {
      return true;
    }
  }
  // ─── CRUD ────────────────────────────────────────────────────────────────

  addTrackedWallet({ guildId, walletAddress, label, alertChannelId, panelChannelId }) {
    try {
      const normalizedGuildId = String(guildId || '').trim();
      if (normalizedGuildId) {
        const countRow = db.prepare(`
          SELECT COUNT(1) AS count
          FROM tracked_wallets
          WHERE guild_id = ?
        `).get(normalizedGuildId);
        let limitCheck = entitlementService.enforceLimit({
          guildId: normalizedGuildId,
          moduleKey: 'wallettracker',
          limitKey: 'max_tracked_wallets',
          currentCount: Number(countRow?.count || 0),
          incrementBy: 1,
          itemLabel: 'tracked wallets',
        });
        // Backward compatibility: older deployments stored this cap under treasury.
        if (limitCheck.success && limitCheck.limit === null) {
          limitCheck = entitlementService.enforceLimit({
            guildId: normalizedGuildId,
            moduleKey: 'treasury',
            limitKey: 'max_tracked_wallets',
            currentCount: Number(countRow?.count || 0),
            incrementBy: 1,
            itemLabel: 'tracked wallets',
          });
        }
        if (!limitCheck.success) {
          return {
            success: false,
            code: 'limit_exceeded',
            message: limitCheck.message,
            limit: limitCheck.limit,
            used: limitCheck.used,
          };
        }
      }

      const addr = String(walletAddress || '').trim();
      if (!addr) return { success: false, message: 'walletAddress is required' };

      const result = db.prepare(`
        INSERT INTO tracked_wallets (guild_id, wallet_address, label, alert_channel_id, panel_channel_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        normalizedGuildId,
        addr,
        (label || '').trim() || null,
        (alertChannelId || '').trim() || null,
        (panelChannelId || '').trim() || null,
      );

      this.syncWalletAddressToHeliusWebhook(addr, 'add')
        .catch(err => logger.error('[tracked-token-webhook] failed to sync added wallet to helius webhook:', err?.message || err));

      return { success: true, id: result.lastInsertRowid };
    } catch (e) {
      if (e.message?.includes('UNIQUE constraint')) {
        return { success: false, message: 'Wallet already tracked for this server' };
      }
      logger.error('Error adding tracked wallet:', e);
      return { success: false, message: 'Failed to add tracked wallet' };
    }
  }

  removeTrackedWallet(id, guildId) {
    try {
      const existing = guildId
        ? db.prepare('SELECT id, guild_id, wallet_address, enabled FROM tracked_wallets WHERE id = ? AND guild_id = ?').get(id, guildId)
        : db.prepare('SELECT id, guild_id, wallet_address, enabled FROM tracked_wallets WHERE id = ?').get(id);
      const query = guildId
        ? 'DELETE FROM tracked_wallets WHERE id = ? AND guild_id = ?'
        : 'DELETE FROM tracked_wallets WHERE id = ?';
      const params = guildId ? [id, guildId] : [id];
      const result = db.prepare(query).run(...params);

      if (result.changes > 0 && existing?.wallet_address) {
        const remaining = this.countEnabledTrackedWalletsByAddress(existing.wallet_address);
        if (remaining === 0) {
          this.syncWalletAddressToHeliusWebhook(existing.wallet_address, 'remove')
            .catch(err => logger.error('[tracked-token-webhook] failed to sync removed wallet from helius webhook:', err?.message || err));
        }
      }

      return { success: true, removed: result.changes };
    } catch (e) {
      logger.error('Error removing tracked wallet:', e);
      return { success: false, message: 'Failed to remove tracked wallet' };
    }
  }

  getTrackedWallets(guildId) {
    try {
      if (guildId) {
        return db.prepare('SELECT * FROM tracked_wallets WHERE guild_id = ? ORDER BY created_at DESC').all(guildId);
      }
      return db.prepare('SELECT * FROM tracked_wallets ORDER BY created_at DESC').all();
    } catch (e) {
      logger.error('Error getting tracked wallets:', e);
      return [];
    }
  }

  getTrackedWalletById(id, guildId) {
    try {
      if (guildId) {
        return db.prepare('SELECT * FROM tracked_wallets WHERE id = ? AND guild_id = ?').get(id, guildId);
      }
      return db.prepare('SELECT * FROM tracked_wallets WHERE id = ?').get(id);
    } catch (e) {
      return null;
    }
  }

  getTrackedWalletsByAddress(walletAddress) {
    try {
      return db.prepare(`
        SELECT * FROM tracked_wallets
        WHERE LOWER(wallet_address) = LOWER(?) AND enabled = 1
      `).all(walletAddress);
    } catch (e) {
      return [];
    }
  }

  getTrackedWalletsByAddresses(addresses = []) {
    try {
      const normalized = Array.from(new Set(
        (Array.isArray(addresses) ? addresses : [])
          .map(addr => String(addr || '').trim().toLowerCase())
          .filter(Boolean)
      ));
      if (!normalized.length) return [];

      const placeholders = normalized.map(() => '?').join(', ');
      return db.prepare(`
        SELECT * FROM tracked_wallets
        WHERE enabled = 1
          AND LOWER(wallet_address) IN (${placeholders})
      `).all(...normalized);
    } catch (e) {
      logger.error('Error getting tracked wallets by addresses:', e);
      return [];
    }
  }

  updateTrackedWallet(id, updates, guildId) {
    try {
      const before = this.getTrackedWalletById(id, guildId);
      const allowed = { label: 'label', alertChannelId: 'alert_channel_id', panelChannelId: 'panel_channel_id', enabled: 'enabled' };
      const setClauses = [];
      const params = [];
      for (const [key, col] of Object.entries(allowed)) {
        if (key in updates) {
          setClauses.push(`${col} = ?`);
          params.push(typeof updates[key] === 'boolean' ? (updates[key] ? 1 : 0) : updates[key]);
        }
      }
      if (!setClauses.length) return { success: false, message: 'No valid updates provided' };
      setClauses.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id);
      if (guildId) params.push(guildId);
      const sql = `UPDATE tracked_wallets SET ${setClauses.join(', ')} WHERE id = ?${guildId ? ' AND guild_id = ?' : ''}`;
      const info = db.prepare(sql).run(...params);
      if (!info.changes) return { success: false, message: 'Wallet not found or access denied' };

      if (before && Object.prototype.hasOwnProperty.call(updates, 'enabled')) {
        const enabledNow = updates.enabled ? 1 : 0;
        const enabledBefore = Number(before.enabled || 0);
        const walletAddress = String(before.wallet_address || '').trim();

        if (walletAddress && enabledBefore !== enabledNow) {
          if (enabledNow === 1) {
            this.syncWalletAddressToHeliusWebhook(walletAddress, 'add')
              .catch(err => logger.error('[tracked-token-webhook] failed to sync enabled wallet to helius webhook:', err?.message || err));
          } else {
            const remaining = this.countEnabledTrackedWalletsByAddress(walletAddress);
            if (remaining === 0) {
              this.syncWalletAddressToHeliusWebhook(walletAddress, 'remove')
                .catch(err => logger.error('[tracked-token-webhook] failed to sync disabled wallet from helius webhook:', err?.message || err));
            }
          }
        }
      }

      return { success: true };
    } catch (e) {
      logger.error('Error updating tracked wallet:', e);
      return { success: false, message: 'Failed to update tracked wallet' };
    }
  }

  countEnabledTrackedWalletsByAddress(walletAddress) {
    try {
      const row = db.prepare(`
        SELECT COUNT(*) AS count
        FROM tracked_wallets
        WHERE enabled = 1
          AND LOWER(wallet_address) = LOWER(?)
      `).get(walletAddress);
      return Number(row?.count || 0);
    } catch (_error) {
      return 0;
    }
  }

  getHeliusTokenWebhookConfig() {
    return {
      apiKey: String(process.env.HELIUS_API_KEY || '').trim(),
      webhookId: String(process.env.HELIUS_TOKEN_WEBHOOK_ID || process.env.HELIUS_WEBHOOK_ID || '').trim(),
    };
  }

  async fetchHeliusWebhookPayload() {
    const { apiKey, webhookId } = this.getHeliusTokenWebhookConfig();
    if (!apiKey || !webhookId) return null;

    const url = `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      logger.error(`[tracked-token-webhook] Helius GET webhook failed: ${res.status} ${await res.text()}`);
      return null;
    }

    return {
      url,
      payload: await res.json(),
    };
  }

  async persistHeliusWebhookAddresses(url, payload, addresses) {
    if (!url || !payload) return false;
    const transactionTypes = Array.isArray(payload.transactionTypes) ? payload.transactionTypes : [];
    const existingTypes = transactionTypes
      .map(type => String(type || '').trim())
      .filter(Boolean);
    const normalizedTypes = existingTypes.map(type => type.toUpperCase());
    const hasAny = normalizedTypes.includes('ANY');
    const mergedTypes = hasAny
      ? existingTypes
      : [
          ...existingTypes,
          ...(normalizedTypes.includes('TRANSFER') ? [] : ['TRANSFER']),
          ...(normalizedTypes.includes('SWAP') ? [] : ['SWAP']),
        ];

    const putRes = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhookURL: payload.webhookURL,
        transactionTypes: mergedTypes,
        accountAddresses: addresses,
        webhookType: payload.webhookType || 'enhanced',
        authHeader: payload.authHeader,
      }),
    });

    if (!putRes.ok) {
      logger.error(`[tracked-token-webhook] Helius PUT webhook failed: ${putRes.status} ${await putRes.text()}`);
      return false;
    }
    return true;
  }

  async syncWalletAddressToHeliusWebhook(walletAddress, action = 'add') {
    const normalized = String(walletAddress || '').trim();
    if (!normalized || !isValidSolanaAddress(normalized)) return;

    const { apiKey, webhookId } = this.getHeliusTokenWebhookConfig();
    if (!apiKey || !webhookId) {
      logger.warn('[tracked-token-webhook] HELIUS_API_KEY or HELIUS_(TOKEN_)WEBHOOK_ID missing; skipping wallet webhook sync');
      return;
    }

    const current = await this.fetchHeliusWebhookPayload();
    if (!current?.payload) return;

    const existingAddresses = Array.isArray(current.payload.accountAddresses) ? [...current.payload.accountAddresses] : [];
    const existingLower = new Set(existingAddresses.map(addr => String(addr || '').trim().toLowerCase()));

    let nextAddresses = existingAddresses;
    if (action === 'add') {
      if (existingLower.has(normalized.toLowerCase())) return;
      nextAddresses = [...existingAddresses, normalized];
    } else if (action === 'remove') {
      nextAddresses = existingAddresses.filter(addr => String(addr || '').trim().toLowerCase() !== normalized.toLowerCase());
      if (nextAddresses.length === existingAddresses.length) return;
    } else {
      return;
    }

    const saved = await this.persistHeliusWebhookAddresses(current.url, current.payload, nextAddresses);
    if (saved) {
      logger.log(`[tracked-token-webhook] helius webhook synced: ${action} ${normalized} (${nextAddresses.length} addresses total)`);
    }
  }

  async syncAllEnabledWalletAddressesToHeliusWebhook() {
    const { apiKey, webhookId } = this.getHeliusTokenWebhookConfig();
    if (!apiKey || !webhookId) return { success: false, skipped: true, reason: 'missing_helius_webhook_config' };

    const enabledWallets = db.prepare('SELECT DISTINCT wallet_address FROM tracked_wallets WHERE enabled = 1').all()
      .map(row => String(row?.wallet_address || '').trim())
      .filter(addr => addr && isValidSolanaAddress(addr));
    if (!enabledWallets.length) return { success: true, skipped: true, reason: 'no_enabled_wallets' };

    const current = await this.fetchHeliusWebhookPayload();
    if (!current?.payload) return { success: false, skipped: true, reason: 'fetch_failed' };

    const existingAddresses = Array.isArray(current.payload.accountAddresses) ? [...current.payload.accountAddresses] : [];
    const existingLower = new Set(existingAddresses.map(addr => String(addr || '').trim().toLowerCase()));
    const additions = enabledWallets.filter(addr => !existingLower.has(addr.toLowerCase()));
    if (!additions.length) return { success: true, skipped: true, reason: 'already_synced' };

    const nextAddresses = [...existingAddresses, ...additions];
    const saved = await this.persistHeliusWebhookAddresses(current.url, current.payload, nextAddresses);
    if (!saved) return { success: false, skipped: true, reason: 'persist_failed' };

    logger.log(`[tracked-token-webhook] added ${additions.length} tracked wallet addresses to helius webhook (${nextAddresses.length} total)`);
    return {
      success: true,
      added: additions.length,
      total: nextAddresses.length,
    };
  }

  addTrackedToken({
    guildId,
    tokenMint,
    tokenSymbol = null,
    tokenName = null,
    decimals = null,
    enabled = true,
    alertChannelId = null,
    alertChannelIds = null,
    alertBuys = true,
    alertSells = true,
    alertTransfers = false,
    minAlertAmount = 0
  }) {
    try {
      const guild = String(guildId || '').trim();
      const mint = String(tokenMint || '').trim();
      if (!guild || !mint) return { success: false, message: 'guildId and tokenMint are required' };

      const countRow = db.prepare(`
        SELECT COUNT(1) AS count
        FROM tracked_tokens
        WHERE guild_id = ?
      `).get(guild);
      const limitCheck = entitlementService.enforceLimit({
        guildId: guild,
        moduleKey: 'tokentracker',
        limitKey: 'max_tokens',
        currentCount: Number(countRow?.count || 0),
        incrementBy: 1,
        itemLabel: 'tracked tokens',
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

      const normalizedAlertChannelIds = normalizeDiscordChannelIds(
        Array.isArray(alertChannelIds) ? alertChannelIds : [alertChannelId]
      );
      const primaryAlertChannelId = normalizedAlertChannelIds[0] || null;

      const result = db.prepare(`
        INSERT INTO tracked_tokens (
          guild_id, token_mint, token_symbol, token_name, decimals, enabled, alert_channel_id, alert_channel_ids, alert_buys, alert_sells, alert_transfers, min_alert_amount
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        guild,
        mint,
        String(tokenSymbol || '').trim() || null,
        String(tokenName || '').trim() || null,
        decimals === null || decimals === undefined || decimals === '' ? null : Number(decimals),
        enabled === false ? 0 : 1,
        primaryAlertChannelId,
        JSON.stringify(normalizedAlertChannelIds),
        alertBuys === false ? 0 : 1,
        alertSells === false ? 0 : 1,
        alertTransfers === true ? 1 : 0,
        Math.max(0, safeToNumber(minAlertAmount))
      );

      // Keep Helius webhook account addresses in sync for live push coverage.
      this.syncWalletAddressToHeliusWebhook(mint, 'add')
        .catch(err => logger.error('[tracked-token-webhook] failed to sync added tracked token mint to helius webhook:', err?.message || err));

      return { success: true, id: Number(result.lastInsertRowid) };
    } catch (e) {
      if (e.message?.includes('UNIQUE constraint')) {
        return { success: false, message: 'Token already tracked for this server' };
      }
      logger.error('Error adding tracked token:', e);
      return { success: false, message: 'Failed to add tracked token' };
    }
  }

  getTrackedTokens(guildId) {
    try {
      const rows = guildId
        ? db.prepare('SELECT * FROM tracked_tokens WHERE guild_id = ? ORDER BY created_at DESC').all(guildId)
        : db.prepare('SELECT * FROM tracked_tokens ORDER BY created_at DESC').all();

      return rows.map(row => {
        const channelIds = parseTrackedTokenAlertChannelIds(row.alert_channel_ids, row.alert_channel_id);
        const primaryChannelId = channelIds[0] || null;
        return {
          ...row,
          alert_channel_ids: channelIds,
          alert_channel_id: primaryChannelId,
          alertChannelIds: channelIds,
          alertChannelId: primaryChannelId,
          enabled: Number(row.enabled || 0) === 1,
          alert_buys: Number(row.alert_buys ?? 1) === 1,
          alert_sells: Number(row.alert_sells ?? 1) === 1,
          alert_transfers: Number(row.alert_transfers || 0) === 1,
          min_alert_amount: safeToNumber(row.min_alert_amount || 0),
        };
      });
    } catch (e) {
      logger.error('Error getting tracked tokens:', e);
      return [];
    }
  }

  getTrackedTokenById(id, guildId) {
    try {
      if (guildId) {
        return db.prepare('SELECT * FROM tracked_tokens WHERE id = ? AND guild_id = ?').get(id, guildId);
      }
      return db.prepare('SELECT * FROM tracked_tokens WHERE id = ?').get(id);
    } catch (e) {
      logger.error('Error getting tracked token by id:', e);
      return null;
    }
  }

  updateTrackedToken(id, updates = {}, guildId) {
    try {
      const before = this.getTrackedTokenById(id, guildId);
      const fieldMap = {
        tokenMint: 'token_mint',
        tokenSymbol: 'token_symbol',
        tokenName: 'token_name',
        decimals: 'decimals',
        enabled: 'enabled',
        alertBuys: 'alert_buys',
        alertSells: 'alert_sells',
        alertTransfers: 'alert_transfers',
        minAlertAmount: 'min_alert_amount',
      };

      const sets = [];
      const params = [];
      for (const [key, val] of Object.entries(updates || {})) {
        const column = fieldMap[key];
        if (!column) continue;

        if (column === 'enabled' || column === 'alert_buys' || column === 'alert_sells' || column === 'alert_transfers') {
          sets.push(`${column} = ?`);
          params.push(val ? 1 : 0);
          continue;
        }
        if (column === 'min_alert_amount') {
          sets.push(`${column} = ?`);
          params.push(Math.max(0, safeToNumber(val)));
          continue;
        }
        if (column === 'decimals') {
          sets.push(`${column} = ?`);
          params.push(val === null || val === undefined || val === '' ? null : Number(val));
          continue;
        }
        sets.push(`${column} = ?`);
        params.push(String(val || '').trim() || null);
      }

      const hasAlertChannels = Object.prototype.hasOwnProperty.call(updates, 'alertChannelIds');
      const hasAlertChannel = Object.prototype.hasOwnProperty.call(updates, 'alertChannelId');
      if (hasAlertChannels || hasAlertChannel) {
        const nextAlertChannelIds = normalizeDiscordChannelIds(
          hasAlertChannels ? updates.alertChannelIds : [updates.alertChannelId]
        );
        sets.push('alert_channel_ids = ?');
        params.push(JSON.stringify(nextAlertChannelIds));
        sets.push('alert_channel_id = ?');
        params.push(nextAlertChannelIds[0] || null);
      }

      if (!sets.length) return { success: false, message: 'No valid updates provided' };
      sets.push('updated_at = CURRENT_TIMESTAMP');

      let info;
      if (guildId) {
        params.push(id, String(guildId));
        info = db.prepare(`UPDATE tracked_tokens SET ${sets.join(', ')} WHERE id = ? AND guild_id = ?`).run(...params);
      } else {
        params.push(id);
        info = db.prepare(`UPDATE tracked_tokens SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      }

      if (!info.changes) return { success: false, message: 'Tracked token not found or access denied' };

      // If token is (or remains) enabled after update, ensure its mint exists on webhook address list.
      // Fire-and-forget to avoid delaying admin UX.
      const enabledAfter = Object.prototype.hasOwnProperty.call(updates, 'enabled')
        ? !!updates.enabled
        : Number(before?.enabled ?? 1) === 1;
      const mintAfter = String(
        (Object.prototype.hasOwnProperty.call(updates, 'tokenMint') ? updates.tokenMint : before?.token_mint) || ''
      ).trim();
      if (enabledAfter && mintAfter) {
        this.syncWalletAddressToHeliusWebhook(mintAfter, 'add')
          .catch(err => logger.error('[tracked-token-webhook] failed to sync updated tracked token mint to helius webhook:', err?.message || err));
      }

      return { success: true };
    } catch (e) {
      logger.error('Error updating tracked token:', e);
      return { success: false, message: 'Failed to update tracked token' };
    }
  }

  removeTrackedToken(id, guildId) {
    try {
      const query = guildId
        ? 'DELETE FROM tracked_tokens WHERE id = ? AND guild_id = ?'
        : 'DELETE FROM tracked_tokens WHERE id = ?';
      const params = guildId ? [id, guildId] : [id];
      const result = db.prepare(query).run(...params);
      return { success: true, removed: result.changes };
    } catch (e) {
      logger.error('Error removing tracked token:', e);
      return { success: false, message: 'Failed to remove tracked token' };
    }
  }

  listTrackedTokenEvents(guildId, limit = 30) {
    try {
      const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
      const rows = guildId
        ? db.prepare(`
          SELECT id, guild_id, wallet_id, wallet_address, token_mint, token_symbol, token_name, event_type, amount_delta, balance_after, sol_delta, stable_delta, tx_signature, event_time, source, created_at
          FROM tracked_token_events
          WHERE guild_id = ?
          ORDER BY datetime(COALESCE(event_time, created_at)) DESC
          LIMIT ?
        `).all(String(guildId), safeLimit)
        : db.prepare(`
          SELECT id, guild_id, wallet_id, wallet_address, token_mint, token_symbol, token_name, event_type, amount_delta, balance_after, sol_delta, stable_delta, tx_signature, event_time, source, created_at
          FROM tracked_token_events
          ORDER BY datetime(COALESCE(event_time, created_at)) DESC
          LIMIT ?
        `).all(safeLimit);

      return rows.map(row => ({
        ...row,
        amount_delta: safeToNumber(row.amount_delta),
        balance_after: row.balance_after === null || row.balance_after === undefined ? null : safeToNumber(row.balance_after),
        sol_delta: row.sol_delta === null || row.sol_delta === undefined ? null : safeToNumber(row.sol_delta),
        stable_delta: row.stable_delta === null || row.stable_delta === undefined ? null : safeToNumber(row.stable_delta),
      }));
    } catch (e) {
      logger.error('Error listing tracked token events:', e);
      return [];
    }
  }

  saveTrackedTokenEvent({
    guildId,
    walletId,
    walletAddress,
    tokenMint,
    tokenSymbol,
    tokenName,
    eventType,
    amountDelta,
    balanceAfter = null,
    solDelta = null,
    stableDelta = null,
    txSignature,
    eventTime = null,
    source = 'poll',
    rawJson = null,
  }) {
    try {
      const existing = db.prepare(`
        SELECT id
        FROM tracked_token_events
        WHERE guild_id = ?
          AND wallet_address = ?
          AND tx_signature = ?
          AND LOWER(token_mint) = LOWER(?)
        LIMIT 1
      `).get(
        String(guildId || ''),
        String(walletAddress || ''),
        String(txSignature || '').trim(),
        String(tokenMint || '')
      );
      if (existing?.id) {
        return { success: true, inserted: false, duplicate: true };
      }

      const result = db.prepare(`
        INSERT INTO tracked_token_events (
          guild_id, wallet_id, wallet_address, token_mint, token_symbol, token_name, event_type, amount_delta, balance_after,
          sol_delta, stable_delta, tx_signature, event_time, source, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(guildId || ''),
        walletId ? Number(walletId) : null,
        String(walletAddress || ''),
        String(tokenMint || ''),
        String(tokenSymbol || '').trim() || null,
        String(tokenName || '').trim() || null,
        String(eventType || '').trim().toLowerCase(),
        safeToNumber(amountDelta),
        balanceAfter === null || balanceAfter === undefined ? null : safeToNumber(balanceAfter),
        solDelta === null || solDelta === undefined ? null : safeToNumber(solDelta),
        stableDelta === null || stableDelta === undefined ? null : safeToNumber(stableDelta),
        String(txSignature || '').trim(),
        eventTime || null,
        String(source || 'poll'),
        rawJson ? JSON.stringify(rawJson) : null
      );
      return { success: true, id: Number(result.lastInsertRowid), inserted: true };
    } catch (e) {
      if (e.message?.includes('UNIQUE constraint')) {
        return { success: true, inserted: false, duplicate: true };
      }
      logger.error('Error saving tracked token event:', e);
      return { success: false, message: 'Failed to save tracked token event' };
    }
  }

  saveWalletTokenCursor(id, signature) {
    try {
      db.prepare(`
        UPDATE tracked_wallets
        SET token_last_signature = ?, token_last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(signature || null, id);
    } catch (e) {
      logger.error('Error saving wallet token cursor:', e);
    }
  }

  touchWalletTokenCursor(id) {
    try {
      db.prepare('UPDATE tracked_wallets SET token_last_checked_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    } catch (e) {
      logger.error('Error updating wallet token check timestamp:', e);
    }
  }

  classifyTokenEventType(amountDelta, solDelta, stableDelta, options = {}) {
    const hasOtherPositiveTokenDelta = !!options.hasOtherPositiveTokenDelta;
    const hasOtherNegativeTokenDelta = !!options.hasOtherNegativeTokenDelta;
    const delta = safeToNumber(amountDelta);
    if (delta > 0) {
      if (safeToNumber(solDelta) < -SOL_DELTA_EPSILON || safeToNumber(stableDelta) < -STABLE_DELTA_EPSILON) return 'buy';
      if (hasOtherNegativeTokenDelta) return 'swap_in';
      if (safeToNumber(solDelta) > SOL_DELTA_EPSILON || safeToNumber(stableDelta) > STABLE_DELTA_EPSILON) return 'swap_in';
      return 'transfer_in';
    }
    if (delta < 0) {
      if (safeToNumber(solDelta) > SOL_DELTA_EPSILON || safeToNumber(stableDelta) > STABLE_DELTA_EPSILON) return 'sell';
      if (hasOtherPositiveTokenDelta) return 'swap_out';
      if (safeToNumber(solDelta) < -SOL_DELTA_EPSILON || safeToNumber(stableDelta) < -STABLE_DELTA_EPSILON) return 'swap_out';
      return 'transfer_out';
    }
    return 'neutral';
  }

  shouldAlertTokenEvent(tokenConfig, eventType, absoluteAmount) {
    const cfg = tokenConfig || {};
    if (cfg.enabled === false || Number(cfg.enabled) === 0) return false;
    if (safeToNumber(absoluteAmount) < Math.max(0, safeToNumber(cfg.min_alert_amount || cfg.minAlertAmount || 0))) return false;

    const buysEnabled = cfg.alert_buys !== false && Number(cfg.alert_buys ?? 1) === 1;
    const sellsEnabled = cfg.alert_sells !== false && Number(cfg.alert_sells ?? 1) === 1;
    const transfersEnabled = cfg.alert_transfers === true || Number(cfg.alert_transfers || 0) === 1;

    if (eventType === 'buy' || eventType === 'swap_in') return buysEnabled;
    if (eventType === 'sell' || eventType === 'swap_out') return sellsEnabled;
    if (eventType === 'transfer_in' || eventType === 'transfer_out') return transfersEnabled;
    return false;
  }

  getAccountKeysFromParsedTx(tx) {
    const entries = tx?.transaction?.message?.accountKeys || [];
    return entries.map(entry => {
      try {
        if (typeof entry === 'string') return entry;
        if (entry?.pubkey?.toBase58) return entry.pubkey.toBase58();
        if (entry?.pubkey) return String(entry.pubkey);
        if (entry?.toBase58) return entry.toBase58();
        return String(entry || '');
      } catch (_error) {
        return '';
      }
    });
  }

  getWalletSolDeltaFromParsedTx(tx, walletAddress) {
    try {
      const walletLower = normalizeAddress(walletAddress);
      const accountKeys = this.getAccountKeysFromParsedTx(tx);
      const idx = accountKeys.findIndex(key => normalizeAddress(key) === walletLower);
      if (idx < 0) return 0;
      const pre = safeToNumber(tx?.meta?.preBalances?.[idx] || 0);
      const post = safeToNumber(tx?.meta?.postBalances?.[idx] || 0);
      return (post - pre) / LAMPORTS_PER_SOL;
    } catch (_error) {
      return 0;
    }
  }

  extractWalletTokenBalanceMaps(tx, walletAddress) {
    const walletLower = normalizeAddress(walletAddress);
    const pre = new Map();
    const post = new Map();

    const collect = (rows, targetMap) => {
      for (const row of rows || []) {
        const owner = normalizeAddress(row?.owner);
        if (!owner || owner !== walletLower) continue;
        const mint = String(row?.mint || '').trim().toLowerCase();
        if (!mint) continue;
        const amount = parseUiAmount(row);
        if (!Number.isFinite(amount)) continue;
        targetMap.set(mint, safeToNumber(targetMap.get(mint)) + amount);
      }
    };

    collect(tx?.meta?.preTokenBalances, pre);
    collect(tx?.meta?.postTokenBalances, post);

    let preStable = 0;
    let postStable = 0;
    for (const [mint, amount] of pre.entries()) {
      if (STABLECOIN_MINTS.has(mint)) preStable += safeToNumber(amount);
    }
    for (const [mint, amount] of post.entries()) {
      if (STABLECOIN_MINTS.has(mint)) postStable += safeToNumber(amount);
    }

    return { pre, post, stableDelta: postStable - preStable };
  }

  detectTrackedTokenEventsFromParsedTx(tx, walletAddress, trackedTokenByMintLower) {
    const events = [];
    const { pre, post, stableDelta } = this.extractWalletTokenBalanceMaps(tx, walletAddress);
    const solDelta = this.getWalletSolDeltaFromParsedTx(tx, walletAddress);
    const txSignature = tx?.transaction?.signatures?.[0] || null;

    for (const [mintLower, tokenConfig] of trackedTokenByMintLower.entries()) {
      const preAmount = safeToNumber(pre.get(mintLower));
      const postAmount = safeToNumber(post.get(mintLower));
      const amountDelta = postAmount - preAmount;
      if (Math.abs(amountDelta) < 1e-9) continue;

      // Additional swap signal:
      // if another token changed in the opposite direction in the same tx, classify as swap.
      let hasOtherPositiveTokenDelta = false;
      let hasOtherNegativeTokenDelta = false;
      const allMints = new Set([...pre.keys(), ...post.keys()]);
      for (const otherMint of allMints) {
        if (otherMint === mintLower) continue;
        const otherPre = safeToNumber(pre.get(otherMint));
        const otherPost = safeToNumber(post.get(otherMint));
        const otherDelta = otherPost - otherPre;
        if (otherDelta > 1e-9) hasOtherPositiveTokenDelta = true;
        else if (otherDelta < -1e-9) hasOtherNegativeTokenDelta = true;
        if (hasOtherPositiveTokenDelta && hasOtherNegativeTokenDelta) break;
      }

      const eventType = this.classifyTokenEventType(amountDelta, solDelta, stableDelta, {
        hasOtherPositiveTokenDelta,
        hasOtherNegativeTokenDelta,
      });
      if (eventType === 'neutral') continue;

      events.push({
        txSignature,
        tokenMint: tokenConfig.token_mint || tokenConfig.tokenMint,
        tokenSymbol: tokenConfig.token_symbol || tokenConfig.tokenSymbol || null,
        tokenName: tokenConfig.token_name || tokenConfig.tokenName || null,
        eventType,
        amountDelta,
        balanceAfter: postAmount,
        solDelta,
        stableDelta,
      });
    }

    return events;
  }

  getTrackedTokenMapForGuild(guildId, tokenConfigCache = null) {
    const guildKey = String(guildId || '');
    const cache = tokenConfigCache instanceof Map ? tokenConfigCache : null;
    if (cache && cache.has(guildKey)) {
      return cache.get(guildKey);
    }

    const tokenRows = this.getTrackedTokens(guildKey).filter(token => token.enabled !== false && Number(token.enabled ?? 1) === 1);
    const tokenMap = new Map(
      tokenRows
        .map(token => [String(token.token_mint || '').trim().toLowerCase(), token])
        .filter(([mint]) => !!mint)
    );
    if (cache) cache.set(guildKey, tokenMap);
    return tokenMap;
  }

  getAllEnabledTrackedTokensByMint(mintConfigCache = null) {
    const cache = mintConfigCache instanceof Map ? mintConfigCache : null;
    if (cache && cache.has('__all_by_mint__')) {
      return cache.get('__all_by_mint__');
    }

    const rows = this.getTrackedTokens()
      .filter(token => token.enabled !== false && Number(token.enabled ?? 1) === 1);
    const byMint = new Map();
    for (const row of rows) {
      const mintLower = String(row.token_mint || '').trim().toLowerCase();
      if (!mintLower) continue;
      const arr = byMint.get(mintLower) || [];
      arr.push(row);
      byMint.set(mintLower, arr);
    }

    if (cache) cache.set('__all_by_mint__', byMint);
    return byMint;
  }

  extractOwnerTokenBalanceMaps(tx, trackedMintSetLower = null) {
    const owners = new Map();

    const getOwnerEntry = (ownerRaw) => {
      const ownerAddress = String(ownerRaw || '').trim();
      if (!ownerAddress) return null;
      const key = ownerAddress.toLowerCase();
      if (!owners.has(key)) {
        owners.set(key, {
          ownerKey: key,
          ownerAddress,
          pre: new Map(),
          post: new Map(),
        });
      }
      return owners.get(key);
    };

    const collect = (rows, targetKey) => {
      for (const row of rows || []) {
        const ownerEntry = getOwnerEntry(row?.owner);
        if (!ownerEntry) continue;
        const mint = String(row?.mint || '').trim().toLowerCase();
        if (!mint) continue;
        if (trackedMintSetLower instanceof Set && trackedMintSetLower.size > 0 && !trackedMintSetLower.has(mint) && !STABLECOIN_MINTS.has(mint)) {
          continue;
        }
        const amount = parseUiAmount(row);
        if (!Number.isFinite(amount)) continue;
        const current = targetKey === 'pre' ? ownerEntry.pre : ownerEntry.post;
        current.set(mint, safeToNumber(current.get(mint)) + amount);
      }
    };

    collect(tx?.meta?.preTokenBalances, 'pre');
    collect(tx?.meta?.postTokenBalances, 'post');

    const stableByOwner = new Map();
    for (const [ownerKey, entry] of owners.entries()) {
      let preStable = 0;
      let postStable = 0;
      for (const [mint, amount] of entry.pre.entries()) {
        if (STABLECOIN_MINTS.has(mint)) preStable += safeToNumber(amount);
      }
      for (const [mint, amount] of entry.post.entries()) {
        if (STABLECOIN_MINTS.has(mint)) postStable += safeToNumber(amount);
      }
      stableByOwner.set(ownerKey, postStable - preStable);
    }

    return { owners, stableByOwner };
  }

  detectTrackedTokenEventsFromParsedTxByOwner(tx, trackedTokenConfigByMintLower) {
    const byMint = trackedTokenConfigByMintLower instanceof Map ? trackedTokenConfigByMintLower : new Map();
    if (!byMint.size) return [];

    const trackedMintSet = new Set(byMint.keys());
    const { owners, stableByOwner } = this.extractOwnerTokenBalanceMaps(tx, trackedMintSet);
    const events = [];

    for (const ownerEntry of owners.values()) {
      const ownerAddress = ownerEntry.ownerAddress;
      const stableDelta = safeToNumber(stableByOwner.get(ownerEntry.ownerKey));
      const solDelta = this.getWalletSolDeltaFromParsedTx(tx, ownerAddress);

      const ownerDeltaByMint = new Map();
      const allMints = new Set([...ownerEntry.pre.keys(), ...ownerEntry.post.keys()]);
      for (const mint of allMints) {
        const pre = safeToNumber(ownerEntry.pre.get(mint));
        const post = safeToNumber(ownerEntry.post.get(mint));
        const delta = post - pre;
        if (Math.abs(delta) < 1e-9) continue;
        ownerDeltaByMint.set(mint, delta);
      }
      if (!ownerDeltaByMint.size) continue;

      for (const [mintLower, amountDelta] of ownerDeltaByMint.entries()) {
        if (!trackedMintSet.has(mintLower)) continue;

        let hasOtherPositiveTokenDelta = false;
        let hasOtherNegativeTokenDelta = false;
        for (const [otherMint, otherDelta] of ownerDeltaByMint.entries()) {
          if (otherMint === mintLower) continue;
          if (otherDelta > 1e-9) hasOtherPositiveTokenDelta = true;
          else if (otherDelta < -1e-9) hasOtherNegativeTokenDelta = true;
          if (hasOtherPositiveTokenDelta && hasOtherNegativeTokenDelta) break;
        }

        const eventType = this.classifyTokenEventType(amountDelta, solDelta, stableDelta, {
          hasOtherPositiveTokenDelta,
          hasOtherNegativeTokenDelta,
        });
        if (eventType === 'neutral') continue;

        const tokenConfigs = byMint.get(mintLower) || [];
        if (!tokenConfigs.length) continue;
        const representative = tokenConfigs[0];
        const postAmount = safeToNumber(ownerEntry.post.get(mintLower));

        events.push({
          ownerAddress,
          tokenMint: representative.token_mint || representative.tokenMint,
          tokenSymbol: representative.token_symbol || representative.tokenSymbol || null,
          tokenName: representative.token_name || representative.tokenName || null,
          eventType,
          amountDelta,
          balanceAfter: postAmount,
          solDelta,
          stableDelta,
          tokenConfigs,
        });
      }
    }

    return events;
  }

  async processParsedTokenActivityByMint({
    tx,
    signature,
    eventTime,
    source = 'webhook',
    mintConfigCache = null,
    rawMeta = null,
  }) {
    if (!tx || !signature) {
      return { success: false, insertedEvents: 0, duplicateEvents: 0, sentAlerts: 0, matchedOwners: 0 };
    }

    const byMint = this.getAllEnabledTrackedTokensByMint(mintConfigCache);
    if (!byMint || byMint.size === 0) {
      return { success: true, insertedEvents: 0, duplicateEvents: 0, sentAlerts: 0, matchedOwners: 0 };
    }

    const events = this.detectTrackedTokenEventsFromParsedTxByOwner(tx, byMint);
    if (!events.length) {
      return { success: true, insertedEvents: 0, duplicateEvents: 0, sentAlerts: 0, matchedOwners: 0 };
    }

    let insertedEvents = 0;
    let duplicateEvents = 0;
    let sentAlerts = 0;
    let matchedOwners = 0;
    const knownUserWalletCache = new Map();

    for (const evt of events) {
      const ownerAddress = String(evt.ownerAddress || '').trim();
      if (!ownerAddress) continue;
      if (!this.isKnownUserWallet(ownerAddress, knownUserWalletCache)) continue;
      matchedOwners += 1;

      for (const tokenCfg of evt.tokenConfigs || []) {
        const guildId = String(tokenCfg.guild_id || '').trim();
        if (!guildId) continue;
        if (!this.isTokenTrackerEnabled(guildId)) continue;

        const persist = this.saveTrackedTokenEvent({
          guildId,
          walletId: null,
          walletAddress: ownerAddress,
          tokenMint: evt.tokenMint,
          tokenSymbol: tokenCfg.token_symbol || evt.tokenSymbol,
          tokenName: tokenCfg.token_name || evt.tokenName,
          eventType: evt.eventType,
          amountDelta: evt.amountDelta,
          balanceAfter: evt.balanceAfter,
          solDelta: evt.solDelta,
          stableDelta: evt.stableDelta,
          txSignature: signature,
          eventTime,
          source,
          rawJson: {
            signature,
            eventType: evt.eventType,
            tokenMint: evt.tokenMint,
            amountDelta: evt.amountDelta,
            balanceAfter: evt.balanceAfter,
            walletAddress: ownerAddress,
            mintScoped: true,
            ...(rawMeta && typeof rawMeta === 'object' ? rawMeta : {}),
          },
        });

        if (!persist.success) continue;
        if (!persist.inserted) {
          duplicateEvents += 1;
          continue;
        }
        insertedEvents += 1;

        const shouldAlert = this.shouldAlertTokenEvent(tokenCfg, evt.eventType, Math.abs(safeToNumber(evt.amountDelta)));
        if (!shouldAlert) continue;
        await this.sendTrackedTokenAlert({
          walletRow: {
            wallet_address: ownerAddress,
            label: null,
            alert_channel_id: tokenCfg.alert_channel_id || null,
            alert_channel_ids: tokenCfg.alert_channel_ids || null,
          },
          guildId,
          evt: {
            ...evt,
            txSignature: signature,
            eventTime,
            alertChannelId: tokenCfg.alert_channel_id || null,
            alertChannelIds: tokenCfg.alert_channel_ids || null,
          },
        });
        sentAlerts += 1;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }

    return {
      success: true,
      insertedEvents,
      duplicateEvents,
      sentAlerts,
      matchedOwners,
    };
  }

  async processParsedTokenActivityForWallet({
    walletRow,
    trackedTokenByMintLower,
    tx,
    signature,
    eventTime,
    source = 'poll',
    rawMeta = null,
  }) {
    const walletAddress = String(walletRow?.wallet_address || '').trim();
    if (!walletAddress || !trackedTokenByMintLower || trackedTokenByMintLower.size === 0 || !tx || !signature) {
      return {
        success: false,
        insertedEvents: 0,
        duplicateEvents: 0,
        sentAlerts: 0,
      };
    }

    const tokenEvents = this.detectTrackedTokenEventsFromParsedTx(tx, walletAddress, trackedTokenByMintLower);
    if (!tokenEvents.length) {
      return {
        success: true,
        insertedEvents: 0,
        duplicateEvents: 0,
        sentAlerts: 0,
      };
    }

    const alerts = [];
    let insertedEvents = 0;
    let duplicateEvents = 0;

    for (const evt of tokenEvents) {
      const persist = this.saveTrackedTokenEvent({
        guildId: walletRow.guild_id || '',
        walletId: walletRow.id,
        walletAddress,
        tokenMint: evt.tokenMint,
        tokenSymbol: evt.tokenSymbol,
        tokenName: evt.tokenName,
        eventType: evt.eventType,
        amountDelta: evt.amountDelta,
        balanceAfter: evt.balanceAfter,
        solDelta: evt.solDelta,
        stableDelta: evt.stableDelta,
        txSignature: signature,
        eventTime,
        source,
        rawJson: {
          signature,
          eventType: evt.eventType,
          tokenMint: evt.tokenMint,
          amountDelta: evt.amountDelta,
          balanceAfter: evt.balanceAfter,
          walletAddress,
          ...(rawMeta && typeof rawMeta === 'object' ? rawMeta : {}),
        },
      });

      if (!persist.success) continue;
      if (!persist.inserted) {
        duplicateEvents += 1;
        continue;
      }
      insertedEvents += 1;

      const tokenCfg = trackedTokenByMintLower.get(String(evt.tokenMint || '').toLowerCase());
      const shouldAlert = this.shouldAlertTokenEvent(tokenCfg, evt.eventType, Math.abs(safeToNumber(evt.amountDelta)));
      if (!shouldAlert) continue;
      alerts.push({
        ...evt,
        txSignature: signature,
        eventTime,
        alertChannelId: tokenCfg?.alert_channel_id || tokenCfg?.alertChannelId || null,
        alertChannelIds: tokenCfg?.alert_channel_ids || tokenCfg?.alertChannelIds || null,
      });
    }

    if (!alerts.length) {
      return {
        success: true,
        insertedEvents,
        duplicateEvents,
        sentAlerts: 0,
      };
    }

    const toSend = alerts.length > TOKEN_ACTIVITY_ALERT_CAP_PER_WALLET
      ? alerts.slice(alerts.length - TOKEN_ACTIVITY_ALERT_CAP_PER_WALLET)
      : alerts;

    if (alerts.length > TOKEN_ACTIVITY_ALERT_CAP_PER_WALLET) {
      logger.warn(`[tracked-token] capped ${alerts.length - toSend.length} token alerts for wallet ${walletAddress}`);
    }

    let sentAlerts = 0;
    for (const evt of toSend) {
      await this.sendTrackedTokenAlert({ walletRow, guildId: walletRow.guild_id, evt });
      sentAlerts += 1;
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    return {
      success: true,
      insertedEvents,
      duplicateEvents,
      sentAlerts,
    };
  }

  extractWebhookSignature(event) {
    return String(
      event?.signature
      || event?.txSignature
      || event?.tx_signature
      || event?.transaction?.signature
      || event?.transaction?.signatures?.[0]
      || ''
    ).trim();
  }

  extractWebhookEventTime(event, tx = null) {
    const tsRaw = event?.timestamp ?? event?.blockTime ?? event?.block_time ?? event?.eventTime ?? event?.event_time ?? tx?.blockTime ?? null;
    const asNumber = Number(tsRaw);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      const ms = asNumber > 1e12 ? asNumber : asNumber * 1000;
      return new Date(ms).toISOString();
    }
    if (typeof tsRaw === 'string' && tsRaw.trim()) {
      const parsed = new Date(tsRaw);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    return new Date().toISOString();
  }

  extractWebhookAddresses(event) {
    const addresses = new Set();
    const add = (value) => {
      const addr = String(value || '').trim();
      if (!addr) return;
      addresses.add(addr.toLowerCase());
    };

    add(event?.feePayer);
    add(event?.fee_payer);
    add(event?.signer);
    add(event?.fromWallet);
    add(event?.toWallet);

    if (Array.isArray(event?.accountData)) {
      for (const row of event.accountData) {
        add(row?.account);
        add(row?.owner);
      }
    }

    if (Array.isArray(event?.nativeTransfers)) {
      for (const transfer of event.nativeTransfers) {
        add(transfer?.fromUserAccount);
        add(transfer?.toUserAccount);
        add(transfer?.from_user_account);
        add(transfer?.to_user_account);
      }
    }

    if (Array.isArray(event?.tokenTransfers)) {
      for (const transfer of event.tokenTransfers) {
        add(transfer?.fromUserAccount);
        add(transfer?.toUserAccount);
        add(transfer?.from_user_account);
        add(transfer?.to_user_account);
        add(transfer?.fromTokenAccount);
        add(transfer?.toTokenAccount);
        add(transfer?.from_token_account);
        add(transfer?.to_token_account);
      }
    }

    return Array.from(addresses);
  }

  parseWebhookTokenAmount(transfer) {
    const direct = Number(transfer?.tokenAmount);
    if (Number.isFinite(direct) && direct > 0) return direct;

    const directAlt = Number(transfer?.amount);
    if (Number.isFinite(directAlt) && directAlt > 0) return directAlt;

    const raw = transfer?.rawTokenAmount || transfer?.raw_token_amount || null;
    const rawAmount = Number(raw?.tokenAmount ?? raw?.token_amount);
    const decimals = Number(raw?.decimals ?? transfer?.decimals);
    if (Number.isFinite(rawAmount) && Number.isFinite(decimals) && decimals >= 0) {
      const scaled = rawAmount / Math.pow(10, decimals);
      if (Number.isFinite(scaled) && scaled > 0) return scaled;
    }

    return 0;
  }

  parseWebhookLamports(transfer) {
    const amount = Number(transfer?.amount ?? transfer?.lamports);
    if (Number.isFinite(amount) && amount > 0) return amount;
    return 0;
  }

  async processWebhookTokenActivityFromPayload({
    event,
    signature,
    eventTime,
    source = 'webhook',
    mintConfigCache = null,
    rawMeta = null,
  }) {
    const byMint = this.getAllEnabledTrackedTokensByMint(mintConfigCache);
    if (!byMint || byMint.size === 0) {
      return { success: true, insertedEvents: 0, duplicateEvents: 0, sentAlerts: 0, matchedOwners: 0 };
    }

    const tokenTransfers = Array.isArray(event?.tokenTransfers) ? event.tokenTransfers : [];
    const nativeTransfers = Array.isArray(event?.nativeTransfers) ? event.nativeTransfers : [];
    if (!tokenTransfers.length && !nativeTransfers.length) {
      return { success: true, insertedEvents: 0, duplicateEvents: 0, sentAlerts: 0, matchedOwners: 0 };
    }

    const ownerTokenDeltas = new Map();
    const ownerSolDeltas = new Map();
    const addTokenDelta = (ownerRaw, mintRaw, deltaRaw) => {
      const owner = normalizeAddress(ownerRaw);
      const mint = String(mintRaw || '').trim().toLowerCase();
      const delta = safeToNumber(deltaRaw);
      if (!owner || !mint || Math.abs(delta) < 1e-12) return;
      if (!ownerTokenDeltas.has(owner)) ownerTokenDeltas.set(owner, new Map());
      const mintMap = ownerTokenDeltas.get(owner);
      mintMap.set(mint, safeToNumber(mintMap.get(mint)) + delta);
    };
    const addSolDelta = (ownerRaw, deltaRaw) => {
      const owner = normalizeAddress(ownerRaw);
      const delta = safeToNumber(deltaRaw);
      if (!owner || Math.abs(delta) < 1e-12) return;
      ownerSolDeltas.set(owner, safeToNumber(ownerSolDeltas.get(owner)) + delta);
    };

    for (const transfer of tokenTransfers) {
      const mint = transfer?.mint;
      if (!mint) continue;
      const amount = this.parseWebhookTokenAmount(transfer);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const fromOwner = transfer?.fromUserAccount || transfer?.from_user_account;
      const toOwner = transfer?.toUserAccount || transfer?.to_user_account;
      if (fromOwner) addTokenDelta(fromOwner, mint, -amount);
      if (toOwner) addTokenDelta(toOwner, mint, amount);
    }

    for (const transfer of nativeTransfers) {
      const lamports = this.parseWebhookLamports(transfer);
      if (lamports <= 0) continue;
      const solAmount = lamports / LAMPORTS_PER_SOL;
      const fromOwner = transfer?.fromUserAccount || transfer?.from_user_account;
      const toOwner = transfer?.toUserAccount || transfer?.to_user_account;
      if (fromOwner) addSolDelta(fromOwner, -solAmount);
      if (toOwner) addSolDelta(toOwner, solAmount);
    }

    let insertedEvents = 0;
    let duplicateEvents = 0;
    let sentAlerts = 0;
    let matchedOwners = 0;
    const knownUserWalletCache = new Map();

    for (const [ownerLower, deltaByMint] of ownerTokenDeltas.entries()) {
      if (!deltaByMint || deltaByMint.size === 0) continue;
      const ownerAddress = String(ownerLower || '').trim();
      if (!ownerAddress) continue;
      if (!this.isKnownUserWallet(ownerAddress, knownUserWalletCache)) continue;

      const trackedMints = [...deltaByMint.keys()].filter(mint => byMint.has(mint));
      if (!trackedMints.length) continue;
      matchedOwners += 1;

      let stableDelta = 0;
      for (const [mint, delta] of deltaByMint.entries()) {
        if (STABLECOIN_MINTS.has(mint)) stableDelta += safeToNumber(delta);
      }
      const solDelta = safeToNumber(ownerSolDeltas.get(ownerLower));

      for (const mintLower of trackedMints) {
        const amountDelta = safeToNumber(deltaByMint.get(mintLower));
        if (Math.abs(amountDelta) < 1e-9) continue;

        let hasOtherPositiveTokenDelta = false;
        let hasOtherNegativeTokenDelta = false;
        for (const [otherMint, otherDelta] of deltaByMint.entries()) {
          if (otherMint === mintLower) continue;
          if (safeToNumber(otherDelta) > 1e-9) hasOtherPositiveTokenDelta = true;
          else if (safeToNumber(otherDelta) < -1e-9) hasOtherNegativeTokenDelta = true;
          if (hasOtherPositiveTokenDelta && hasOtherNegativeTokenDelta) break;
        }

        const eventType = this.classifyTokenEventType(amountDelta, solDelta, stableDelta, {
          hasOtherPositiveTokenDelta,
          hasOtherNegativeTokenDelta,
        });
        if (eventType === 'neutral') continue;

        const tokenConfigs = byMint.get(mintLower) || [];
        const representative = tokenConfigs[0] || {};
        for (const tokenCfg of tokenConfigs) {
          const guildId = String(tokenCfg.guild_id || '').trim();
          if (!guildId) continue;
          if (!this.isTokenTrackerEnabled(guildId)) continue;

          const persist = this.saveTrackedTokenEvent({
            guildId,
            walletId: null,
            walletAddress: ownerAddress,
            tokenMint: representative.token_mint || representative.tokenMint || mintLower,
            tokenSymbol: tokenCfg.token_symbol || representative.token_symbol || null,
            tokenName: tokenCfg.token_name || representative.token_name || null,
            eventType,
            amountDelta,
            balanceAfter: null,
            solDelta,
            stableDelta,
            txSignature: signature,
            eventTime,
            source,
            rawJson: {
              signature,
              eventType,
              tokenMint: representative.token_mint || representative.tokenMint || mintLower,
              amountDelta,
              balanceAfter: null,
              walletAddress: ownerAddress,
              payloadFallback: true,
              ...(rawMeta && typeof rawMeta === 'object' ? rawMeta : {}),
            },
          });

          if (!persist.success) continue;
          if (!persist.inserted) {
            duplicateEvents += 1;
            continue;
          }
          insertedEvents += 1;

          const shouldAlert = this.shouldAlertTokenEvent(tokenCfg, eventType, Math.abs(safeToNumber(amountDelta)));
          if (!shouldAlert) continue;
          await this.sendTrackedTokenAlert({
            walletRow: {
              wallet_address: ownerAddress,
              label: null,
              alert_channel_id: tokenCfg.alert_channel_id || null,
              alert_channel_ids: tokenCfg.alert_channel_ids || null,
            },
            guildId,
            evt: {
              txSignature: signature,
              tokenMint: representative.token_mint || representative.tokenMint || mintLower,
              tokenSymbol: tokenCfg.token_symbol || representative.token_symbol || null,
              tokenName: tokenCfg.token_name || representative.token_name || null,
              eventType,
              amountDelta,
              balanceAfter: null,
              solDelta,
              stableDelta,
              eventTime,
              alertChannelId: tokenCfg.alert_channel_id || null,
              alertChannelIds: tokenCfg.alert_channel_ids || null,
            },
          });
          sentAlerts += 1;
          await new Promise(resolve => setTimeout(resolve, 120));
        }
      }
    }

    return {
      success: true,
      insertedEvents,
      duplicateEvents,
      sentAlerts,
      matchedOwners,
    };
  }

  async ingestWebhookEvent(event, options = {}) {
    const source = String(options.source || 'webhook');
    const attempt = Math.max(0, Number(options.attempt || 0));
    const allowImmediateRetry = options.allowImmediateRetry !== false;
    const allowDurableRetry = options.allowDurableRetry !== false;
    const signature = this.extractWebhookSignature(event);
    if (!signature) {
      return { success: true, ignored: true, reason: 'missing_signature' };
    }

    const tokenConfigCache = options.tokenConfigCache instanceof Map ? options.tokenConfigCache : new Map();
    const mintConfigCache = options.mintConfigCache instanceof Map ? options.mintConfigCache : new Map();
    const hintedAddresses = this.extractWebhookAddresses(event);
    let candidateWallets = hintedAddresses.length ? this.getTrackedWalletsByAddresses(hintedAddresses) : [];
    const eventTime = this.extractWebhookEventTime(event, null);
    const hasRichAddressHints =
      (Array.isArray(event?.accountData) && event.accountData.length > 0)
      || (Array.isArray(event?.nativeTransfers) && event.nativeTransfers.length > 0)
      || (Array.isArray(event?.tokenTransfers) && event.tokenTransfers.length > 0);
    const hasTrackedTokensEnabled = (this.getAllEnabledTrackedTokensByMint(mintConfigCache)?.size || 0) > 0;
    if (hasRichAddressHints && hintedAddresses.length > 0 && candidateWallets.length === 0) {
      // If there are tracked tokens configured, continue into parsed tx path so mint-scoped
      // fallback can still classify and alert without tracked wallets.
      if (!hasTrackedTokensEnabled) {
        this.removeDurableWebhookRetry(signature);
        return { success: true, ignored: true, reason: 'no_tracked_wallets' };
      }
    }

    let tx = null;
    try {
      tx = await this.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
    } catch (e) {
      logger.error(`[tracked-token-webhook] parsed transaction fetch failed for ${signature}:`, e?.message || e);
      const payloadProcessed = await this.processWebhookTokenActivityFromPayload({
        event,
        signature,
        eventTime,
        source: `${source}-payload`,
        mintConfigCache,
        rawMeta: {
          webhookSourceType: String(event?.type || event?.eventType || '').trim() || null,
          payloadReason: 'parsed_tx_fetch_failed',
        },
      });
      if ((payloadProcessed?.insertedEvents || 0) > 0 || (payloadProcessed?.duplicateEvents || 0) > 0 || (payloadProcessed?.sentAlerts || 0) > 0) {
        this.removeDurableWebhookRetry(signature);
        return {
          success: true,
          ignored: false,
          reason: undefined,
          signature,
          matchedWallets: 0,
          insertedEvents: Number(payloadProcessed?.insertedEvents || 0),
          duplicateEvents: Number(payloadProcessed?.duplicateEvents || 0),
          sentAlerts: Number(payloadProcessed?.sentAlerts || 0),
        };
      }
      if (allowImmediateRetry && attempt < TOKEN_WEBHOOK_RETRY_MAX) {
        this.scheduleWebhookRetry(event, { source, attempt, signature, reason: 'parsed_tx_fetch_failed' });
      }
      if (allowDurableRetry) {
        this.enqueueDurableWebhookRetry(event, {
          source,
          attempt,
          signature,
          reason: 'parsed_tx_fetch_failed',
          errorMessage: e?.message || '',
        });
      }
      return { success: false, ignored: true, reason: 'parsed_tx_fetch_failed', errorMessage: e?.message || '' };
    }

    if (!tx) {
      const payloadProcessed = await this.processWebhookTokenActivityFromPayload({
        event,
        signature,
        eventTime,
        source: `${source}-payload`,
        mintConfigCache,
        rawMeta: {
          webhookSourceType: String(event?.type || event?.eventType || '').trim() || null,
          payloadReason: 'tx_not_available',
        },
      });
      if ((payloadProcessed?.insertedEvents || 0) > 0 || (payloadProcessed?.duplicateEvents || 0) > 0 || (payloadProcessed?.sentAlerts || 0) > 0) {
        this.removeDurableWebhookRetry(signature);
        return {
          success: true,
          ignored: false,
          reason: undefined,
          signature,
          matchedWallets: 0,
          insertedEvents: Number(payloadProcessed?.insertedEvents || 0),
          duplicateEvents: Number(payloadProcessed?.duplicateEvents || 0),
          sentAlerts: Number(payloadProcessed?.sentAlerts || 0),
        };
      }
      if (allowImmediateRetry && attempt < TOKEN_WEBHOOK_RETRY_MAX) {
        this.scheduleWebhookRetry(event, { source, attempt, signature, reason: 'tx_not_available' });
      } else {
        logger.warn(`[tracked-token-webhook] tx not available after ${attempt + 1} attempts for ${signature}`);
      }
      if (allowDurableRetry) {
        this.enqueueDurableWebhookRetry(event, {
          source,
          attempt,
          signature,
          reason: 'tx_not_available',
        });
      }
      return { success: true, ignored: true, reason: 'tx_not_available' };
    }

    if (!candidateWallets.length) {
      const accountKeys = this.getAccountKeysFromParsedTx(tx).map(normalizeAddress).filter(Boolean);
      candidateWallets = accountKeys.length ? this.getTrackedWalletsByAddresses(accountKeys) : [];
    }
    if (!candidateWallets.length) {
      if (!hasTrackedTokensEnabled) {
        this.removeDurableWebhookRetry(signature);
        return { success: true, ignored: true, reason: 'no_tracked_wallets' };
      }
    }
    const eventTimeResolved = this.extractWebhookEventTime(event, tx);
    let matchedWallets = 0;
    let insertedEvents = 0;
    let duplicateEvents = 0;
    let sentAlerts = 0;

    for (const walletRow of candidateWallets) {
      const walletGuild = String(walletRow.guild_id || '');
      if (!this.isTokenTrackerEnabled(walletGuild)) continue;

      const tokenMap = this.getTrackedTokenMapForGuild(walletGuild, tokenConfigCache);
      if (!tokenMap || tokenMap.size === 0) continue;

      matchedWallets += 1;
      const processed = await this.processParsedTokenActivityForWallet({
        walletRow,
        trackedTokenByMintLower: tokenMap,
        tx,
        signature,
        eventTime: eventTimeResolved,
        source,
        rawMeta: {
          webhookSourceType: String(event?.type || event?.eventType || '').trim() || null,
        },
      });
      insertedEvents += Number(processed?.insertedEvents || 0);
      duplicateEvents += Number(processed?.duplicateEvents || 0);
      sentAlerts += Number(processed?.sentAlerts || 0);
    }

    // Fallback: mint-scoped processing for servers that track tokens
    // without configuring tracked wallets.
    if (matchedWallets === 0) {
      const mintScoped = await this.processParsedTokenActivityByMint({
        tx,
        signature,
        eventTime: eventTimeResolved,
        source,
        mintConfigCache,
        rawMeta: {
          webhookSourceType: String(event?.type || event?.eventType || '').trim() || null,
        },
      });
      insertedEvents += Number(mintScoped?.insertedEvents || 0);
      duplicateEvents += Number(mintScoped?.duplicateEvents || 0);
      sentAlerts += Number(mintScoped?.sentAlerts || 0);
    }

    const result = {
      success: true,
      ignored: matchedWallets === 0 && insertedEvents === 0,
      reason: matchedWallets === 0 ? 'no_matching_wallets_or_tokens' : undefined,
      signature,
      matchedWallets,
      insertedEvents,
      duplicateEvents,
      sentAlerts,
    };
    this.removeDurableWebhookRetry(signature);
    return result;
  }

  async ingestWebhookBatch(events = [], options = {}) {
    const batch = Array.isArray(events) ? events : [events];
    const source = String(options.source || 'webhook');
    const tokenConfigCache = new Map();
    const mintConfigCache = new Map();
    const seenSignatures = new Set();

    let processed = 0;
    let ignored = 0;
    let failed = 0;
    let insertedEvents = 0;
    let duplicateEvents = 0;
    let sentAlerts = 0;
    const ignoredReasons = {};

    for (const event of batch) {
      const signature = this.extractWebhookSignature(event);
      if (signature && seenSignatures.has(signature)) {
        ignored += 1;
        continue;
      }
      if (signature) seenSignatures.add(signature);

      try {
        const result = await this.ingestWebhookEvent(event, { source, tokenConfigCache, mintConfigCache, attempt: 0 });
        if (!result?.success) {
          failed += 1;
          continue;
        }
        if (result.ignored) {
          ignored += 1;
          const reason = String(result.reason || 'unknown').trim() || 'unknown';
          ignoredReasons[reason] = Number(ignoredReasons[reason] || 0) + 1;
        } else {
          processed += 1;
        }
        insertedEvents += Number(result.insertedEvents || 0);
        duplicateEvents += Number(result.duplicateEvents || 0);
        sentAlerts += Number(result.sentAlerts || 0);
      } catch (e) {
        failed += 1;
        logger.error('[tracked-token-webhook] ingest event failed:', e?.message || e);
      }
    }

    return {
      received: batch.length,
      processed,
      ignored,
      failed,
      insertedEvents,
      duplicateEvents,
      sentAlerts,
      ignoredReasons,
    };
  }

  async processTrackedWalletTokenActivity(walletRow, trackedTokenByMintLower) {
    const walletAddress = String(walletRow?.wallet_address || '').trim();
    if (!walletAddress) return;

    if (!isValidSolanaAddress(walletAddress)) {
      const warnKey = `${walletRow.guild_id || 'global'}:${walletAddress}`;
      if (!this.invalidWalletWarned.has(warnKey)) {
        logger.warn(`[tracked-token] skipping invalid tracked wallet ${walletAddress}${walletRow.guild_id ? ` (guild ${walletRow.guild_id})` : ''}`);
        this.invalidWalletWarned.add(warnKey);
      }
      return;
    }

    let signatureRows = [];
    try {
      signatureRows = await this.connection.getSignaturesForAddress(new PublicKey(walletAddress), { limit: TOKEN_ACTIVITY_POLL_LIMIT });
    } catch (e) {
      logger.error(`[tracked-token] signature poll failed for ${walletAddress}:`, e?.message || e);
      return;
    }

    if (!signatureRows.length) {
      this.touchWalletTokenCursor(walletRow.id);
      return;
    }

    const latestSignature = signatureRows[0]?.signature || null;
    const previousCursor = String(walletRow.token_last_signature || '').trim();
    if (!previousCursor) {
      this.saveWalletTokenCursor(walletRow.id, latestSignature);
      logger.log(`[tracked-token] baseline cursor set for wallet ${walletAddress}${walletRow.guild_id ? ` [guild ${walletRow.guild_id}]` : ''}`);
      return;
    }

    const newSignatures = [];
    for (const row of signatureRows) {
      if (!row?.signature) continue;
      if (row.signature === previousCursor) break;
      newSignatures.push(row.signature);
    }

    if (!newSignatures.length) {
      this.touchWalletTokenCursor(walletRow.id);
      return;
    }

    const chronologicalSignatures = newSignatures.slice().reverse();
    let parsedTxs = [];
    try {
      parsedTxs = await this.connection.getParsedTransactions(chronologicalSignatures, { maxSupportedTransactionVersion: 0 });
    } catch (e) {
      logger.error(`[tracked-token] parsed transaction fetch failed for ${walletAddress}:`, e?.message || e);
      // Do not advance cursor on fetch failure; retry these signatures on next poll.
      return;
    }

    const sigMetaBySignature = new Map(signatureRows.map(row => [row.signature, row]));
    let newestParsedSignature = null;

    for (let i = 0; i < parsedTxs.length; i++) {
      const tx = parsedTxs[i];
      const signature = chronologicalSignatures[i];
      if (!tx || !signature) continue;
      newestParsedSignature = signature;

      const sigMeta = sigMetaBySignature.get(signature);
      const eventTime = sigMeta?.blockTime ? new Date(sigMeta.blockTime * 1000).toISOString() : new Date().toISOString();
      await this.processParsedTokenActivityForWallet({
        walletRow,
        trackedTokenByMintLower,
        tx,
        signature,
        eventTime,
        source: 'poll',
      });
    }

    // Advance cursor only to newest successfully parsed signature.
    // This avoids skipping signatures that were returned but not yet parseable.
    if (newestParsedSignature) {
      this.saveWalletTokenCursor(walletRow.id, newestParsedSignature);
    } else {
      this.touchWalletTokenCursor(walletRow.id);
    }

    return;
  }

  async pollTrackedTokenActivity(guildId = null) {
    const wallets = this.getTrackedWallets(guildId).filter(wallet => Number(wallet.enabled || 0) === 1);
    if (!wallets.length) return;

    const tokenConfigCache = new Map();
    for (const walletRow of wallets) {
      const walletGuild = String(walletRow.guild_id || '');
      if (!this.isTokenTrackerEnabled(walletGuild)) continue;
      const tokenMap = this.getTrackedTokenMapForGuild(walletGuild, tokenConfigCache);
      if (!tokenMap || tokenMap.size === 0) continue;

      try {
        await this.processTrackedWalletTokenActivity(walletRow, tokenMap);
      } catch (e) {
        logger.error(`[tracked-token] wallet poll failed for ${walletRow.wallet_address}:`, e?.message || e);
      }
      await new Promise(resolve => setTimeout(resolve, 350));
    }
  }

  savePanelMessageId(id, messageId) {
    try {
      db.prepare('UPDATE tracked_wallets SET panel_message_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(messageId, id);
    } catch (e) {
      logger.error('Error saving panel message ID:', e);
    }
  }

  // ─── Holdings Panel ───────────────────────────────────────────────────────

  async buildHoldingsEmbed(walletRow, guildId) {
    const addr = walletRow.wallet_address;
    const label = walletRow.label || `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    const trackedTokens = this.isTokenTrackerEnabled(guildId)
      ? this.getTrackedTokens(guildId).filter(t => Number(t.enabled || 0) === 1)
      : [];
    const trackedMints = [...new Set(trackedTokens.map(t => String(t.token_mint || '').trim()).filter(Boolean))];

    // Fetch NFTs and balances in parallel
    let nfts = [];
    let balances = { sol: null, usdc: null };
    let tokenBalances = [];
    try {
      [nfts, balances, tokenBalances] = await Promise.all([
        nftService.getNFTsForWallet(addr, { guildId }).catch(e => { logger.error('Error fetching NFTs:', e); return []; }),
        _getSolanaBalances(addr),
        trackedMints.length
          ? tokenService.getWalletTokenBalances(addr, { guildId, mintFilter: trackedMints }).catch(e => { logger.error('Error fetching tracked token balances:', e); return []; })
          : Promise.resolve([])
      ]);
    } catch (e) {
      logger.error('Error fetching holdings data:', e);
    }

    const total = nfts.length;

    // Group NFTs by collection name (first 5 unique names, then "and X more")
    const nameGroups = {};
    for (const nft of nfts) {
      const key = nft.name?.replace(/#\d+$/, '').trim() || 'Unknown';
      nameGroups[key] = (nameGroups[key] || 0) + 1;
    }

    const collectionLines = Object.entries(nameGroups)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => `• **${name}** × ${count}`);

    if (Object.keys(nameGroups).length > 8) {
      collectionLines.push(`_...and ${Object.keys(nameGroups).length - 8} more collections_`);
    }

    // Trait breakdown from first collection (most common)
    let traitSection = null;
    if (nfts.length > 0) {
      const allTraits = nftService.getAllTraits(nfts);
      const traitLines = Object.entries(allTraits)
        .slice(0, 4)
        .map(([type, values]) => `**${type}**: ${values.slice(0, 3).join(', ')}${values.length > 3 ? ` +${values.length - 3}` : ''}`);
      if (traitLines.length) traitSection = traitLines.join('\n');
    }

    const branding = getBranding(guildId || '', 'nfttracker');
    const client = clientProvider.getClient();
    const botAvatar = client?.user?.displayAvatarURL?.() || null;
    const logoUrl = branding.logo || botAvatar;

    // Chain emoji icons (configurable via Superadmin → Chain Emoji Map)
    const settingsManager = require('../config/settings');
    const chainEmojiMap = settingsManager.getSettings().chainEmojiMap || {};
    const solEmoji  = chainEmojiMap['solana'] || process.env.SOL_EMOJI  || '◎';
    const usdcEmoji = chainEmojiMap['usdc']   || process.env.USDC_EMOJI || '💵';

    const embed = new EmbedBuilder()
      .setTitle(`💼 Holdings: ${label}`)
      .setDescription(
        total === 0
          ? '_No NFTs found in this wallet_'
          : collectionLines.join('\n')
      )
      .setTimestamp()
      .setFooter({ text: `Last updated` });

    // SOL and USDC balance row
    if (balances.sol !== null) {
      embed.addFields(
        { name: `${solEmoji} SOL`, value: balances.sol.toFixed(4), inline: true },
        { name: `${usdcEmoji} USDC`, value: balances.usdc !== null ? balances.usdc.toFixed(2) : '—', inline: true },
        { name: '\u200b', value: '\u200b', inline: true } // spacer
      );
    }

    embed.addFields(
      { name: '🖼️ Total NFTs', value: total.toString(), inline: true },
      { name: '📍 Address', value: `\`${addr.slice(0, 6)}...${addr.slice(-4)}\``, inline: true }
    );

    if (traitSection) {
      embed.addFields({ name: '🎨 Traits', value: traitSection, inline: false });
    }

    if (trackedTokens.length > 0) {
      const trackedByMint = new Map(
        trackedTokens.map(t => [String(t.token_mint || '').trim().toLowerCase(), t])
      );

      const tokenLines = (tokenBalances || [])
        .filter(t => String(t.mint || '').toLowerCase() !== USDC_MINT.toLowerCase())
        .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))
        .map(t => {
          const conf = trackedByMint.get(String(t.mint || '').toLowerCase());
          const symbol = conf?.token_symbol || conf?.token_name || `${t.mint.slice(0, 4)}...${t.mint.slice(-4)}`;
          const amount = Number(t.amount || 0);
          return `• **${symbol}**: ${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
        });

      if (tokenLines.length > 0) {
        const preview = tokenLines.slice(0, 8);
        if (tokenLines.length > 8) preview.push(`_...and ${tokenLines.length - 8} more tracked tokens_`);
        embed.addFields({ name: '🪙 Tracked Tokens', value: preview.join('\n'), inline: false });
      } else {
        embed.addFields({ name: '🪙 Tracked Tokens', value: '_No tracked token balances found in this wallet_', inline: false });
      }
    }

    applyEmbedBranding(embed, {
      guildId: guildId || '',
      moduleKey: 'wallettracker',
      defaultColor: '#FFD700',
      defaultFooter: 'Wallet Holdings',
      fallbackLogoUrl: logoUrl,
    });

    const solscanUrl = `https://solscan.io/account/${addr}`;
    const meUrl = `https://magiceden.io/u/${addr}`;

    const buttons = [
      new ButtonBuilder().setLabel('Solscan').setURL(solscanUrl).setStyle(ButtonStyle.Link).setEmoji('🔍'),
      new ButtonBuilder().setLabel('Magic Eden').setURL(meUrl).setStyle(ButtonStyle.Link).setEmoji('🌊'),
    ];
    const components = [new ActionRowBuilder().addComponents(...buttons)];

    return { embed, components };
  }

  /**
   * Post (or update) a holdings panel for a tracked wallet in a given channel.
   * If walletRow.panel_message_id exists, tries to edit that message first.
   */
  async postHoldingsPanel(walletRow, targetChannelId, guildId) {
    const client = clientProvider.getClient();
    if (!client) return { success: false, message: 'Discord client not available' };

    const channelId = targetChannelId || walletRow.panel_channel_id;
    if (!channelId) return { success: false, message: 'No channel configured for holdings panel' };

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.send) return { success: false, message: 'Channel not found or bot lacks access' };

    const { embed, components } = await this.buildHoldingsEmbed(walletRow, guildId);

    // Try to edit existing panel message
    if (walletRow.panel_message_id) {
      try {
        const existing = await channel.messages.fetch(walletRow.panel_message_id).catch(() => null);
        if (existing) {
          await existing.edit({ embeds: [embed], components });
          logger.log(`[wallet-panel] updated panel for ${walletRow.wallet_address} in channel ${channelId}`);
          return { success: true, action: 'updated', messageId: walletRow.panel_message_id };
        }
      } catch (e) {
        logger.warn(`[wallet-panel] could not edit old panel message: ${e.message}`);
      }
    }

    // Post fresh panel
    const msg = await channel.send({ embeds: [embed], components });
    this.savePanelMessageId(walletRow.id, msg.id);
    logger.log(`[wallet-panel] posted panel for ${walletRow.wallet_address} in channel ${channelId}`);
    return { success: true, action: 'posted', messageId: msg.id };
  }

  /**
   * Refresh all panels for a guild (or all guilds).
   * Called by a cron job to keep holdings up to date.
   */
  async refreshAllPanels(guildId) {
    const wallets = this.getTrackedWallets(guildId).filter(w => w.enabled && w.panel_channel_id);
    for (const wallet of wallets) {
      try {
        await this.postHoldingsPanel(wallet, wallet.panel_channel_id, wallet.guild_id);
        await new Promise(r => setTimeout(r, 1500)); // avoid rate limits
      } catch (e) {
        logger.error(`[wallet-panel] refresh failed for ${wallet.wallet_address}:`, e);
      }
    }
  }

  // ─── TX alert helpers (called from nftActivityService) ───────────────────

  resolveWalletIdentity(walletAddress) {
    const wallet = String(walletAddress || '').trim();
    if (!wallet) return { text: 'unknown', isAddress: true };

    const shortWallet = `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;

    try {
      const row = db.prepare(`
        SELECT u.username, COALESCE(u.wallet_alert_identity_opt_out, 0) AS wallet_alert_identity_opt_out
        FROM wallets w
        JOIN users u ON u.discord_id = w.discord_id
        WHERE lower(w.wallet_address) = lower(?)
        LIMIT 1
      `).get(wallet);

      if (row?.username && Number(row.wallet_alert_identity_opt_out || 0) !== 1) {
        return { text: `@${row.username}`, isAddress: false };
      }
    } catch (_error) {}

    return { text: shortWallet, isAddress: true };
  }

  isKnownUserWallet(walletAddress, cache = null) {
    const wallet = String(walletAddress || '').trim().toLowerCase();
    if (!wallet) return false;

    if (cache instanceof Map && cache.has(wallet)) {
      return cache.get(wallet) === true;
    }

    let known = false;
    try {
      const row = db.prepare(`
        SELECT 1
        FROM wallets
        WHERE lower(wallet_address) = ?
        LIMIT 1
      `).get(wallet);
      known = !!row;
    } catch (_error) {
      known = false;
    }

    if (cache instanceof Map) {
      cache.set(wallet, known);
    }
    return known;
  }

  async sendTrackedTokenAlert({ walletRow, guildId, evt }) {
    const client = clientProvider.getClient();
    if (!client) return;

    const channelIds = await this.resolveTokenAlertChannelIds({
      guildId,
      eventChannelIds: evt?.alertChannelIds,
      eventChannelId: evt?.alertChannelId,
      walletChannelIds: walletRow?.alert_channel_ids,
      walletChannelId: walletRow?.alert_channel_id,
    });
    if (!channelIds.length) {
      logger.warn(`[tracked-token-alert] skipped no channel wallet=${walletRow?.wallet_address || 'unknown'} guild=${guildId || ''}`);
      return;
    }

    const eventType = String(evt?.eventType || evt?.event_type || 'activity').toLowerCase();
    const amountDelta = safeToNumber(evt?.amountDelta ?? evt?.amount_delta);
    const absAmount = Math.abs(amountDelta);
    const tokenMint = String(evt?.tokenMint || evt?.token_mint || '').trim();
    const tokenSymbol = String(evt?.tokenSymbol || evt?.token_symbol || evt?.tokenName || evt?.token_name || '').trim()
      || (tokenMint ? `${tokenMint.slice(0, 4)}...${tokenMint.slice(-4)}` : 'Token');
    const balanceAfter = evt?.balanceAfter ?? evt?.balance_after;
    const solDelta = evt?.solDelta ?? evt?.sol_delta;
    const stableDelta = evt?.stableDelta ?? evt?.stable_delta;
    const signature = String(evt?.txSignature || evt?.tx_signature || '').trim();
    const walletIdentity = this.resolveWalletIdentity(walletRow.wallet_address);
    const walletDisplay = walletIdentity.isAddress ? `\`${walletIdentity.text}\`` : walletIdentity.text;

    const style = {
      buy: { icon: '🟢', title: 'BUY', color: '#57F287' },
      sell: { icon: '🔴', title: 'SELL', color: '#ED4245' },
      transfer_in: { icon: '📥', title: 'TRANSFER IN', color: '#3B82F6' },
      transfer_out: { icon: '📤', title: 'TRANSFER OUT', color: '#60A5FA' },
      swap_in: { icon: '🟣', title: 'BUY / SWAP IN', color: '#A78BFA' },
      swap_out: { icon: '🟠', title: 'SELL / SWAP OUT', color: '#F59E0B' },
    }[eventType] || { icon: '🧩', title: eventType.toUpperCase(), color: '#5865F2' };

    const whenTs = evt?.eventTime ? Math.floor(new Date(evt.eventTime).getTime() / 1000) : null;
    const amountFormatted = absAmount.toLocaleString(undefined, { maximumFractionDigits: 6 });

    const embed = new EmbedBuilder()
      .setTitle(`${style.icon} ${style.title}: ${tokenSymbol}`)
      .setDescription(`Wallet **${walletIdentity.text}** ${style.title.toLowerCase()} event detected.`)
      .addFields(
        { name: 'Wallet', value: walletDisplay, inline: true },
        { name: 'Amount', value: `${amountDelta >= 0 ? '+' : '-'}${amountFormatted}`, inline: true },
        { name: 'Token', value: tokenSymbol, inline: true },
      )
      .setTimestamp();

    if (balanceAfter !== null && balanceAfter !== undefined) {
      embed.addFields({
        name: 'Balance After',
        value: safeToNumber(balanceAfter).toLocaleString(undefined, { maximumFractionDigits: 6 }),
        inline: true
      });
    }
    if (solDelta !== null && solDelta !== undefined) {
      embed.addFields({
        name: 'SOL Delta',
        value: `${safeToNumber(solDelta) >= 0 ? '+' : ''}${safeToNumber(solDelta).toFixed(4)} SOL`,
        inline: true
      });
    }
    if (stableDelta !== null && stableDelta !== undefined) {
      embed.addFields({
        name: 'Stable Delta',
        value: `${safeToNumber(stableDelta) >= 0 ? '+' : ''}${safeToNumber(stableDelta).toFixed(2)}`,
        inline: true
      });
    }
    if (whenTs) {
      embed.addFields({ name: 'When', value: `<t:${whenTs}:R>`, inline: true });
    }

    const branding = getBranding(guildId || '', 'tokentracker');
    const botAvatar = client?.user?.displayAvatarURL?.() || null;
    applyEmbedBranding(embed, {
      guildId: guildId || '',
      moduleKey: 'tokentracker',
      defaultColor: style.color,
      defaultFooter: 'Powered by Guild Pilot',
      fallbackLogoUrl: branding.logo || botAvatar,
    });

    const tokenImage = await this.resolveTokenImage(tokenMint);
    if (tokenImage) {
      try { embed.setThumbnail(tokenImage); } catch (_error) {}
    }

    const buttons = [];
    if (signature) {
      buttons.push(
        new ButtonBuilder()
          .setLabel('View Tx')
          .setURL(`https://solscan.io/tx/${signature}`)
          .setStyle(ButtonStyle.Link)
          .setEmoji('🔍')
      );
    }
    if (tokenMint) {
      buttons.push(
        new ButtonBuilder()
          .setLabel('Token')
          .setURL(`https://solscan.io/token/${tokenMint}`)
          .setStyle(ButtonStyle.Link)
          .setEmoji('🪙')
      );
    }
    const components = buttons.length ? [new ActionRowBuilder().addComponents(...buttons)] : [];

    let sent = 0;
    for (const channelId of channelIds) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.send) {
        logger.warn(`[tracked-token-alert] skipped invalid channel=${channelId} guild=${guildId || ''}`);
        continue;
      }
      try {
        await channel.send({ embeds: [embed], components });
        sent += 1;
        logger.log(`[tracked-token-alert] sent wallet=${walletRow.wallet_address} guild=${guildId || ''} channel=${channelId} type=${eventType} token=${tokenMint || 'unknown'}`);
      } catch (e) {
        logger.error(`[tracked-token-alert] failed for wallet=${walletRow.wallet_address} channel=${channelId}:`, e?.message || e);
      }
    }

    if (!sent) {
      logger.warn(`[tracked-token-alert] no deliveries wallet=${walletRow?.wallet_address || 'unknown'} guild=${guildId || ''}`);
    }
  }

  /**
   * Send a wallet-level TX alert when a tracked wallet is involved in a transaction.
   */
  async sendWalletAlert({ walletRow, guildId, evt, typeIcon, priceDisplay, chain }) {
    const client = clientProvider.getClient();
    if (!client || !walletRow.alert_channel_id) return;

    const channel = await client.channels.fetch(walletRow.alert_channel_id).catch(() => null);
    if (!channel || !channel.send) return;

    const label = walletRow.label || `${walletRow.wallet_address.slice(0, 6)}...${walletRow.wallet_address.slice(-4)}`;
    const role = evt.from_wallet?.toLowerCase() === walletRow.wallet_address.toLowerCase() ? 'Sent' : 'Received';
    const eventType = (evt.eventType || evt.event_type || 'activity').toUpperCase();

    const branding = getBranding(guildId || '', 'wallettracker');
    const botAvatar = client?.user?.displayAvatarURL?.() || null;

    const embed = new EmbedBuilder()
      .setTitle(`${typeIcon} Wallet Alert: ${label}`)
      .setDescription(`**${role}** — ${eventType} detected`)
      .addFields(
        { name: 'Wallet', value: `\`${walletRow.wallet_address.slice(0, 6)}...${walletRow.wallet_address.slice(-4)}\``, inline: true },
        { name: 'Action', value: `${role} ${eventType}`, inline: true },
      )
      .setTimestamp();

    if (evt.token_name || evt.tokenName) {
      embed.addFields({ name: '🖼️ Token', value: evt.token_name || evt.tokenName, inline: true });
    }
    if (priceDisplay && priceDisplay !== '—') {
      embed.addFields({ name: '💰 Price', value: priceDisplay, inline: true });
    }

    const colorMap = { MINT: '#57F287', SELL: '#57F287', LIST: '#FEE75C', DELIST: '#5865F2', TRANSFER: '#EB459E' };
    applyEmbedBranding(embed, {
      guildId: guildId || '',
      moduleKey: 'wallettracker',
      defaultColor: colorMap[eventType] || '#5865F2',
      defaultFooter: 'Wallet Tracker',
      fallbackLogoUrl: branding.logo || botAvatar,
    });

    const txSig = evt.txSignature || evt.tx_signature;
    const tokenMint = evt.tokenMint || evt.token_mint;
    const buttons = [];
    if (txSig) buttons.push(new ButtonBuilder().setLabel('View Tx').setURL(`https://solscan.io/tx/${txSig}`).setStyle(ButtonStyle.Link).setEmoji('🔍'));
    if (tokenMint) buttons.push(new ButtonBuilder().setLabel('Magic Eden').setURL(`https://magiceden.io/item-details/${tokenMint}`).setStyle(ButtonStyle.Link).setEmoji('🌊'));
    const components = buttons.length ? [new ActionRowBuilder().addComponents(...buttons)] : [];

    try {
      await channel.send({ embeds: [embed], components });
      logger.log(`[wallet-alert] sent for wallet=${walletRow.wallet_address} guild=${guildId} channel=${walletRow.alert_channel_id}`);
    } catch (e) {
      logger.error(`[wallet-alert] failed for wallet=${walletRow.wallet_address}:`, e.message);
    }
  }

  isTransientWebhookRetryReason(reason) {
    return TRANSIENT_WEBHOOK_RETRY_REASONS.has(String(reason || '').trim());
  }

  getDurableWebhookRetryDelayMs(nextAttempt) {
    const base = TOKEN_WEBHOOK_DURABLE_RETRY_BASE_MS * Math.pow(2, Math.max(0, Number(nextAttempt || 1) - 1));
    return Math.min(TOKEN_WEBHOOK_DURABLE_RETRY_MAX_DELAY_MS, Math.max(TOKEN_WEBHOOK_DURABLE_RETRY_BASE_MS, Math.round(base)));
  }

  toSqliteDelayModifier(delayMs) {
    const sec = Math.max(1, Math.ceil(Number(delayMs || 0) / 1000));
    return `+${sec} seconds`;
  }

  enqueueDurableWebhookRetry(event, { source, attempt, signature, reason, errorMessage } = {}) {
    try {
      const sig = String(signature || this.extractWebhookSignature(event) || '').trim();
      if (!sig) return false;

      const transientReason = String(reason || '').trim();
      if (!this.isTransientWebhookRetryReason(transientReason)) return false;

      const nextAttempt = Math.max(1, Number(attempt || 0) + 1);
      if (nextAttempt > TOKEN_WEBHOOK_DURABLE_RETRY_MAX) return false;

      const delayMs = this.getDurableWebhookRetryDelayMs(nextAttempt);
      const delayModifier = this.toSqliteDelayModifier(delayMs);
      const payloadJson = JSON.stringify(event || {});
      const sourceTag = String(source || 'webhook').trim() || 'webhook';

      db.prepare(`
        INSERT INTO tracked_token_webhook_retry_queue (
          signature, source, payload_json, attempt_count, next_attempt_at, last_reason, last_error, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, datetime('now', ?), ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(signature) DO UPDATE SET
          source = excluded.source,
          payload_json = excluded.payload_json,
          attempt_count = CASE
            WHEN tracked_token_webhook_retry_queue.attempt_count > excluded.attempt_count
              THEN tracked_token_webhook_retry_queue.attempt_count
            ELSE excluded.attempt_count
          END,
          next_attempt_at = excluded.next_attempt_at,
          last_reason = excluded.last_reason,
          last_error = excluded.last_error,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        sig,
        sourceTag,
        payloadJson,
        nextAttempt,
        delayModifier,
        transientReason || null,
        String(errorMessage || '').trim() || null,
      );

      logger.log(`[tracked-token-webhook] queued durable retry attempt=${nextAttempt}/${TOKEN_WEBHOOK_DURABLE_RETRY_MAX} in ${delayMs}ms for ${sig} (${transientReason || 'transient'})`);
      return true;
    } catch (error) {
      logger.error('[tracked-token-webhook] failed to queue durable retry:', error?.message || error);
      return false;
    }
  }

  removeDurableWebhookRetry(signature) {
    try {
      const sig = String(signature || '').trim();
      if (!sig) return;
      db.prepare('DELETE FROM tracked_token_webhook_retry_queue WHERE signature = ?').run(sig);
    } catch (_error) {}
  }

  async processWebhookRetryQueue(limit = TOKEN_WEBHOOK_DURABLE_RETRY_BATCH_SIZE) {
    if (this.webhookQueueSweepRunning) {
      return { success: true, skipped: true, reason: 'already_running' };
    }

    this.webhookQueueSweepRunning = true;
    try {
      const safeLimit = Math.max(1, Math.min(100, Number(limit) || TOKEN_WEBHOOK_DURABLE_RETRY_BATCH_SIZE));
      const dueRows = db.prepare(`
        SELECT signature, source, payload_json, attempt_count, last_reason
        FROM tracked_token_webhook_retry_queue
        WHERE datetime(next_attempt_at) <= datetime('now')
        ORDER BY datetime(next_attempt_at) ASC
        LIMIT ?
      `).all(safeLimit);

      if (!dueRows.length) {
        return { success: true, processed: 0, requeued: 0, removed: 0 };
      }

      let processed = 0;
      let requeued = 0;
      let removed = 0;

      for (const row of dueRows) {
        const signature = String(row?.signature || '').trim();
        if (!signature) {
          removed += db.prepare('DELETE FROM tracked_token_webhook_retry_queue WHERE signature = ?').run(row.signature).changes;
          continue;
        }

        let payload = null;
        try {
          payload = JSON.parse(String(row?.payload_json || '{}'));
        } catch (_error) {
          db.prepare('DELETE FROM tracked_token_webhook_retry_queue WHERE signature = ?').run(signature);
          removed += 1;
          continue;
        }

        const currentAttempt = Math.max(1, Number(row?.attempt_count || 1));
        let result = null;
        try {
          result = await this.ingestWebhookEvent(payload, {
            source: `${String(row?.source || 'webhook')}-durable`,
            tokenConfigCache: new Map(),
            mintConfigCache: new Map(),
            attempt: currentAttempt,
            allowImmediateRetry: false,
            allowDurableRetry: false,
          });
        } catch (error) {
          result = { success: false, ignored: true, reason: String(row?.last_reason || 'retry_error'), errorMessage: error?.message || String(error) };
        }

        processed += 1;
        const reason = String(result?.reason || '').trim();
        const transient = this.isTransientWebhookRetryReason(reason);
        const shouldRequeue = (!result?.success || (result?.ignored && transient));

        if (!shouldRequeue) {
          db.prepare('DELETE FROM tracked_token_webhook_retry_queue WHERE signature = ?').run(signature);
          removed += 1;
          continue;
        }

        const nextAttempt = currentAttempt + 1;
        if (nextAttempt > TOKEN_WEBHOOK_DURABLE_RETRY_MAX) {
          db.prepare('DELETE FROM tracked_token_webhook_retry_queue WHERE signature = ?').run(signature);
          removed += 1;
          logger.warn(`[tracked-token-webhook] durable retry exhausted for ${signature} after ${currentAttempt} attempts (${reason || 'unknown'})`);
          continue;
        }

        const delayMs = this.getDurableWebhookRetryDelayMs(nextAttempt);
        const delayModifier = this.toSqliteDelayModifier(delayMs);
        db.prepare(`
          UPDATE tracked_token_webhook_retry_queue
          SET attempt_count = ?,
              next_attempt_at = datetime('now', ?),
              last_reason = ?,
              last_error = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE signature = ?
        `).run(
          nextAttempt,
          delayModifier,
          reason || String(row?.last_reason || '').trim() || 'transient',
          String(result?.errorMessage || '').trim() || null,
          signature
        );
        requeued += 1;
      }

      if (processed > 0) {
        logger.log(`[tracked-token-webhook] durable queue sweep processed=${processed} requeued=${requeued} removed=${removed}`);
      }

      return { success: true, processed, requeued, removed };
    } catch (error) {
      logger.error('[tracked-token-webhook] durable queue sweep failed:', error?.message || error);
      return { success: false, message: error?.message || 'queue_sweep_failed' };
    } finally {
      this.webhookQueueSweepRunning = false;
    }
  }

  scheduleWebhookRetry(event, { source, attempt, signature, reason }) {
    const nextAttempt = Math.max(0, Number(attempt || 0)) + 1;
    if (nextAttempt > TOKEN_WEBHOOK_RETRY_MAX) return;

    const retryKey = `${String(signature || this.extractWebhookSignature(event) || 'unknown')}|${String(source || 'webhook')}|${nextAttempt}`;
    if (this.webhookRetryKeys.has(retryKey)) return;
    this.webhookRetryKeys.add(retryKey);

    const delayMs = TOKEN_WEBHOOK_RETRY_BASE_MS * Math.pow(2, Math.max(0, nextAttempt - 1));
    logger.log(`[tracked-token-webhook] scheduling retry attempt=${nextAttempt} in ${delayMs}ms for ${signature || 'unknown'} (${reason || 'unknown'})`);
    setTimeout(async () => {
      try {
        await this.ingestWebhookEvent(event, {
          source: source || 'webhook-retry',
          tokenConfigCache: new Map(),
          mintConfigCache: new Map(),
          attempt: nextAttempt,
          allowImmediateRetry: true,
          allowDurableRetry: false,
        });
      } catch (e) {
        logger.error(`[tracked-token-webhook] retry attempt=${nextAttempt} failed for ${signature || 'unknown'}:`, e?.message || e);
      } finally {
        this.webhookRetryKeys.delete(retryKey);
      }
    }, delayMs);
  }

  async resolveTokenAlertChannelIds({ guildId, eventChannelIds, eventChannelId, walletChannelIds, walletChannelId }) {
    const fromEvent = parseTrackedTokenAlertChannelIds(eventChannelIds, eventChannelId);
    if (fromEvent.length) return fromEvent;

    const fromWallet = parseTrackedTokenAlertChannelIds(walletChannelIds, walletChannelId);
    if (fromWallet.length) return fromWallet;

    const guild = String(guildId || '').trim();
    if (!guild) return [];

    try {
      const walletDefault = db.prepare(`
        SELECT alert_channel_id
        FROM tracked_wallets
        WHERE guild_id = ?
          AND enabled = 1
          AND alert_channel_id IS NOT NULL
          AND TRIM(alert_channel_id) <> ''
        ORDER BY id ASC
        LIMIT 1
      `).get(guild);
      const fallbackWalletChannelId = normalizeDiscordChannelId(walletDefault?.alert_channel_id);
      if (fallbackWalletChannelId) return [fallbackWalletChannelId];
    } catch (_error) {}

    try {
      const nftChannel = db.prepare(`
        SELECT channel_id
        FROM nft_tracked_collections
        WHERE guild_id = ?
          AND enabled = 1
          AND channel_id IS NOT NULL
          AND TRIM(channel_id) <> ''
        ORDER BY id ASC
        LIMIT 1
      `).get(guild);
      const fallbackNftChannelId = normalizeDiscordChannelId(nftChannel?.channel_id);
      if (fallbackNftChannelId) return [fallbackNftChannelId];
    } catch (_error) {}

    return [];
  }

  async resolveTokenAlertChannelId(args = {}) {
    const ids = await this.resolveTokenAlertChannelIds(args);
    return ids[0] || '';
  }

  _normalizeHttpImageUrl(value) {
    const url = String(value || '').trim();
    if (!url) return null;
    if (!/^https?:\/\//i.test(url)) return null;
    return url;
  }

  _getCachedTokenImage(tokenMint) {
    const key = String(tokenMint || '').trim().toLowerCase();
    if (!key) return { hit: false, value: null };
    const entry = this.tokenImageCache.get(key);
    if (!entry) return { hit: false, value: null };
    if (entry.expiresAt <= Date.now()) {
      this.tokenImageCache.delete(key);
      return { hit: false, value: null };
    }
    return { hit: true, value: entry.value || null };
  }

  _setCachedTokenImage(tokenMint, value) {
    const key = String(tokenMint || '').trim().toLowerCase();
    if (!key) return;
    this.tokenImageCache.set(key, {
      value: value || null,
      expiresAt: Date.now() + this.tokenImageCacheTtlMs,
    });
  }

  async _fetchJsonWithTimeout(url, options = {}, timeoutMs = 3500) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch (_error) {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async _resolveTokenImageFromHelius(tokenMint) {
    const apiKey = String(process.env.HELIUS_API_KEY || '').trim();
    if (!apiKey || !tokenMint) return null;

    const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    const data = await this._fetchJsonWithTimeout(
      rpcUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'gp-token-image',
          method: 'getAsset',
          params: { id: tokenMint },
        }),
      },
      4500
    );
    if (!data?.result) return null;

    const candidates = [
      data.result?.content?.links?.image,
      data.result?.content?.files?.[0]?.uri,
      data.result?.content?.metadata?.image,
      data.result?.token_info?.image,
      data.result?.token_info?.logoURI,
    ];
    for (const candidate of candidates) {
      const normalized = this._normalizeHttpImageUrl(candidate);
      if (normalized) return normalized;
    }
    return null;
  }

  async _resolveTokenImageFromJupiter(tokenMint) {
    if (!tokenMint) return null;
    const data = await this._fetchJsonWithTimeout(
      `https://lite-api.jup.ag/tokens/v1/token/${encodeURIComponent(tokenMint)}`,
      { method: 'GET' },
      3500
    );
    if (!data) return null;

    const row = Array.isArray(data) ? (data[0] || null) : data;
    if (!row) return null;
    const candidates = [row.logoURI, row.logoUri, row.logo_uri, row.image];
    for (const candidate of candidates) {
      const normalized = this._normalizeHttpImageUrl(candidate);
      if (normalized) return normalized;
    }
    return null;
  }

  async resolveTokenImage(tokenMint) {
    const mint = String(tokenMint || '').trim();
    if (!mint) return null;

    const cached = this._getCachedTokenImage(mint);
    if (cached.hit) return cached.value;

    let image = await this._resolveTokenImageFromHelius(mint);
    if (!image) {
      image = await this._resolveTokenImageFromJupiter(mint);
    }

    this._setCachedTokenImage(mint, image || null);
    return image || null;
  }
}

module.exports = new TrackedWalletsService();
