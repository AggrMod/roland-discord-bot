const { EmbedBuilder } = require('discord.js');
const logger = require('./logger');

class GovernanceLogger {
  constructor() {
    this.client = null;
  }

  setClient(client) {
    this.client = client;
  }

  async log(eventType, data) {
    try {
      const channelId = process.env.GOVERNANCE_LOG_CHANNEL_ID;
      if (!channelId || !this.client) return;

      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return;

      const embed = this.buildEmbed(eventType, data);
      if (embed) {
        await channel.send({ embeds: [embed] });
        logger.log(`Governance audit log: ${eventType} - ${data.proposalId || data.message}`);
      }
    } catch (error) {
      logger.error('Error logging governance event:', error);
    }
  }

  buildEmbed(eventType, data) {
    const timestamp = new Date();
    
    switch (eventType) {
      case 'proposal_created':
        return new EmbedBuilder()
          .setColor('#FFD700')
          .setTitle('📜 Proposal Created')
          .addFields(
            { name: 'Proposal ID', value: data.proposalId, inline: true },
            { name: 'Creator', value: `<@${data.creatorId}>`, inline: true },
            { name: 'Status', value: 'Draft', inline: true },
            { name: 'Title', value: data.title, inline: false }
          )
          .setTimestamp(timestamp);

      case 'support_added':
        return new EmbedBuilder()
          .setColor('#00FF00')
          .setTitle('✅ Support Added')
          .addFields(
            { name: 'Proposal ID', value: data.proposalId, inline: true },
            { name: 'Supporter', value: `<@${data.supporterId}>`, inline: true },
            { name: 'Count', value: `${data.supporterCount}/4`, inline: true }
          )
          .setTimestamp(timestamp);

      case 'support_blocked':
        return new EmbedBuilder()
          .setColor('#FFA500')
          .setTitle('🚫 Self-Support Blocked')
          .addFields(
            { name: 'Proposal ID', value: data.proposalId, inline: true },
            { name: 'User', value: `<@${data.userId}>`, inline: true },
            { name: 'Reason', value: 'Creator cannot support own proposal', inline: false }
          )
          .setTimestamp(timestamp);

      case 'proposal_promoted':
        return new EmbedBuilder()
          .setColor('#0099FF')
          .setTitle('🗳️ Proposal Promoted to Voting')
          .addFields(
            { name: 'Proposal ID', value: data.proposalId, inline: true },
            { name: 'Total VP', value: data.totalVP.toString(), inline: true },
            { name: 'Duration', value: '7 days', inline: true },
            { name: 'Title', value: data.title, inline: false }
          )
          .setTimestamp(timestamp);

      case 'vote_cast':
        return new EmbedBuilder()
          .setColor('#9B59B6')
          .setTitle('🗳️ Vote Cast')
          .addFields(
            { name: 'Proposal ID', value: data.proposalId, inline: true },
            { name: 'Voter', value: `<@${data.voterId}>`, inline: true },
            { name: 'Choice', value: data.voteChoice.toUpperCase(), inline: true },
            { name: 'Voting Power', value: `${data.votingPower} VP`, inline: true }
          )
          .setTimestamp(timestamp);

      case 'vote_changed':
        return new EmbedBuilder()
          .setColor('#E67E22')
          .setTitle('🔄 Vote Changed')
          .addFields(
            { name: 'Proposal ID', value: data.proposalId, inline: true },
            { name: 'Voter', value: `<@${data.voterId}>`, inline: true },
            { name: 'New Choice', value: data.voteChoice.toUpperCase(), inline: true },
            { name: 'Voting Power', value: `${data.votingPower} VP`, inline: true }
          )
          .setTimestamp(timestamp);

      case 'vote_closed':
        const statusEmoji = data.status === 'passed' ? '✅' : data.status === 'rejected' ? '❌' : '⚠️';
        return new EmbedBuilder()
          .setColor(data.status === 'passed' ? '#00FF00' : data.status === 'rejected' ? '#FF0000' : '#808080')
          .setTitle(`${statusEmoji} Vote Closed`)
          .addFields(
            { name: 'Proposal ID', value: data.proposalId, inline: true },
            { name: 'Result', value: data.status.toUpperCase().replace('_', ' '), inline: true },
            { name: 'Quorum Met', value: data.quorumMet ? 'Yes' : 'No', inline: true },
            { name: 'Yes VP', value: `${data.yesVP} VP`, inline: true },
            { name: 'No VP', value: `${data.noVP} VP`, inline: true },
            { name: 'Abstain VP', value: `${data.abstainVP} VP`, inline: true }
          )
          .setTimestamp(timestamp);

      case 'proposal_expired':
        return new EmbedBuilder()
          .setColor('#808080')
          .setTitle('⏰ Draft Proposal Expired')
          .addFields(
            { name: 'Proposal ID', value: data.proposalId, inline: true },
            { name: 'Creator', value: `<@${data.creatorId}>`, inline: true },
            { name: 'Supporters', value: `${data.supporterCount}/4`, inline: true },
            { name: 'Title', value: data.title, inline: false },
            { name: 'Reason', value: 'Draft expired after 7 days without sufficient support', inline: false }
          )
          .setTimestamp(timestamp);

      default:
        logger.warn(`Unknown governance event type: ${eventType}`);
        return null;
    }
  }
}

module.exports = new GovernanceLogger();
