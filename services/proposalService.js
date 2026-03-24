const db = require('../database/db');
const vpService = require('./vpService');
const logger = require('../utils/logger');

class ProposalService {
  constructor() {
    this.client = null; // Will be set from index.js
  }

  setClient(client) {
    this.client = client;
  }

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
      return { success: true, supporterCount, promoted: supporterCount >= 4 };
    } catch (error) {
      if (error.message.includes('UNIQUE constraint failed')) {
        return { success: false, message: 'You already support this proposal' };
      }
      logger.error('Error adding supporter:', error);
      return { success: false, message: 'Failed to add support' };
    }
  }

  async promoteToVoting(proposalId) {
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

      // Post to voting channel
      if (this.client) {
        await this.postToVotingChannel(proposalId);
      }

      return { success: true };
    } catch (error) {
      logger.error('Error promoting proposal:', error);
      return { success: false };
    }
  }

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
          { name: '⏰ Deadline', value: `<t:${Math.floor(endDate.getTime() / 1000)}:R>`, inline: false },
          { name: '📊 Current Votes', value: '✅ Yes: 0 VP\n❌ No: 0 VP\n⚖️ Abstain: 0 VP', inline: false }
        )
        .setFooter({ text: 'Vote below! Voting ends in 7 days or when >50% VP votes.' })
        .setTimestamp();

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`vote_yes_${proposalId}`)
            .setLabel('Yes')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅'),
          new ButtonBuilder()
            .setCustomId(`vote_no_${proposalId}`)
            .setLabel('No')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌'),
          new ButtonBuilder()
            .setCustomId(`vote_abstain_${proposalId}`)
            .setLabel('Abstain')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⚖️')
        );

      const message = await votingChannel.send({ embeds: [embed], components: [row] });

      // Store voting message ID
      db.prepare('UPDATE proposals SET voting_message_id = ? WHERE proposal_id = ?')
        .run(message.id, proposalId);

      logger.log(`Proposal ${proposalId} posted to voting channel, message ${message.id}`);
    } catch (error) {
      logger.error('Error posting to voting channel:', error);
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
      
      // Update the current votes field
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

  checkAutoClose(proposalId) {
    try {
      const proposal = this.getProposal(proposalId);
      if (!proposal || proposal.status !== 'voting') return;

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
        logger.log(`Proposal ${proposalId} auto-closed: 7 days elapsed`);
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
      const quorumMet = vpService.meetsQuorum(totalVoted, proposal.total_vp, proposal.quorum_threshold);
      
      let finalStatus = 'rejected';
      
      if (quorumMet) {
        const passed = vpService.hasVotePassed(proposal.yes_vp, proposal.no_vp, proposal.abstain_vp);
        finalStatus = passed ? 'passed' : 'rejected';
      } else {
        finalStatus = 'quorum_not_met';
      }

      db.prepare('UPDATE proposals SET status = ? WHERE proposal_id = ?').run(finalStatus, proposalId);

      // Update voting channel message
      await this.updateVotingMessageFinal(proposalId, finalStatus, quorumMet);

      // Post to results channel
      await this.postToResultsChannel(proposalId, finalStatus, quorumMet);

      logger.log(`Proposal ${proposalId} closed with status: ${finalStatus}`);
      return { success: true, status: finalStatus, quorumMet };
    } catch (error) {
      logger.error('Error closing vote:', error);
      return { success: false };
    }
  }

  async updateVotingMessageFinal(proposalId, finalStatus, quorumMet) {
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

      let statusText = '';
      let color = '#808080';
      
      if (finalStatus === 'passed') {
        statusText = '✅ PASSED';
        color = '#00FF00';
      } else if (finalStatus === 'rejected') {
        statusText = '❌ REJECTED';
        color = '#FF0000';
      } else if (finalStatus === 'quorum_not_met') {
        statusText = '⚠️ QUORUM NOT MET';
        color = '#808080';
      }

      const embed = EmbedBuilder.from(message.embeds[0])
        .setColor(color)
        .setTitle(`🗳️ ${proposal.title} - ${statusText}`)
        .setFooter({ text: 'Voting has closed. See results channel for full summary.' });

      // Disable all buttons
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`vote_yes_${proposalId}_disabled`)
            .setLabel('Yes')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅')
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId(`vote_no_${proposalId}_disabled`)
            .setLabel('No')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌')
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId(`vote_abstain_${proposalId}_disabled`)
            .setLabel('Abstain')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⚖️')
            .setDisabled(true)
        );

      await message.edit({ embeds: [embed], components: [row] });
    } catch (error) {
      logger.error('Error updating final voting message:', error);
    }
  }

  async postToResultsChannel(proposalId, finalStatus, quorumMet) {
    try {
      const resultsChannelId = process.env.RESULTS_CHANNEL_ID;
      if (!resultsChannelId || !this.client) return;

      const proposal = this.getProposal(proposalId);
      if (!proposal) return;

      const channel = await this.client.channels.fetch(resultsChannelId);
      if (!channel || !channel.isTextBased()) return;

      const { EmbedBuilder } = require('discord.js');

      const totalVoted = proposal.yes_vp + proposal.no_vp + proposal.abstain_vp;
      const quorumPercent = Math.round((totalVoted / proposal.total_vp) * 100);
      const voterCount = db.prepare('SELECT COUNT(DISTINCT voter_id) as count FROM votes WHERE proposal_id = ?').get(proposalId).count;
      
      const startTime = new Date(proposal.start_time);
      const endTime = new Date();
      const durationHours = Math.round((endTime - startTime) / (1000 * 60 * 60));

      let statusText = '';
      let color = '#808080';
      
      if (finalStatus === 'passed') {
        statusText = '✅ PASSED';
        color = '#FFD700'; // Gold for passed
      } else if (finalStatus === 'rejected') {
        statusText = '❌ REJECTED';
        color = '#FF0000'; // Red for rejected
      } else if (finalStatus === 'quorum_not_met') {
        statusText = '⚠️ QUORUM NOT MET';
        color = '#808080'; // Grey for quorum not met
      }

      const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`📊 Vote Results: ${proposal.title}`)
        .setDescription(`**${statusText}**`)
        .addFields(
          { name: '🆔 Proposal ID', value: proposal.proposal_id, inline: true },
          { name: '👤 Creator', value: `<@${proposal.creator_id}>`, inline: true },
          { name: '📈 Result', value: statusText, inline: true },
          { name: '✅ Yes Votes', value: `${proposal.yes_vp} VP`, inline: true },
          { name: '❌ No Votes', value: `${proposal.no_vp} VP`, inline: true },
          { name: '⚖️ Abstain Votes', value: `${proposal.abstain_vp} VP`, inline: true },
          { name: '📊 Total Voted', value: `${totalVoted} VP`, inline: true },
          { name: '🎯 Quorum', value: `${quorumPercent}% (needed 25%)`, inline: true },
          { name: '👥 Voters', value: voterCount.toString(), inline: true },
          { name: '⏱️ Duration', value: `${durationHours} hours`, inline: true }
        )
        .setFooter({ text: `Proposal ended: ${endTime.toLocaleString()}` })
        .setTimestamp();

      await channel.send({ embeds: [embed] });
      logger.log(`Results posted to results channel for proposal ${proposalId}`);
    } catch (error) {
      logger.error('Error posting to results channel:', error);
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
