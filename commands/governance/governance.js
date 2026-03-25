const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const proposalService = require('../../services/proposalService');
const roleService = require('../../services/roleService');
const walletService = require('../../services/walletService');
const settings = require('../../config/settings.json');
const logger = require('../../utils/logger');
const moduleGuard = require('../../utils/moduleGuard');

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
            .setRequired(true)))
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('support')
        .setDescription('Support a draft proposal to help promote it to voting')
        .addStringOption(option =>
          option.setName('proposal_id')
            .setDescription('The proposal ID (e.g., P-001)')
            .setRequired(true)))
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('vote')
        .setDescription('Cast your vote on an active proposal')
        .addStringOption(option =>
          option.setName('proposal_id')
            .setDescription('The proposal ID (e.g., P-001)')
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
                  { name: 'Draft', value: 'draft' },
                  { name: 'Voting', value: 'voting' },
                  { name: 'Passed', value: 'passed' },
                  { name: 'Failed', value: 'failed' }
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
        }
      }
    } catch (error) {
      logger.error('Error executing governance command:', error);
      
      const reply = { 
        content: `❌ Something went wrong: ${error.message}`, 
        ephemeral: true 
      };
      
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply);
      } else {
        await interaction.reply(reply);
      }
    }
  },

  // ==================== USER COMMANDS ====================

  async handlePropose(interaction) {
    await interaction.deferReply();

    const discordId = interaction.user.id;
    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');

    const userInfo = await roleService.getUserInfo(discordId);
    
    if (!userInfo || !userInfo.voting_power || userInfo.voting_power === 0) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Not Eligible')
        .setDescription('You must verify your wallet and own at least 1 SOLPRANOS NFT to create proposals.\n\nUse `/verification status` to get started.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const wallets = walletService.getLinkedWallets(discordId);
    const primaryWallet = wallets.find(w => w.primary_wallet) || wallets[0];

    const result = proposalService.createProposal(
      discordId,
      primaryWallet?.wallet_address || null,
      title,
      description
    );

    if (!result.success) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Failed to Create Proposal')
        .setDescription(result.message || 'An error occurred.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const supportThreshold = settings.supportThreshold || 4;

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('📜 New Proposal Created')
      .setDescription(`**${title}**\n\n${description}`)
      .addFields(
        { name: '🆔 Proposal ID', value: result.proposalId, inline: true },
        { name: '👤 Creator', value: interaction.user.username, inline: true },
        { name: '📊 Status', value: `Draft (Needs ${supportThreshold} supporters)`, inline: true }
      )
      .setFooter({ text: 'Posted to proposals channel - waiting for supporters' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${interaction.user.username} created proposal ${result.proposalId}`);

    // Post to proposals channel
    const proposalsChannelId = process.env.PROPOSALS_CHANNEL_ID;
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
              { name: '📊 Status', value: 'Draft', inline: true },
              { name: '👥 Supporters', value: `0/${supportThreshold}`, inline: true }
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
          
          const db = require('../../database/db');
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
    const proposalId = interaction.options.getString('proposal_id').toUpperCase();

    const userInfo = await roleService.getUserInfo(discordId);
    
    if (!userInfo || !userInfo.voting_power || userInfo.voting_power === 0) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Not Eligible')
        .setDescription('You must verify your wallet and own at least 1 SOLPRANOS NFT to support proposals.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const proposal = proposalService.getProposal(proposalId);
    
    if (!proposal) {
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

    const supportThreshold = settings.supportThreshold || 4;
    const supporterCount = result.supporterCount;
    const isPromoted = result.promoted;

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle(isPromoted ? '🗳️ Proposal Promoted to Voting!' : '✅ Support Added')
      .setDescription(`**${proposal.title}**`)
      .addFields(
        { name: '🆔 Proposal ID', value: proposalId, inline: true },
        { name: '👥 Supporters', value: `${supporterCount}/${supportThreshold}`, inline: true },
        { name: '📊 Status', value: isPromoted ? 'Now Voting' : 'Still in Draft', inline: true }
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
    const proposalId = interaction.options.getString('proposal_id').toUpperCase();
    const choice = interaction.options.getString('choice');

    const userInfo = await roleService.getUserInfo(discordId);
    
    if (!userInfo || !userInfo.voting_power || userInfo.voting_power === 0) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Not Eligible')
        .setDescription('You must verify your wallet and own at least 1 SOLPRANOS NFT to vote.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const proposal = proposalService.getProposal(proposalId);
    
    if (!proposal) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Proposal Not Found')
        .setDescription(`No proposal found with ID: ${proposalId}`)
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const result = proposalService.castVote(proposalId, discordId, choice, userInfo.voting_power);

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
        { name: 'Voting Power', value: `${userInfo.voting_power}`, inline: true },
        { name: '📊 Current Results', value: `✅ Yes: ${updatedProposal.yes_vp}\n❌ No: ${updatedProposal.no_vp}\n⚖️ Abstain: ${updatedProposal.abstain_vp}\n\n**Total:** ${totalVoted} VP`, inline: false }
      )
      .setFooter({ text: 'Your vote has been recorded' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${interaction.user.username} voted ${choice} on proposal ${proposalId}`);
  },

  // ==================== ADMIN COMMANDS ====================

  async handleAdminList(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const statusFilter = interaction.options.getString('status');
    const db = require('../../database/db');
    
    let query = 'SELECT * FROM proposals';
    let params = [];
    
    if (statusFilter) {
      query += ' WHERE status = ?';
      params.push(statusFilter);
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
        'voting': '🗳️',
        'passed': '✅',
        'failed': '❌'
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

    const proposalId = interaction.options.getString('proposal_id').toUpperCase();
    const confirm = interaction.options.getBoolean('confirm');

    if (!confirm) {
      return interaction.editReply({ 
        content: '❌ You must set confirm=true to cancel a proposal.',
        ephemeral: true 
      });
    }

    const proposal = proposalService.getProposal(proposalId);
    
    if (!proposal) {
      return interaction.editReply({ 
        content: `❌ Proposal not found: ${proposalId}`,
        ephemeral: true 
      });
    }

    const db = require('../../database/db');
    db.prepare('UPDATE proposals SET status = ? WHERE proposal_id = ?').run('cancelled', proposalId);

    await interaction.editReply({ 
      content: `✅ Proposal ${proposalId} has been cancelled by admin.`,
      ephemeral: true 
    });
    logger.log(`Admin ${interaction.user.tag} cancelled proposal ${proposalId}`);
  },

  async handleAdminSettings(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('⚙️ Governance Settings')
      .setDescription('Current governance configuration')
      .addFields(
        { name: 'Support Threshold', value: `${settings.supportThreshold} supporters`, inline: true },
        { name: 'Quorum Percentage', value: `${settings.quorumPercentage}%`, inline: true },
        { name: 'Vote Duration', value: `${settings.voteDurationDays} days`, inline: true }
      )
      .setFooter({ text: 'Edit config/settings.json to change (Sprint B: admin UI)' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed governance settings`);
  }
};
