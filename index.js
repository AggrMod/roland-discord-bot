require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Collection, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');
const WebServer = require('./web/server');
const tenantService = require('./services/tenantService');
const moduleGate = require('./middleware/moduleGate');
const { getCommandModuleKey } = require('./config/commandModules');
const clientProvider = require('./utils/clientProvider');
const { applyEmbedBranding } = require('./services/embedBranding');

// Validate critical environment variables on startup
function validateEnvVars() {
  const required = ['DISCORD_TOKEN', 'CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI', 'SESSION_SECRET'];

  const missing = [];
  for (const varName of required) {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  }

  if (missing.length > 0) {
    logger.error(`CRITICAL: Missing required environment variables: ${missing.join(', ')}`);
    logger.error('The bot cannot start without these. Please set them in .env file.');
    process.exit(1);
  }

  // Optional vars with specific warnings
  if (!process.env.HELIUS_API_KEY) {
    logger.warn('HELIUS_API_KEY not set — NFT verification will use mock mode');
  }
  if (!process.env.SOLANA_RPC_URL) {
    logger.warn('SOLANA_RPC_URL not set — Solana RPC calls may fail or use default endpoint');
  }

  // Check for hardcoded session secret default
  if (process.env.SESSION_SECRET === 'solpranos-secret-key-change-this-in-production') {
    logger.warn('WARNING: Using default SESSION_SECRET. This should be changed in production!');
  }

  // Block mock mode in production
  if (process.env.NODE_ENV === 'production' && process.env.MOCK_MODE === 'true') {
    throw new Error('FATAL: MOCK_MODE=true is not allowed in production');
  }
}

validateEnvVars();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
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
const microVerifyService = require('./services/microVerifyService');
const governanceLogger = require('./utils/governanceLogger');
const ticketService = require('./services/ticketService');
const nftActivityService = require('./services/nftActivityService');
const settings = require('./config/settings.json');

const intervals = [];

client.once(Events.ClientReady, () => {
  logger.log(`✅ Bot is online as ${client.user.tag}`);
  logger.log(`📊 Loaded ${client.commands.size} commands`);
  logger.log(`🏛️ Serving ${client.guilds.cache.size} guild(s)`);
  
  // Bot activity status — use tenant branding if available, else generic fallback
  const currentGuildIdForActivity = process.env.GUILD_ID;
  let activityName = 'Serving your community';
  if (currentGuildIdForActivity) {
    try {
      const tenantCtx = tenantService.ensureTenant(currentGuildIdForActivity);
      activityName = tenantCtx?.branding?.bot_display_name || tenantCtx?.branding?.display_name || activityName;
    } catch (_) { /* fallback to default */ }
  }
  client.user.setActivity(activityName, { type: 0 });

  // Set client reference via clientProvider
  clientProvider.setClient(client);

  // Pass client to proposalService, webServer, governanceLogger, ticketService
  proposalService.setClient(client);
  webServer.setClient(client);
  governanceLogger.setClient(client);
  ticketService.setClient(client);

  const currentGuildId = process.env.GUILD_ID;
  if (currentGuildId) {
    const currentGuild = client.guilds.cache.get(currentGuildId);
    try {
      tenantService.ensureTenant(currentGuildId, currentGuild?.name || null);
      logger.log(`🏗️ Tenant scaffold ensured for guild ${currentGuildId}${currentGuild?.name ? ` (${currentGuild.name})` : ''}`);
    } catch (error) {
      logger.error('Error ensuring startup tenant:', error);
    }
  }

  if (tenantService.isMultitenantEnabled() && currentGuildId) {
    tenantService.syncGuildCommands(client.commands, currentGuildId, client.guilds.cache.get(currentGuildId)?.name || null)
      .catch(error => logger.error('Error syncing startup guild commands:', error));
  }

  // Initialize and start micro-verify service
  microVerifyService.init();

  // Sync persisted DB settings into microVerifyService on startup
  // (in-memory _configOverrides are lost on restart; re-apply from settingsManager)
  try {
    const settingsManager = require('./config/settings');
    const saved = settingsManager.getSettings();
    const startupOverrides = {};
    if (saved.moduleMicroVerifyEnabled !== undefined) startupOverrides['MICRO_VERIFY_ENABLED'] = String(saved.moduleMicroVerifyEnabled);
    if (saved.verificationReceiveWallet)              startupOverrides['VERIFICATION_RECEIVE_WALLET'] = saved.verificationReceiveWallet;
    if (saved.verifyRequestTtlMinutes)                startupOverrides['VERIFY_REQUEST_TTL_MINUTES'] = String(saved.verifyRequestTtlMinutes);
    if (saved.pollIntervalSeconds)                    startupOverrides['POLL_INTERVAL_SECONDS'] = String(saved.pollIntervalSeconds);
    if (Object.keys(startupOverrides).length) microVerifyService.updateConfig(startupOverrides);
  } catch (e) {
    logger.warn('microVerifyService startup sync warning:', e?.message || e);
  }

  microVerifyService.startPolling();

  // Import module guard for scheduler checks
  const moduleGuard = require('./utils/moduleGuard');

  // Start periodic vote check (every 5 minutes) - only if governance enabled
  startVoteCheckInterval();

  // Start role resync scheduler (every 4 hours) - only if verification enabled
  startRoleResyncScheduler();

  // Start treasury monitoring scheduler - only if treasury enabled
  treasuryService.setClient(client);
  treasuryService.startScheduler();

  // Start micro-verify cleanup job (runs every 10 minutes) - only if verification enabled
  intervals.push(setInterval(() => {
    if (moduleGuard.isModuleEnabled('verification')) {
      microVerifyService.expireStaleRequests();
    }
  }, 10 * 60 * 1000));

  // NFT activity polling cron — catches Magic Eden/Tensor listings that webhooks miss
  const pollAllCollections = () => {
    nftActivityService.pollCollectionActivity().catch(err => {
      logger.error('[nft-poll] Error in scheduled poll:', err);
    });
  };
  intervals.push(setInterval(pollAllCollections, 5 * 60 * 1000));
  setTimeout(pollAllCollections, 30 * 1000); // first poll 30s after startup
  logger.log('🔔 NFT activity poll scheduled (30s startup delay, then every 5 min)');

  // Holdings panel refresh cron — keep wallet holding panels up to date
  const trackedWalletsService = require('./services/trackedWalletsService');
  const refreshAllHoldingsPanels = () => {
    trackedWalletsService.refreshAllPanels().catch(err => {
      logger.error('[wallet-panel] Error in scheduled refresh:', err);
    });
  };
  intervals.push(setInterval(refreshAllHoldingsPanels, 30 * 60 * 1000)); // every 30 min
  setTimeout(refreshAllHoldingsPanels, 2 * 60 * 1000); // first refresh 2 min after startup
  logger.log('📋 Wallet holdings panel refresh scheduled (2 min startup delay, then every 30 min)');
});

client.on(Events.GuildCreate, async guild => {
  try {
    tenantService.ensureTenant(guild.id, guild.name);
    logger.log(`🏗️ Tenant scaffold ensured for joined guild ${guild.id} (${guild.name})`);

    if (tenantService.isMultitenantEnabled()) {
      await tenantService.syncGuildCommands(client.commands, guild.id, guild.name);
    }
  } catch (error) {
    logger.error(`Error handling guildCreate for ${guild.id}:`, error);
  }
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
      const moduleKey = getCommandModuleKey(interaction.commandName);
      if (!(await moduleGate(interaction, moduleKey))) {
        return;
      }

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
      await handlePanelVerifyButton(interaction);
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

    // Micro-verify button handlers
    if (customId === 'micro_verify_check_status') {
      await handleMicroVerifyCheckStatus(interaction);
      return;
    }

    if (customId === 'micro_verify_copy_amount') {
      await handleMicroVerifyCopyAmount(interaction);
      return;
    }

    // Role claim button handler
    if (customId.startsWith('role_claim_') || customId.startsWith('claim_role_')) {
      await handleRoleClaimButton(interaction);
      return;
    }

    // Ticket button handlers
    if (customId.startsWith('ticket_open_')) {
      await handleTicketOpenButton(interaction);
      return;
    }
    if (customId === 'ticket_claim') {
      await handleTicketClaimButton(interaction);
      return;
    }
    if (customId === 'ticket_close') {
      await handleTicketCloseButton(interaction);
      return;
    }
    if (customId === 'ticket_reopen') {
      await handleTicketReopenButton(interaction);
      return;
    }
    if (customId === 'ticket_delete') {
      await handleTicketDeleteButton(interaction);
      return;
    }
  }

  // Handle modal submissions
  if (interaction.isModalSubmit()) {
    const customId = interaction.customId;

    if (customId.startsWith('ticket_modal_')) {
      await handleTicketModalSubmit(interaction);
      return;
    }
  }
});

async function handlePanelVerifyButton(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    const username = interaction.user.username;
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';
    const wallets = walletService.getLinkedWallets(discordId);

    // If no wallets linked, send to portal
    if (!wallets || wallets.length === 0) {
      const embed = new EmbedBuilder()
        .setTitle('🔗 Verification Portal')
        .setDescription('No wallet linked yet. Connect your wallet to join the Family, then we\'ll sync your holdings automatically.')
        .addFields(
          { name: 'Next Steps', value: '1) Open portal\n2) Connect/sign\n3) Click Verify again', inline: false }
        )
        .setTimestamp();
      applyEmbedBranding(embed, {
        guildId: interaction.guildId || '',
        moduleKey: 'verification',
        defaultColor: '#FFD700',
        defaultFooter: 'Powered by Guild Pilot',
        fallbackLogoUrl: client?.user?.displayAvatarURL?.() || null,
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Open Verify Portal')
          .setStyle(ButtonStyle.Link)
          .setURL(`${webUrl}/verify`),
        new ButtonBuilder()
          .setLabel('Add Wallet')
          .setStyle(ButtonStyle.Link)
          .setURL(`${webUrl}/verify?action=add`)
      );

      await interaction.editReply({ embeds: [embed], components: [row], ephemeral: true });
      return;
    }

    // Wallet exists: verify holdings now
    const updateResult = await roleService.updateUserRoles(discordId, username, interaction.guildId || null);

    if (!updateResult.success) {
      return interaction.editReply({
        content: `❌ Could not verify holdings right now: ${updateResult.message || 'unknown error'}. Try again in a moment.`
      });
    }

    // Sync Discord roles best-effort
    let roleSyncText = 'Role sync skipped';
    if (interaction.guild) {
      const syncResult = await roleService.syncUserDiscordRoles(interaction.guild, discordId, interaction.guildId || null);
      roleSyncText = syncResult.success
        ? `+${syncResult.totalAdded || 0} / -${syncResult.totalRemoved || 0}`
        : 'Role sync partial';
    }

    const tierText = updateResult.tier || 'Associate';
    const embed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('✅ Holdings Verified')
      .setDescription('Your linked wallet(s) were detected and your holdings were refreshed.')
      .addFields(
        { name: 'Linked Wallets', value: `${wallets.length}`, inline: true },
        { name: 'NFTs', value: `${updateResult.totalNFTs || 0}`, inline: true },
        { name: 'Tier', value: `${tierText}`, inline: true },
        { name: 'Voting Power', value: `${updateResult.votingPower || 0}`, inline: true },
        { name: 'Discord Role Sync', value: roleSyncText, inline: true }
      )
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Add Wallet')
        .setStyle(ButtonStyle.Link)
        .setURL(`${webUrl}/verify?action=add`)
    );

    await interaction.editReply({ embeds: [embed], components: [row], ephemeral: true });
  } catch (error) {
    logger.error('Error handling panel verify button:', error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '❌ Verification button failed. Please run `/verification status` or use `/verification quick`.' });
      } else {
        await interaction.reply({ content: '❌ Verification button failed. Please run `/verification status` or use `/verification quick`.', ephemeral: true });
      }
    } catch (followUpError) {
      logger.error('Could not send verify button error:', followUpError);
    }
  }
}

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
        .setDescription('You must verify your wallet to support proposals.\n\nUse `/verification status` to get started.')
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
        .setTitle('❌ Cannot Support')
        .setDescription(result.message || 'An error occurred.')
        .setTimestamp();
      applyEmbedBranding(embed, {
        guildId: interaction.guildId || '',
        moduleKey: 'governance',
        defaultColor: '#FF0000',
        defaultFooter: 'Powered by Guild Pilot',
        fallbackLogoUrl: client?.user?.displayAvatarURL?.() || null,
      });

      return interaction.editReply({ embeds: [embed] });
    }

    const supporterCount = result.supporterCount;
    const isPromoted = result.promoted;

    // Update the proposal message
    await updateProposalMessage(interaction.message, proposalId, supporterCount, isPromoted);

    const embed = new EmbedBuilder()
      .setTitle(isPromoted ? '🗳️ Promoted to Voting!' : '✅ Support Added')
      .setDescription(isPromoted 
        ? 'This proposal has been promoted to voting! Check the voting channel to cast your vote.'
        : `You've supported this proposal! (${supporterCount}/4 supporters)`
      )
      .setTimestamp();
    applyEmbedBranding(embed, {
      guildId: interaction.guildId || '',
      moduleKey: 'governance',
      defaultColor: '#FFD700',
      defaultFooter: 'Powered by Guild Pilot',
      fallbackLogoUrl: client?.user?.displayAvatarURL?.() || null,
    });

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
        .setDescription('You must verify your wallet to vote on proposals.\n\nUse `/verification status` to get started.')
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    const userInfo = await roleService.getUserInfo(discordId);
    if (!userInfo || !userInfo.voting_power || userInfo.voting_power === 0) {
      const embed = new EmbedBuilder()
        .setTitle('❌ Not Eligible')
        .setDescription('You must own at least 1 SOLPRANOS NFT to vote.')
        .setTimestamp();
      applyEmbedBranding(embed, {
        guildId: interaction.guildId || '',
        moduleKey: 'governance',
        defaultColor: '#FF0000',
        defaultFooter: 'Powered by Guild Pilot',
        fallbackLogoUrl: client?.user?.displayAvatarURL?.() || null,
      });

      return interaction.editReply({ embeds: [embed] });
    }

    const result = proposalService.castVote(proposalId, discordId, voteChoice, userInfo.voting_power);

    if (!result.success) {
      const embed = new EmbedBuilder()
        .setTitle('❌ Cannot Vote')
        .setDescription(result.message || 'An error occurred.')
        .setTimestamp();
      applyEmbedBranding(embed, {
        guildId: interaction.guildId || '',
        moduleKey: 'governance',
        defaultColor: '#FF0000',
        defaultFooter: 'Powered by Guild Pilot',
        fallbackLogoUrl: client?.user?.displayAvatarURL?.() || null,
      });

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
      .setTitle('🗳️ Vote Recorded!')
      .setDescription(`Your ${choiceEmoji[voteChoice]} **${voteChoice.toUpperCase()}** vote has been recorded!\n\n**Voting Power:** ${userInfo.voting_power} VP`)
      .setFooter({ text: 'You can change your vote any time before voting closes.' })
      .setTimestamp();
    applyEmbedBranding(embed, {
      guildId: interaction.guildId || '',
      moduleKey: 'governance',
      defaultColor: '#FFD700',
      defaultFooter: 'Powered by Guild Pilot',
      fallbackLogoUrl: client?.user?.displayAvatarURL?.() || null,
    });

    await interaction.editReply({ embeds: [embed] });
    logger.log(`User ${discordId} voted ${voteChoice} on proposal ${proposalId} with ${userInfo.voting_power} VP`);

  } catch (error) {
    logger.error('Error handling vote button:', error);
    await interaction.editReply({ content: 'An error occurred while processing your vote.', ephemeral: true });
  }
}

async function handleMicroVerifyCheckStatus(interaction) {
  const microVerifyService = require('./services/microVerifyService');
  
  try {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    const result = microVerifyService.getPendingRequest(discordId);

    if (!result.success) {
      // Check if user has verified wallets now
      const wallets = walletService.getLinkedWallets(discordId);
      
      if (wallets && wallets.length > 0) {
        const embed = new EmbedBuilder()
          .setColor('#57F287')
          .setTitle('✅ Wallet Already Verified!')
          .setDescription('Your wallet has been successfully verified. Use `/verification status` to see your status.')
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } else {
        const embed = new EmbedBuilder()
          .setColor('#FFA500')
          .setTitle('⏳ No Verification Request')
          .setDescription(result.message || 'No pending verification request found.')
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      }
      return;
    }

    const request = result.request;
    const expiresAt = new Date(request.expires_at);
    const timeLeft = Math.max(0, Math.floor((expiresAt - new Date()) / 1000 / 60));

    const embed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('⏳ Verification Pending')
      .setDescription(
        `Waiting for your transfer...\n\n` +
        `**Amount:** \`${request.expected_amount}\` SOL\n` +
        `**Time left:** ${timeLeft} minute(s)\n\n` +
        `The system checks for transactions every ${microVerifyService.getConfig().pollIntervalSeconds} seconds.`
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error handling micro-verify check status:', error);
    await interaction.editReply({ content: 'An error occurred while checking status.', ephemeral: true });
  }
}

async function handleMicroVerifyCopyAmount(interaction) {
  const microVerifyService = require('./services/microVerifyService');
  
  try {
    const discordId = interaction.user.id;
    const result = microVerifyService.getPendingRequest(discordId);

    if (!result.success) {
      await interaction.reply({ 
        content: 'No pending verification request found.', 
        ephemeral: true 
      });
      return;
    }

    const request = result.request;
    
    await interaction.reply({ 
      content: `💰 **Amount to send:** \`${request.expected_amount}\`\n\nCopy this exact amount and send it to the verification wallet.`, 
      ephemeral: true 
    });
  } catch (error) {
    logger.error('Error handling micro-verify copy amount:', error);
    await interaction.reply({ 
      content: 'An error occurred.', 
      ephemeral: true 
    });
  }
}

async function handleRoleClaimButton(interaction) {
  const roleClaimService = require('./services/roleClaimService');
  const rolePanelService = require('./services/rolePanelService');
  
  try {
    await interaction.deferReply({ ephemeral: true });

    // Extract role ID from customId:
    // new format: claim_role_<panelId>__<roleId>
    // legacy:     claim_role_<roleId> or role_claim_<roleId>
    let panelId = null;
    let roleId = interaction.customId.replace('claim_role_', '').replace('role_claim_', '');
    if (interaction.customId.startsWith('claim_role_') && roleId.includes('__')) {
      const [p, ...rest] = roleId.split('__');
      panelId = parseInt(p, 10);
      roleId = rest.join('__');
    }

    // Check legacy pool first, then new multi-panel system
    const inLegacyPool = !!roleClaimService.getAllRoles().find(r => r.roleId === roleId);
    const panelForRole = !inLegacyPool
      ? (panelId ? rolePanelService.getPanel(panelId, interaction.guildId) : rolePanelService.getPanelByRole(roleId, interaction.guildId))
      : null;
    const inPanelSystem = !!panelForRole && rolePanelService.isRoleClaimable(roleId, interaction.guildId);

    if (!inLegacyPool && !inPanelSystem) {
      await interaction.editReply({ content: '❌ This role is no longer available for self-assignment.', ephemeral: true });
      return;
    }

    const result = await roleClaimService.toggleRole(
      interaction.guild,
      interaction.member,
      roleId
    );

    // Single-select panel: if user just claimed one role, remove other panel roles
    if (result.success && result.action === 'added' && panelForRole && panelForRole.single_select === 1) {
      const allPanelRoles = (panelForRole.roles || []).map(r => r.role_id).filter(r => r !== roleId);
      for (const otherRoleId of allPanelRoles) {
        const roleObj = interaction.guild.roles.cache.get(otherRoleId);
        if (roleObj && interaction.member.roles.cache.has(otherRoleId)) {
          try { await interaction.member.roles.remove(roleObj, 'Single-select role panel enforced'); } catch {}
        }
      }
    }

    const embed = new EmbedBuilder()
      .setTitle(result.success ? (result.action === 'added' ? '✅ Role Added' : '➖ Role Removed') : '❌ Error')
      .setDescription(result.message)
      .setTimestamp();
    applyEmbedBranding(embed, {
      guildId: interaction.guildId || '',
      moduleKey: 'selfserve',
      defaultColor: result.success ? (result.action === 'added' ? '#57F287' : '#FEE75C') : '#ED4245',
      defaultFooter: 'Powered by Guild Pilot',
      fallbackLogoUrl: client?.user?.displayAvatarURL?.() || null,
    });

    await interaction.editReply({ embeds: [embed] });
    
    logger.log(`User ${interaction.user.tag} ${result.action || 'attempted'} role: ${roleId}`);
  } catch (error) {
    logger.error('Error handling role claim button:', error);
    await interaction.editReply({ 
      content: 'An error occurred while processing your request.', 
      ephemeral: true 
    });
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
      const panel = buildTreasuryPanelFromService();
      await interaction.editReply({ embeds: [panel.embed], components: [panel.components] });
      
      await interaction.followUp({ 
        content: '⚠️ Treasury not fully configured. Enable and configure wallet to fetch live data.', 
        ephemeral: true 
      });
      return;
    }

    // Fetch fresh balances
    const result = await treasuryService.fetchBalances();

    // Rebuild panel with fresh data
    const panel = buildTreasuryPanelFromService();
    await interaction.editReply({ embeds: [panel.embed], components: [panel.components] });

    if (result.success) {
      await interaction.followUp({ 
        content: `✅ Treasury data refreshed: ${result.balances.sol} SOL, ${result.balances.usdc} USDC`, 
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
      logger.error('Could not send error follow-up:', followUpError);
    }
  }
}

function buildTreasuryPanelFromService() {
  const summary = treasuryService.getSummary();
  const status = summary.success ? summary.treasury.status : 'error';
  const statusEmoji = status === 'ok' ? '✅' : status === 'stale' ? '⚠️' : '❌';

  const embed = new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle('💰 Treasury Watch')
    .setDescription(summary.success
      ? 'Live treasury snapshot'
      : `⚠️ ${summary.message || 'Treasury unavailable'}`)
    .addFields(
      { name: '🪙 SOL', value: summary.success ? `${summary.treasury.sol}` : '—', inline: true },
      { name: '💵 USDC', value: summary.success ? `${summary.treasury.usdc}` : '—', inline: true },
      { name: 'Status', value: `${statusEmoji} ${status}`, inline: true },
      { name: 'Last Updated', value: summary.success && summary.treasury.lastUpdated ? `<t:${Math.floor(new Date(summary.treasury.lastUpdated).getTime()/1000)}:R>` : 'Unknown', inline: false }
    )
    .setFooter({ text: 'Wallet hidden for security' })
    .setTimestamp();

  const components = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('treasury_refresh_panel')
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔄')
  );

  return { embed, components };
}

function startVoteCheckInterval() {
  // Check every 5 minutes for votes that need to be closed and stale drafts
  intervals.push(setInterval(async () => {
    // Check if governance module is enabled
    const moduleGuard = require('./utils/moduleGuard');
    if (!moduleGuard.isModuleEnabled('governance')) {
      return; // Skip if governance disabled
    }

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
  }, 5 * 60 * 1000)); // 5 minutes

  logger.log('📅 Vote auto-close and draft expiry checker started (runs every 5 minutes)');
}

function startRoleResyncScheduler() {
  const RESYNC_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
  const STARTUP_DELAY_MS = 60 * 1000; // 1 minute delay on startup to avoid race conditions
  
  // Load guild ID from environment
  const guildId = process.env.GUILD_ID || process.env.DISCORD_GUILD_ID;

  async function performRoleResync() {
    // Check if verification module is enabled
    const moduleGuard = require('./utils/moduleGuard');
    if (!moduleGuard.isModuleEnabled('verification')) {
      return; // Skip if verification disabled
    }

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

      // Resolve verified guild members for this tenant-scoped resync
      const verifiedUsers = await roleService.getAllVerifiedUsers(guild);
      logger.log(`📊 Found ${verifiedUsers.length} verified users to resync`);

      let syncedCount = 0;
      let errorCount = 0;
      let totalAdded = 0;
      let totalRemoved = 0;

      for (const user of verifiedUsers) {
        try {
          // Re-fetch holdings and update database
          const updateResult = await roleService.updateUserRoles(user.discord_id, user.username, guild.id);
          
          if (updateResult.success) {
            // Sync Discord roles (tier + trait)
            const syncResult = await roleService.syncUserDiscordRoles(guild, user.discord_id, guild.id);
            
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
  intervals.push(setInterval(() => {
    performRoleResync();
  }, RESYNC_INTERVAL_MS));

  logger.log(`⏰ Role resync scheduler started (runs every 4 hours + on startup)`);
}

// ==================== Ticket Interaction Handlers ====================

async function handleTicketOpenButton(interaction) {
  try {
    if (!ticketService.isEnabled()) {
      return interaction.reply({ content: '❌ Ticketing is currently disabled.', ephemeral: true });
    }

    const categoryId = parseInt(interaction.customId.replace('ticket_open_', ''));
    const category = ticketService.getCategory(categoryId);

    if (!category) {
      return interaction.reply({ content: '❌ This ticket category no longer exists.', ephemeral: true });
    }
    if (!category.enabled) {
      return interaction.reply({ content: '❌ This ticket category is currently disabled.', ephemeral: true });
    }

    const modal = ticketService.buildTemplateModal(category);
    await interaction.showModal(modal);
  } catch (error) {
    logger.error('Error handling ticket open button:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Failed to open ticket form.', ephemeral: true });
      }
    } catch (e) { /* ignore */ }
  }
}

async function handleTicketModalSubmit(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const categoryId = parseInt(interaction.customId.replace('ticket_modal_', ''));
    const category = ticketService.getCategory(categoryId);
    if (!category) {
      return interaction.editReply({ content: '❌ This ticket category no longer exists.' });
    }

    const templateResponses = ticketService.extractTemplateResponses(category, interaction);

    const result = await ticketService.createTicket(interaction, categoryId, templateResponses);

    if (!result.success) {
      return interaction.editReply({ content: `❌ Could not create ticket: ${result.message}` });
    }

    await interaction.editReply({
      content: `✅ Ticket #${result.ticketNumber} created! Head to <#${result.channelId}>`
    });
    logger.log(`Ticket #${result.ticketNumber} created by ${interaction.user.tag} in category ${categoryId}`);
  } catch (error) {
    logger.error('Error handling ticket modal submit:', error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '❌ An error occurred while creating your ticket.' });
      }
    } catch (e) { /* ignore */ }
  }
}

async function handleTicketClaimButton(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const result = await ticketService.claimTicket(interaction, interaction.channelId);

    if (!result.success) {
      return interaction.editReply({ content: `❌ ${result.message}` });
    }

    await interaction.editReply({ content: '✅ You have claimed this ticket.' });
    logger.log(`Ticket claimed by ${interaction.user.tag} in ${interaction.channelId}`);
  } catch (error) {
    logger.error('Error handling ticket claim:', error);
    await interaction.editReply({ content: '❌ Failed to claim ticket.' });
  }
}

async function handleTicketCloseButton(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const result = await ticketService.closeTicket(interaction, interaction.channelId);

    if (!result.success) {
      return interaction.editReply({ content: `❌ ${result.message}` });
    }

    await interaction.editReply({ content: '🔒 Ticket closed. A transcript has been saved.' });
    logger.log(`Ticket closed by ${interaction.user.tag} in ${interaction.channelId}`);
  } catch (error) {
    logger.error('Error handling ticket close:', error);
    await interaction.editReply({ content: '❌ Failed to close ticket.' });
  }
}

async function handleTicketReopenButton(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const result = await ticketService.reopenTicket(interaction.channelId);

    if (!result.success) {
      return interaction.editReply({ content: `❌ ${result.message}` });
    }

    await interaction.editReply({ content: '🔓 Ticket reopened.' });
    logger.log(`Ticket reopened by ${interaction.user.tag} in ${interaction.channelId}`);
  } catch (error) {
    logger.error('Error handling ticket reopen:', error);
    await interaction.editReply({ content: '❌ Failed to reopen ticket.' });
  }
}

async function handleTicketDeleteButton(interaction) {
  try {
    // Admin only
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ Only administrators can delete tickets.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply({ content: '🗑️ Deleting ticket channel in 3 seconds...' });

    setTimeout(async () => {
      try {
        await ticketService.deleteTicket(interaction.channelId);
        logger.log(`Ticket deleted by ${interaction.user.tag} in ${interaction.channelId}`);
      } catch (error) {
        logger.error('Error deleting ticket channel:', error);
      }
    }, 3000);
  } catch (error) {
    logger.error('Error handling ticket delete:', error);
    try {
      await interaction.reply({ content: '❌ Failed to delete ticket.', ephemeral: true });
    } catch (e) { /* ignore */ }
  }
}

client.on(Events.Error, error => {
  logger.error('Discord client error:', error);
});

async function fetchLobbyRolesAndBuildEmbed(battleService, lobby, reaction, participants) {
  let requiredRoles = [];
  let excludedRoles = [];
  if (lobby.required_role_ids) {
    const requiredIds = lobby.required_role_ids.split(',');
    for (const requiredId of requiredIds) {
      try {
        const role = await reaction.message.guild.roles.fetch(requiredId);
        requiredRoles.push(role);
      } catch (error) {
        logger.error('Failed to fetch required role:', error);
      }
    }
  }
  if (lobby.excluded_role_ids) {
    const excludedIds = lobby.excluded_role_ids.split(',');
    for (const excludedId of excludedIds) {
      try {
        const role = await reaction.message.guild.roles.fetch(excludedId);
        excludedRoles.push(role);
      } catch (error) {
        logger.error('Failed to fetch excluded role:', error);
      }
    }
  }
  return battleService.buildLobbyEmbed(lobby, participants, requiredRoles.length ? requiredRoles : null, excludedRoles.length ? excludedRoles : null);
}

// Battle reaction handlers
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    // Ignore bot reactions
    if (user.bot) return;

    // Handle partial reactions
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch (error) {
        logger.error('Failed to fetch reaction:', error);
        return;
      }
    }

    // ── Engagement: award reaction points ──────────────────────────────────────
    if (reaction.message?.guild) {
      try {
        const eng = require('./services/engagementService');
        eng.tryAwardReaction(reaction.message.guild.id, user.id, user.username, `react:${reaction.message.id}`);
      } catch (_) {}
    }

    const emojiName = reaction.emoji.name;

    // ── Game registry: lobby join (all mini-games) ──────────────────────────
    const gameRegistry = require('./services/gameRegistry');
    const gameSvc = gameRegistry.getByJoinEmoji(emojiName);
    if (gameSvc) {
      const game = gameSvc.getGameByLobby(reaction.message.id);
      if (game && game.status === 'waiting') {
        const r = gameSvc.addPlayer(reaction.message.id, user.id, user.username);
        if (r.success) {
          try {
            await reaction.message.edit({ embeds: [gameSvc.buildLobbyEmbed(game, reaction.message.guildId)] });
          } catch (e) { logger.error('[gameRegistry] lobby update error:', e); }
        }
      }
    }

    // ── Game Night: lobby join ──────────────────────────────────────────────
    const gnService = require('./services/gameNightService');
    if (emojiName === gnService.JOIN_EMOJI) {
      const gnSession = gnService.getByMessage(reaction.message.id);
      if (gnSession && gnSession.status === 'waiting') {
        const r = gnService.addPlayer(gnSession.channelId, user.id, user.username);
        if (r.success) {
          try {
            await reaction.message.edit({ embeds: [gnService.buildLobbyEmbed(gnSession, reaction.message.guildId)] });
          } catch (e) { logger.error('[GameNight] lobby update error:', e); }
        }
      }
    }

    // ── Higher or Lower: round guess ────────────────────────────────────────
    const hlService = require('./services/higherLowerService');
    if (emojiName === hlService.HIGHER_EMOJI || emojiName === hlService.LOWER_EMOJI) {
      const game = hlService.getGameByRound(reaction.message.id);
      if (game && game.status === 'playing') {
        const guess = emojiName === hlService.HIGHER_EMOJI ? 'higher' : 'lower';
        const result = hlService.recordGuess(reaction.message.id, user.id, guess);
        if (!result.success) {
          await reaction.users.remove(user.id).catch(() => {});
        }
      }
    }

    const battleService = require('./services/battleService');

    // Check if this is a battle lobby reaction
    if (reaction.emoji.name === battleService.SWORD_EMOJI) {
      const lobby = battleService.getLobbyByMessage(reaction.message.id);
      
      if (lobby && lobby.status === 'open') {
        // Fetch member to get roles
        let userRoles = [];
        try {
          const member = await reaction.message.guild.members.fetch(user.id);
          userRoles = member.roles.cache.map(role => role.id);
        } catch (error) {
          logger.error('Failed to fetch member roles:', error);
        }

        const result = battleService.addParticipant(lobby.lobby_id, user.id, user.username, userRoles);

        if (result.success) {
          // Update lobby embed
          const participants = battleService.getParticipants(lobby.lobby_id);
          const updatedEmbed = await fetchLobbyRolesAndBuildEmbed(battleService, lobby, reaction, participants);
          await reaction.message.edit({ embeds: [updatedEmbed] });
          logger.log(`User ${user.username} joined battle lobby ${lobby.lobby_id} via reaction`);
        } else if (result.message === 'Already in this lobby') {
          // Silently ignore - user already joined
          return;
        } else {
          // Remove their reaction if they can't join
          await reaction.users.remove(user.id);
          
          // If they were blocked by role constraints, optionally notify them
          if (result.requiresRole || result.blockedRole) {
            try {
              const msg = result.requiresRole
                ? '❌ You need a specific role to join that battle lobby.'
                : '❌ Your role is excluded from this battle lobby.';
              await user.send(msg);
            } catch (dmError) {
              // User has DMs disabled, ignore
              logger.log(`Could not DM user ${user.username} about role restrictions (DMs disabled)`);
            }
          }
        }
      }
    }
  } catch (error) {
    logger.error('Error handling reaction add:', error);
  }
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  try {
    // Ignore bot reactions
    if (user.bot) return;

    // Handle partial reactions
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch (error) {
        logger.error('Failed to fetch reaction:', error);
        return;
      }
    }

    // ── Game registry: lobby leave (all mini-games) ────────────────────────
    const gameRegistry = require('./services/gameRegistry');
    const gameSvc = gameRegistry.getByJoinEmoji(reaction.emoji.name);
    if (gameSvc) {
      const game = gameSvc.getGameByLobby(reaction.message.id);
      if (game && game.status === 'waiting') {
        const r = gameSvc.removePlayer(reaction.message.id, user.id);
        if (r.success) {
          try {
            await reaction.message.edit({ embeds: [gameSvc.buildLobbyEmbed(game, reaction.message.guildId)] });
          } catch (_) {}
        }
      }
    }

    // ── Game Night: lobby leave ─────────────────────────────────────────────
    const gnService = require('./services/gameNightService');
    if (reaction.emoji.name === gnService.JOIN_EMOJI) {
      const gnSession = gnService.getByMessage(reaction.message.id);
      if (gnSession && gnSession.status === 'waiting') {
        const r = gnService.removePlayer(gnSession.channelId, user.id);
        if (r.success) {
          try {
            await reaction.message.edit({ embeds: [gnService.buildLobbyEmbed(gnSession, reaction.message.guildId)] });
          } catch (_) {}
        }
      }
    }

    const battleService = require('./services/battleService');

    // Check if this is a battle lobby reaction
    if (reaction.emoji.name === battleService.SWORD_EMOJI) {
      const lobby = battleService.getLobbyByMessage(reaction.message.id);
      
      if (lobby && lobby.status === 'open') {
        const result = battleService.removeParticipant(lobby.lobby_id, user.id);

        if (result.success) {
          // Update lobby embed
          const participants = battleService.getParticipants(lobby.lobby_id);
          const updatedEmbed = await fetchLobbyRolesAndBuildEmbed(battleService, lobby, reaction, participants);
          await reaction.message.edit({ embeds: [updatedEmbed] });
          logger.log(`User ${user.username} left battle lobby ${lobby.lobby_id} via reaction removal`);
        }
      }
    }
  } catch (error) {
    logger.error('Error handling reaction remove:', error);
  }
});

process.on('unhandledRejection', error => {
  logger.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
  logger.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('SIGTERM', () => {
  logger.log('[Bot] Graceful shutdown...');
  intervals.forEach(clearInterval);
  client.destroy();
  process.exit(0);
});
process.on('SIGINT', () => {
  logger.log('[Bot] Graceful shutdown...');
  intervals.forEach(clearInterval);
  client.destroy();
  process.exit(0);
});

// ── Engagement: award points for chat messages ───────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  try {
    const eng = require('./services/engagementService');
    eng.tryAwardMessage(message.guild.id, message.author.id, message.author.username);
  } catch (_) {}
});

client.login(process.env.DISCORD_TOKEN);
