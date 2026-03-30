const { Connection, PublicKey } = require('@solana/web3.js');
const { EmbedBuilder } = require('discord.js');
const db = require('../database/db');
const logger = require('../utils/logger');
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
  getConfig() {
    try {
      let config = db.prepare('SELECT * FROM treasury_config WHERE id = 1').get();
      
      if (!config) {
        // Initialize default config
        db.prepare(`
          INSERT INTO treasury_config (id, enabled, refresh_hours) 
          VALUES (1, 0, 4)
        `).run();
        config = db.prepare('SELECT * FROM treasury_config WHERE id = 1').get();
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
  updateConfig({ enabled, solanaWallet, refreshHours, txAlertsEnabled, txAlertChannelId, txAlertIncomingOnly, txAlertMinSol, txLastSignature, watchChannelId }) {
    try {
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
      params.push(1); // WHERE id = 1

      const sql = `UPDATE treasury_config SET ${updates.join(', ')} WHERE id = ?`;
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
  async fetchBalances() {
    const config = this.getConfig();
    
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
        UPDATE treasury_config 
        SET sol_balance = ?, 
            usdc_balance = ?, 
            last_updated = CURRENT_TIMESTAMP,
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).run(solBalanceFormatted, usdcBalance);

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
        UPDATE treasury_config 
        SET last_error = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).run(error.message);

      return {
        success: false,
        message: 'Failed to fetch balances',
        error: error.message
      };
    }
  }

  /**
   * Get treasury summary (safe for public consumption)
   */
  getSummary() {
    const config = this.getConfig();
    
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
  getAdminSummary() {
    const config = this.getConfig();
    
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
  async getRecentTransactions(limit = 15) {
    const config = this.getConfig();

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
      return { success: false, message: 'Failed to fetch transaction history', error: error.message };
    }
  }

  /**
   * Check for new txs and post alerts to configured channel
   */
  async checkAndSendTxAlerts() {
    const config = this.getConfig();
    if (!config || config.tx_alerts_enabled !== 1 || !config.tx_alert_channel_id || !config.solana_wallet) return;

    const txResult = await this.getRecentTransactions(20);
    if (!txResult.success || !txResult.transactions.length) return;

    const latestSig = txResult.transactions[0].signature;

    // First run baseline: set pointer, don't flood old txs
    if (!config.tx_last_signature) {
      this.updateConfig({ txLastSignature: latestSig });
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

    this.updateConfig({ txLastSignature: latestSig });

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
  async postOrUpdateWatchPanel(client) {
    const c = client || this.client;
    if (!c) return { success: false, message: 'No Discord client available' };

    const config = this.getConfig();
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
      .setColor(0xFFD700)
      .addFields(
        { name: 'Wallet', value: `\`${walletDisplay}\``, inline: true },
        { name: 'SOL Balance', value: `${solBal} SOL`, inline: true },
        { name: 'USDC Balance', value: `$${usdcBal}`, inline: true },
        { name: 'Last Updated', value: config.last_updated ? `<t:${Math.floor(new Date(config.last_updated).getTime() / 1000)}:R>` : 'Never', inline: true }
      )
      .setFooter({ text: `Auto-updates every ${refreshHours} hours` })
      .setTimestamp();

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
      db.prepare('UPDATE treasury_config SET watch_message_id = ? WHERE id = 1').run(msg.id);
      logger.log(`💰 Treasury watch panel posted in #${channel.name} (${msg.id})`);
      return { success: true, messageId: msg.id };
    } catch (error) {
      logger.error('Error posting treasury watch panel:', error);
      return { success: false, message: error.message };
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
  startScheduler() {
    const config = this.getConfig();
    
    // Check if treasury module is enabled (via module toggles)
    const moduleGuard = require('../utils/moduleGuard');
    if (!moduleGuard.isModuleEnabled('treasury')) {
      logger.log('⏸️ Treasury module disabled');
      return;
    }

    if (!config || !config.enabled || !config.solana_wallet) {
      logger.log('⏸️ Treasury scheduler not started (disabled or no wallet configured)');
      return;
    }

    const intervalMs = config.refresh_hours * 60 * 60 * 1000;

    // Clear existing timer
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    // Initial fetch
    if (moduleGuard.isModuleEnabled('treasury')) {
      this.fetchBalances()
        .then(result => { if (result.success && config.watch_channel_id) this.postOrUpdateWatchPanel().catch(err => logger.error('Watch panel update failed:', err)); })
        .catch(err => logger.error('Initial treasury fetch failed:', err));
      this.checkAndSendTxAlerts().catch(err => logger.error('Initial treasury tx alert check failed:', err));
    }

    // Schedule recurring fetches
    this.refreshTimer = setInterval(() => {
      if (moduleGuard.isModuleEnabled('treasury')) {
        this.fetchBalances()
          .then(result => { if (result.success) { const cfg = this.getConfig(); if (cfg && cfg.watch_channel_id) this.postOrUpdateWatchPanel().catch(err => logger.error('Watch panel update failed:', err)); } })
          .catch(err => logger.error('Scheduled treasury fetch failed:', err));
        this.checkAndSendTxAlerts().catch(err => logger.error('Scheduled treasury tx alert check failed:', err));
      }
    }, intervalMs);

    logger.log(`⏰ Treasury auto-refresh started (every ${config.refresh_hours} hours)`);
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
      if (!this.isValidSolanaAddress(address)) {
        return { success: false, message: 'Invalid Solana wallet address' };
      }
      // Check for duplicate within same guild
      const existing = guildId
        ? db.prepare('SELECT id FROM treasury_wallets WHERE address = ? AND guild_id = ?').get(address, guildId)
        : db.prepare('SELECT id FROM treasury_wallets WHERE address = ? AND guild_id IS NULL').get(address);
      if (existing) return { success: false, message: 'This wallet is already in the list' };
      const info = db.prepare(
        'INSERT INTO treasury_wallets (address, label, guild_id) VALUES (?, ?, ?)'
      ).run(address, label || '', guildId || null);
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
