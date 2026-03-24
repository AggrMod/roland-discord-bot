require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');
const WebServer = require('./web/server');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Collection();

function loadCommandsFromDirectory(dir) {
  const commandsPath = path.join(__dirname, dir);
  
  if (!fs.existsSync(commandsPath)) {
    logger.warn(`Commands directory not found: ${commandsPath}`);
    return;
  }

  const entries = fs.readdirSync(commandsPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(commandsPath, entry.name);

    if (entry.isDirectory()) {
      loadCommandsFromDirectory(path.relative(__dirname, fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      try {
        const command = require(fullPath);
        
        if ('data' in command && 'execute' in command) {
          client.commands.set(command.data.name, command);
          logger.log(`Loaded command: ${command.data.name}`);
        } else {
          logger.warn(`Command at ${fullPath} is missing required "data" or "execute" property.`);
        }
      } catch (error) {
        logger.error(`Error loading command at ${fullPath}:`, error);
      }
    }
  }
}

loadCommandsFromDirectory('commands');

// Initialize web server
const webServer = new WebServer();
webServer.start();

// Set client reference in proposalService
const proposalService = require('./services/proposalService');
const walletService = require('./services/walletService');
const roleService = require('./services/roleService');
const treasuryService = require('./services/treasuryService');
const governanceLogger = require('./utils/governanceLogger');
const settings = require('./config/settings.json');

client.once(Events.ClientReady, () => {
  logger.log(`✅ Bot is online as ${client.user.tag}`);
  logger.log(`📊 Loaded ${client.commands.size} commands`);
  logger.log(`🏛️ Serving ${client.guilds.cache.size} guild(s)`);
  
  client.user.setActivity('The Commission', { type: 0 });

  // Pass client to proposalService, webServer, and governanceLogger
  proposalService.setClient(client);
  webServer.setClient(client);
  governanceLogger.setClient(client);

  // Start periodic vote check (every 5 minutes)
  startVoteCheckInterval();

  // Start role resync scheduler (every 4 hours)
  startRoleResyncScheduler();

  // Start treasury monitoring scheduler
  treasuryService.startScheduler();
});

client.on(Events.InteractionCreate, async interaction => {
  // Handle slash commands
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);

    if (!command) {
      logger.warn(`No command matching ${interaction.commandName} was found.`);
      return;
    }

    try {
      await command.execute(interaction);
      logger.log(`Command executed: ${interaction.commandName} by ${interaction.user.tag}`);
    } catch (error) {
      logger.error(`Error executing ${interaction.commandName}:`, error);
      
      const errorMessage = { 
        content: 'There was an error while executing this command!', 
        ephemeral: true 
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorMessage);
      } else {
        await interaction.reply(errorMessage);
      }
    }
    return;
  }

  // Handle button interactions
  if (interaction.isButton()) {
    const customId = interaction.customId;

    // Verify panel button handler
    if (customId === 'panel_verify') {
      // Run the same logic as /verify command
      const verifyCommand = client.commands.get('verify');
      if (verifyCommand) {
        await verifyCommand.execute(interaction);
      }
      return;
    }

    // Treasury panel refresh button handler
    if (customId === 'treasury_refresh_panel') {
      await handleTreasuryRefreshButton(interaction);
      return;
    }

    // Support button handler
    if (customId.startsWith('support_')) {
      await handleSupportButton(interaction);
      return;
    }

    // Vote button handlers
    if (customId.startsWith('vote_yes_') || customId.startsWith('vote_no_') || customId.startsWith('vote_abstain_')) {
      await handleVoteButton(interaction);
      return;
    }
  }
});

async function handleSupportButton(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const proposalId = interaction.customId.replace('support_', '');
    const discordId = interaction.user.id;

    // Check if user has verified wallet
    const wallets = walletService.getLinkedWallets(discordId);
    if (!wallets || wallets.length === 0) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Not Verified')
        .setDescription('You must verify your wallet to support proposals.\n\nUse `/verify` to get started.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const userInfo = await roleService.getUserInfo(discordId);
    if (!userInfo || !userInfo.voting_power || userInfo.voting_power === 0) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Not Eligible')
        .setDescription('You must own at least 1 SOLPRANOS NFT to support proposals.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const result = proposalService.addSupporter(proposalId, discordId);

    if (!result.success) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Cannot Support')
        .setDescription(result.message || 'An error occurred.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const supporterCount = result.supporterCount;
    const isPromoted = result.promoted;

    // Update the proposal message
    await updateProposalMessage(interaction.message, proposalId, supporterCount, isPromoted);

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle(isPromoted ? '🗳️ Promoted to Voting!' : '✅ Support Added')
      .setDescription(isPromoted 
        ? 'This proposal has been promoted to voting! Check the voting channel to cast your vote.'
        : `You've supported this proposal! (${supporterCount}/4 supporters)`
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${discordId} supported proposal ${proposalId} (${supporterCount}/4)${isPromoted ? ' - PROMOTED' : ''}`);

  } catch (error) {
    logger.error('Error handling support button:', error);
    await interaction.editReply({ content: 'An error occurred while processing your support.', ephemeral: true });
  }
}

async function updateProposalMessage(message, proposalId, supporterCount, isPromoted) {
  try {
    const proposal = proposalService.getProposal(proposalId);
    if (!proposal) return;

    const supportThreshold = settings.supportThreshold || 4;

    const embed = EmbedBuilder.from(message.embeds[0]);
    
    // Update supporters field
    const fieldIndex = embed.data.fields.findIndex(f => f.name === '👥 Supporters');
    if (fieldIndex >= 0) {
      embed.data.fields[fieldIndex].value = isPromoted ? `${supportThreshold}/${supportThreshold} ✅` : `${supporterCount}/${supportThreshold}`;
    }

    // Update status field if promoted
    if (isPromoted) {
      const statusIndex = embed.data.fields.findIndex(f => f.name === '📊 Status');
      if (statusIndex >= 0) {
        embed.data.fields[statusIndex].value = 'PROMOTED TO VOTE ✅';
      }
      embed.setColor('#00FF00');
      embed.setFooter({ text: 'This proposal has been promoted to voting!' });
    }

    // Disable button if promoted
    const row = isPromoted 
      ? new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`support_${proposalId}_disabled`)
              .setLabel('Support')
              .setStyle(ButtonStyle.Primary)
              .setEmoji('✅')
              .setDisabled(true)
          )
      : message.components[0];

    await message.edit({ embeds: [embed], components: [row] });
  } catch (error) {
    logger.error('Error updating proposal message:', error);
  }
}

async function handleVoteButton(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const parts = interaction.customId.split('_');
    const voteChoice = parts[1]; // yes, no, or abstain
    const proposalId = parts.slice(2).join('_'); // Handle proposal IDs with underscores

    const discordId = interaction.user.id;

    // Check if user has verified wallet
    const wallets = walletService.getLinkedWallets(discordId);
    if (!wallets || wallets.length === 0) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Not Verified')
        .setDescription('You must verify your wallet to vote on proposals.\n\nUse `/verify` to get started.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const userInfo = await roleService.getUserInfo(discordId);
    if (!userInfo || !userInfo.voting_power || userInfo.voting_power === 0) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Not Eligible')
        .setDescription('You must own at least 1 SOLPRANOS NFT to vote.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const result = proposalService.castVote(proposalId, discordId, voteChoice, userInfo.voting_power);

    if (!result.success) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Cannot Vote')
        .setDescription(result.message || 'An error occurred.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // Update the voting message with new tallies
    await proposalService.updateVotingMessage(proposalId);

    const choiceEmoji = {
      'yes': '✅',
      'no': '❌',
      'abstain': '⚖️'
    };

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🗳️ Vote Recorded!')
      .setDescription(`Your ${choiceEmoji[voteChoice]} **${voteChoice.toUpperCase()}** vote has been recorded!\n\n**Voting Power:** ${userInfo.voting_power} VP`)
      .setFooter({ text: 'You can change your vote any time before voting closes.' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${discordId} voted ${voteChoice} on proposal ${proposalId} with ${userInfo.voting_power} VP`);

  } catch (error) {
    logger.error('Error handling vote button:', error);
    await interaction.editReply({ content: 'An error occurred while processing your vote.', ephemeral: true });
  }
}

async function handleTreasuryRefreshButton(interaction) {
  try {
    await interaction.deferUpdate();

    // Check if user is admin
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.followUp({ 
        content: '❌ Only administrators can refresh the treasury panel.', 
        ephemeral: true 
      });
      return;
    }

    const config = treasuryService.getConfig();

    if (!config || !config.enabled || !config.solana_wallet) {
      // Just rebuild the panel with current state (shows setup messages)
      const treasuryCommand = require('./commands/admin/treasury.js');
      const { embed, components } = treasuryCommand.buildTreasuryPanel();
      
      await interaction.editReply({ embeds: [embed], components: [components] });
      
      await interaction.followUp({ 
        content: '⚠️ Treasury not fully configured. Enable and configure wallet to fetch live data.', 
        ephemeral: true 
      });
      return;
    }

    // Fetch fresh balances
    const result = await treasuryService.fetchBalances();

    // Rebuild panel with fresh data
    const treasuryCommand = require('./commands/admin/treasury.js');
    const { embed, components } = treasuryCommand.buildTreasuryPanel();

    await interaction.editReply({ embeds: [embed], components: [components] });

    if (result.success) {
      await interaction.followUp({ 
        content: `✅ Treasury data refreshed: ${result.balances.sol} SOL, $${result.balances.usdc} USDC`, 
        ephemeral: true 
      });
      logger.log(`Treasury panel refreshed by ${interaction.user.tag}`);
    } else {
      await interaction.followUp({ 
        content: `⚠️ Refresh attempted but encountered error: ${result.message || result.error}`, 
        ephemeral: true 
      });
    }

  } catch (error) {
    logger.error('Error handling treasury refresh button:', error);
    try {
      await interaction.followUp({ 
        content: 'An error occurred while refreshing the treasury panel.', 
        ephemeral: true 
      });
    } catch (followUpError) {
      // Interaction might have expired, log and continue
      logger.error('Could not send error follow-up:', followUpError);
    }
  }
}

function startVoteCheckInterval() {
  // Check every 5 minutes for votes that need to be closed and stale drafts
  setInterval(async () => {
    try {
      const db = require('./database/db');
      const activeVotes = db.prepare('SELECT * FROM proposals WHERE status = ?').all('voting');

      for (const proposal of activeVotes) {
        proposalService.checkAutoClose(proposal.proposal_id);
      }

      // Check for stale draft proposals
      await proposalService.expireStaleProposals();
    } catch (error) {
      logger.error('Error in vote check interval:', error);
    }
  }, 5 * 60 * 1000); // 5 minutes

  logger.log('📅 Vote auto-close and draft expiry checker started (runs every 5 minutes)');
}

function startRoleResyncScheduler() {
  const RESYNC_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
  const STARTUP_DELAY_MS = 60 * 1000; // 1 minute delay on startup to avoid race conditions
  
  // Load guild ID from environment
  const guildId = process.env.GUILD_ID || process.env.DISCORD_GUILD_ID;

  async function performRoleResync() {
    try {
      const startTime = Date.now();
      logger.log('🔄 Starting role resync cycle...');

      if (!guildId) {
        logger.warn('⚠️ GUILD_ID not configured, skipping role resync');
        return;
      }

      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        logger.warn(`⚠️ Guild ${guildId} not found, skipping role resync`);
        return;
      }

      // Get all verified users (users with at least some NFTs)
      const verifiedUsers = roleService.getAllVerifiedUsers();
      logger.log(`📊 Found ${verifiedUsers.length} verified users to resync`);

      let syncedCount = 0;
      let errorCount = 0;
      let totalAdded = 0;
      let totalRemoved = 0;

      for (const user of verifiedUsers) {
        try {
          // Re-fetch holdings and update database
          const updateResult = await roleService.updateUserRoles(user.discord_id, user.username);
          
          if (updateResult.success) {
            // Sync Discord roles (tier + trait)
            const syncResult = await roleService.syncUserDiscordRoles(guild, user.discord_id);
            
            if (syncResult.success) {
              syncedCount++;
              totalAdded += syncResult.totalAdded || 0;
              totalRemoved += syncResult.totalRemoved || 0;
            } else {
              errorCount++;
              logger.warn(`Failed to sync roles for user ${user.discord_id}: ${syncResult.message}`);
            }
          }

          // Small delay to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          errorCount++;
          logger.error(`Error processing user ${user.discord_id}:`, error);
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.log(`✅ Role resync complete: ${syncedCount} synced, ${errorCount} errors, ${totalAdded} roles added, ${totalRemoved} roles removed (${duration}s)`);
    } catch (error) {
      logger.error('❌ Error in role resync cycle:', error);
    }
  }

  // Run once on startup with delay
  setTimeout(() => {
    logger.log('🚀 Running initial role resync (startup)...');
    performRoleResync();
  }, STARTUP_DELAY_MS);

  // Schedule recurring resync every 4 hours
  setInterval(() => {
    performRoleResync();
  }, RESYNC_INTERVAL_MS);

  logger.log(`⏰ Role resync scheduler started (runs every 4 hours + on startup)`);
}

client.on(Events.Error, error => {
  logger.error('Discord client error:', error);
});

process.on('unhandledRejection', error => {
  logger.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
  logger.error('Uncaught exception:', error);
  process.exit(1);
});

if (!process.env.DISCORD_TOKEN) {
  logger.error('❌ DISCORD_TOKEN is not set in .env file');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
