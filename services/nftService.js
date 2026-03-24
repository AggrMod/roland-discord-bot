const { Connection, PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logger');

const MOCK_MODE = process.env.MOCK_MODE === 'true' || true;

class NFTService {
  constructor() {
    this.connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
  }

  async getNFTsForWallet(walletAddress) {
    if (MOCK_MODE) {
      return this.getMockNFTs(walletAddress);
    }

    try {
      logger.log(`Fetching NFTs for wallet: ${walletAddress}`);
      return [];
    } catch (error) {
      logger.error('Error fetching NFTs:', error);
      return [];
    }
  }

  getMockNFTs(walletAddress) {
    const mockCount = Math.floor(Math.random() * 10) + 1;
    const roles = ['The Hitman', 'The Enforcer', 'The Driver', 'The Accountant', 'The Consigliere', 'The Don'];
    
    const nfts = [];
    for (let i = 0; i < mockCount; i++) {
      const randomRole = roles[Math.floor(Math.random() * roles.length)];
      nfts.push({
        mint: `MOCK_${walletAddress.slice(0, 8)}_${i}`,
        name: `SOLPRANOS #${1000 + i}`,
        image: `https://example.com/nft/${i}.png`,
        attributes: [
          { trait_type: 'Role', value: randomRole },
          { trait_type: 'Rarity', value: 'Common' }
        ],
        assignedToMission: null
      });
    }

    logger.log(`Mock mode: Generated ${mockCount} NFTs for ${walletAddress}`);
    return nfts;
  }

  async getNFTsByRole(walletAddress, requiredRole) {
    const allNFTs = await this.getNFTsForWallet(walletAddress);
    return allNFTs.filter(nft => {
      const roleAttr = nft.attributes.find(a => a.trait_type === 'Role');
      return roleAttr && roleAttr.value === requiredRole && !nft.assignedToMission;
    });
  }

  async countNFTsForWallets(walletAddresses) {
    let totalCount = 0;
    for (const wallet of walletAddresses) {
      const nfts = await this.getNFTsForWallet(wallet);
      totalCount += nfts.length;
    }
    return totalCount;
  }

  async getAllNFTsForWallets(walletAddresses) {
    const allNFTs = [];
    for (const wallet of walletAddresses) {
      const nfts = await this.getNFTsForWallet(wallet);
      allNFTs.push(...nfts);
    }
    return allNFTs;
  }
}

module.exports = new NFTService();
