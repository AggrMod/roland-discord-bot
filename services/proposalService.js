const db = require('../database/db');
const vpService = require('./vpService');
const logger = require('../utils/logger');

class ProposalService {
  generateProposalId() {
    const count = db.prepare('SELECT COUNT(*) as count FROM proposals').get().count;
    return `P-${String(count + 1).padStart(3, '0')}`;
  }

  createProposal(creatorId, creatorWallet, title, description) {
    try {
      const proposalId = this.generateProposalId();
      
      db.prepare(`
        INSERT INTO proposals (proposal_id, creator_id, creator_wallet, title, description, status)
        VALUES (?, ?, ?, ?, ?, 'draft')
      `).run(proposalId, creatorId, creatorWallet, title, description);

      logger.log(`Proposal ${proposalId} created by ${creatorId}`);
      return { success: true, proposalId };
    } catch (error) {
      logger.error('Error creating proposal:', error);
      return { success: false, message: 'Failed to create proposal' };
    }
  }

  getProposal(proposalId) {
    try {
      const proposal = db.prepare('SELECT * FROM proposals WHERE proposal_id = ?').get(proposalId);
      return proposal;
    } catch (error) {
      logger.error('Error fetching proposal:', error);
      return null;
    }
  }

  addSupporter(proposalId, supporterId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) {
        return { success: false, message: 'Proposal not found' };
      }

      if (proposal.status !== 'draft') {
        return { success: false, message: 'Can only support draft proposals' };
      }

      db.prepare(`
        INSERT INTO proposal_supporters (proposal_id, supporter_id)
        VALUES (?, ?)
      `).run(proposalId, supporterId);

      const supporterCount = db.prepare(
        'SELECT COUNT(*) as count FROM proposal_supporters WHERE proposal_id = ?'
      ).get(proposalId).count;

      if (supporterCount >= 4) {
        this.promoteToVoting(proposalId);
      }

      logger.log(`User ${supporterId} supported proposal ${proposalId} (${supporterCount}/4)`);
      return { success: true, supporterCount };
    } catch (error) {
      if (error.message.includes('UNIQUE constraint failed')) {
        return { success: false, message: 'You already support this proposal' };
      }
      logger.error('Error adding supporter:', error);
      return { success: false, message: 'Failed to add support' };
    }
  }

  promoteToVoting(proposalId) {
    try {
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 7 * 24 * 60 * 60 * 1000);

      const allUsers = db.prepare('SELECT voting_power FROM users WHERE voting_power > 0').all();
      const totalVP = vpService.getTotalVPInSystem(allUsers);

      db.prepare(`
        UPDATE proposals 
        SET status = 'voting', start_time = ?, end_time = ?, total_vp = ?
        WHERE proposal_id = ?
      `).run(startTime.toISOString(), endTime.toISOString(), totalVP, proposalId);

      logger.log(`Proposal ${proposalId} promoted to voting. Total VP: ${totalVP}`);
      return { success: true };
    } catch (error) {
      logger.error('Error promoting proposal:', error);
      return { success: false };
    }
  }

  castVote(proposalId, voterId, voteChoice, votingPower) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) {
        return { success: false, message: 'Proposal not found' };
      }

      if (proposal.status !== 'voting') {
        return { success: false, message: 'Proposal is not in voting phase' };
      }

      const existingVote = db.prepare(
        'SELECT * FROM votes WHERE proposal_id = ? AND voter_id = ?'
      ).get(proposalId, voterId);

      if (existingVote) {
        db.prepare(`
          UPDATE votes 
          SET vote_choice = ?, voting_power = ?, updated_at = CURRENT_TIMESTAMP
          WHERE proposal_id = ? AND voter_id = ?
        `).run(voteChoice, votingPower, proposalId, voterId);

        logger.log(`User ${voterId} changed vote on ${proposalId} to ${voteChoice}`);
      } else {
        db.prepare(`
          INSERT INTO votes (proposal_id, voter_id, vote_choice, voting_power)
          VALUES (?, ?, ?, ?)
        `).run(proposalId, voterId, voteChoice, votingPower);

        logger.log(`User ${voterId} voted ${voteChoice} on ${proposalId} with ${votingPower} VP`);
      }

      this.updateProposalTally(proposalId);
      this.checkAutoClose(proposalId);

      return { success: true };
    } catch (error) {
      logger.error('Error casting vote:', error);
      return { success: false, message: 'Failed to cast vote' };
    }
  }

  updateProposalTally(proposalId) {
    try {
      const votes = db.prepare('SELECT vote_choice, SUM(voting_power) as vp FROM votes WHERE proposal_id = ? GROUP BY vote_choice').all(proposalId);
      
      let yesVP = 0, noVP = 0, abstainVP = 0;
      
      votes.forEach(v => {
        if (v.vote_choice === 'yes') yesVP = v.vp;
        if (v.vote_choice === 'no') noVP = v.vp;
        if (v.vote_choice === 'abstain') abstainVP = v.vp;
      });

      db.prepare(`
        UPDATE proposals 
        SET yes_vp = ?, no_vp = ?, abstain_vp = ?
        WHERE proposal_id = ?
      `).run(yesVP, noVP, abstainVP, proposalId);

      return { yesVP, noVP, abstainVP };
    } catch (error) {
      logger.error('Error updating tally:', error);
      return { yesVP: 0, noVP: 0, abstainVP: 0 };
    }
  }

  checkAutoClose(proposalId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal || proposal.status !== 'voting') return;

      const totalVoted = proposal.yes_vp + proposal.no_vp + proposal.abstain_vp;
      const halfVP = Math.floor(proposal.total_vp / 2);

      if (totalVoted > halfVP) {
        this.closeVote(proposalId);
        logger.log(`Proposal ${proposalId} auto-closed: >50% VP voted`);
      }

      const now = new Date();
      const endTime = new Date(proposal.end_time);
      if (now >= endTime) {
        this.closeVote(proposalId);
        logger.log(`Proposal ${proposalId} auto-closed: 7 days elapsed`);
      }
    } catch (error) {
      logger.error('Error checking auto-close:', error);
    }
  }

  closeVote(proposalId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false };

      const totalVoted = proposal.yes_vp + proposal.no_vp + proposal.abstain_vp;
      const quorumMet = vpService.meetsQuorum(totalVoted, proposal.total_vp, proposal.quorum_threshold);
      
      let finalStatus = 'rejected';
      
      if (quorumMet) {
        const passed = vpService.hasVotePassed(proposal.yes_vp, proposal.no_vp, proposal.abstain_vp);
        finalStatus = passed ? 'passed' : 'rejected';
      } else {
        finalStatus = 'rejected';
      }

      db.prepare('UPDATE proposals SET status = ? WHERE proposal_id = ?').run(finalStatus, proposalId);

      logger.log(`Proposal ${proposalId} closed with status: ${finalStatus}`);
      return { success: true, status: finalStatus, quorumMet };
    } catch (error) {
      logger.error('Error closing vote:', error);
      return { success: false };
    }
  }

  getActiveProposals() {
    return db.prepare('SELECT * FROM proposals WHERE status IN (?, ?) ORDER BY created_at DESC').all('draft', 'voting');
  }

  getSupporterCount(proposalId) {
    return db.prepare('SELECT COUNT(*) as count FROM proposal_supporters WHERE proposal_id = ?').get(proposalId).count;
  }
}

module.exports = new ProposalService();
