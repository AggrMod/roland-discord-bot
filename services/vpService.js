const settingsManager = require('../config/settings');

class VPService {
  getTiers() {
    if (typeof settingsManager.getAllTiers === 'function') {
      return settingsManager.getAllTiers();
    }
    const settings = settingsManager.getSettings ? settingsManager.getSettings() : {};
    return Array.isArray(settings?.tiers) ? settings.tiers : [];
  }

  getTierForNFTCount(nftCount) {
    if (nftCount === 0) return null;

    const tiers = this.getTiers();
    for (const tier of tiers) {
      if (nftCount >= tier.minNFTs && nftCount <= tier.maxNFTs) {
        return tier;
      }
    }

    return tiers[tiers.length - 1] || null;
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
    return this.getTiers();
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
