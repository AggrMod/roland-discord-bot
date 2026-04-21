const { EmbedBuilder } = require('discord.js');
const settingsManager = require('../config/settings');
const logger = require('./logger');

class GovernanceLogger {
  constructor() {
    this.client = null;
  }

  setClient(client) {
    this.client = client;
  }

  resolveSupportThreshold() {
    try {
      const settings = settingsManager.getSettings ? settingsManager.getSettings() : {};
      const threshold = Number(settings?.supportThreshold);
      if (Number.isFinite(threshold) && threshold >= 1) {
        return threshold;
      }
    } catch (_error) {
      // Ignore and fall back to default.
    }
    return 4;
  }

  resolveLogChannelId(data = {}) {
    const explicitChannelId = String(data?.logChannelId || '').trim();
    if (explicitChannelId) {
      return explicitChannelId;
    }

    try {
      const settings = settingsManager.getSettings ? settingsManager.getSettings() : {};
      const configuredChannelId = String(settings?.governanceLogChannelId || '').trim();
      if (configuredChannelId) {
        return configuredChannelId;
      }
    } catch (_error) {
      // Ignore and fall back to env var.
    }

    return String(process.env.GOVERNANCE_LOG_CHANNEL_ID || '').trim();
  }

  async log(eventType, data = {}) {
    try {
      const channelId = this.resolveLogChannelId(data);
      if (!channelId || !this.client) return;

      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return;

      const embed = this.buildEmbed(eventType, data);
      if (!embed) return;

      await channel.send({ embeds: [embed] });
      logger.log(`Governance audit log: ${eventType} - ${data.proposalId || data.message || 'n/a'}`);
    } catch (error) {
      logger.error('Error logging governance event:', error);
    }
  }

  buildEmbed(eventType, data = {}) {
    const timestamp = new Date();
    const supportThreshold = this.resolveSupportThreshold();

    switch (eventType) {
      case 'proposal_created':
        return new EmbedBuilder()
          .setColor('#FFD700')
          .setTitle('Proposal Created')
          .addFields(
            { name: 'Proposal ID', value: String(data.proposalId || 'unknown'), inline: true },
            { name: 'Creator', value: `<@${data.creatorId}>`, inline: true },
            { name: 'Status', value: 'Draft', inline: true },
            { name: 'Title', value: String(data.title || 'Untitled'), inline: false }
          )
          .setTimestamp(timestamp);

      case 'support_added':
        return new EmbedBuilder()
          .setColor('#00FF00')
          .setTitle('Support Added')
          .addFields(
            { name: 'Proposal ID', value: String(data.proposalId || 'unknown'), inline: true },
            { name: 'Supporter', value: `<@${data.supporterId}>`, inline: true },
            { name: 'Count', value: `${Number(data.supporterCount || 0)}/${supportThreshold}`, inline: true }
          )
          .setTimestamp(timestamp);

      case 'support_blocked':
        return new EmbedBuilder()
          .setColor('#FFA500')
          .setTitle('Self-Support Blocked')
          .addFields(
            { name: 'Proposal ID', value: String(data.proposalId || 'unknown'), inline: true },
            { name: 'User', value: `<@${data.userId}>`, inline: true },
            { name: 'Reason', value: 'Creator cannot support own proposal', inline: false }
          )
          .setTimestamp(timestamp);

      case 'proposal_promoted':
        return new EmbedBuilder()
          .setColor('#0099FF')
          .setTitle('Proposal Promoted to Voting')
          .addFields(
            { name: 'Proposal ID', value: String(data.proposalId || 'unknown'), inline: true },
            { name: 'Total VP', value: String(data.totalVP ?? 0), inline: true },
            { name: 'Duration', value: '7 days', inline: true },
            { name: 'Title', value: String(data.title || 'Untitled'), inline: false }
          )
          .setTimestamp(timestamp);

      case 'vote_cast':
        return new EmbedBuilder()
          .setColor('#9B59B6')
          .setTitle('Vote Cast')
          .addFields(
            { name: 'Proposal ID', value: String(data.proposalId || 'unknown'), inline: true },
            { name: 'Voter', value: `<@${data.voterId}>`, inline: true },
            { name: 'Choice', value: String(data.voteChoice || '').toUpperCase() || 'UNKNOWN', inline: true },
            { name: 'Voting Power', value: `${Number(data.votingPower || 0)} VP`, inline: true }
          )
          .setTimestamp(timestamp);

      case 'vote_changed':
        return new EmbedBuilder()
          .setColor('#E67E22')
          .setTitle('Vote Changed')
          .addFields(
            { name: 'Proposal ID', value: String(data.proposalId || 'unknown'), inline: true },
            { name: 'Voter', value: `<@${data.voterId}>`, inline: true },
            { name: 'New Choice', value: String(data.voteChoice || '').toUpperCase() || 'UNKNOWN', inline: true },
            { name: 'Voting Power', value: `${Number(data.votingPower || 0)} VP`, inline: true }
          )
          .setTimestamp(timestamp);

      case 'vote_closed': {
        const normalizedStatus = String(data.status || '').toLowerCase();
        const color = normalizedStatus === 'passed'
          ? '#00FF00'
          : normalizedStatus === 'rejected'
            ? '#FF0000'
            : '#808080';
        return new EmbedBuilder()
          .setColor(color)
          .setTitle('Vote Closed')
          .addFields(
            { name: 'Proposal ID', value: String(data.proposalId || 'unknown'), inline: true },
            { name: 'Result', value: normalizedStatus ? normalizedStatus.toUpperCase().replace('_', ' ') : 'UNKNOWN', inline: true },
            { name: 'Quorum Met', value: data.quorumMet ? 'Yes' : 'No', inline: true },
            { name: 'Yes VP', value: `${Number(data.yesVP || 0)} VP`, inline: true },
            { name: 'No VP', value: `${Number(data.noVP || 0)} VP`, inline: true },
            { name: 'Abstain VP', value: `${Number(data.abstainVP || 0)} VP`, inline: true }
          )
          .setTimestamp(timestamp);
      }

      case 'proposal_expired':
        return new EmbedBuilder()
          .setColor('#808080')
          .setTitle('Draft Proposal Expired')
          .addFields(
            { name: 'Proposal ID', value: String(data.proposalId || 'unknown'), inline: true },
            { name: 'Creator', value: data.creatorId ? `<@${data.creatorId}>` : 'Unknown', inline: true },
            { name: 'Supporters', value: `${Number(data.supporterCount || 0)}/${supportThreshold}`, inline: true },
            { name: 'Title', value: String(data.title || 'Untitled'), inline: false },
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
