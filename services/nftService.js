const { Connection, PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logger');
const tenantService = require('./tenantService');

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const ALLOW_MOCK_IN_PROD = process.env.ALLOW_MOCK_IN_PROD === 'true';

// Helius rate limiter — default 10 req/sec (free tier), set HELIUS_RPS in .env to override
const HELIUS_RPS = parseInt(process.env.HELIUS_RPS || '10');
const HELIUS_MIN_INTERVAL_MS = Math.ceil(1000 / HELIUS_RPS);
let _heliusLastCall = 0;
let _heliusQueue = Promise.resolve();

function heliusRateLimited(fn) {
  _heliusQueue = _heliusQueue.then(async () => {
    const now = Date.now();
    const wait = HELIUS_MIN_INTERVAL_MS - (now - _heliusLastCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _heliusLastCall = Date.now();
    return fn();
  });
  return _heliusQueue;
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

class NFTService {
  constructor() {
    if (IS_PRODUCTION && MOCK_MODE && !ALLOW_MOCK_IN_PROD) {
      throw new Error('MOCK_MODE is not allowed in production. Disable MOCK_MODE or set ALLOW_MOCK_IN_PROD=true explicitly.');
    }
    this.connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
    this.invalidWalletWarned = new Set();
    this.mockInProdWarnedGuilds = new Set();
  }

  async getNFTsForWallet(walletAddress, options = {}) {
    const normalizedWallet = String(walletAddress || '').trim();
    if (!normalizedWallet) {
      return [];
    }

    const guildId = options.guildId;
    const tenantMockEnabled = guildId && tenantService.isMultitenantEnabled()
      ? tenantService.getTenantContext(guildId)?.limits?.mockDataEnabled === true
      : false;

    if (IS_PRODUCTION && !ALLOW_MOCK_IN_PROD && tenantMockEnabled) {
      const warnKey = String(guildId || 'global');
      if (!this.mockInProdWarnedGuilds.has(warnKey)) {
        logger.error(`Tenant mock_data_enabled ignored in production for guild ${warnKey}`);
        this.mockInProdWarnedGuilds.add(warnKey);
      }
    }

    if (MOCK_MODE || tenantMockEnabled) {
      if (IS_PRODUCTION && !ALLOW_MOCK_IN_PROD) {
        return [];
      }
      if (tenantMockEnabled && !MOCK_MODE) {
        logger.warn(`Tenant mock_data_enabled active for guild ${guildId}; serving mock NFTs for ${normalizedWallet}`);
      }
      return this.getMockNFTs(normalizedWallet, {
        guildId,
        mockReason: tenantMockEnabled && !MOCK_MODE ? 'tenant-mock-data-enabled' : 'global-mock-mode'
      });
    }

    // Legacy mock wallet IDs can remain in DB; skip invalid addresses before hitting Helius.
    if (!isValidSolanaAddress(normalizedWallet)) {
      const warnKey = `${guildId || 'global'}:${normalizedWallet}`;
      if (!this.invalidWalletWarned.has(warnKey)) {
        logger.warn(`Skipping invalid wallet address for NFT fetch: ${normalizedWallet}${guildId ? ` (guild ${guildId})` : ''}`);
        this.invalidWalletWarned.add(warnKey);
      }
      return [];
    }

    try {
      logger.log(`Fetching NFTs for wallet: ${normalizedWallet}`);
      return await this.fetchNFTsFromHelius(normalizedWallet);
    } catch (error) {
      logger.error('Error fetching NFTs:', error);
      // Fail closed outside mock mode to prevent accidental role grants.
      return [];
    }
  }

  async fetchNFTsFromHelius(walletAddress) {
    const heliusApiKey = process.env.HELIUS_API_KEY;
    if (!heliusApiKey) {
      logger.warn('HELIUS_API_KEY not configured; returning empty NFT set');
      return [];
    }

    try {
      const response = await heliusRateLimited(() => fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'helius-nft-fetch',
          method: 'getAssetsByOwner',
          params: {
            ownerAddress: walletAddress,
            displayOptions: {
              showFungible: false,
              showCollectionMetadata: true,
              showInscription: false
            },
            limit: 1000
          }
        })
      }));

      const data = await response.json();
      if (data.error) {
        logger.error('Helius API error:', data.error);
        return [];
      }

      if (!data.result || !data.result.items) {
        return [];
      }

      // Transform Helius response to NFT format
      return data.result.items.map(item => ({
        mint: item.id,
        name: item.content?.metadata?.name || 'Unknown NFT',
        image: item.content?.links?.image || '',
        attributes: this.extractHeliusAttributes(item.content?.metadata?.attributes || []),
        collectionKey: item.grouping?.[0]?.group_value || null,
        assignedToMission: null
      }));
    } catch (error) {
      logger.error('Helius fetch error:', error);
      return [];
    }
  }

  extractHeliusAttributes(attributes) {
    if (!Array.isArray(attributes)) return [];
    return attributes.map(attr => ({
      trait_type: attr.trait_type || attr.traitType || 'Unknown',
      value: attr.value
    })).filter(a => a.value);
  }

  getMockNFTs(walletAddress, context = {}) {
    const mockCount = Math.floor(Math.random() * 10) + 1;
    const roles = ['The Hitman', 'The Enforcer', 'The Driver', 'The Accountant', 'The Consigliere', 'The Don'];
    const rarities = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
    const guildSuffix = context.guildId ? ` (guild ${context.guildId})` : '';
    const reasonSuffix = context.mockReason ? ` [reason: ${context.mockReason}]` : '';
    
    const nfts = [];
    for (let i = 0; i < mockCount; i++) {
      const randomRole = roles[Math.floor(Math.random() * roles.length)];
      const randomRarity = rarities[Math.floor(Math.random() * rarities.length)];
      
      nfts.push({
        mint: `MOCK_${walletAddress.slice(0, 8)}_${i}`,
        name: `GuildPilot Mock #${1000 + i}`,
        image: `https://example.com/nft/${i}.png`,
        attributes: [
          { trait_type: 'Role', value: randomRole },
          { trait_type: 'Rarity', value: randomRarity },
          { trait_type: 'Background', value: 'City Skyline' },
          { trait_type: 'Outfit', value: 'Classic Suit' }
        ],
        assignedToMission: null
      });
    }

    logger.log(`Mock mode${guildSuffix}${reasonSuffix}: Generated ${mockCount} NFTs for ${walletAddress}`);
    return nfts;
  }

  async getNFTsByRole(walletAddress, requiredRole, options = {}) {
    const allNFTs = await this.getNFTsForWallet(walletAddress, options);
    return allNFTs.filter(nft => {
      const roleAttr = nft.attributes.find(a => a.trait_type === 'Role');
      return roleAttr && roleAttr.value === requiredRole && !nft.assignedToMission;
    });
  }

  async countNFTsForWallets(walletAddresses, options = {}) {
    let totalCount = 0;
    for (const wallet of walletAddresses) {
      const nfts = await this.getNFTsForWallet(wallet, options);
      totalCount += nfts.length;
    }
    return totalCount;
  }

  async getAllNFTsForWallets(walletAddresses, options = {}) {
    const allNFTs = [];
    for (const wallet of walletAddresses) {
      const nfts = await this.getNFTsForWallet(wallet, options);
      allNFTs.push(...nfts);
    }
    return allNFTs;
  }

  /**
   * Extract unique trait values from NFTs by trait type
   */
  extractTraitValues(nfts, traitType) {
    const values = new Set();
    
    for (const nft of nfts) {
      if (nft.attributes && Array.isArray(nft.attributes)) {
        const trait = nft.attributes.find(a => a.trait_type === traitType);
        if (trait && trait.value) {
          values.add(trait.value);
        }
      }
    }
    
    return Array.from(values);
  }

  /**
   * Get all unique traits across NFT collection
   */
  getAllTraits(nfts) {
    const traitMap = new Map();
    
    for (const nft of nfts) {
      if (nft.attributes && Array.isArray(nft.attributes)) {
        for (const attr of nft.attributes) {
          if (attr.trait_type && attr.value) {
            if (!traitMap.has(attr.trait_type)) {
              traitMap.set(attr.trait_type, new Set());
            }
            traitMap.get(attr.trait_type).add(attr.value);
          }
        }
      }
    }
    
    const result = {};
    for (const [traitType, values] of traitMap.entries()) {
      result[traitType] = Array.from(values);
    }
    
    return result;
  }
}

module.exports = new NFTService();
