const rolesConfig = require('../config/roles.json');
const logger = require('../utils/logger');

class VPService {
  getTierForNFTCount(nftCount) {
    if (nftCount === 0) return null;
    
    for (const tier of rolesConfig.tiers) {
      if (nftCount >= tier.minNFTs && nftCount <= tier.maxNFTs) {
        return tier;
      }
    }
    
    return rolesConfig.tiers[rolesConfig.tiers.length - 1];
  }

  calculateVotingPower(nftCount) {
    const tier = this.getTierForNFTCount(nftCount);
    return tier ? tier.votingPower : 0;
  }

  getTierName(nftCount) {
    const tier = this.getTierForNFTCount(nftCount);
    return tier ? tier.name : 'None';
  }

  getAllTiers() {
    return rolesConfig.tiers;
  }

  getTotalVPInSystem(users) {
    return users.reduce((total, user) => total + (user.voting_power || 0), 0);
  }

  meetsQuorum(votedVP, totalVP, quorumPercentage = 25) {
    const quorumRequired = Math.ceil(totalVP * (quorumPercentage / 100));
    return votedVP >= quorumRequired;
  }

  hasVotePassed(yesVP, noVP, abstainVP) {
    const totalVoted = yesVP + noVP + abstainVP;
    if (totalVoted === 0) return false;
    
    const yesPercentage = (yesVP / (yesVP + noVP)) * 100;
    return yesPercentage > 50;
  }
}

module.exports = new VPService();
