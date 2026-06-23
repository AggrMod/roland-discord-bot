const { Connection, PublicKey } = require('@solana/web3.js');
const { EmbedBuilder } = require('discord.js');
const db = require('../database/db');
const logger = require('../utils/logger');
const entitlementService = require('./entitlementService');
const { applyEmbedBranding } = require('./embedBranding');
const clientProvider = require('../utils/clientProvider');

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC mainnet

class TreasuryService {
  constructor() {
    this.connection = new Connection(SOLANA_RPC, 'confirmed');
    this.refreshTimer = null;
    this.client = null;
  }

  /**
   * Store Discord client reference for watch panel updates
   */
  setClient(client) {
    this.client = client;
  }

  /**
   * Initialize treasury config table
   */
  initTable() {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS treasury_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          enabled BOOLEAN DEFAULT 0,
          solana_wallet TEXT,
          refresh_hours INTEGER DEFAULT 4,
          last_updated DATETIME,
          sol_balance TEXT,
          usdc_balance TEXT,
          last_error TEXT,
          tx_alerts_enabled BOOLEAN DEFAULT 0,
          tx_alert_channel_id TEXT,
          tx_alert_incoming_only BOOLEAN DEFAULT 0,
          tx_alert_min_sol REAL DEFAULT 0,
          tx_last_signature TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Safe additive migrations
      try { db.exec('ALTER TABLE treasury_config ADD COLUMN tx_alerts_enabled BOOLEAN DEFAULT 0'); } catch (e) {}
      try { db.exec('ALTER TABLE treasury_config ADD COLUMN tx_alert_channel_id TEXT'); } catch (e) {}
      try { db.exec('ALTER TABLE treasury_config ADD COLUMN tx_alert_incoming_only BOOLEAN DEFAULT 0'); } catch (e) {}
      try { db.exec('ALTER TABLE treasury_config ADD COLUMN tx_alert_min_sol REAL DEFAULT 0'); } catch (e) {}
      try { db.exec('ALTER TABLE treasury_config ADD COLUMN tx_last_signature TEXT'); } catch (e) {}
      try { db.exec('ALTER TABLE treasury_config ADD COLUMN watch_channel_id TEXT'); } catch (e) {}
      try { db.exec('ALTER TABLE treasury_config ADD COLUMN watch_message_id TEXT'); } catch (e) {}

      // Multi-wallet tracking table
      db.exec(`
        CREATE TABLE IF NOT EXISTS treasury_wallets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT,
          address TEXT NOT NULL,
          label TEXT DEFAULT '',
          enabled BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      logger.log('✅ Treasury config table initialized');
    } catch (error) {
      logger.error('Error initializing treasury table:', error);
    }
  }

  /**
   * Get current treasury configuration
   */
  // Fix E (audit H-1): per-tenant treasury config. Default OFF means every
  // method below targets the legacy single global row exactly as before — zero
  // behavior change. When TREASURY_PER_TENANT=true AND a valid guildId is
  // supplied, config is read/written from the per-guild table instead, so one
  // tenant's admin can no longer overwrite another tenant's treasury settings.
  _perTenantEnabled() {
    return String(process.env.TREASURY_PER_TENANT || '').trim().toLowerCase() === 'true';
  }

  _scopeFor(guildId) {
    const gid = String(guildId || '').trim();
    if (this._perTenantEnabled() && /^\d{17,20}$/.test(gid)) {
      return { table: 'treasury_config_guild', whereCol: 'guild_id', key: gid, perGuild: true };
    }
    return { table: 'treasury_config', whereCol: 'id', key: 1, perGuild: false };
  }

  getConfig(guildId = null) {
    try {
      const scope = this._scopeFor(guildId);
      let config = db.prepare(`SELECT * FROM ${scope.table} WHERE ${scope.whereCol} = ?`).get(scope.key);

      if (!config) {
        if (scope.perGuild) {
          // Lazily backfill from the legacy global row so a tenant inherits any
          // pre-existing single-tenant config the first time it is touched.
          let legacy = null;
          try { legacy = db.prepare('SELECT * FROM treasury_config WHERE id = 1').get(); } catch (_error) { legacy = null; }
          db.prepare(`
            INSERT INTO treasury_config_guild (
              guild_id, enabled, solana_wallet, refresh_hours,
              tx_alerts_enabled, tx_alert_channel_id, tx_alert_incoming_only,
              tx_alert_min_sol, tx_last_signature, watch_channel_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            scope.key,
            legacy?.enabled ?? 0,
            legacy?.solana_wallet ?? null,
            legacy?.refresh_hours ?? 4,
            legacy?.tx_alerts_enabled ?? 0,
            legacy?.tx_alert_channel_id ?? null,
            legacy?.tx_alert_incoming_only ?? 0,
            legacy?.tx_alert_min_sol ?? 0,
            legacy?.tx_last_signature ?? null,
            legacy?.watch_channel_id ?? null
          );
        } else {
          db.prepare('INSERT INTO treasury_config (id, enabled, refresh_hours) VALUES (1, 0, 4)').run();
        }
        config = db.prepare(`SELECT * FROM ${scope.table} WHERE ${scope.whereCol} = ?`).get(scope.key);
      }

      return config;
    } catch (error) {
      logger.error('Error fetching treasury config:', error);
      return null;
    }
  }

  /**
   * Update treasury configuration (admin only)
   */
  updateConfig({ enabled, solanaWallet, refreshHours, txAlertsEnabled, txAlertChannelId, txAlertIncomingOnly, txAlertMinSol, txLastSignature, watchChannelId } = {}, guildId = null) {
    try {
      const scope = this._scopeFor(guildId);
      // Ensure the target row exists (creates/backfills a per-guild row if needed).
      this.getConfig(guildId);
      const updates = [];
      const params = [];

      if (enabled !== undefined) {
        updates.push('enabled = ?');
        params.push(enabled ? 1 : 0);
      }

      if (solanaWallet !== undefined) {
        // Validate Solana wallet address
        if (solanaWallet && !this.isValidSolanaAddress(solanaWallet)) {
          return { success: false, message: 'Invalid Solana wallet address' };
        }
        updates.push('solana_wallet = ?');
        params.push(solanaWallet || null);
      }

      if (refreshHours !== undefined) {
        if (refreshHours < 1 || refreshHours > 168) {
          return { success: false, message: 'Refresh hours must be between 1 and 168 (1 week)' };
        }
        updates.push('refresh_hours = ?');
        params.push(refreshHours);
      }

      if (txAlertsEnabled !== undefined) {
        updates.push('tx_alerts_enabled = ?');
        params.push(txAlertsEnabled ? 1 : 0);
      }

      if (txAlertChannelId !== undefined) {
        updates.push('tx_alert_channel_id = ?');
        params.push(txAlertChannelId || null);
      }

      if (txAlertIncomingOnly !== undefined) {
        updates.push('tx_alert_incoming_only = ?');
        params.push(txAlertIncomingOnly ? 1 : 0);
      }

      if (txAlertMinSol !== undefined) {
        const minVal = Number(txAlertMinSol);
        if (Number.isNaN(minVal) || minVal < 0) {
          return { success: false, message: 'txAlertMinSol must be a non-negative number' };
        }
        updates.push('tx_alert_min_sol = ?');
        params.push(minVal);
      }

      if (txLastSignature !== undefined) {
        updates.push('tx_last_signature = ?');
        params.push(txLastSignature || null);
      }

      if (watchChannelId !== undefined) {
        updates.push('watch_channel_id = ?');
        params.push(watchChannelId || null);
      }

      if (updates.length === 0) {
        return { success: false, message: 'No valid updates provided' };
      }

      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(scope.key); // WHERE <whereCol> = key

      const sql = `UPDATE ${scope.table} SET ${updates.join(', ')} WHERE ${scope.whereCol} = ?`;
      db.prepare(sql).run(...params);

      logger.log('📝 Treasury config updated:', { enabled, solanaWallet: solanaWallet ? this.maskAddress(solanaWallet) : null, refreshHours });

      // Restart scheduler if config changed
      this.restartScheduler();

      return { success: true, message: 'Treasury configuration updated' };
    } catch (error) {
      logger.error('Error updating treasury config:', error);
      return { success: false, message: 'Failed to update configuration' };
    }
  }

  /**
   * Validate Solana address format
   */
  isValidSolanaAddress(address) {
    try {
      new PublicKey(address);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Mask wallet address for display (show first 4 and last 4 chars)
   */
  maskAddress(address) {
    if (!address || address.length < 8) return '****';
    return `${address.substring(0, 4)}...${address.substring(address.length - 4)}`;
  }

  /**
   * Fetch treasury balances from Solana blockchain
   */
  async fetchBalances(guildId = null) {
    const scope = this._scopeFor(guildId);
    const config = this.getConfig(guildId);

    if (!config || !config.enabled) {
      return { success: false, message: 'Treasury monitoring is disabled' };
    }

    if (!config.solana_wallet) {
      return { success: false, message: 'No wallet configured' };
    }

    try {
      const walletPubkey = new PublicKey(config.solana_wallet);
      
      // Fetch SOL balance
      const solBalance = await this.connection.getBalance(walletPubkey);
      const solBalanceFormatted = (solBalance / 1e9).toFixed(4); // Convert lamports to SOL

      // Fetch USDC balance
      let usdcBalance = '0.0000';
      try {
        const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
          walletPubkey,
          { mint: new PublicKey(USDC_MINT) }
        );

        if (tokenAccounts.value.length > 0) {
          const usdcAmount = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
          usdcBalance = usdcAmount.toFixed(2);
        }
      } catch (usdcError) {
        logger.warn('Could not fetch USDC balance (wallet may not have USDC token account):', usdcError.message);
      }

      // Update database
      db.prepare(`
        UPDATE ${scope.table}
        SET sol_balance = ?,
            usdc_balance = ?,
            last_updated = CURRENT_TIMESTAMP,
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE ${scope.whereCol} = ?
      `).run(solBalanceFormatted, usdcBalance, scope.key);

      logger.log(`💰 Treasury balances updated: ${solBalanceFormatted} SOL, ${usdcBalance} USDC`);

      return {
        success: true,
        balances: {
          sol: solBalanceFormatted,
          usdc: usdcBalance,
          lastUpdated: new Date().toISOString()
        }
      };
    } catch (error) {
      logger.error('Error fetching treasury balances:', error);
      
      // Store error in database
      db.prepare(`
        UPDATE ${scope.table}
        SET last_error = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE ${scope.whereCol} = ?
      `).run(error.message, scope.key);

      return {
        success: false,
        message: 'Failed to fetch balances'
      };
    }
  }

  /**
   * Get treasury summary (safe for public consumption)
   */
  getSummary(guildId = null) {
    const config = this.getConfig(guildId);

    if (!config || !config.enabled) {
      return {
        success: false,
        message: 'Treasury monitoring is disabled'
      };
    }

    const staleness = this.checkStaleness(config.last_updated, config.refresh_hours);

    return {
      success: true,
      treasury: {
        sol: config.sol_balance || '0.0000',
        usdc: config.usdc_balance || '0.0000',
        lastUpdated: config.last_updated,
        status: staleness.status,
        staleMinutes: staleness.minutes
      }
    };
  }

  /**
   * Get treasury summary for admin (includes masked wallet)
   */
  getAdminSummary(guildId = null) {
    const config = this.getConfig(guildId);

    if (!config) {
      return {
        success: false,
        message: 'Treasury config not initialized'
      };
    }

    const staleness = this.checkStaleness(config.last_updated, config.refresh_hours);

    return {
      success: true,
      config: {
        enabled: config.enabled === 1,
        wallet: config.solana_wallet ? this.maskAddress(config.solana_wallet) : null,
        solanaWallet: config.solana_wallet || null,
        refreshHours: config.refresh_hours,
        lastUpdated: config.last_updated,
        lastError: config.last_error,
        txAlertsEnabled: config.tx_alerts_enabled === 1,
        txAlertChannelId: config.tx_alert_channel_id || null,
        txAlertIncomingOnly: config.tx_alert_incoming_only === 1,
        txAlertMinSol: Number(config.tx_alert_min_sol || 0),
        watchChannelId: config.watch_channel_id || null,
        watchMessageId: config.watch_message_id || null
      },
      treasury: {
        sol: config.sol_balance || '0.0000',
        usdc: config.usdc_balance || '0.0000',
        lastUpdated: config.last_updated,
        status: staleness.status,
        staleMinutes: staleness.minutes
      }
    };
  }

  /**
   * Get recent treasury wallet transactions (incoming/outgoing SOL)
   */
  async getRecentTransactions(limit = 15, guildId = null) {
    const config = this.getConfig(guildId);

    if (!config || !config.solana_wallet) {
      return { success: false, message: 'No treasury wallet configured' };
    }

    try {
      const wallet = new PublicKey(config.solana_wallet);
      const sigs = await this.connection.getSignaturesForAddress(wallet, { limit: Math.min(Math.max(limit, 1), 50) });

      if (!sigs.length) {
        return { success: true, transactions: [] };
      }

      const parsed = await this.connection.getParsedTransactions(
        sigs.map(s => s.signature),
        { maxSupportedTransactionVersion: 0 }
      );

      const txs = [];
      for (let i = 0; i < parsed.length; i++) {
        const tx = parsed[i];
        if (!tx || !tx.meta) continue;

        const keys = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
        const idx = keys.findIndex(k => k === config.solana_wallet);
        if (idx === -1) continue;

        const pre = tx.meta.preBalances?.[idx] ?? 0;
        const post = tx.meta.postBalances?.[idx] ?? 0;
        const deltaLamports = post - pre;
        const deltaSol = deltaLamports / 1e9;

        txs.push({
          signature: sigs[i].signature,
          slot: sigs[i].slot,
          blockTime: sigs[i].blockTime,
          success: !sigs[i].err,
          feeSol: (tx.meta.fee || 0) / 1e9,
          deltaSol: Number(deltaSol.toFixed(6)),
          direction: deltaSol > 0 ? 'incoming' : deltaSol < 0 ? 'outgoing' : 'neutral'
        });
      }

      return { success: true, transactions: txs };
    } catch (error) {
      logger.error('Error fetching treasury transactions:', error);
      return { success: false, message: 'Failed to fetch transaction history' };
    }
  }

  /**
   * Check for new txs and post alerts to configured channel
   */
  async checkAndSendTxAlerts(guildId = null) {
    const config = this.getConfig(guildId);
    if (!config || config.tx_alerts_enabled !== 1 || !config.tx_alert_channel_id || !config.solana_wallet) return;

    const txResult = await this.getRecentTransactions(20, guildId);
    if (!txResult.success || !txResult.transactions.length) return;

    const latestSig = txResult.transactions[0].signature;

    // First run baseline: set pointer, don't flood old txs
    if (!config.tx_last_signature) {
      this.updateConfig({ txLastSignature: latestSig }, guildId);
      return;
    }

    const newTxs = [];
    for (const tx of txResult.transactions) {
      if (tx.signature === config.tx_last_signature) break;
      newTxs.push(tx);
    }

    if (!newTxs.length) return;

    const filtered = newTxs
      .filter(tx => tx.success)
      .filter(tx => !(config.tx_alert_incoming_only === 1 && tx.direction !== 'incoming'))
      .filter(tx => Math.abs(tx.deltaSol) >= Number(config.tx_alert_min_sol || 0));

    this.updateConfig({ txLastSignature: latestSig }, guildId);

    if (!filtered.length) return;

    const client = clientProvider.getClient();
    if (!client) return;

    const channel = await client.channels.fetch(config.tx_alert_channel_id).catch(() => null);
    if (!channel || !channel.send) return;

    const lines = filtered.slice().reverse().slice(0, 10).map(tx => {
      const dir = tx.direction === 'incoming' ? '🟢 IN' : tx.direction === 'outgoing' ? '🔴 OUT' : '🟡';
      const amount = `${tx.deltaSol > 0 ? '+' : ''}${tx.deltaSol} SOL`;
      const when = tx.blockTime ? `<t:${tx.blockTime}:R>` : 'unknown';
      return `${dir} ${amount} • ${when}\n\`${tx.signature.slice(0, 12)}...${tx.signature.slice(-8)}\``;
    });

    await channel.send({
      content: `💰 **Treasury Tx Alert** (${filtered.length} new)` + '\n' + lines.join('\n')
    });
  }

  /**
   * Post or update a persistent watch panel embed in Discord
   */
  async postOrUpdateWatchPanel(client, guildId = null) {
    const c = client || this.client;
    if (!c) return { success: false, message: 'No Discord client available' };

    const scope = this._scopeFor(guildId);
    const config = this.getConfig(guildId);
    if (!config || !config.watch_channel_id) {
      return { success: false, message: 'No watch channel configured' };
    }

    const channel = c.channels.cache.get(config.watch_channel_id);
    if (!channel) return { success: false, message: 'Watch channel not found' };

    const walletDisplay = config.solana_wallet ? this.maskAddress(config.solana_wallet) : 'Not set';
    const solBal = config.sol_balance || '0.0000';
    const usdcBal = config.usdc_balance || '0.00';
    const refreshHours = config.refresh_hours || 4;

    const embed = new EmbedBuilder()
      .setTitle('💰 Treasury Watch')
      .addFields(
        { name: 'Wallet', value: `\`${walletDisplay}\``, inline: true },
        { name: 'SOL Balance', value: `${solBal} SOL`, inline: true },
        { name: 'USDC Balance', value: `$${usdcBal}`, inline: true },
        { name: 'Last Updated', value: config.last_updated ? `<t:${Math.floor(new Date(config.last_updated).getTime() / 1000)}:R>` : 'Never', inline: true }
      )
      .setFooter({ text: `Auto-updates every ${refreshHours} hours` })
      .setTimestamp();

    applyEmbedBranding(embed, {
      guildId: channel.guild?.id || config.guild_id || '',
      moduleKey: 'treasury',
      defaultColor: '#FFD700',
      defaultFooter: 'Powered by Guild Pilot',
      fallbackLogoUrl: c.user?.displayAvatarURL?.() || null,
    });

    try {
      // Try to edit existing message
      if (config.watch_message_id) {
        try {
          const existing = await channel.messages.fetch(config.watch_message_id);
          await existing.edit({ embeds: [embed] });
          return { success: true, messageId: config.watch_message_id };
        } catch (fetchErr) {
          logger.warn('Watch panel message not found, posting new one');
        }
      }

      // Post new message
      const msg = await channel.send({ embeds: [embed] });
      db.prepare(`UPDATE ${scope.table} SET watch_message_id = ? WHERE ${scope.whereCol} = ?`).run(msg.id, scope.key);
      logger.log(`💰 Treasury watch panel posted in #${channel.name} (${msg.id})`);
      return { success: true, messageId: msg.id };
    } catch (error) {
      logger.error('Error posting treasury watch panel:', error);
      return { success: false, message: 'Failed to post treasury watch panel' };
    }
  }

  /**
   * Check if treasury data is stale
   */
  checkStaleness(lastUpdated, refreshHours) {
    if (!lastUpdated) {
      return { status: 'never_updated', minutes: null };
    }

    const lastUpdateTime = new Date(lastUpdated);
    const now = new Date();
    const minutesSinceUpdate = Math.floor((now - lastUpdateTime) / (1000 * 60));
    const refreshMinutes = refreshHours * 60;

    if (minutesSinceUpdate > refreshMinutes * 1.5) {
      return { status: 'stale', minutes: minutesSinceUpdate };
    } else if (minutesSinceUpdate > refreshMinutes) {
      return { status: 'warning', minutes: minutesSinceUpdate };
    } else {
      return { status: 'ok', minutes: minutesSinceUpdate };
    }
  }

  /**
   * Start automatic refresh scheduler
   */
  // The guild scopes the scheduler should service. Global mode -> [null]
  // (legacy single config). Per-tenant mode -> every enabled per-guild config.
  _activeSchedulerGuildIds() {
    if (!this._perTenantEnabled()) return [null];
    try {
      const rows = db.prepare(`
        SELECT guild_id FROM treasury_config_guild
        WHERE enabled = 1 AND solana_wallet IS NOT NULL AND solana_wallet != ''
      `).all();
      return rows.map(row => row.guild_id).filter(Boolean);
    } catch (_error) {
      return [];
    }
  }

  _schedulerIntervalMs() {
    if (!this._perTenantEnabled()) {
      const config = this.getConfig();
      return Math.max(1, Number(config?.refresh_hours) || 4) * 60 * 60 * 1000;
    }
    try {
      const row = db.prepare(`
        SELECT MIN(refresh_hours) AS h FROM treasury_config_guild
        WHERE enabled = 1 AND solana_wallet IS NOT NULL AND solana_wallet != ''
      `).get();
      return Math.max(1, Number(row?.h) || 4) * 60 * 60 * 1000;
    } catch (_error) {
      return 4 * 60 * 60 * 1000;
    }
  }

  async _runSchedulerPass() {
    const moduleGuard = require('../utils/moduleGuard');
    if (!moduleGuard.isModuleEnabled('treasury')) return;
    for (const guildId of this._activeSchedulerGuildIds()) {
      try {
        const result = await this.fetchBalances(guildId);
        if (result.success) {
          const cfg = this.getConfig(guildId);
          if (cfg && cfg.watch_channel_id) {
            await this.postOrUpdateWatchPanel(this.client, guildId).catch(err => logger.error('Watch panel update failed:', err));
          }
        }
        await this.checkAndSendTxAlerts(guildId).catch(err => logger.error('Treasury tx alert check failed:', err));
      } catch (error) {
        logger.error(`Scheduled treasury pass failed${guildId ? ` for guild ${guildId}` : ''}:`, error);
      }
    }
  }

  startScheduler() {
    // Check if treasury module is enabled (via module toggles)
    const moduleGuard = require('../utils/moduleGuard');
    if (!moduleGuard.isModuleEnabled('treasury')) {
      logger.log('⏸️ Treasury module disabled');
      return;
    }

    const activeGuildIds = this._activeSchedulerGuildIds();

    if (!this._perTenantEnabled()) {
      const config = this.getConfig();
      if (!config || !config.enabled || !config.solana_wallet) {
        logger.log('⏸️ Treasury scheduler not started (disabled or no wallet configured)');
        return;
      }
    } else if (activeGuildIds.length === 0) {
      logger.log('⏸️ Treasury scheduler not started (no enabled per-guild treasury configs)');
      return;
    }

    const intervalMs = this._schedulerIntervalMs();

    // Clear existing timer
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    // Initial pass
    this._runSchedulerPass().catch(err => logger.error('Initial treasury pass failed:', err));

    // Schedule recurring passes
    this.refreshTimer = setInterval(() => {
      this._runSchedulerPass().catch(err => logger.error('Scheduled treasury pass failed:', err));
    }, intervalMs);

    const scopeNote = this._perTenantEnabled() ? `, ${activeGuildIds.length} guild(s)` : '';
    logger.log(`⏰ Treasury auto-refresh started (every ${Math.round(intervalMs / 3600000)} hours${scopeNote})`);
  }

  /**
   * Stop scheduler
   */
  stopScheduler() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      logger.log('⏸️ Treasury scheduler stopped');
    }
  }

  /**
   * Restart scheduler (called when config changes)
   */
  restartScheduler() {
    this.stopScheduler();
    this.startScheduler();
  }

  // ==================== MULTI-WALLET MANAGEMENT ====================

  listWallets(guildId) {
    try {
      if (guildId) {
        return db.prepare('SELECT * FROM treasury_wallets WHERE guild_id = ? ORDER BY created_at ASC').all(guildId);
      }
      return db.prepare('SELECT * FROM treasury_wallets ORDER BY created_at ASC').all();
    } catch (e) {
      logger.error('Error listing treasury wallets:', e);
      return [];
    }
  }

  addWallet(address, label = '', guildId = null) {
    try {
      const normalizedGuildId = String(guildId || '').trim();
      if (normalizedGuildId) {
        const countRow = db.prepare(`
          SELECT COUNT(1) AS count
          FROM treasury_wallets
          WHERE guild_id = ?
        `).get(normalizedGuildId);
        const limitCheck = entitlementService.enforceLimit({
          guildId: normalizedGuildId,
          moduleKey: 'treasury',
          limitKey: 'max_wallets',
          currentCount: Number(countRow?.count || 0),
          incrementBy: 1,
          itemLabel: 'treasury wallets',
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
      }

      if (!this.isValidSolanaAddress(address)) {
        return { success: false, message: 'Invalid Solana wallet address' };
      }
      // Check for duplicate within same guild
      const existing = normalizedGuildId
        ? db.prepare('SELECT id FROM treasury_wallets WHERE address = ? AND guild_id = ?').get(address, normalizedGuildId)
        : db.prepare('SELECT id FROM treasury_wallets WHERE address = ? AND guild_id IS NULL').get(address);
      if (existing) return { success: false, message: 'This wallet is already in the list' };
      const info = db.prepare(
        'INSERT INTO treasury_wallets (address, label, guild_id) VALUES (?, ?, ?)'
      ).run(address, label || '', normalizedGuildId || null);
      return { success: true, id: info.lastInsertRowid };
    } catch (e) {
      logger.error('Error adding treasury wallet:', e);
      return { success: false, message: 'Failed to add wallet' };
    }
  }

  updateWallet(id, { address, label, enabled } = {}, guildId = null) {
    try {
      const sets = [];
      const params = [];
      if (address !== undefined) {
        if (!this.isValidSolanaAddress(address)) return { success: false, message: 'Invalid Solana wallet address' };
        sets.push('address = ?');
        params.push(address);
      }
      if (label !== undefined) { sets.push('label = ?'); params.push(label || ''); }
      if (enabled !== undefined) { sets.push('enabled = ?'); params.push(enabled ? 1 : 0); }
      if (!sets.length) return { success: false, message: 'Nothing to update' };

      if (guildId) params.push(id, guildId); else params.push(id);
      const q = `UPDATE treasury_wallets SET ${sets.join(', ')} WHERE id = ?${guildId ? ' AND guild_id = ?' : ''}`;
      const info = db.prepare(q).run(...params);
      if (!info.changes) return { success: false, message: 'Wallet not found' };
      return { success: true };
    } catch (e) {
      logger.error('Error updating treasury wallet:', e);
      return { success: false, message: 'Failed to update wallet' };
    }
  }

  removeWallet(id, guildId = null) {
    try {
      let info;
      if (guildId) {
        info = db.prepare('DELETE FROM treasury_wallets WHERE id = ? AND guild_id = ?').run(id, guildId);
      } else {
        info = db.prepare('DELETE FROM treasury_wallets WHERE id = ?').run(id);
      }
      if (!info.changes) return { success: false, message: 'Wallet not found' };
      return { success: true };
    } catch (e) {
      logger.error('Error removing treasury wallet:', e);
      return { success: false, message: 'Failed to remove wallet' };
    }
  }
}

// Singleton instance
const treasuryService = new TreasuryService();
treasuryService.initTable();

module.exports = treasuryService;
