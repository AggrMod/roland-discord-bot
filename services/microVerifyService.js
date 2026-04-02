const db = require('../database/db');
const logger = require('../utils/logger');
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const clientProvider = require('../utils/clientProvider');

class MicroVerifyService {
  constructor() {
    this.connection = null;
    this.pollingInterval = null;
    this.lastSignature = null;
    this._configOverrides = {};
  }

  /**
   * Initialize service with Solana connection
   */
  init() {
    try {
      const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
      this.connection = new Connection(rpcUrl, 'confirmed');
      logger.log('MicroVerifyService initialized');
    } catch (error) {
      logger.error('Error initializing MicroVerifyService:', error);
    }
  }

  /**
   * Check if micro verify is enabled
   */
  isEnabled() {
    return this._getConfigValue('MICRO_VERIFY_ENABLED') === 'true';
  }

  /**
   * Get configuration
   */
  getConfig() {
    return {
      enabled: this.isEnabled(),
      receiveWallet: this._getConfigValue('VERIFICATION_RECEIVE_WALLET') || null,
      ttlMinutes: parseInt(this._getConfigValue('VERIFY_REQUEST_TTL_MINUTES') || '15'),
      pollIntervalSeconds: parseInt(this._getConfigValue('POLL_INTERVAL_SECONDS') || '30'),
      rateLimitMinutes: parseInt(this._getConfigValue('VERIFY_RATE_LIMIT_MINUTES') || '1'),
      maxPendingPerUser: parseInt(this._getConfigValue('MAX_PENDING_PER_USER') || '1')
    };
  }

  /**
   * Update configuration (uses module-level config, NOT process.env)
   */
  updateConfig(updates) {
    try {
      const validKeys = ['MICRO_VERIFY_ENABLED', 'VERIFICATION_RECEIVE_WALLET', 'VERIFY_REQUEST_TTL_MINUTES', 'POLL_INTERVAL_SECONDS'];
      let updated = [];

      for (const [key, value] of Object.entries(updates)) {
        const envKey = key.toUpperCase();
        if (validKeys.includes(envKey)) {
          this._configOverrides[envKey] = String(value);
          updated.push(key);
        }
      }

      logger.log(`MicroVerify config updated: ${updated.join(', ')}`);
      return { success: true, message: 'Configuration updated', updated };
    } catch (error) {
      logger.error('Error updating config:', error);
      return { success: false, message: 'Failed to update configuration' };
    }
  }

  _getConfigValue(key) {
    return this._configOverrides[key] !== undefined ? this._configOverrides[key] : process.env[key];
  }

  /**
   * Generate a unique tiny SOL amount
   * Format: 0.0000XYZ where XYZ is unique
   */
  generateUniqueAmount() {
    // Generate 3-4 random digits
    const random = Math.floor(Math.random() * 9000) + 1000;
    // Format as 0.0000XXXX (4-7 decimal places for uniqueness)
    const amount = random / 100000000;
    return parseFloat(amount.toFixed(8));
  }

  /**
   * Get or create a fixed verification amount for a user
   * Same amount used for all their wallet verifications
   */
  getOrCreateUserAmount(discordId, username) {
    try {
      // Check if user already has an assigned amount
      const existing = db.prepare('SELECT assigned_amount FROM user_verify_amounts WHERE discord_id = ?').get(discordId);
      
      if (existing) {
        return { 
          success: true, 
          amount: existing.assigned_amount,
          isNew: false 
        };
      }

      // Wrap amount uniqueness check + insert in a transaction to prevent collisions
      const assignAmount = db.transaction(() => {
        let amt, tries = 0;
        do {
          amt = this.generateUniqueAmount();
          tries++;
          const collision = db.prepare('SELECT id FROM user_verify_amounts WHERE assigned_amount = ?').get(amt);
          if (!collision) break;
        } while (tries < 10);

        if (tries >= 10) {
          throw new Error('Failed to generate unique amount');
        }

        db.prepare(`
          INSERT INTO user_verify_amounts (discord_id, username, assigned_amount)
          VALUES (?, ?, ?)
        `).run(discordId, username, amt);

        return amt;
      });

      let amount;
      try {
        amount = assignAmount();
      } catch (txErr) {
        return { success: false, message: txErr.message };
      }

      return {
        success: true,
        amount,
        isNew: true
      };
    } catch (error) {
      logger.error('Error getting/creating user verify amount:', error);
      return { success: false, message: 'Database error' };
    }
  }

  /**
   * Create a new verification request
   */
  createRequest(discordId, username, guildId = '') {
    try {
      const config = this.getConfig();

      if (!config.enabled) {
        return { success: false, message: 'Micro-verification is not enabled' };
      }

      if (!config.receiveWallet) {
        return { success: false, message: 'Verification wallet not configured' };
      }

      // Reuse existing pending request if still valid (better UX)
      const pending = db.prepare(`
        SELECT * FROM micro_verify_requests
        WHERE discord_id = ? AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1
      `).get(discordId);

      if (pending) {
        if (new Date(pending.expires_at) > new Date()) {
          return {
            success: true,
            reused: true,
            request: {
              id: pending.id,
              amount: pending.expected_amount,
              destinationWallet: pending.destination_wallet,
              expiresAt: pending.expires_at,
              ttlMinutes: config.ttlMinutes
            }
          };
        }

        // Expire stale pending request and continue creating a fresh one
        this.expireRequest(pending.id);
      }

      // Check rate limit (after handling pending reuse)
      const rateLimitCheck = db.prepare(`
        SELECT COUNT(*) as count FROM micro_verify_requests 
        WHERE discord_id = ? 
        AND created_at > datetime('now', '-' || ? || ' minutes')
      `).get(discordId, config.rateLimitMinutes);

      if (rateLimitCheck.count > 0) {
        return { 
          success: false, 
          message: `Please wait ${config.rateLimitMinutes} minutes before requesting another verification` 
        };
      }

      // Get or create user's fixed verification amount
      const amountResult = this.getOrCreateUserAmount(discordId, username);
      if (!amountResult.success) {
        return amountResult;
      }
      const amount = amountResult.amount;

      // Calculate expiry
      const expiresAt = new Date(Date.now() + config.ttlMinutes * 60 * 1000).toISOString();

      // Create request
      const result = db.prepare(`
        INSERT INTO micro_verify_requests 
        (discord_id, username, guild_id, expected_amount, destination_wallet, expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(discordId, username, guildId || '', amount, config.receiveWallet, expiresAt, 'pending');

      logger.log(`Micro-verify request created: ${discordId} -> ${amount} SOL`);

      return {
        success: true,
        request: {
          id: result.lastInsertRowid,
          amount,
          destinationWallet: config.receiveWallet,
          expiresAt,
          ttlMinutes: config.ttlMinutes
        }
      };
    } catch (error) {
      logger.error('Error creating verification request:', error);
      return { success: false, message: 'Failed to create verification request' };
    }
  }

  /**
   * Get pending request for a user
   */
  getPendingRequest(discordId) {
    try {
      const request = db.prepare(`
        SELECT * FROM micro_verify_requests 
        WHERE discord_id = ? AND status = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(discordId, 'pending');

      if (!request) {
        return { success: false, message: 'No pending verification request' };
      }

      // Check if expired
      if (new Date(request.expires_at) < new Date()) {
        this.expireRequest(request.id);
        return { success: false, message: 'Verification request expired' };
      }

      return { success: true, request };
    } catch (error) {
      logger.error('Error getting pending request:', error);
      return { success: false, message: 'Failed to get pending request' };
    }
  }

  /**
   * Expire a request
   */
  expireRequest(requestId) {
    try {
      db.prepare(`
        UPDATE micro_verify_requests 
        SET status = 'expired', updated_at = datetime('now')
        WHERE id = ?
      `).run(requestId);
      logger.log(`Expired micro-verify request ${requestId}`);
      return { success: true };
    } catch (error) {
      logger.error('Error expiring request:', error);
      return { success: false, message: 'Failed to expire request' };
    }
  }

  /**
   * Mark request as verified and link wallet
   */
  verifyRequest(requestId, senderWallet, txSignature) {
    try {
      const request = db.prepare('SELECT * FROM micro_verify_requests WHERE id = ?').get(requestId);
      
      if (!request) {
        return { success: false, message: 'Request not found' };
      }

      if (request.status !== 'pending') {
        return { success: false, message: 'Request already processed' };
      }

      // Mark as verified
      db.prepare(`
        UPDATE micro_verify_requests 
        SET status = 'verified', sender_wallet = ?, tx_signature = ?, verified_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(senderWallet, txSignature, requestId);

      // Link wallet to user
      const walletService = require('./walletService');
      const linkResult = walletService.linkWallet(request.discord_id, request.username, senderWallet, request.guild_id || '');

      logger.log(`Micro-verify completed: ${request.discord_id} -> ${senderWallet} (${txSignature})`);

      return {
        success: true,
        walletLinked: linkResult.success,
        message: 'Wallet verified successfully'
      };
    } catch (error) {
      logger.error('Error verifying request:', error);
      return { success: false, message: 'Failed to verify request' };
    }
  }

  /**
   * Manually scan the chain right now for a specific user's pending request.
   * Called by the "Check Status" button — handles tx sent before/during restart.
   */
  async checkNow(discordId) {
    try {
      const config = this.getConfig();
      if (!config.enabled || !config.receiveWallet) {
        return { success: false, message: 'Micro-verification not configured' };
      }
      const pendingResult = this.getPendingRequest(discordId);
      if (!pendingResult.success || !pendingResult.request) {
        return { success: false, message: 'No pending request found' };
      }
      const request = pendingResult.request;
      if (request.status === 'verified') {
        return { success: true, status: 'verified', request };
      }

      const publicKey = new PublicKey(config.receiveWallet);
      const signatures = await this.connection.getSignaturesForAddress(publicKey, { limit: 20 });

      for (const sig of signatures) {
        const result = await this.checkTransaction(sig.signature, publicKey);
        if (result && result.success) {
          const updated = this.getPendingRequest(discordId);
          return { success: true, status: 'verified', request: updated.request };
        }
      }

      return { success: true, status: request.status, request };
    } catch (e) {
      logger.error('checkNow error:', e);
      return { success: false, message: e.message };
    }
  }

  /**
   * Poll Solana for incoming transactions
   */
  async pollTransactions() {
    try {
      const config = this.getConfig();

      if (!config.enabled || !config.receiveWallet) {
        return;
      }

      const publicKey = new PublicKey(config.receiveWallet);
      
      // Get recent transactions
      const scanLimit = Math.max(5, Math.min(20, parseInt(process.env.MICRO_VERIFY_SCAN_LIMIT || '8', 10)));
      const signatures = await this.connection.getSignaturesForAddress(publicKey, {
        limit: scanLimit
      });

      if (signatures.length === 0) {
        return;
      }

      // On first run, process recent txs against pending requests (don't skip)
      if (!this.lastSignature) {
        this.lastSignature = signatures[0].signature;
        logger.log('Micro-verify: first poll — scanning recent txs for pending requests');
        // Process all recent signatures in case a tx arrived before/during restart
        for (const sig of signatures) {
          const result = await this.checkTransaction(sig.signature, publicKey);
          if (result && result.rateLimited) {
            logger.warn('Micro-verify RPC rate-limited during first scan; retrying on next interval');
            break;
          }
          await new Promise(r => setTimeout(r, 250));
        }
        return;
      }

      // Process new transactions
      let newTxs = [];
      for (const sig of signatures) {
        if (sig.signature === this.lastSignature) {
          break;
        }
        newTxs.push(sig);
      }

      if (newTxs.length > 0) {
        logger.log(`Found ${newTxs.length} new transaction(s) to check`);
        this.lastSignature = signatures[0].signature;
      }

      // Check each transaction (throttled to avoid RPC 429)
      for (const sig of newTxs) {
        const result = await this.checkTransaction(sig.signature, publicKey);
        // If provider is rate-limiting, stop this cycle and retry next interval
        if (result && result.rateLimited) {
          logger.warn('Micro-verify RPC rate-limited; pausing tx checks until next poll');
          break;
        }
        await new Promise(r => setTimeout(r, 250));
      }
    } catch (error) {
      logger.error('Error polling transactions:', error);
    }
  }

  /**
   * Check a specific transaction for verification match
   */
  async checkTransaction(signature, destinationPublicKey) {
    try {
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0
      });

      if (!tx || !tx.meta) {
        return;
      }

      // Find SOL transfer to our wallet
      const accountKeys = tx.transaction.message.getAccountKeys();
      const destinationIndex = accountKeys.staticAccountKeys.findIndex(
        key => key.equals(destinationPublicKey)
      );

      if (destinationIndex === -1) {
        return;
      }

      // Check balance change
      const preBalance = tx.meta.preBalances[destinationIndex];
      const postBalance = tx.meta.postBalances[destinationIndex];
      const lamportsReceived = postBalance - preBalance;

      if (lamportsReceived <= 0) {
        return;
      }

      const solReceived = lamportsReceived / LAMPORTS_PER_SOL;
      const solRounded = parseFloat(solReceived.toFixed(8));

      // Find matching pending request
      const pendingRequests = db.prepare(`
        SELECT * FROM micro_verify_requests 
        WHERE status = ? 
        AND expires_at > datetime('now')
        AND ABS(expected_amount - ?) < 0.00000001
      `).all('pending', solRounded);

      if (pendingRequests.length === 0) {
        logger.log(`No matching request for ${solRounded} SOL`);
        return;
      }

      // Get sender wallet
      const senderIndex = 0; // First account is usually the sender
      const senderWallet = accountKeys.staticAccountKeys[senderIndex].toBase58();

      // Verify the first matching request
      const request = pendingRequests[0];
      logger.log(`Matched transaction ${signature} to request ${request.id}`);

      const result = this.verifyRequest(request.id, senderWallet, signature);

      if (result.success) {
        // Notify user if possible (requires Discord client reference)
        this.notifyUserVerified(request.discord_id, senderWallet);
      }

      return result;
    } catch (error) {
      const msg = String(error?.message || error || '');
      if (msg.includes('429') || msg.includes('Too many requests')) {
        logger.warn(`Rate-limited while checking tx ${signature}: ${msg}`);
        return { rateLimited: true };
      }
      logger.error(`Error checking transaction ${signature}:`, error);
    }
  }

  /**
   * Notify user of successful verification (requires Discord client)
   */
  async notifyUserVerified(discordId, walletAddress) {
    try {
      const client = clientProvider.getClient();
      if (!client) return;

      const user = await client.users.fetch(discordId).catch(() => null);
      if (!user) return;

      await user.send(
        `✅ **Wallet Verified!**\n\n` +
        `Your wallet \`${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}\` has been successfully verified via micro-transfer!\n\n` +
        `Your roles and voting power have been updated. Use \`/verification status\` to see your status.`
      ).catch(err => logger.error('Failed to DM user:', err));

      logger.log(`Notified user ${discordId} of verification`);
    } catch (error) {
      logger.error('Error notifying user:', error);
    }
  }

  /**
   * Start polling for transactions
   */
  startPolling() {
    const config = this.getConfig();
    
    if (!config.enabled || !config.receiveWallet) {
      logger.log('Micro-verify polling not started (disabled or no wallet configured)');
      return;
    }

    if (this.pollingInterval) {
      this.stopPolling();
    }

    const intervalMs = config.pollIntervalSeconds * 1000;
    
    this.pollingInterval = setInterval(() => {
      this.pollTransactions().catch(err => 
        logger.error('Polling error:', err)
      );
    }, intervalMs);

    logger.log(`Started micro-verify polling (interval: ${config.pollIntervalSeconds}s)`);
    
    // Do initial poll
    this.pollTransactions().catch(err => 
      logger.error('Initial poll error:', err)
    );
  }

  /**
   * Stop polling
   */
  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logger.log('Stopped micro-verify polling');
    }
  }

  /**
   * Expire stale requests (cleanup job)
   */
  expireStaleRequests() {
    try {
      const result = db.prepare(`
        UPDATE micro_verify_requests 
        SET status = ?, updated_at = datetime('now')
        WHERE status = ? AND expires_at < datetime('now')
      `).run('expired', 'pending');

      if (result.changes > 0) {
        logger.log(`Expired ${result.changes} stale micro-verify request(s)`);
      }
    } catch (error) {
      logger.error('Error expiring stale requests:', error);
    }
  }

  /**
   * Get statistics
   */
  getStats() {
    try {
      const stats = db.prepare(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) as verified,
          SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired
        FROM micro_verify_requests
      `).get();

      return { success: true, stats };
    } catch (error) {
      logger.error('Error getting stats:', error);
      return { success: false, message: 'Failed to get stats' };
    }
  }
}

module.exports = new MicroVerifyService();
