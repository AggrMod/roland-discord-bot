const { Connection, PublicKey } = require('@solana/web3.js');
const db = require('../database/db');
const logger = require('../utils/logger');

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC mainnet

class TreasuryService {
  constructor() {
    this.connection = new Connection(SOLANA_RPC, 'confirmed');
    this.refreshTimer = null;
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
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  updateConfig({ enabled, solanaWallet, refreshHours }) {
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
        refreshHours: config.refresh_hours,
        lastUpdated: config.last_updated,
        lastError: config.last_error
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
      this.fetchBalances().catch(err => logger.error('Initial treasury fetch failed:', err));
    }

    // Schedule recurring fetches
    this.refreshTimer = setInterval(() => {
      if (moduleGuard.isModuleEnabled('treasury')) {
        this.fetchBalances().catch(err => logger.error('Scheduled treasury fetch failed:', err));
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
}

// Singleton instance
const treasuryService = new TreasuryService();
treasuryService.initTable();

module.exports = treasuryService;
