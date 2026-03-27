const db = require('../database/db');
const vpService = require('./vpService');
const logger = require('../utils/logger');
const governanceLogger = require('../utils/governanceLogger');
const settingsManager = require('../config/settings');

// Tier-based VP thresholds per governance rules
const TIER_VP = [
  { name: 'Associate', min: 1, max: 2, vp: 1 },
  { name: 'Soldato', min: 3, max: 6, vp: 3 },
  { name: 'Capo', min: 7, max: 14, vp: 6 },
  { name: 'Elite', min: 15, max: 49, vp: 10 },
  { name: 'Underboss Holder', min: 50, max: 149, vp: 14 },
  { name: 'Don Holder', min: 150, max: Infinity, vp: 18 }
];

function getTierVP(nftCount) {
  if (!nftCount || nftCount < 1) return 0;
  for (const t of TIER_VP) {
    if (nftCount >= t.min && nftCount <= t.max) return t.vp;
  }
  return TIER_VP[TIER_VP.length - 1].vp;
}

class ProposalService {
  constructor() {
    this.client = null;
  }

  setClient(client) {
    this.client = client;
  }

  generateProposalId() {
    const count = db.prepare('SELECT COUNT(*) as count FROM proposals').get().count;
    return `P-${String(count + 1).padStart(3, '0')}`;
  }

  // ==================== PROPOSAL LIFECYCLE ====================

  createProposal(creatorId, { title, description, category, costIndication }) {
    try {
      const proposalId = this.generateProposalId();
      const validCategories = settingsManager.getSettings().proposalCategories || ['Partnership', 'Treasury Allocation', 'Rule Change', 'Community Event', 'Other'];
      const safeCategory = validCategories.includes(category) ? category : 'Other';

      db.prepare(`
        INSERT INTO proposals (proposal_id, creator_id, title, description, status, category, cost_indication)
        VALUES (?, ?, ?, ?, 'draft', ?, ?)
      `).run(proposalId, creatorId, title, description, safeCategory, costIndication || null);

      logger.log(`Proposal ${proposalId} created by ${creatorId}`);
      governanceLogger.log('proposal_created', { proposalId, creatorId, title, category: safeCategory });

      return { success: true, proposalId };
    } catch (error) {
      logger.error('Error creating proposal:', error);
      return { success: false, message: 'Failed to create proposal' };
    }
  }

  // Legacy compat: support old 4-arg call from Discord commands
  createProposalLegacy(creatorId, creatorWallet, title, description) {
    return this.createProposal(creatorId, { title, description, category: 'Other', costIndication: null });
  }

  submitForReview(proposalId, discordId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (proposal.creator_id !== discordId) return { success: false, message: 'Only the author can submit for review' };
      if (proposal.status !== 'draft') return { success: false, message: 'Only draft proposals can be submitted for review' };

      db.prepare("UPDATE proposals SET status = 'pending_review' WHERE proposal_id = ?").run(proposalId);
      governanceLogger.log('proposal_submitted_for_review', { proposalId, discordId });
      return { success: true };
    } catch (error) {
      logger.error('Error submitting for review:', error);
      return { success: false, message: 'Failed to submit for review' };
    }
  }

  approveProposal(proposalId, adminId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (proposal.status !== 'pending_review' && proposal.status !== 'on_hold') {
        return { success: false, message: 'Proposal must be pending review or on hold to approve' };
      }

      db.prepare("UPDATE proposals SET status = 'supporting' WHERE proposal_id = ?").run(proposalId);
      governanceLogger.log('proposal_approved', { proposalId, adminId });
      return { success: true };
    } catch (error) {
      logger.error('Error approving proposal:', error);
      return { success: false, message: 'Failed to approve proposal' };
    }
  }

  holdProposal(proposalId, adminId, reason) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (proposal.status !== 'pending_review') {
        return { success: false, message: 'Only pending_review proposals can be placed on hold' };
      }

      db.prepare("UPDATE proposals SET status = 'on_hold', on_hold_reason = ? WHERE proposal_id = ?").run(reason || '', proposalId);
      governanceLogger.log('proposal_on_hold', { proposalId, adminId, reason });
      return { success: true };
    } catch (error) {
      logger.error('Error holding proposal:', error);
      return { success: false, message: 'Failed to place on hold' };
    }
  }

  async promoteToVoting(proposalId, adminId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (proposal.status !== 'supporting') {
        return { success: false, message: 'Only supporting proposals can be promoted to voting' };
      }

      // Take VP snapshot
      const snapshot = this.takeVPSnapshot();
      const totalVP = snapshot.totalVP;
      const quorumRequired = Math.ceil(totalVP * ((settingsManager.getSettings().governanceQuorum || 25) / 100));

      const startTime = new Date();
      const voteDays = settingsManager.getSettings().voteDurationDays || 7;
      const endTime = new Date(startTime.getTime() + voteDays * 24 * 60 * 60 * 1000);

      db.prepare(`
        UPDATE proposals
        SET status = 'voting', start_time = ?, end_time = ?, total_vp = ?,
            vp_snapshot = ?, quorum_required = ?, promoted_by = ?
        WHERE proposal_id = ?
      `).run(
        startTime.toISOString(), endTime.toISOString(), totalVP,
        JSON.stringify(snapshot), quorumRequired, adminId || null,
        proposalId
      );

      logger.log(`Proposal ${proposalId} promoted to voting. Total VP: ${totalVP}, Quorum: ${quorumRequired}`);
      governanceLogger.log('proposal_promoted', { proposalId, totalVP, quorumRequired, adminId, title: proposal.title });

      if (this.client) {
        await this.postToVotingChannel(proposalId);
      }

      return { success: true, totalVP, quorumRequired };
    } catch (error) {
      logger.error('Error promoting proposal:', error);
      return { success: false, message: 'Failed to promote to voting' };
    }
  }

  takeVPSnapshot() {
    const settings = settingsManager.getSettings();
    const staffTrusteeRoles = settings.staffTrusteeRoles || ['Enforcer', 'Caporegime', 'Consigliere', 'Underboss', 'Don'];
    const staffVP = settings.staffTrusteesVP || 10;

    // Get all users with NFTs
    const users = db.prepare('SELECT discord_id, total_nfts, voting_power FROM users WHERE total_nfts > 0').all();

    // Get role VP mappings for staff trustee check
    const roleMappings = db.prepare('SELECT * FROM role_vp_mappings').all();
    const staffRoleMappings = roleMappings.filter(m => staffTrusteeRoles.includes(m.role_name));

    const voterVPs = {};
    let totalVP = 0;

    for (const user of users) {
      const tierVP = getTierVP(user.total_nfts);

      // Check if user has a staff trustee role via role_vp_mappings
      let isStaff = false;
      for (const mapping of staffRoleMappings) {
        // Check if user has this role mapping — we use the VP mapping table as indicator
        // In a full implementation we'd check Discord roles, but for snapshot we use the mapping
        if (mapping.voting_power > 0) {
          // Staff trustee check would need Discord member data; for now use tier-based VP
          // The actual staff check happens at vote time when we have the member object
        }
      }

      // For snapshot: use tier-based VP. Staff trustee adjustment happens at castVote.
      const vp = tierVP;
      if (vp > 0) {
        voterVPs[user.discord_id] = vp;
        totalVP += vp;
      }
    }

    return { totalVP, voterVPs };
  }

  castVote(proposalId, discordId, choice, votingPower) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (proposal.status !== 'voting') return { success: false, message: 'Proposal is not in voting phase' };
      if (proposal.paused) return { success: false, message: 'Voting is currently paused on this proposal' };

      // Use snapshotted VP if available, otherwise fall back to provided VP
      let effectiveVP = votingPower;
      if (proposal.vp_snapshot) {
        try {
          const snapshot = JSON.parse(proposal.vp_snapshot);
          if (snapshot.voterVPs && snapshot.voterVPs[discordId] !== undefined) {
            effectiveVP = snapshot.voterVPs[discordId];
          }
        } catch (e) {
          logger.warn(`Failed to parse VP snapshot for ${proposalId}, using provided VP`);
        }
      }

      if (!effectiveVP || effectiveVP < 1) {
        return { success: false, message: 'You have no voting power for this proposal' };
      }

      const existingVote = db.prepare(
        'SELECT * FROM votes WHERE proposal_id = ? AND voter_id = ?'
      ).get(proposalId, discordId);

      if (existingVote) {
        db.prepare(`
          UPDATE votes
          SET vote_choice = ?, voting_power = ?, updated_at = CURRENT_TIMESTAMP
          WHERE proposal_id = ? AND voter_id = ?
        `).run(choice, effectiveVP, proposalId, discordId);
        governanceLogger.log('vote_changed', { proposalId, voterId: discordId, voteChoice: choice, votingPower: effectiveVP });
      } else {
        db.prepare(`
          INSERT INTO votes (proposal_id, voter_id, vote_choice, voting_power)
          VALUES (?, ?, ?, ?)
        `).run(proposalId, discordId, choice, effectiveVP);
        governanceLogger.log('vote_cast', { proposalId, voterId: discordId, voteChoice: choice, votingPower: effectiveVP });
      }

      this.updateProposalTally(proposalId);
      this.checkAutoClose(proposalId);

      return { success: true, votingPower: effectiveVP };
    } catch (error) {
      logger.error('Error casting vote:', error);
      return { success: false, message: 'Failed to cast vote' };
    }
  }

  concludeProposal(proposalId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (proposal.status !== 'voting') return { success: false, message: 'Only voting proposals can be concluded' };

      return this.closeVote(proposalId);
    } catch (error) {
      logger.error('Error concluding proposal:', error);
      return { success: false, message: 'Failed to conclude proposal' };
    }
  }

  vetoProposal(proposalId, discordId, reason) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (!['voting', 'concluded', 'passed'].includes(proposal.status) && proposal.status !== 'supporting') {
        return { success: false, message: 'This proposal cannot be vetoed in its current state' };
      }

      // Record veto vote
      try {
        db.prepare(`
          INSERT INTO proposal_veto_votes (proposal_id, voter_id, reason)
          VALUES (?, ?, ?)
        `).run(proposalId, discordId, reason || '');
      } catch (e) {
        if (e.message.includes('UNIQUE constraint failed')) {
          return { success: false, message: 'You have already cast a veto vote' };
        }
        throw e;
      }

      // Get all veto votes for this proposal
      const vetoVotes = db.prepare('SELECT * FROM proposal_veto_votes WHERE proposal_id = ?').all(proposalId);
      const vetoVoterIds = vetoVotes.map(v => v.voter_id);

      // Update the proposal's veto_votes field
      db.prepare('UPDATE proposals SET veto_votes = ? WHERE proposal_id = ?')
        .run(JSON.stringify(vetoVoterIds), proposalId);

      governanceLogger.log('veto_vote_cast', { proposalId, discordId, reason, totalVetoVotes: vetoVotes.length });

      // Note: The caller (API endpoint) is responsible for checking if ALL council members
      // have voted and then setting status to 'vetoed'. This service just records the vote.
      return { success: true, vetoCount: vetoVotes.length, vetoVoterIds };
    } catch (error) {
      logger.error('Error vetoing proposal:', error);
      return { success: false, message: 'Failed to record veto vote' };
    }
  }

  applyVeto(proposalId, reason) {
    try {
      db.prepare("UPDATE proposals SET status = 'vetoed', veto_reason = ? WHERE proposal_id = ?")
        .run(reason || 'Unanimous council veto', proposalId);
      governanceLogger.log('proposal_vetoed', { proposalId, reason });
      return { success: true };
    } catch (error) {
      logger.error('Error applying veto:', error);
      return { success: false, message: 'Failed to apply veto' };
    }
  }

  emergencyPause(proposalId, discordId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (proposal.status !== 'voting') return { success: false, message: 'Only voting proposals can be paused' };

      const newPaused = proposal.paused ? 0 : 1;
      db.prepare('UPDATE proposals SET paused = ? WHERE proposal_id = ?').run(newPaused, proposalId);

      governanceLogger.log(newPaused ? 'proposal_paused' : 'proposal_unpaused', { proposalId, discordId });
      return { success: true, paused: !!newPaused };
    } catch (error) {
      logger.error('Error toggling emergency pause:', error);
      return { success: false, message: 'Failed to toggle pause' };
    }
  }

  // ==================== COMMENTS ====================

  addComment(proposalId, authorId, authorName, content) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };

      db.prepare(`
        INSERT INTO proposal_comments (proposal_id, author_id, author_name, content)
        VALUES (?, ?, ?, ?)
      `).run(proposalId, authorId, authorName || 'Unknown', content);

      return { success: true };
    } catch (error) {
      logger.error('Error adding comment:', error);
      return { success: false, message: 'Failed to add comment' };
    }
  }

  getComments(proposalId) {
    try {
      return db.prepare('SELECT * FROM proposal_comments WHERE proposal_id = ? ORDER BY created_at ASC').all(proposalId);
    } catch (error) {
      logger.error('Error fetching comments:', error);
      return [];
    }
  }

  // ==================== SUPPORT ====================

  addSupporter(proposalId, supporterId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false, message: 'Proposal not found' };
      if (proposal.status !== 'supporting') {
        return { success: false, message: 'Can only support proposals in the supporting phase' };
      }
      if (proposal.creator_id === supporterId) {
        governanceLogger.log('support_blocked', { proposalId, userId: supporterId });
        return { success: false, message: 'You cannot support your own proposal' };
      }

      // Use both tables for compatibility
      try {
        db.prepare('INSERT INTO proposal_support (proposal_id, supporter_id) VALUES (?, ?)').run(proposalId, supporterId);
      } catch (e) {
        if (e.message.includes('UNIQUE constraint failed')) {
          return { success: false, message: 'You already support this proposal' };
        }
        throw e;
      }

      // Also insert into legacy table
      try {
        db.prepare('INSERT INTO proposal_supporters (proposal_id, supporter_id) VALUES (?, ?)').run(proposalId, supporterId);
      } catch (e) { /* ignore duplicate */ }

      const supporterCount = db.prepare('SELECT COUNT(*) as count FROM proposal_support WHERE proposal_id = ?').get(proposalId).count;

      governanceLogger.log('support_added', { proposalId, supporterId, supporterCount });
      logger.log(`User ${supporterId} supported proposal ${proposalId} (${supporterCount} supporters)`);

      return { success: true, supporterCount };
    } catch (error) {
      logger.error('Error adding supporter:', error);
      return { success: false, message: 'Failed to add support' };
    }
  }

  getSupporterCount(proposalId) {
    try {
      const fromNew = db.prepare('SELECT COUNT(*) as count FROM proposal_support WHERE proposal_id = ?').get(proposalId);
      if (fromNew.count > 0) return fromNew.count;
      // Fallback to legacy table
      return db.prepare('SELECT COUNT(*) as count FROM proposal_supporters WHERE proposal_id = ?').get(proposalId).count;
    } catch (e) {
      return 0;
    }
  }

  // ==================== CORE HELPERS ====================

  getProposal(proposalId) {
    try {
      return db.prepare('SELECT * FROM proposals WHERE proposal_id = ?').get(proposalId);
    } catch (error) {
      logger.error('Error fetching proposal:', error);
      return null;
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

      db.prepare('UPDATE proposals SET yes_vp = ?, no_vp = ?, abstain_vp = ? WHERE proposal_id = ?')
        .run(yesVP, noVP, abstainVP, proposalId);

      return { yesVP, noVP, abstainVP };
    } catch (error) {
      logger.error('Error updating tally:', error);
      return { yesVP: 0, noVP: 0, abstainVP: 0 };
    }
  }

  checkAutoClose(proposalId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal || proposal.status !== 'voting' || proposal.paused) return;

      const totalVoted = proposal.yes_vp + proposal.no_vp + proposal.abstain_vp;
      const halfVP = Math.floor(proposal.total_vp / 2);

      if (totalVoted > halfVP) {
        this.closeVote(proposalId);
        logger.log(`Proposal ${proposalId} auto-closed: >50% VP voted`);
        return;
      }

      const now = new Date();
      const endTime = new Date(proposal.end_time);
      if (now >= endTime) {
        this.closeVote(proposalId);
        logger.log(`Proposal ${proposalId} auto-closed: voting period elapsed`);
      }
    } catch (error) {
      logger.error('Error checking auto-close:', error);
    }
  }

  async closeVote(proposalId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { success: false };

      const totalVoted = proposal.yes_vp + proposal.no_vp + proposal.abstain_vp;
      const quorumReq = proposal.quorum_required || Math.ceil(proposal.total_vp * 0.25);
      const quorumMet = totalVoted >= quorumReq;

      let finalStatus = 'concluded';
      let result = 'quorum_not_met';

      if (quorumMet) {
        const passed = vpService.hasVotePassed(proposal.yes_vp, proposal.no_vp, proposal.abstain_vp);
        result = passed ? 'passed' : 'rejected';
      }

      // Status is 'concluded' with the result stored in description or logged
      db.prepare("UPDATE proposals SET status = 'concluded' WHERE proposal_id = ?").run(proposalId);

      governanceLogger.log('vote_closed', {
        proposalId, status: finalStatus, result, quorumMet,
        quorumRequired: quorumReq, totalVoted,
        yesVP: proposal.yes_vp, noVP: proposal.no_vp, abstainVP: proposal.abstain_vp
      });

      await this.updateVotingMessageFinal(proposalId, result, quorumMet);
      await this.postToResultsChannel(proposalId, result, quorumMet);

      logger.log(`Proposal ${proposalId} concluded: ${result} (quorum ${quorumMet ? 'met' : 'not met'})`);
      return { success: true, status: finalStatus, result, quorumMet };
    } catch (error) {
      logger.error('Error closing vote:', error);
      return { success: false };
    }
  }

  getActiveProposals() {
    return db.prepare("SELECT * FROM proposals WHERE status IN ('supporting', 'voting') ORDER BY created_at DESC").all();
  }

  getConcludedProposals() {
    return db.prepare("SELECT * FROM proposals WHERE status IN ('concluded', 'vetoed', 'passed', 'rejected', 'quorum_not_met') ORDER BY created_at DESC").all();
  }

  // ==================== DISCORD CHANNEL POSTING ====================

  async postToVotingChannel(proposalId) {
    try {
      const votingChannelId = process.env.VOTING_CHANNEL_ID;
      if (!votingChannelId) {
        logger.warn('VOTING_CHANNEL_ID not set in .env');
        return;
      }

      const proposal = this.getProposal(proposalId);
      if (!proposal) return;

      const votingChannel = await this.client.channels.fetch(votingChannelId);
      if (!votingChannel || !votingChannel.isTextBased()) return;

      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

      const endDate = new Date(proposal.end_time);
      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`🗳️ ${proposal.title}`)
        .setDescription(proposal.description)
        .addFields(
          { name: '🆔 Proposal ID', value: proposal.proposal_id, inline: true },
          { name: '👤 Creator', value: `<@${proposal.creator_id}>`, inline: true },
          { name: '💪 Total VP', value: proposal.total_vp.toString(), inline: true },
          { name: '📂 Category', value: proposal.category || 'Other', inline: true },
          { name: '💰 Cost', value: proposal.cost_indication || 'N/A', inline: true },
          { name: '🎯 Quorum Required', value: `${proposal.quorum_required} VP`, inline: true },
          { name: '⏰ Deadline', value: `<t:${Math.floor(endDate.getTime() / 1000)}:R>`, inline: false },
          { name: '📊 Current Votes', value: '✅ Yes: 0 VP\n❌ No: 0 VP\n⚖️ Abstain: 0 VP', inline: false }
        )
        .setFooter({ text: 'Vote below! VP is locked at snapshot.' })
        .setTimestamp();

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder().setCustomId(`vote_yes_${proposalId}`).setLabel('Yes').setStyle(ButtonStyle.Success).setEmoji('✅'),
          new ButtonBuilder().setCustomId(`vote_no_${proposalId}`).setLabel('No').setStyle(ButtonStyle.Danger).setEmoji('❌'),
          new ButtonBuilder().setCustomId(`vote_abstain_${proposalId}`).setLabel('Abstain').setStyle(ButtonStyle.Secondary).setEmoji('⚖️')
        );

      const message = await votingChannel.send({ embeds: [embed], components: [row] });
      db.prepare('UPDATE proposals SET voting_message_id = ? WHERE proposal_id = ?').run(message.id, proposalId);
      logger.log(`Proposal ${proposalId} posted to voting channel, message ${message.id}`);
    } catch (error) {
      logger.error('Error posting to voting channel:', error);
    }
  }

  async updateVotingMessage(proposalId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal || !proposal.voting_message_id || !this.client) return;

      const votingChannelId = process.env.VOTING_CHANNEL_ID;
      if (!votingChannelId) return;

      const channel = await this.client.channels.fetch(votingChannelId);
      if (!channel || !channel.isTextBased()) return;

      const message = await channel.messages.fetch(proposal.voting_message_id);
      if (!message) return;

      const { EmbedBuilder } = require('discord.js');
      const embed = message.embeds[0];
      const newEmbed = EmbedBuilder.from(embed);
      const fieldIndex = newEmbed.data.fields.findIndex(f => f.name === '📊 Current Votes');

      if (fieldIndex >= 0) {
        newEmbed.data.fields[fieldIndex].value =
          `✅ Yes: ${proposal.yes_vp} VP\n❌ No: ${proposal.no_vp} VP\n⚖️ Abstain: ${proposal.abstain_vp} VP`;
      }

      await message.edit({ embeds: [newEmbed] });
    } catch (error) {
      logger.error('Error updating voting message:', error);
    }
  }

  async updateVotingMessageFinal(proposalId, finalResult, quorumMet) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal || !proposal.voting_message_id || !this.client) return;

      const votingChannelId = process.env.VOTING_CHANNEL_ID;
      if (!votingChannelId) return;

      const channel = await this.client.channels.fetch(votingChannelId);
      if (!channel || !channel.isTextBased()) return;

      const message = await channel.messages.fetch(proposal.voting_message_id);
      if (!message) return;

      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

      let statusText = '', color = '#808080';
      if (finalResult === 'passed') { statusText = '✅ PASSED'; color = '#00FF00'; }
      else if (finalResult === 'rejected') { statusText = '❌ REJECTED'; color = '#FF0000'; }
      else { statusText = '⚠️ QUORUM NOT MET'; color = '#808080'; }

      const embed = EmbedBuilder.from(message.embeds[0])
        .setColor(color)
        .setTitle(`🗳️ ${proposal.title} - ${statusText}`)
        .setFooter({ text: 'Voting has closed. See results channel for full summary.' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`vote_yes_${proposalId}_disabled`).setLabel('Yes').setStyle(ButtonStyle.Success).setEmoji('✅').setDisabled(true),
        new ButtonBuilder().setCustomId(`vote_no_${proposalId}_disabled`).setLabel('No').setStyle(ButtonStyle.Danger).setEmoji('❌').setDisabled(true),
        new ButtonBuilder().setCustomId(`vote_abstain_${proposalId}_disabled`).setLabel('Abstain').setStyle(ButtonStyle.Secondary).setEmoji('⚖️').setDisabled(true)
      );

      await message.edit({ embeds: [embed], components: [row] });
    } catch (error) {
      logger.error('Error updating final voting message:', error);
    }
  }

  async postToResultsChannel(proposalId, finalResult, quorumMet) {
    try {
      const resultsChannelId = process.env.RESULTS_CHANNEL_ID;
      if (!resultsChannelId || !this.client) return;

      const proposal = this.getProposal(proposalId);
      if (!proposal) return;

      const channel = await this.client.channels.fetch(resultsChannelId);
      if (!channel || !channel.isTextBased()) return;

      const { EmbedBuilder } = require('discord.js');

      const totalVoted = proposal.yes_vp + proposal.no_vp + proposal.abstain_vp;
      const quorumPercent = proposal.total_vp > 0 ? Math.round((totalVoted / proposal.total_vp) * 100) : 0;
      const voterCount = db.prepare('SELECT COUNT(DISTINCT voter_id) as count FROM votes WHERE proposal_id = ?').get(proposalId).count;

      let statusText = '', color = '#808080';
      if (finalResult === 'passed') { statusText = '✅ PASSED'; color = '#FFD700'; }
      else if (finalResult === 'rejected') { statusText = '❌ REJECTED'; color = '#FF0000'; }
      else { statusText = '⚠️ QUORUM NOT MET'; color = '#808080'; }

      const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`📊 Vote Results: ${proposal.title}`)
        .setDescription(`**${statusText}**`)
        .addFields(
          { name: '🆔 Proposal ID', value: proposal.proposal_id, inline: true },
          { name: '👤 Creator', value: `<@${proposal.creator_id}>`, inline: true },
          { name: '📂 Category', value: proposal.category || 'Other', inline: true },
          { name: '✅ Yes Votes', value: `${proposal.yes_vp} VP`, inline: true },
          { name: '❌ No Votes', value: `${proposal.no_vp} VP`, inline: true },
          { name: '⚖️ Abstain', value: `${proposal.abstain_vp} VP`, inline: true },
          { name: '📊 Total Voted', value: `${totalVoted} VP`, inline: true },
          { name: '🎯 Quorum', value: `${quorumPercent}% (needed ${proposal.quorum_required || '25%'})`, inline: true },
          { name: '👥 Voters', value: voterCount.toString(), inline: true }
        )
        .setFooter({ text: `Proposal concluded: ${new Date().toLocaleString()}` })
        .setTimestamp();

      await channel.send({ embeds: [embed] });
    } catch (error) {
      logger.error('Error posting to results channel:', error);
    }
  }

  // ==================== STALE EXPIRY ====================

  async expireStaleProposals() {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const staleDrafts = db.prepare(`
        SELECT * FROM proposals
        WHERE status = 'draft'
        AND created_at < ?
      `).all(sevenDaysAgo.toISOString());

      for (const proposal of staleDrafts) {
        db.prepare("UPDATE proposals SET status = 'expired' WHERE proposal_id = ?").run(proposal.proposal_id);
        logger.log(`Proposal ${proposal.proposal_id} expired (stale draft)`);
        governanceLogger.log('proposal_expired', { proposalId: proposal.proposal_id, title: proposal.title });
      }
    } catch (error) {
      logger.error('Error expiring stale proposals:', error);
    }
  }
}

module.exports = new ProposalService();
