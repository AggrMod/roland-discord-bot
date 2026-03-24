const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const settingsManager = require('../../config/settings');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Manage bot configuration (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(subcommand =>
      subcommand
        .setName('view')
        .setDescription('View current configuration'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('tier')
        .setDescription('Update a tier configuration')
        .addStringOption(option =>
          option.setName('tier_name')
            .setDescription('Name of the tier to update')
            .setRequired(true)
            .addChoices(
              { name: 'Associate', value: 'Associate' },
              { name: 'Soldato', value: 'Soldato' },
              { name: 'Capo', value: 'Capo' },
              { name: 'Elite', value: 'Elite' },
              { name: 'Underboss', value: 'Underboss' },
              { name: 'Don', value: 'Don' }
            ))
        .addIntegerOption(option =>
          option.setName('min_nfts')
            .setDescription('Minimum NFTs required')
            .setRequired(true)
            .setMinValue(1))
        .addIntegerOption(option =>
          option.setName('max_nfts')
            .setDescription('Maximum NFTs for this tier')
            .setRequired(true)
            .setMinValue(1))
        .addIntegerOption(option =>
          option.setName('voting_power')
            .setDescription('Voting power for this tier')
            .setRequired(true)
            .setMinValue(1)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('quorum')
        .setDescription('Update quorum threshold percentage')
        .addNumberOption(option =>
          option.setName('percentage')
            .setDescription('Quorum percentage (e.g., 25 for 25%)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(100)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('support-threshold')
        .setDescription('Update number of supporters needed to promote proposal')
        .addIntegerOption(option =>
          option.setName('count')
            .setDescription('Number of supporters required')
            .setRequired(true)
            .setMinValue(1)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('vote-duration')
        .setDescription('Update voting period length')
        .addIntegerOption(option =>
          option.setName('days')
            .setDescription('Number of days for voting period')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(30))),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommand === 'view') {
        await this.handleView(interaction);
      } else if (subcommand === 'tier') {
        await this.handleTierUpdate(interaction);
      } else if (subcommand === 'quorum') {
        await this.handleQuorumUpdate(interaction);
      } else if (subcommand === 'support-threshold') {
        await this.handleSupportThresholdUpdate(interaction);
      } else if (subcommand === 'vote-duration') {
        await this.handleVoteDurationUpdate(interaction);
      }
    } catch (error) {
      logger.error('Error executing settings command:', error);
      await interaction.reply({ 
        content: 'An error occurred while updating settings.', 
        ephemeral: true 
      });
    }
  },

  async handleView(interaction) {
    const settings = settingsManager.getSettings();

    const tiersText = settings.tiers.map(t => 
      `**${t.name}**: ${t.minNFTs}-${t.maxNFTs} NFTs → ${t.votingPower} VP`
    ).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('⚙️ Bot Configuration')
      .setDescription('Current system settings')
      .addFields(
        { name: '👥 Tiers', value: tiersText, inline: false },
        { name: '📊 Quorum Threshold', value: `${settings.quorumPercentage}%`, inline: true },
        { name: '✋ Support Threshold', value: `${settings.supportThreshold} supporters`, inline: true },
        { name: '⏰ Vote Duration', value: `${settings.voteDurationDays} days`, inline: true }
      )
      .setFooter({ text: 'Use /settings to modify these values' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },

  async handleTierUpdate(interaction) {
    const tierName = interaction.options.getString('tier_name');
    const minNFTs = interaction.options.getInteger('min_nfts');
    const maxNFTs = interaction.options.getInteger('max_nfts');
    const votingPower = interaction.options.getInteger('voting_power');

    if (minNFTs > maxNFTs) {
      return interaction.reply({ 
        content: '❌ Minimum NFTs cannot be greater than maximum NFTs!', 
        ephemeral: true 
      });
    }

    const result = settingsManager.updateTier(tierName, minNFTs, maxNFTs, votingPower);

    if (result.success) {
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Tier Updated')
        .setDescription(`**${tierName}** tier has been updated`)
        .addFields(
          { name: 'Min NFTs', value: minNFTs.toString(), inline: true },
          { name: 'Max NFTs', value: maxNFTs.toString(), inline: true },
          { name: 'Voting Power', value: votingPower.toString(), inline: true }
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
      logger.log(`Admin ${interaction.user.tag} updated tier ${tierName}`);
    } else {
      await interaction.reply({ 
        content: `❌ ${result.message}`, 
        ephemeral: true 
      });
    }
  },

  async handleQuorumUpdate(interaction) {
    const percentage = interaction.options.getNumber('percentage');

    const result = settingsManager.updateSettings({ quorumPercentage: percentage });

    if (result.success) {
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Quorum Updated')
        .setDescription(`Quorum threshold set to **${percentage}%**`)
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
      logger.log(`Admin ${interaction.user.tag} updated quorum to ${percentage}%`);
    } else {
      await interaction.reply({ 
        content: `❌ ${result.message}`, 
        ephemeral: true 
      });
    }
  },

  async handleSupportThresholdUpdate(interaction) {
    const count = interaction.options.getInteger('count');

    const result = settingsManager.updateSettings({ supportThreshold: count });

    if (result.success) {
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Support Threshold Updated')
        .setDescription(`Proposals now need **${count} supporters** to be promoted to voting`)
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
      logger.log(`Admin ${interaction.user.tag} updated support threshold to ${count}`);
    } else {
      await interaction.reply({ 
        content: `❌ ${result.message}`, 
        ephemeral: true 
      });
    }
  },

  async handleVoteDurationUpdate(interaction) {
    const days = interaction.options.getInteger('days');

    const result = settingsManager.updateSettings({ voteDurationDays: days });

    if (result.success) {
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Vote Duration Updated')
        .setDescription(`Voting period set to **${days} days**`)
        .setFooter({ text: 'This applies to new proposals only' })
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
      logger.log(`Admin ${interaction.user.tag} updated vote duration to ${days} days`);
    } else {
      await interaction.reply({ 
        content: `❌ ${result.message}`, 
        ephemeral: true 
      });
    }
  }
};
