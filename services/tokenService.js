const { Connection, PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logger');
const tenantService = require('./tenantService');

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const MOCK_MODE = process.env.MOCK_MODE === 'true';

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

class TokenService {
  constructor() {
    this.connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
    this.invalidWalletWarned = new Set();
  }

  _normalizeMintList(mintFilter) {
    if (!Array.isArray(mintFilter) || !mintFilter.length) return [];
    return [...new Set(
      mintFilter
        .map(m => String(m || '').trim())
        .filter(Boolean)
    )];
  }

  async getWalletTokenBalances(walletAddress, options = {}) {
    const normalizedWallet = String(walletAddress || '').trim();
    const guildId = options.guildId || null;
    const mintList = this._normalizeMintList(options.mintFilter);
    const mintFilterSet = mintList.length
      ? new Set(mintList.map(m => m.toLowerCase()))
      : null;

    if (!normalizedWallet) return [];

    const tenantMockEnabled = guildId && tenantService.isMultitenantEnabled()
      ? tenantService.getTenantContext(guildId)?.limits?.mockDataEnabled === true
      : false;

    if (MOCK_MODE || tenantMockEnabled) {
      return this.getMockTokenBalances(mintList);
    }

    if (!isValidSolanaAddress(normalizedWallet)) {
      const warnKey = `${guildId || 'global'}:${normalizedWallet}`;
      if (!this.invalidWalletWarned.has(warnKey)) {
        logger.warn(`Skipping invalid wallet address for token fetch: ${normalizedWallet}${guildId ? ` (guild ${guildId})` : ''}`);
        this.invalidWalletWarned.add(warnKey);
      }
      return [];
    }

    try {
      const owner = new PublicKey(normalizedWallet);
      const response = await this.connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID });

      const byMint = new Map();
      for (const entry of response.value || []) {
        const info = entry?.account?.data?.parsed?.info;
        const mint = String(info?.mint || '').trim();
        if (!mint) continue;
        if (mintFilterSet && !mintFilterSet.has(mint.toLowerCase())) continue;

        const tokenAmount = info?.tokenAmount;
        const amount = Number(tokenAmount?.uiAmount ?? 0);
        const decimals = Number(tokenAmount?.decimals ?? 0);
        if (!Number.isFinite(amount) || amount <= 0) continue;

        const current = byMint.get(mint) || { mint, amount: 0, decimals };
        current.amount += amount;
        if (!Number.isFinite(current.decimals)) current.decimals = decimals;
        byMint.set(mint, current);
      }

      return Array.from(byMint.values()).sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0));
    } catch (error) {
      logger.error(`Error fetching token balances for wallet ${normalizedWallet}:`, error?.message || error);
      return [];
    }
  }

  async getAggregateBalancesForWallets(walletAddresses, mintFilter = [], options = {}) {
    const wallets = Array.isArray(walletAddresses) ? walletAddresses : [];
    const mintList = this._normalizeMintList(mintFilter);
    const totals = {};

    for (const mint of mintList) {
      totals[mint] = 0;
    }

    for (const wallet of wallets) {
      const balances = await this.getWalletTokenBalances(wallet, { ...options, mintFilter: mintList });
      for (const row of balances) {
        if (!totals[row.mint]) totals[row.mint] = 0;
        totals[row.mint] += Number(row.amount || 0);
      }
    }

    return totals;
  }

  getMockTokenBalances(mintFilter = []) {
    const mints = mintFilter.length
      ? mintFilter
      : [
        'So11111111111111111111111111111111111111112',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      ];

    return mints.map((mint, idx) => ({
      mint,
      amount: Number((Math.random() * (idx === 0 ? 3 : 2000)).toFixed(idx === 0 ? 4 : 2)),
      decimals: idx === 0 ? 9 : 6
    }));
  }
}

module.exports = new TokenService();
