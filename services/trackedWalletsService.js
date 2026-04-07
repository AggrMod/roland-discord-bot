const db = require('../database/db');
const logger = require('../utils/logger');
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
      const addr = String(walletAddress || '').trim();
      if (!addr) return { success: false, message: 'walletAddress is required' };

      const result = db.prepare(`
        INSERT INTO tracked_wallets (guild_id, wallet_address, label, alert_channel_id, panel_channel_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        guildId || '',
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
    alertBuys = true,
    alertSells = true,
    alertTransfers = false,
    minAlertAmount = 0
  }) {
    try {
      const guild = String(guildId || '').trim();
      const mint = String(tokenMint || '').trim();
      if (!guild || !mint) return { success: false, message: 'guildId and tokenMint are required' };

      const result = db.prepare(`
        INSERT INTO tracked_tokens (
          guild_id, token_mint, token_symbol, token_name, decimals, enabled, alert_channel_id, alert_buys, alert_sells, alert_transfers, min_alert_amount
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        guild,
        mint,
        String(tokenSymbol || '').trim() || null,
        String(tokenName || '').trim() || null,
        decimals === null || decimals === undefined || decimals === '' ? null : Number(decimals),
        enabled === false ? 0 : 1,
        String(alertChannelId || '').trim() || null,
        alertBuys === false ? 0 : 1,
        alertSells === false ? 0 : 1,
        alertTransfers === true ? 1 : 0,
        Math.max(0, safeToNumber(minAlertAmount))
      );

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

      return rows.map(row => ({
        ...row,
        enabled: Number(row.enabled || 0) === 1,
        alert_buys: Number(row.alert_buys ?? 1) === 1,
        alert_sells: Number(row.alert_sells ?? 1) === 1,
        alert_transfers: Number(row.alert_transfers || 0) === 1,
        min_alert_amount: safeToNumber(row.min_alert_amount || 0),
      }));
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
      const fieldMap = {
        tokenMint: 'token_mint',
        tokenSymbol: 'token_symbol',
        tokenName: 'token_name',
        decimals: 'decimals',
        enabled: 'enabled',
        alertChannelId: 'alert_channel_id',
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

  async ingestWebhookEvent(event, options = {}) {
    const source = String(options.source || 'webhook');
    const signature = this.extractWebhookSignature(event);
    if (!signature) {
      return { success: true, ignored: true, reason: 'missing_signature' };
    }

    const tokenConfigCache = options.tokenConfigCache instanceof Map ? options.tokenConfigCache : new Map();
    const hintedAddresses = this.extractWebhookAddresses(event);
    let candidateWallets = hintedAddresses.length ? this.getTrackedWalletsByAddresses(hintedAddresses) : [];
    const hasRichAddressHints =
      (Array.isArray(event?.accountData) && event.accountData.length > 0)
      || (Array.isArray(event?.nativeTransfers) && event.nativeTransfers.length > 0)
      || (Array.isArray(event?.tokenTransfers) && event.tokenTransfers.length > 0);
    if (hasRichAddressHints && hintedAddresses.length > 0 && candidateWallets.length === 0) {
      return { success: true, ignored: true, reason: 'no_tracked_wallets' };
    }

    let tx = null;
    try {
      tx = await this.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
    } catch (e) {
      logger.error(`[tracked-token-webhook] parsed transaction fetch failed for ${signature}:`, e?.message || e);
      return { success: false, ignored: true, reason: 'parsed_tx_fetch_failed' };
    }

    if (!tx) {
      return { success: true, ignored: true, reason: 'tx_not_available' };
    }

    if (!candidateWallets.length) {
      const accountKeys = this.getAccountKeysFromParsedTx(tx).map(normalizeAddress).filter(Boolean);
      candidateWallets = accountKeys.length ? this.getTrackedWalletsByAddresses(accountKeys) : [];
    }
    if (!candidateWallets.length) {
      return { success: true, ignored: true, reason: 'no_tracked_wallets' };
    }

    const eventTime = this.extractWebhookEventTime(event, tx);
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
        eventTime,
        source,
        rawMeta: {
          webhookSourceType: String(event?.type || event?.eventType || '').trim() || null,
        },
      });
      insertedEvents += Number(processed?.insertedEvents || 0);
      duplicateEvents += Number(processed?.duplicateEvents || 0);
      sentAlerts += Number(processed?.sentAlerts || 0);
    }

    return {
      success: true,
      ignored: matchedWallets === 0 && insertedEvents === 0,
      reason: matchedWallets === 0 ? 'no_matching_wallets_or_tokens' : undefined,
      signature,
      matchedWallets,
      insertedEvents,
      duplicateEvents,
      sentAlerts,
    };
  }

  async ingestWebhookBatch(events = [], options = {}) {
    const batch = Array.isArray(events) ? events : [events];
    const source = String(options.source || 'webhook');
    const tokenConfigCache = new Map();
    const seenSignatures = new Set();

    let processed = 0;
    let ignored = 0;
    let failed = 0;
    let insertedEvents = 0;
    let duplicateEvents = 0;
    let sentAlerts = 0;

    for (const event of batch) {
      const signature = this.extractWebhookSignature(event);
      if (signature && seenSignatures.has(signature)) {
        ignored += 1;
        continue;
      }
      if (signature) seenSignatures.add(signature);

      try {
        const result = await this.ingestWebhookEvent(event, { source, tokenConfigCache });
        if (!result?.success) {
          failed += 1;
          continue;
        }
        if (result.ignored) ignored += 1;
        else processed += 1;
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
      moduleKey: 'nfttracker',
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

  async sendTrackedTokenAlert({ walletRow, guildId, evt }) {
    const client = clientProvider.getClient();
    if (!client) return;

    const channelId = String(evt?.alertChannelId || walletRow?.alert_channel_id || '').trim();
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.send) return;

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
    const label = walletRow.label || `${walletRow.wallet_address.slice(0, 6)}...${walletRow.wallet_address.slice(-4)}`;

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
      .setDescription(`Wallet **${label}** ${style.title.toLowerCase()} event detected.`)
      .addFields(
        { name: 'Wallet', value: `\`${walletRow.wallet_address.slice(0, 6)}...${walletRow.wallet_address.slice(-4)}\``, inline: true },
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

    const branding = getBranding(guildId || '', 'nfttracker');
    const botAvatar = client?.user?.displayAvatarURL?.() || null;
    applyEmbedBranding(embed, {
      guildId: guildId || '',
      moduleKey: 'nfttracker',
      defaultColor: style.color,
      defaultFooter: 'Wallet Tracker',
      fallbackLogoUrl: branding.logo || botAvatar,
    });

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

    try {
      await channel.send({ embeds: [embed], components });
      logger.log(`[tracked-token-alert] sent wallet=${walletRow.wallet_address} guild=${guildId || ''} channel=${channelId} type=${eventType} token=${tokenMint || 'unknown'}`);
    } catch (e) {
      logger.error(`[tracked-token-alert] failed for wallet=${walletRow.wallet_address}:`, e?.message || e);
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

    const branding = getBranding(guildId || '', 'nfttracker');
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
      moduleKey: 'nfttracker',
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
}

module.exports = new TrackedWalletsService();
