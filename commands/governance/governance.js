const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const proposalService = require('../../services/proposalService');
const roleService = require('../../services/roleService');
const settingsManager = require('../../config/settings');
const db = require('../../database/db');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

let _hasProposalsGuildColumnCache = null;
function hasProposalsGuildColumn() {
  if (_hasProposalsGuildColumnCache !== null) return _hasProposalsGuildColumnCache;
  try {
    const columns = db.prepare('PRAGMA table_info(proposals)').all();
    _hasProposalsGuildColumnCache = columns.some((column) => String(column?.name || '').toLowerCase() === 'guild_id');
  } catch (_error) {
    _hasProposalsGuildColumnCache = false;
  }
  return _hasProposalsGuildColumnCache;
}

function isProposalVisibleInGuild(proposal, guildId) {
  if (!proposal) return false;
  if (!hasProposalsGuildColumn()) return true;
  const proposalGuildId = String(proposal.guild_id || '').trim();
  const requestedGuildId = String(guildId || '').trim();
  if (!proposalGuildId) return true;
  return !!requestedGuildId && proposalGuildId === requestedGuildId;
}

function normalizeProposalIdInput(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return '';
  const legacyNumericMatch = raw.match(/^p-(\d+)$/i);
  if (legacyNumericMatch) {
    return String(Number.parseInt(legacyNumericMatch[1], 10));
  }
  return raw.toUpperCase();
}

function isCreatorCancellableStatus(status) {
  const normalizedStatus = String(status || '').toLowerCase();
  if (!normalizedStatus) return false;
  if (normalizedStatus === 'vetoed') return false;
  return true;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('governance')
    .setDescription('🏛️ Governance module - proposals and voting')
    
    // User commands
    .addSubcommand(subcommand =>
      subcommand
        .setName('propose')
        .setDescription('Create a new governance proposal')
        .addStringOption(option =>
          option.setName('title')
            .setDescription('Proposal title')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('description')
            .setDescription('Detailed description of the proposal')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('category')
            .setDescription('Proposal category')
            .setRequired(false)
            .addChoices(
              { name: 'Partnership', value: 'Partnership' },
              { name: 'Treasury Allocation', value: 'Treasury Allocation' },
              { name: 'Rule Change', value: 'Rule Change' },
              { name: 'Community Event', value: 'Community Event' },
              { name: 'Other', value: 'Other' }
            ))
        .addStringOption(option =>
          option.setName('cost')
            .setDescription('Estimated cost (e.g. 500 USDC)')
            .setRequired(true)))
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('support')
        .setDescription('Support a proposal to help promote it to voting')
        .addStringOption(option =>
          option.setName('proposal_id')
            .setDescription('The proposal ID (e.g., 1)')
            .setRequired(true)))
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('vote')
        .setDescription('Cast your vote on an active proposal')
        .addStringOption(option =>
          option.setName('proposal_id')
            .setDescription('The proposal ID (e.g., 1)')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('choice')
            .setDescription('Your vote')
            .setRequired(true)
            .addChoices(
              { name: '✅ Yes', value: 'yes' },
              { name: '❌ No', value: 'no' },
              { name: '⚖️ Abstain', value: 'abstain' }
            )))

    .addSubcommand(subcommand =>
      subcommand
        .setName('cancel')
        .setDescription('Cancel your own proposal')
        .addStringOption(option =>
          option.setName('proposal_id')
            .setDescription('The proposal ID (e.g., 1)')
            .setRequired(true))
        .addBooleanOption(option =>
          option.setName('confirm')
            .setDescription('Confirm cancellation')
            .setRequired(true)))
    
    // Admin subgroup
    .addSubcommandGroup(group =>
      group
        .setName('admin')
        .setDescription('Admin governance management')
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('list')
            .setDescription('View all proposals (any status)')
            .addStringOption(option =>
              option.setName('status')
                .setDescription('Filter by status (optional)')
                .setRequired(false)
                .addChoices(
                  { name: 'Supporting', value: 'supporting' },
                  { name: 'Voting', value: 'voting' },
                  { name: 'Passed', value: 'passed' },
                  { name: 'Rejected', value: 'rejected' },
                  { name: 'Quorum Not Met', value: 'quorum_not_met' },
                  { name: 'Vetoed', value: 'vetoed' },
                  { name: 'Draft', value: 'draft' },
                  { name: 'Pending Review', value: 'pending_review' },
                  { name: 'On Hold', value: 'on_hold' },
                  { name: 'Cancelled', value: 'cancelled' },
                  { name: 'Expired', value: 'expired' }
                )))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('cancel')
            .setDescription('Cancel a proposal (emergency)')
            .addStringOption(option =>
              option.setName('proposal_id')
                .setDescription('Proposal ID to cancel')
                .setRequired(true))
            .addBooleanOption(option =>
              option.setName('confirm')
                .setDescription('Confirm cancellation')
                .setRequired(true)))
        
        .addSubcommand(subcommand =>
          subcommand
            .setName('settings')
            .setDescription('View/update governance settings'))),

  async execute(interaction) {
    // Check if governance module is enabled
    if (!await moduleGuard.checkModuleEnabled(interaction, 'governance')) {
      return;
    }

    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommandGroup === 'admin') {
        // Admin commands require admin check
        if (!await moduleGuard.checkAdmin(interaction)) {
          return;
        }

        switch (subcommand) {
          case 'list':
            await this.handleAdminList(interaction);
            break;
          case 'cancel':
            await this.handleAdminCancel(interaction);
            break;
          case 'settings':
            await this.handleAdminSettings(interaction);
            break;
        }
      } else {
        // User commands
        switch (subcommand) {
          case 'propose':
            await this.handlePropose(interaction);
            break;
          case 'support':
            await this.handleSupport(interaction);
            break;
          case 'vote':
            await this.handleVote(interaction);
            break;
          case 'cancel':
            await this.handleCancel(interaction);
            break;
        }
      }
    } catch (error) {
      logger.error('[CommandError]', error);
      const userMsg = 'An error occurred. Please try again or contact an admin.';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: userMsg });
      } else {
        await interaction.reply({ content: userMsg, ephemeral: true });
      }
    }
  },

  // ==================== USER COMMANDS ====================

  async handlePropose(interaction) {
    await interaction.deferReply();

    const discordId = interaction.user.id;
    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');

    const userInfo = await roleService.getUserInfo(discordId, interaction.guildId, interaction.member);
    const votingPower = Number(userInfo?.voting_power || 0);
    
    if (!userInfo || votingPower < 1) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Not Eligible')
        .setDescription('You must verify your wallet and own at least 1 NFT from a recognized collection to create proposals.\n\nUse `/verification status` to get started.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const category = interaction.options.getString('category') || 'Other';
    const costIndication = String(interaction.options.getString('cost') || '').trim();
    if (!costIndication) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Missing Cost')
        .setDescription('Please include the estimated cost for your proposal.')
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    const result = proposalService.createProposal(discordId, {
      title,
      description,
      category,
      costIndication,
      guildId: interaction.guildId || '',
      initialStatus: 'supporting'
    });

    if (!result.success) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Failed to Create Proposal')
        .setDescription(result.message || 'An error occurred.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const settings = settingsManager.getSettings();
    const supportThreshold = settings.supportThreshold || 4;

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('📜 New Proposal Created')
      .setDescription(`**${title}**\n\n${description}`)
      .addFields(
        { name: '🆔 Proposal ID', value: result.proposalId, inline: true },
        { name: '👤 Creator', value: interaction.user.username, inline: true },
        { name: '📊 Status', value: `Supporting (Needs ${supportThreshold} supporters)`, inline: true },
        { name: '💰 Cost', value: costIndication, inline: true }
      )
      .setFooter({ text: 'Posted to proposals channel - waiting for supporters' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${interaction.user.username} created proposal ${result.proposalId}`);

    // Post to proposals channel
    const proposalsChannelId = settings.proposalsChannelId || process.env.PROPOSALS_CHANNEL_ID;
    if (proposalsChannelId) {
      try {
        const proposalsChannel = await interaction.client.channels.fetch(proposalsChannelId);
        
        if (proposalsChannel && proposalsChannel.isTextBased()) {
          const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
          
          const channelEmbed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle(`📜 ${title}`)
            .setDescription(description)
            .addFields(
              { name: '🆔 Proposal ID', value: result.proposalId, inline: true },
              { name: '👤 Creator', value: interaction.user.username, inline: true },
              { name: '📊 Status', value: 'Supporting', inline: true },
              { name: '👥 Supporters', value: `0/${supportThreshold}`, inline: true },
              { name: '💰 Cost', value: costIndication, inline: true }
            )
            .setFooter({ text: `Click Support below to help promote this proposal (${supportThreshold} needed)` })
            .setTimestamp();

          const row = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(`support_${result.proposalId}`)
                .setLabel('Support')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('✅')
            );

          const message = await proposalsChannel.send({ embeds: [channelEmbed], components: [row] });
          
          db.prepare('UPDATE proposals SET message_id = ?, channel_id = ? WHERE proposal_id = ?')
            .run(message.id, proposalsChannelId, result.proposalId);
          
          logger.log(`Proposal ${result.proposalId} posted to channel ${proposalsChannelId}`);
        }
      } catch (error) {
        logger.error('Error posting proposal to channel:', error);
      }
    }
  },

  async handleSupport(interaction) {
    await interaction.deferReply();

    const discordId = interaction.user.id;
    const proposalId = normalizeProposalIdInput(interaction.options.getString('proposal_id'));
    if (!proposalId) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Proposal ID Required')
        .setDescription('Please provide a valid proposal ID.')
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    const userInfo = await roleService.getUserInfo(discordId, interaction.guildId, interaction.member);
    const votingPower = Number(userInfo?.voting_power || 0);
    
    if (!userInfo || votingPower < 1) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Not Eligible')
        .setDescription('You must verify your wallet and own at least 1 NFT from a recognized collection to support proposals.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const proposal = proposalService.getProposal(proposalId);
    
    if (!proposal || !isProposalVisibleInGuild(proposal, interaction.guildId)) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Proposal Not Found')
        .setDescription(`No proposal found with ID: ${proposalId}`)
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const result = proposalService.addSupporter(proposalId, discordId);

    if (!result.success) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Failed to Add Support')
        .setDescription(result.message || 'An error occurred.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const settings = settingsManager.getSettings();
    const supportThreshold = settings.supportThreshold || 4;
    const supporterCount = result.supporterCount;
    let isPromoted = false;

    if (String(proposal.status || '').toLowerCase() === 'supporting' && supporterCount >= supportThreshold) {
      const promoteResult = await proposalService.promoteToVoting(proposalId, discordId);
      if (promoteResult?.success) {
        isPromoted = true;
      } else if (!String(promoteResult?.message || '').toLowerCase().includes('only supporting proposals')) {
        logger.warn(`[governance] Failed auto-promotion for ${proposalId}: ${promoteResult?.message || 'unknown error'}`);
      }
    }

    const proposalAfterSupport = proposalService.getProposal(proposalId);
    if (!isPromoted && String(proposalAfterSupport?.status || '').toLowerCase() === 'voting') {
      isPromoted = true;
    }

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle(isPromoted ? '🗳️ Proposal Promoted to Voting!' : '✅ Support Added')
      .setDescription(`**${proposal.title}**`)
      .addFields(
        { name: '🆔 Proposal ID', value: proposalId, inline: true },
        { name: '👥 Supporters', value: `${supporterCount}/${supportThreshold}`, inline: true },
        { name: '📊 Status', value: isPromoted ? 'Now Voting' : 'Still Supporting', inline: true }
      )
      .setFooter({ 
        text: isPromoted 
          ? 'Voting is now open for 7 days!' 
          : `${supportThreshold - supporterCount} more supporter(s) needed`
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${interaction.user.username} supported proposal ${proposalId}`);
  },

  async handleVote(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    const proposalId = normalizeProposalIdInput(interaction.options.getString('proposal_id'));
    if (!proposalId) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Proposal ID Required')
        .setDescription('Please provide a valid proposal ID.')
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }
    const choice = interaction.options.getString('choice');

    const userInfo = await roleService.getUserInfo(discordId, interaction.guildId, interaction.member);
    const votingPower = Number(userInfo?.voting_power || 0);
    
    if (!userInfo || votingPower < 1) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Not Eligible')
        .setDescription('You must verify your wallet and own at least 1 NFT from a recognized collection to vote.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const proposal = proposalService.getProposal(proposalId);
    
    if (!proposal || !isProposalVisibleInGuild(proposal, interaction.guildId)) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Proposal Not Found')
        .setDescription(`No proposal found with ID: ${proposalId}`)
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const result = proposalService.castVote(proposalId, discordId, choice, votingPower);

    if (!result.success) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Failed to Cast Vote')
        .setDescription(result.message || 'An error occurred.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const updatedProposal = proposalService.getProposal(proposalId);
    const totalVoted = updatedProposal.yes_vp + updatedProposal.no_vp + updatedProposal.abstain_vp;

    const choiceEmoji = {
      'yes': '✅',
      'no': '❌',
      'abstain': '⚖️'
    };

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🗳️ Vote Recorded')
      .setDescription(`**${proposal.title}**`)
      .addFields(
        { name: '🆔 Proposal ID', value: proposalId, inline: true },
        { name: 'Your Vote', value: `${choiceEmoji[choice]} ${choice.toUpperCase()}`, inline: true },
        { name: 'Voting Power', value: `${result.votingPower || votingPower}`, inline: true },
        { name: '📊 Current Results', value: `✅ Yes: ${updatedProposal.yes_vp}\n❌ No: ${updatedProposal.no_vp}\n⚖️ Abstain: ${updatedProposal.abstain_vp}\n\n**Total:** ${totalVoted} VP`, inline: false }
      )
      .setFooter({ text: 'Your vote has been recorded' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${interaction.user.username} voted ${choice} on proposal ${proposalId}`);
  },

  async handleCancel(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const proposalIdRaw = interaction.options.getString('proposal_id');
    if (!proposalIdRaw) {
      return interaction.editReply({
        content: '❌ Proposal ID is required.',
        ephemeral: true
      });
    }
    const proposalId = normalizeProposalIdInput(proposalIdRaw);
    if (!proposalId) {
      return interaction.editReply({
        content: '❌ Proposal ID is required.',
        ephemeral: true
      });
    }
    const confirm = interaction.options.getBoolean('confirm');

    if (!confirm) {
      return interaction.editReply({
        content: '❌ You must set confirm=true to cancel your proposal.',
        ephemeral: true
      });
    }

    const proposal = proposalService.getProposal(proposalId);
    if (!proposal || !isProposalVisibleInGuild(proposal, interaction.guildId)) {
      return interaction.editReply({
        content: `❌ Proposal not found: ${proposalId}`,
        ephemeral: true
      });
    }

    if (String(proposal.creator_id || '').trim() !== String(interaction.user.id || '').trim()) {
      return interaction.editReply({
        content: '❌ You can only cancel proposals you created.',
        ephemeral: true
      });
    }

    if (!isCreatorCancellableStatus(proposal.status)) {
      return interaction.editReply({
        content: `❌ Proposal ${proposalId} cannot be cancelled in status "${proposal.status}".`,
        ephemeral: true
      });
    }

    const cancelResult = proposalService.cancelProposal(proposalId, interaction.user.id, interaction.guildId || '');
    if (!cancelResult?.success) {
      return interaction.editReply({
        content: `❌ ${cancelResult?.message || `Failed to cancel proposal ${proposalId}.`}`,
        ephemeral: true
      });
    }

    await interaction.editReply({
      content: `✅ Proposal ${proposalId} has been cancelled.`,
      ephemeral: true
    });
    logger.log(`User ${interaction.user.tag} cancelled own proposal ${proposalId}`);
  },

  // ==================== ADMIN COMMANDS ====================

  async handleAdminList(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const statusFilter = interaction.options.getString('status');
    const db = require('../../database/db');
    
    let query = 'SELECT * FROM proposals';
    const params = [];
    const whereClauses = [];

    if (hasProposalsGuildColumn() && interaction.guildId) {
      whereClauses.push('guild_id = ?');
      params.push(interaction.guildId);
    }
    
    if (statusFilter) {
      whereClauses.push('status = ?');
      params.push(statusFilter);
    }

    if (whereClauses.length) {
      query += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    
    query += ' ORDER BY created_at DESC LIMIT 10';
    
    const proposals = db.prepare(query).all(...params);

    if (proposals.length === 0) {
      return interaction.editReply({ 
        content: '❌ No proposals found.', 
        ephemeral: true 
      });
    }

    const proposalList = proposals.map((p, i) => {
      const statusEmoji = {
        'draft': '📝',
        'supporting': '🤝',
        'voting': '🗳️',
        'passed': '✅',
        'rejected': '❌',
        'quorum_not_met': '⚠️',
        'vetoed': '🛑',
        'pending_review': '🕒',
        'on_hold': '⏸️',
        'cancelled': '🚫',
        'expired': '⌛'
      };
      return `${i + 1}. ${statusEmoji[p.status] || '📜'} **${p.proposal_id}**: ${p.title} (${p.status})`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('📋 All Proposals')
      .setDescription(proposalList)
      .setFooter({ text: `Total: ${proposals.length} (showing last 10)` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed proposal list`);
  },

  async handleAdminCancel(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const proposalId = normalizeProposalIdInput(interaction.options.getString('proposal_id'));
    if (!proposalId) {
      return interaction.editReply({
        content: '❌ Proposal ID is required.',
        ephemeral: true
      });
    }
    const confirm = interaction.options.getBoolean('confirm');

    if (!confirm) {
      return interaction.editReply({ 
        content: '❌ You must set confirm=true to cancel a proposal.',
        ephemeral: true 
      });
    }

    const proposal = proposalService.getProposal(proposalId);
    
    if (!proposal || !isProposalVisibleInGuild(proposal, interaction.guildId)) {
      return interaction.editReply({ 
        content: `❌ Proposal not found: ${proposalId}`,
        ephemeral: true 
      });
    }

    let updateResult;
    if (hasProposalsGuildColumn() && interaction.guildId) {
      updateResult = db.prepare('UPDATE proposals SET status = ? WHERE proposal_id = ? AND guild_id = ?').run('cancelled', proposalId, interaction.guildId);
      if (!updateResult?.changes && !String(proposal.guild_id || '').trim()) {
        // Legacy proposal rows may have empty guild_id.
        updateResult = db.prepare('UPDATE proposals SET status = ? WHERE proposal_id = ?').run('cancelled', proposalId);
      }
    } else {
      updateResult = db.prepare('UPDATE proposals SET status = ? WHERE proposal_id = ?').run('cancelled', proposalId);
    }

    if (!updateResult?.changes) {
      return interaction.editReply({
        content: `❌ Failed to cancel proposal: ${proposalId}`,
        ephemeral: true
      });
    }

    await interaction.editReply({ 
      content: `✅ Proposal ${proposalId} has been cancelled by admin.`,
      ephemeral: true 
    });
    logger.log(`Admin ${interaction.user.tag} cancelled proposal ${proposalId}`);
  },

  async handleAdminSettings(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const settings = settingsManager.getSettings();
    const effectiveQuorum = Number.isFinite(Number(settings.quorumPercentage))
      ? Number(settings.quorumPercentage)
      : Number(settings.governanceQuorum || 25);
    const effectiveVoteDays = Number.isFinite(Number(settings.voteDurationDays))
      ? Number(settings.voteDurationDays)
      : Math.max(1, Math.round(Number(settings.voteDurationHours || 168) / 24));

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('⚙️ Governance Settings')
      .setDescription('Current governance configuration')
      .addFields(
        { name: 'Support Threshold', value: `${settings.supportThreshold} supporters`, inline: true },
        { name: 'Quorum Percentage', value: `${effectiveQuorum}%`, inline: true },
        { name: 'Vote Duration', value: `${effectiveVoteDays} days`, inline: true }
      )
      .setFooter({ text: 'Edit config/settings.json to change (Sprint B: admin UI)' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed governance settings`);
  }
};
