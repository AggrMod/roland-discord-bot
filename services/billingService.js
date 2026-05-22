const db = require('../database/db');
const tenantService = require('./tenantService');
const settingsManager = require('../config/settings');
const { getPlanPreset, normalizePlanKey } = require('../config/plans');
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const crypto = require('crypto');

function normalizeString(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeLower(value) {
  const str = normalizeString(value);
  return str ? str.toLowerCase() : null;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y';
}

function normalizeInterval(value) {
  const normalized = normalizeLower(value);
  if (!normalized) return null;
  if (['month', 'monthly', 'm'].includes(normalized)) return 'monthly';
  if (['year', 'yearly', 'annual', 'annually', 'y'].includes(normalized)) return 'yearly';
  return null;
}

function normalizeTokenSymbol(value) {
  const normalized = normalizeLower(value);
  if (!normalized) return null;
  if (normalized === 'sol') return 'SOL';
  if (normalized === 'usdc') return 'USDC';
  return null;
}

function isLikelySolanaAddress(value) {
  const text = String(value || '').trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text);
}

function isLikelySolanaSignature(value) {
  const text = String(value || '').trim();
  return /^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(text);
}

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function toIsoDate(value) {
  if (value === undefined || value === null || value === '') return null;

  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  const text = String(value).trim();
  if (!text) return null;

  if (/^\d+$/.test(text)) {
    const num = Number(text);
    if (!Number.isFinite(num)) return null;
    const ms = num > 1e12 ? num : num * 1000;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function safeJsonParse(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function envValue(keys = []) {
  for (const key of keys) {
    const value = normalizeString(process.env[key]);
    if (value) return value;
  }
  return null;
}

function toBase64Url(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64url');
}

function fromBase64Url(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function applyTemplate(url, params = {}) {
  const normalized = normalizeString(url);
  if (!normalized) return null;

  let output = normalized;
  output = output.replace(/\{GUILD_ID\}/g, encodeURIComponent(String(params.guildId || '')));
  output = output.replace(/\{PLAN\}/g, encodeURIComponent(String(params.planKey || '')));
  output = output.replace(/\{INTERVAL\}/g, encodeURIComponent(String(params.interval || '')));

  try {
    const parsed = new URL(output);
    if (params.guildId && !parsed.searchParams.get('guildId')) parsed.searchParams.set('guildId', String(params.guildId));
    if (params.planKey && !parsed.searchParams.get('plan')) parsed.searchParams.set('plan', String(params.planKey));
    if (params.interval && !parsed.searchParams.get('interval')) parsed.searchParams.set('interval', String(params.interval));
    return parsed.toString();
  } catch (_error) {
    return output;
  }
}

class BillingService {
  getQuoteSigningSecret() {
    return envValue([
      'BILLING_QUOTE_SECRET',
      'PUBLIC_WEB_AUTH_SECRET',
      'SESSION_SECRET',
      'JWT_SECRET',
    ]) || 'guildpilot-local-quote-secret';
  }

  signQuotePayload(payload = {}) {
    const payloadJson = JSON.stringify(payload);
    const payloadPart = toBase64Url(payloadJson);
    const signature = crypto
      .createHmac('sha256', this.getQuoteSigningSecret())
      .update(payloadPart)
      .digest('base64url');
    return `${payloadPart}.${signature}`;
  }

  parseAndVerifyQuoteToken(token) {
    const raw = normalizeString(token);
    if (!raw) return { success: false, message: 'quoteToken is required' };
    const parts = raw.split('.');
    if (parts.length !== 2) return { success: false, message: 'quoteToken format is invalid' };
    const [payloadPart, signaturePart] = parts;
    const expectedSig = crypto
      .createHmac('sha256', this.getQuoteSigningSecret())
      .update(payloadPart)
      .digest('base64url');
    if (expectedSig !== signaturePart) return { success: false, message: 'quoteToken signature is invalid' };
    try {
      const payload = JSON.parse(fromBase64Url(payloadPart));
      return { success: true, payload };
    } catch (_error) {
      return { success: false, message: 'quoteToken payload is invalid' };
    }
  }

  async getSolUsdRate() {
    const fallback = Number(process.env.BILLING_SOL_USD_FALLBACK || 0);
    const timeoutMs = Math.max(1000, Number(process.env.BILLING_QUOTE_TIMEOUT_MS || 5000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
        method: 'GET',
        headers: { 'accept': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`price source returned ${response.status}`);
      const json = await response.json();
      const rate = Number(json?.solana?.usd || 0);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('invalid SOL/USD rate');
      return { success: true, rate, source: 'coingecko' };
    } catch (error) {
      clearTimeout(timer);
      if (Number.isFinite(fallback) && fallback > 0) {
        return { success: true, rate: fallback, source: 'env_fallback' };
      }
      return { success: false, message: `Failed to fetch SOL/USD rate: ${error?.message || 'unknown error'}` };
    }
  }

  async createCryptoQuote(guildId, payload = {}) {
    const normalizedGuildId = normalizeString(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };

    const planKey = normalizePlanKey(payload.planKey || payload.plan_key);
    const billingInterval = normalizeInterval(payload.billingInterval || payload.billing_interval);
    const tokenSymbol = normalizeTokenSymbol(payload.tokenSymbol || payload.token_symbol);

    if (!planKey || planKey === 'starter' || planKey === 'enterprise') {
      return { success: false, message: 'planKey must be a paid self-serve plan' };
    }
    if (!billingInterval) return { success: false, message: 'billingInterval must be monthly or yearly' };
    if (!tokenSymbol) return { success: false, message: 'tokenSymbol must be SOL or USDC' };

    const expectedUsd = this.getExpectedPlanUsd(planKey, billingInterval);
    if (!Number.isFinite(expectedUsd) || expectedUsd <= 0) {
      return { success: false, message: 'Unable to compute plan price for quote' };
    }

    let quotedAmount = expectedUsd;
    let fxRate = null;
    let rateSource = tokenSymbol === 'USDC' ? 'fixed_1_usd' : null;
    if (tokenSymbol === 'SOL') {
      const rateResult = await this.getSolUsdRate();
      if (!rateResult.success) return rateResult;
      fxRate = Number(rateResult.rate);
      rateSource = rateResult.source || 'unknown';
      quotedAmount = expectedUsd / fxRate;
    }

    const amountDecimals = tokenSymbol === 'SOL' ? 6 : 2;
    const normalizedAmount = Number(quotedAmount.toFixed(amountDecimals));
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
      return { success: false, message: 'Failed to calculate payable quote amount' };
    }

    const expiresAtMs = Date.now() + (5 * 60 * 1000);
    const quotePayload = {
      kind: 'billing_quote',
      guildId: normalizedGuildId,
      planKey,
      billingInterval,
      tokenSymbol,
      usdAmount: Number(expectedUsd.toFixed(2)),
      tokenAmount: normalizedAmount,
      fxRate,
      rateSource,
      amountDecimals,
      issuedAt: Date.now(),
      expiresAt: expiresAtMs,
      nonce: crypto.randomBytes(8).toString('hex'),
    };

    return {
      success: true,
      quoteToken: this.signQuotePayload(quotePayload),
      quote: {
        ...quotePayload,
        expiresAtIso: new Date(expiresAtMs).toISOString(),
      },
      paymentDetails: this.getPaymentDetails(normalizedGuildId),
    };
  }
  isOnchainVerificationEnabled() {
    const settings = settingsManager.getSettings();
    if (settings && Object.prototype.hasOwnProperty.call(settings, 'billingOnchainVerifyEnabled')) {
      return !!settings.billingOnchainVerifyEnabled;
    }
    return String(process.env.BILLING_ONCHAIN_VERIFY_ENABLED || 'false').trim().toLowerCase() === 'true';
  }

  getBillingReceiveWallet() {
    const settings = settingsManager.getSettings();
    const configured = normalizeString(settings?.billingReceiveWallet);
    if (configured) return configured;
    const explicit = normalizeString(process.env.BILLING_RECEIVE_WALLET);
    if (explicit) return explicit;
    const treasuryConfig = db.prepare('SELECT solana_wallet FROM treasury_config WHERE id = 1').get();
    const treasuryWallet = normalizeString(treasuryConfig?.solana_wallet);
    if (treasuryWallet) return treasuryWallet;
    return normalizeString(process.env.VERIFICATION_RECEIVE_WALLET);
  }

  getPaymentDetails(guildId) {
    const settings = settingsManager.getSettings();
    const destinationWallet = this.getBillingReceiveWallet();
    const supportUrl = normalizeString(settings?.billingSupportUrl) || this.getSupportUrl(guildId);
    return {
      destinationWallet: destinationWallet || null,
      acceptedTokens: ['SOL', 'USDC'],
      onchainVerificationEnabled: this.isOnchainVerificationEnabled(),
      supportUrl: supportUrl || null,
      mode: 'manual_receipt_review',
    };
  }

  async verifyCryptoReceiptOnChain({ receiptId, force = false } = {}) {
    const enabled = this.isOnchainVerificationEnabled();
    if (!enabled && !force) {
      return { success: false, message: 'On-chain receipt verification is disabled (set BILLING_ONCHAIN_VERIFY_ENABLED=true)' };
    }
    const id = Number(receiptId);
    if (!Number.isFinite(id) || id <= 0) return { success: false, message: 'Valid receiptId is required' };
    const row = db.prepare('SELECT * FROM crypto_payment_receipts WHERE id = ? LIMIT 1').get(id);
    if (!row) return { success: false, message: 'Receipt not found' };

    const destinationWallet = this.getBillingReceiveWallet();
    if (!destinationWallet) return { success: false, message: 'Billing destination wallet is not configured' };

    try {
      const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
      const parsedTx = await connection.getParsedTransaction(String(row.tx_signature), { maxSupportedTransactionVersion: 0 });
      if (!parsedTx) return { success: true, verified: false, reason: 'Transaction not found on-chain' };
      if (parsedTx.meta?.err) return { success: true, verified: false, reason: 'Transaction failed on-chain' };

      const tokenSymbol = String(row.token_symbol || '').trim().toUpperCase();
      const expectedAmount = Number(row.amount || 0);
      const minExpected = Math.max(0, expectedAmount - 0.000001);
      const accountKeys = Array.isArray(parsedTx.transaction?.message?.accountKeys) ? parsedTx.transaction.message.accountKeys : [];
      const keyAt = (idx) => {
        const entry = accountKeys[idx];
        if (!entry) return null;
        if (typeof entry === 'string') return entry;
        if (entry.pubkey) return String(entry.pubkey);
        return null;
      };

      let matchedAmount = 0;
      const instructions = parsedTx.transaction?.message?.instructions || [];
      for (const instruction of instructions) {
        const parsed = instruction?.parsed;
        if (!parsed || typeof parsed !== 'object') continue;
        const type = String(parsed.type || '').toLowerCase();
        const info = parsed.info || {};

        if (tokenSymbol === 'SOL' && type === 'transfer') {
          const dest = String(info.destination || '');
          const lamports = Number(info.lamports || 0);
          if (dest === destinationWallet && lamports > 0) {
            matchedAmount += (lamports / LAMPORTS_PER_SOL);
          }
        }

        if (tokenSymbol === 'USDC' && (type === 'transferchecked' || type === 'transfer')) {
          const dest = String(info.destination || '');
          const mint = String(info.mint || keyAt(instruction?.accounts?.[1]) || '');
          let tokenAmount = Number(info.tokenAmount?.uiAmount || 0);
          if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
            const raw = Number(info.tokenAmount?.amount || info.amount || 0);
            const decimals = Number(info.tokenAmount?.decimals || info.decimals || 6);
            tokenAmount = raw > 0 ? raw / (10 ** decimals) : 0;
          }
          if (dest === destinationWallet && mint === USDC_MINT && tokenAmount > 0) {
            matchedAmount += tokenAmount;
          }
        }
      }

      if (matchedAmount >= minExpected) {
        return {
          success: true,
          verified: true,
          reason: 'On-chain transfer matched receipt',
          details: {
            tokenSymbol,
            expectedAmount,
            matchedAmount: Number(matchedAmount.toFixed(6)),
            destinationWallet,
          },
        };
      }

      return {
        success: true,
        verified: false,
        reason: 'No matching transfer to billing wallet found for expected token/amount',
        details: {
          tokenSymbol,
          expectedAmount,
          matchedAmount: Number(matchedAmount.toFixed(6)),
          destinationWallet,
        },
      };
    } catch (error) {
      return { success: false, message: `Verification failed: ${error?.message || 'unknown error'}` };
    }
  }

  submitCryptoReceipt(guildId, payload = {}) {
    const normalizedGuildId = normalizeString(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };

    const txSignature = normalizeString(payload.txSignature || payload.tx_signature);
    const senderWallet = normalizeString(payload.senderWallet || payload.sender_wallet);
    const quoteToken = normalizeString(payload.quoteToken || payload.quote_token);
    let tokenSymbol = normalizeTokenSymbol(payload.tokenSymbol || payload.token_symbol);
    let planKey = normalizePlanKey(payload.planKey || payload.plan_key);
    let billingInterval = normalizeInterval(payload.billingInterval || payload.billing_interval);
    let amount = Number(payload.amount);

    if (!txSignature) return { success: false, message: 'txSignature is required' };
    if (!senderWallet) return { success: false, message: 'senderWallet is required' };
    if (!isLikelySolanaSignature(txSignature)) return { success: false, message: 'txSignature format is invalid' };
    if (!isLikelySolanaAddress(senderWallet)) return { success: false, message: 'senderWallet format is invalid' };

    let quoteMetadata = null;
    if (quoteToken) {
      const parsed = this.parseAndVerifyQuoteToken(quoteToken);
      if (!parsed.success) return parsed;
      const q = parsed.payload || {};
      if (String(q.kind || '') !== 'billing_quote') return { success: false, message: 'quoteToken kind is invalid' };
      if (String(q.guildId || '') !== normalizedGuildId) return { success: false, message: 'quoteToken guild mismatch' };
      if (!Number.isFinite(Number(q.expiresAt)) || Number(q.expiresAt) <= Date.now()) {
        return { success: false, message: 'quoteToken has expired. Prepare a new quote.' };
      }
      tokenSymbol = normalizeTokenSymbol(q.tokenSymbol);
      planKey = normalizePlanKey(q.planKey);
      billingInterval = normalizeInterval(q.billingInterval);
      amount = Number(q.tokenAmount);
      quoteMetadata = q;
    }

    if (!tokenSymbol) return { success: false, message: 'tokenSymbol must be SOL or USDC' };
    if (!planKey || planKey === 'starter' || planKey === 'enterprise') return { success: false, message: 'planKey must be a paid self-serve plan' };
    if (!billingInterval) return { success: false, message: 'billingInterval must be monthly or yearly' };
    if (!Number.isFinite(amount) || amount <= 0) return { success: false, message: 'amount must be greater than 0' };
    if (amount > 1000000) return { success: false, message: 'amount is outside allowed range' };

    const preset = getPlanPreset(planKey);
    if (!preset || !Number.isFinite(Number(preset?.billing?.monthlyUsd || 0)) || Number(preset.billing.monthlyUsd) <= 0) {
      return { success: false, message: 'planKey does not support self-serve crypto billing' };
    }

    try {
      db.prepare(`
        INSERT INTO crypto_payment_receipts (
          guild_id, tx_signature, amount, token_symbol, sender_wallet, plan_key, billing_interval, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
      `).run(
        normalizedGuildId,
        txSignature,
        amount,
        tokenSymbol,
        senderWallet,
        planKey,
        billingInterval
      );
      return {
        success: true,
        quoted: !!quoteMetadata,
        quote: quoteMetadata ? {
          usdAmount: quoteMetadata.usdAmount,
          tokenAmount: quoteMetadata.tokenAmount,
          tokenSymbol: quoteMetadata.tokenSymbol,
          planKey: quoteMetadata.planKey,
          billingInterval: quoteMetadata.billingInterval,
          fxRate: quoteMetadata.fxRate,
          rateSource: quoteMetadata.rateSource,
          expiresAt: quoteMetadata.expiresAt,
        } : null,
      };
    } catch (error) {
      if (String(error?.message || '').toLowerCase().includes('unique')) {
        return { success: false, message: 'This transaction signature was already submitted.' };
      }
      return { success: false, message: 'Failed to submit payment receipt' };
    }
  }

  computePeriodEndIso(billingInterval, fromDate = new Date()) {
    const base = fromDate instanceof Date ? new Date(fromDate.getTime()) : new Date(fromDate);
    if (!Number.isFinite(base.getTime())) return null;
    const normalized = normalizeInterval(billingInterval) || 'monthly';
    if (normalized === 'yearly') {
      base.setUTCFullYear(base.getUTCFullYear() + 1);
      return base.toISOString();
    }
    base.setUTCMonth(base.getUTCMonth() + 1);
    return base.toISOString();
  }

  applyApprovedReceiptEntitlement(receiptRow, actorId = 'billing-auto-approval') {
    if (!receiptRow || !receiptRow.guild_id) return { success: false, message: 'receiptRow is required' };
    const guildId = String(receiptRow.guild_id).trim();
    const planKey = normalizePlanKey(receiptRow.plan_key);
    const billingInterval = normalizeInterval(receiptRow.billing_interval) || 'monthly';
    if (!guildId || !planKey) return { success: false, message: 'receipt is missing guild or plan metadata' };

    const tenant = tenantService.getTenant(guildId) || tenantService.ensureTenant(guildId, null) || tenantService.getTenant(guildId);
    if (!tenant?.id) return { success: false, message: 'Tenant not found for receipt guild' };

    const setPlan = tenantService.setTenantPlan(guildId, planKey, actorId);
    if (!setPlan?.success) return { success: false, message: setPlan?.message || 'Failed to apply plan from receipt' };

    const setStatus = tenantService.setTenantStatus(guildId, 'active', actorId);
    if (!setStatus?.success) return { success: false, message: setStatus?.message || 'Failed to activate tenant after receipt approval' };

    const periodEnd = this.computePeriodEndIso(billingInterval, new Date());
    db.prepare(`
      INSERT INTO tenant_billing (
        tenant_id, provider, subscription_status, billing_interval, current_period_end, last_payment_at, last_payment_status, metadata_json
      ) VALUES (?, 'manual_crypto', 'approved', ?, ?, ?, 'approved', ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        provider = 'manual_crypto',
        subscription_status = 'approved',
        billing_interval = excluded.billing_interval,
        current_period_end = excluded.current_period_end,
        last_payment_at = excluded.last_payment_at,
        last_payment_status = 'approved',
        metadata_json = excluded.metadata_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      tenant.id,
      billingInterval,
      periodEnd,
      new Date().toISOString(),
      JSON.stringify({
        source: 'billing_auto_verification',
        receiptId: Number(receiptRow.id || 0) || null,
        txSignature: receiptRow.tx_signature || null,
        actorId,
        appliedAt: new Date().toISOString(),
      })
    );

    return { success: true, guildId, planKey, billingInterval, currentPeriodEnd: periodEnd };
  }

  async autoVerifyAndApplyReceipt(receiptId, actorId = 'billing-auto-approval') {
    const id = Number(receiptId);
    if (!Number.isFinite(id) || id <= 0) return { success: false, message: 'Valid receiptId is required' };
    const receipt = db.prepare('SELECT * FROM crypto_payment_receipts WHERE id = ? LIMIT 1').get(id);
    if (!receipt) return { success: false, message: 'Receipt not found' };

    const destinationWallet = this.getBillingReceiveWallet();
    if (!destinationWallet) {
      return { success: true, autoProcessed: false, status: 'pending', reason: 'Billing destination wallet is not configured' };
    }

    const verify = await this.verifyCryptoReceiptOnChain({ receiptId: id, force: true });
    if (!verify.success) {
      return { success: true, autoProcessed: false, status: 'pending', reason: verify.message || 'On-chain verification failed' };
    }

    if (!verify.verified) {
      return {
        success: true,
        autoProcessed: false,
        status: 'pending',
        reason: verify.reason || 'Transaction does not match quote yet',
        details: verify.details || null,
      };
    }

    const approve = this.setCryptoReceiptStatus({ id, status: 'approved' });
    if (!approve.success) return { success: false, message: approve.message || 'Failed to mark receipt approved' };

    const entitlement = this.applyApprovedReceiptEntitlement(approve.receipt, actorId);
    if (!entitlement.success) return { success: false, message: entitlement.message || 'Failed to apply entitlement' };

    return {
      success: true,
      autoProcessed: true,
      status: 'approved',
      reason: 'Receipt verified and plan activated automatically',
      entitlement,
      verification: verify.details || null,
    };
  }

  getExpectedPlanUsd(planKey, billingInterval = 'monthly') {
    const normalizedPlan = normalizePlanKey(planKey);
    const normalizedInterval = normalizeInterval(billingInterval) || 'monthly';
    const preset = getPlanPreset(normalizedPlan);
    const monthly = Number(preset?.billing?.monthlyUsd || 0);
    if (!preset || !Number.isFinite(monthly) || monthly <= 0) return null;
    if (normalizedInterval === 'yearly') {
      const discountPct = Number(preset?.billing?.annualDiscountPct || 0);
      const yearly = monthly * 12 * (1 - (Math.max(0, Math.min(100, discountPct)) / 100));
      return Number(yearly.toFixed(2));
    }
    return Number(monthly.toFixed(2));
  }

  listCryptoReceiptsByGuild(guildId, { limit = 20, status = '' } = {}) {
    const normalizedGuildId = normalizeString(guildId);
    if (!normalizedGuildId) return { success: false, message: 'guildId is required' };
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const normalizedStatus = normalizeLower(status);
    const allowedStatuses = new Set(['pending', 'approved', 'rejected']);
    const hasStatusFilter = allowedStatuses.has(normalizedStatus);
    const rows = hasStatusFilter
      ? db.prepare(`
        SELECT id, guild_id, tx_signature, amount, token_symbol, sender_wallet, plan_key, billing_interval, status, verification_error, verified_at, created_at
        FROM crypto_payment_receipts
        WHERE guild_id = ?
          AND LOWER(COALESCE(status, 'pending')) = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(normalizedGuildId, normalizedStatus, safeLimit)
      : db.prepare(`
        SELECT id, guild_id, tx_signature, amount, token_symbol, sender_wallet, plan_key, billing_interval, status, verification_error, verified_at, created_at
        FROM crypto_payment_receipts
        WHERE guild_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(normalizedGuildId, safeLimit);
    return { success: true, receipts: rows };
  }

  setCryptoReceiptStatus({ id, status, verificationError = null }) {
    const receiptId = Number(id);
    const normalizedStatus = normalizeLower(status);
    if (!Number.isFinite(receiptId) || receiptId <= 0) return { success: false, message: 'receipt id is required' };
    if (!['pending', 'approved', 'rejected'].includes(normalizedStatus)) {
      return { success: false, message: 'status must be pending, approved, or rejected' };
    }
    const row = db.prepare('SELECT * FROM crypto_payment_receipts WHERE id = ? LIMIT 1').get(receiptId);
    if (!row) return { success: false, message: 'receipt not found' };

    db.prepare(`
      UPDATE crypto_payment_receipts
      SET status = ?,
          verification_error = ?,
          verified_at = CASE WHEN ? = 'approved' THEN CURRENT_TIMESTAMP ELSE NULL END
      WHERE id = ?
    `).run(
      normalizedStatus,
      normalizedStatus === 'rejected' ? (normalizeString(verificationError) || 'Rejected by superadmin') : null,
      normalizedStatus,
      receiptId
    );

    const updated = db.prepare('SELECT * FROM crypto_payment_receipts WHERE id = ? LIMIT 1').get(receiptId);
    return { success: true, receipt: updated };
  }

  getTenantBilling(guildId) {
    const context = tenantService.getTenantContext(guildId);
    const tenantId = context?.tenant?.id;
    if (!tenantId) return null;

    const row = db.prepare(`
      SELECT *
      FROM tenant_billing
      WHERE tenant_id = ?
      LIMIT 1
    `).get(tenantId);

    if (!row) return null;

    return {
      customerId: row.customer_id || null,
      subscriptionId: row.subscription_id || null,
      provider: row.provider || null,
      subscriptionStatus: row.subscription_status || null,
      billingInterval: row.billing_interval || null,
      currentPeriodStart: row.current_period_start || null,
      currentPeriodEnd: row.current_period_end || null,
      cancelAtPeriodEnd: row.cancel_at_period_end === 1,
      canceledAt: row.canceled_at || null,
      lastPaymentAt: row.last_payment_at || null,
      lastPaymentStatus: row.last_payment_status || null,
      metadata: safeJsonParse(row.metadata_json),
      updatedAt: row.updated_at || null,
      createdAt: row.created_at || null
    };
  }

  upsertFromEntitlement(payload, result = 'ignored') {
    const guildId = normalizeString(payload?.guildId);
    if (!guildId) return { success: false, message: 'guildId is required' };

    const context = tenantService.ensureTenant(guildId);
    const tenantId = context?.tenant?.id;
    if (!tenantId) return { success: false, message: 'Tenant not found' };

    const metadata = payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
    const existingRow = db.prepare('SELECT * FROM tenant_billing WHERE tenant_id = ? LIMIT 1').get(tenantId);
    const existingMeta = safeJsonParse(existingRow?.metadata_json);

    const customerId = normalizeString(pickFirst(
      payload.customerId,
      payload.customer_id,
      metadata.customerId,
      metadata.customer_id,
      metadata.stripeCustomerId
    ));
    const subscriptionId = normalizeString(pickFirst(
      payload.subscriptionId,
      payload.subscription_id,
      metadata.subscriptionId,
      metadata.subscription_id,
      metadata.subscription
    ));
    const provider = normalizeLower(pickFirst(
      payload.provider,
      metadata.provider,
      metadata.source,
      metadata.gateway
    ));
    const subscriptionStatus = normalizeLower(pickFirst(
      payload.subscriptionStatus,
      payload.subscription_status,
      payload.status,
      metadata.subscriptionStatus,
      metadata.subscription_status,
      metadata.status
    ));
    const billingInterval = normalizeInterval(pickFirst(
      payload.billingInterval,
      payload.billing_interval,
      payload.interval,
      metadata.billingInterval,
      metadata.billing_interval,
      metadata.interval,
      metadata.billingCycle
    ));
    const currentPeriodStart = toIsoDate(pickFirst(
      payload.currentPeriodStart,
      payload.current_period_start,
      payload.periodStart,
      payload.startAt,
      payload.startsAt,
      metadata.currentPeriodStart,
      metadata.current_period_start,
      metadata.periodStart,
      metadata.startAt,
      metadata.startsAt
    ));
    const currentPeriodEnd = toIsoDate(pickFirst(
      payload.currentPeriodEnd,
      payload.current_period_end,
      payload.periodEnd,
      payload.endAt,
      payload.expiresAt,
      payload.expiry,
      payload.validUntil,
      metadata.currentPeriodEnd,
      metadata.current_period_end,
      metadata.periodEnd,
      metadata.endAt,
      metadata.expiresAt,
      metadata.expiry,
      metadata.validUntil
    ));
    const canceledAt = toIsoDate(pickFirst(
      payload.canceledAt,
      payload.canceled_at,
      payload.cancelledAt,
      payload.cancelled_at,
      metadata.canceledAt,
      metadata.canceled_at,
      metadata.cancelledAt,
      metadata.cancelled_at
    ));
    const lastPaymentAt = toIsoDate(pickFirst(
      payload.lastPaymentAt,
      payload.last_payment_at,
      payload.paidAt,
      payload.paymentAt,
      metadata.lastPaymentAt,
      metadata.last_payment_at,
      metadata.paidAt,
      metadata.paymentAt,
      metadata.invoicePaidAt
    ));
    const lastPaymentStatus = normalizeLower(pickFirst(
      payload.paymentStatus,
      payload.payment_status,
      metadata.paymentStatus,
      metadata.payment_status,
      metadata.invoiceStatus,
      payload.status
    ));

    let cancelAtPeriodEnd = existingRow?.cancel_at_period_end === 1 ? 1 : 0;
    if (
      payload?.cancelAtPeriodEnd !== undefined
      || payload?.cancel_at_period_end !== undefined
      || metadata?.cancelAtPeriodEnd !== undefined
      || metadata?.cancel_at_period_end !== undefined
    ) {
      cancelAtPeriodEnd = normalizeBoolean(pickFirst(
        payload.cancelAtPeriodEnd,
        payload.cancel_at_period_end,
        metadata.cancelAtPeriodEnd,
        metadata.cancel_at_period_end
      )) ? 1 : 0;
    }

    const nextMeta = {
      ...existingMeta,
      lastWebhookEventType: normalizeString(payload?.eventType) || existingMeta.lastWebhookEventType || null,
      lastWebhookResult: normalizeString(result) || existingMeta.lastWebhookResult || null,
      lastWebhookAt: new Date().toISOString(),
    };
    if (Object.keys(metadata).length > 0) {
      nextMeta.lastWebhookMetadata = metadata;
    }
    const metadataJson = JSON.stringify(nextMeta);

    const merged = {
      customer_id: customerId || existingRow?.customer_id || null,
      subscription_id: subscriptionId || existingRow?.subscription_id || null,
      provider: provider || existingRow?.provider || null,
      subscription_status: subscriptionStatus || existingRow?.subscription_status || null,
      billing_interval: billingInterval || existingRow?.billing_interval || null,
      current_period_start: currentPeriodStart || existingRow?.current_period_start || null,
      current_period_end: currentPeriodEnd || existingRow?.current_period_end || null,
      cancel_at_period_end: cancelAtPeriodEnd,
      canceled_at: canceledAt || existingRow?.canceled_at || null,
      last_payment_at: lastPaymentAt || existingRow?.last_payment_at || null,
      last_payment_status: lastPaymentStatus || existingRow?.last_payment_status || null,
      metadata_json: metadataJson
    };

    db.prepare(`
      INSERT INTO tenant_billing (
        tenant_id,
        customer_id,
        subscription_id,
        provider,
        subscription_status,
        billing_interval,
        current_period_start,
        current_period_end,
        cancel_at_period_end,
        canceled_at,
        last_payment_at,
        last_payment_status,
        metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        customer_id = excluded.customer_id,
        subscription_id = excluded.subscription_id,
        provider = excluded.provider,
        subscription_status = excluded.subscription_status,
        billing_interval = excluded.billing_interval,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        canceled_at = excluded.canceled_at,
        last_payment_at = excluded.last_payment_at,
        last_payment_status = excluded.last_payment_status,
        metadata_json = excluded.metadata_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      tenantId,
      merged.customer_id,
      merged.subscription_id,
      merged.provider,
      merged.subscription_status,
      merged.billing_interval,
      merged.current_period_start,
      merged.current_period_end,
      merged.cancel_at_period_end,
      merged.canceled_at,
      merged.last_payment_at,
      merged.last_payment_status,
      merged.metadata_json
    );

    return { success: true };
  }

  resolveCheckoutUrl({ provider, planKey, interval, guildId }) {
    const providerKey = String(provider || '').trim().toUpperCase();
    const normalizedPlan = normalizePlanKey(planKey);
    const planKeyUpper = String(normalizedPlan || '').toUpperCase();
    const normalizedInterval = normalizeInterval(interval);
    const intervalUpper = String(normalizedInterval || '').toUpperCase();

    if (!providerKey || !planKeyUpper) return null;

    const url = envValue([
      `BILLING_${providerKey}_CHECKOUT_${planKeyUpper}_${intervalUpper}`,
      `BILLING_CHECKOUT_${providerKey}_${planKeyUpper}_${intervalUpper}`,
      `BILLING_${providerKey}_CHECKOUT_${planKeyUpper}`,
      `BILLING_CHECKOUT_${providerKey}_${planKeyUpper}`,
      `BILLING_${providerKey}_CHECKOUT_URL`,
      `BILLING_CHECKOUT_${providerKey}_URL`
    ]);

    if (!url) return null;
    return applyTemplate(url, { guildId, planKey: normalizedPlan, interval: normalizedInterval || 'monthly' });
  }

  resolveManageUrl({ provider, guildId, planKey, interval }) {
    const providerKey = String(provider || '').trim().toUpperCase();
    const url = envValue([
      `BILLING_${providerKey}_MANAGE_URL`,
      `BILLING_MANAGE_${providerKey}_URL`,
      'BILLING_MANAGE_URL'
    ]);
    if (!url) return null;
    return applyTemplate(url, { guildId, planKey, interval });
  }

  getRenewalOptions({ guildId, planKey, interval }) {
    const normalizedPlan = normalizePlanKey(planKey);
    if (!normalizedPlan || normalizedPlan === 'starter' || normalizedPlan === 'enterprise') {
      return [];
    }

    const preferredInterval = normalizeInterval(interval) || 'monthly';
    const intervals = preferredInterval === 'yearly' ? ['yearly', 'monthly'] : ['monthly', 'yearly'];
    const providers = ['stripe', 'crypto'];
    const options = [];

    for (const provider of providers) {
      for (const billingInterval of intervals) {
        const url = this.resolveCheckoutUrl({
          provider,
          planKey: normalizedPlan,
          interval: billingInterval,
          guildId
        });
        if (!url) continue;
        options.push({
          provider,
          interval: billingInterval,
          url,
          label: `${provider === 'stripe' ? 'Stripe' : 'Crypto'} ${billingInterval === 'yearly' ? 'Yearly' : 'Monthly'}`
        });
      }
    }

    return options;
  }

  enforceSubscriptionExpiry({ graceMinutes = 1440, batchSize = 50 } = {}) {
    const normalizedGrace = Math.max(0, Number(graceMinutes) || 0);
    const normalizedBatch = Math.max(1, Math.min(200, Number(batchSize) || 50));
    const cutoff = new Date(Date.now() - (normalizedGrace * 60 * 1000)).toISOString();

    const activeMarkers = ['active', 'approved', 'success', 'paid', 'trialing'];
    const placeholders = activeMarkers.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT
        t.guild_id AS guild_id,
        t.plan_key AS plan_key,
        t.status AS tenant_status,
        tb.subscription_status AS subscription_status,
        tb.current_period_end AS current_period_end
      FROM tenants t
      INNER JOIN tenant_billing tb ON tb.tenant_id = t.id
      WHERE LOWER(COALESCE(t.plan_key, 'starter')) != 'starter'
        AND LOWER(COALESCE(t.status, 'active')) = 'active'
        AND tb.current_period_end IS NOT NULL
        AND datetime(tb.current_period_end) <= datetime(?)
        AND LOWER(COALESCE(tb.subscription_status, '')) NOT IN (${placeholders})
      ORDER BY datetime(tb.current_period_end) ASC
      LIMIT ?
    `).all(cutoff, ...activeMarkers, normalizedBatch);

    let downgraded = 0;
    let errors = 0;

    for (const row of rows) {
      try {
        const guildId = normalizeString(row.guild_id);
        if (!guildId) continue;

        const downgrade = tenantService.setTenantPlan(guildId, 'starter', 'billing-expiry-sweep');
        const suspend = tenantService.setTenantStatus(guildId, 'suspended', 'billing-expiry-sweep');
        if (!downgrade.success || !suspend.success) {
          errors += 1;
          continue;
        }

        db.prepare(`
          UPDATE tenant_billing
          SET subscription_status = 'expired',
              updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = (SELECT id FROM tenants WHERE guild_id = ? LIMIT 1)
        `).run(guildId);

        downgraded += 1;
      } catch (_error) {
        errors += 1;
      }
    }

    return {
      scanned: rows.length,
      downgraded,
      errors,
      cutoff
    };
  }

  getSupportUrl(guildId) {
    const settings = settingsManager.getSettings();
    const settingsSupport = normalizeString(settings?.billingSupportUrl);
    if (settingsSupport) {
      return applyTemplate(settingsSupport, { guildId, planKey: null, interval: null });
    }
    const envSupport = envValue(['BILLING_SUPPORT_URL', 'SUPPORT_URL']);
    if (envSupport) {
      return applyTemplate(envSupport, { guildId, planKey: null, interval: null });
    }

    const context = tenantService.getTenantContext(guildId);
    return context?.branding?.support_url || null;
  }

  getSubscriptionSnapshot(guildId) {
    const context = tenantService.getTenantContext(guildId);
    const planKey = context?.planKey || 'starter';
    const planPreset = getPlanPreset(planKey);
    const billing = this.getTenantBilling(guildId);
    const billingInterval = billing?.billingInterval || 'monthly';
    const renewalOptions = this.getRenewalOptions({
      guildId,
      planKey,
      interval: billingInterval
    });

    const manageUrl = billing?.provider
      ? this.resolveManageUrl({
        provider: billing.provider,
        guildId,
        planKey,
        interval: billingInterval
      })
      : null;

    return {
      plan: planKey,
      planLabel: context?.planLabel || planPreset?.label || planKey,
      status: context?.status || 'active',
      expiresAt: billing?.currentPeriodEnd || null,
      billing: billing ? {
        ...billing,
        manageUrl: manageUrl || null
      } : null,
      renewal: {
        annualDiscountPct: Number(planPreset?.billing?.annualDiscountPct || 15),
        supportUrl: this.getSupportUrl(guildId),
        options: renewalOptions
      }
    };
  }
}

module.exports = new BillingService();
