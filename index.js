require('dotenv').config();
const { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  Collection, 
  Events, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits 
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');
const clientProvider = require('./utils/clientProvider');
const tenantService = require('./services/tenantService');
const aiAssistantService = require('./services/aiAssistantService');
const aiSummaryService = require('./services/aiSummaryService');

// Global caches/state
const commandCooldownCache = new Map();
const legacyAliasNoticeCache = new Map();
const aiAssistantMentionCooldownCache = new Map();
const aiAssistantPassiveChannelCache = new Map();
const aiAssistantPassiveChannelState = new Map();

const LEGACY_ALIAS_NOTICE_TTL_MS = 24 * 60 * 60 * 1000;
const inviteRefreshMs = 120 * 1000;

const COMMAND_COOLDOWN_SECONDS = {
  default: 3,
  verification: {
    status: 5,
    quick: 10,
    check: 5
  },
  governance: {
    create: 30,
    list: 5
  },
  minigames: 5
};

const LEGACY_MINIGAME_ALIASES = new Set(['battle', 'heist', 'arena', 'coinflip', 'rps', 'dice', 'slots', 'higherlower', 'gamenight']);

const PLAN_TIER_RANK = {
  'starter': 0,
  'pro': 1,
  'enterprise': 2
};

const AI_PASSIVE_KEYWORDS = new Set([
  'help', 'how', 'what', 'why', 'where', 'when', 'who',
  'bot', 'ai', 'assistant', 'question', 'info', 'information',
  'verify', 'verification', 'governance', 'proposal', 'vote',
  'heist', 'battle', 'arena', 'minigame', 'rank', 'points',
  'family', 'mafia', 'don', 'boss', 'consigliere', 'underboss',
  'solana', 'nft', 'wallet', 'token', 'treasury'
]);

// Helper: Module gate for commands
async function moduleGate(interaction, moduleKey) {
  if (!moduleKey) return true;
  const guildId = interaction.guildId;
  if (!guildId) return true;

  if (tenantService.isModuleEnabled(guildId, moduleKey)) {
    return true;
  }

  const message = {
    content: `❌ The **${moduleKey}** module is currently disabled for this server.`,
    ephemeral: true
  };

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(message);
  } else {
    await interaction.reply(message);
  }
  return false;
}

function getCommandModuleKey(commandName) {
  const mapping = {
    'verification': 'verification',
    'governance': 'governance',
    'proposal': 'governance',
    'treasury': 'treasury',
    'ticketing': 'ticketing',
    'minigames': 'minigames',
    'battle': 'minigames',
    'aiassistant': 'aiassistant'
  };
  return mapping[commandName.toLowerCase()] || null;
}

function getCommandCooldownSeconds(interaction) {
  const commandName = String(interaction.commandName || '').toLowerCase();
  const group = ''; 
  let subcommand = '';
  try { subcommand = interaction.options?.getSubcommand?.(false) || ''; } catch (_) {}

  const commandConfig = COMMAND_COOLDOWN_SECONDS[commandName];
  if (!commandConfig) return COMMAND_COOLDOWN_SECONDS.default;
  if (typeof commandConfig === 'number') return commandConfig;

  if (group) {
    const groupConfig = commandConfig[group];
    if (subcommand && typeof groupConfig[subcommand] === 'number') {
      return groupConfig[subcommand];
    }
  }
  if (subcommand && typeof commandConfig[subcommand] === 'number') {
    return commandConfig[subcommand];
  }
  return COMMAND_COOLDOWN_SECONDS.default;
}

async function enforceCommandCooldown(interaction) {
  const cooldownSeconds = Number(getCommandCooldownSeconds(interaction) || 0);
  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds <= 0) {
    return true;
  }

  const userId = String(interaction?.user?.id || '').trim();
  if (!userId) {
    return true;
  }

  const commandName = String(interaction.commandName || '').trim().toLowerCase();
  let subcommand = '';
  let subcommandGroup = '';
  try {
    subcommandGroup = String(interaction.options?.getSubcommandGroup?.(false) || '').trim().toLowerCase();
  } catch (_error) {
    subcommandGroup = '';
  }
  try {
    subcommand = String(interaction.options?.getSubcommand?.(false) || '').trim().toLowerCase();
  } catch (_error) {
    subcommand = '';
  }

  const scopeKey = `${interaction.guildId || 'dm'}:${commandName}:${subcommandGroup}:${subcommand}`;
  const cacheKey = `${userId}:${scopeKey}`;
  const now = Date.now();
  const expiresAt = commandCooldownCache.get(cacheKey) || 0;
  if (expiresAt > now) {
    const remainingMs = Math.max(0, expiresAt - now);
    const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    const cooldownMessage = {
      content: `⏳ Slow down a bit. You can use this command again in ${remainingSeconds}s.`,
      ephemeral: true
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(cooldownMessage);
    } else {
      await interaction.reply(cooldownMessage);
    }
    return false;
  }

  commandCooldownCache.set(cacheKey, now + (cooldownSeconds * 1000));
  if (commandCooldownCache.size > 20000) {
    for (const [key, expiry] of commandCooldownCache.entries()) {
      if (expiry <= now) {
        commandCooldownCache.delete(key);
      }
    }
  }

  return true;
}

function getLegacyMinigameAliasNotice(interaction) {
  const commandName = String(interaction?.commandName || '').trim().toLowerCase();
  if (!LEGACY_MINIGAME_ALIASES.has(commandName)) return null;

  let subcommand = null;
  try {
    subcommand = interaction.options?.getSubcommand?.(false) || null;
  } catch (_error) {
    subcommand = null;
  }

  const parts = [`Use \`/minigames run game:${commandName}\``];
  if (subcommand && subcommand !== 'admin') {
    parts.push(`with \`action:${subcommand}\``);
  }
  parts.push('for the canonical module command path. Legacy aliases remain supported for now.');
  return parts.join(' ');
}

async function maybeSendLegacyMinigameAliasNotice(interaction) {
  const notice = getLegacyMinigameAliasNotice(interaction);
  if (!notice) return;

  const userId = String(interaction?.user?.id || '').trim();
  if (!userId) return;
  const commandName = String(interaction?.commandName || '').trim().toLowerCase();
  const cacheKey = `${userId}:${commandName}`;
  const now = Date.now();
  const lastSentAt = legacyAliasNoticeCache.get(cacheKey) || 0;
  if (now - lastSentAt < LEGACY_ALIAS_NOTICE_TTL_MS) return;

  legacyAliasNoticeCache.set(cacheKey, now);

  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: `Heads up: ${notice}`, ephemeral: true });
    }
  } catch (_error) {
    // Non-fatal: alias hints should never break command execution.
  }
}

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
    logger.warn('HELIUS_API_KEY not set - live NFT verification data will be unavailable');
  }
  if (!process.env.SOLANA_RPC_URL) {
    logger.warn('SOLANA_RPC_URL not set — Solana RPC calls may fail or use default endpoint');
  }

  // Enforce strong session secret (minimum 32 characters)
  if (process.env.SESSION_SECRET.length < 32) {
    logger.error('CRITICAL: SESSION_SECRET must be at least 32 characters long.');
    process.exit(1);
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
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
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

// Imports requiring client ref
const WebServer = require('./web/server');
const webServer = new WebServer();
webServer.start();

const proposalService = require('./services/proposalService');
const walletService = require('./services/walletService');
const roleService = require('./services/roleService');
const treasuryService = require('./services/treasuryService');
const microVerifyService = require('./services/microVerifyService');
const databaseBackupService = require('./services/databaseBackupService');
const governanceLogger = require('./utils/governanceLogger');
const ticketService = require('./services/ticketService');
const nftActivityService = require('./services/nftActivityService');
const inviteTrackerService = require('./services/inviteTrackerService');

const intervals = [];

client.once(Events.ClientReady, () => {
  logger.log(`✅ Bot is online as ${client.user.tag}`);
  logger.log(`📊 Loaded ${client.commands.size} commands`);
  logger.log(`🏛️ Serving ${client.guilds.cache.size} guild(s)`);
  
  // Bot activity status
  const currentGuildIdForActivity = process.env.GUILD_ID;
  let activityName = 'Serving your community';
  if (currentGuildIdForActivity) {
    try {
      const tenantCtx = tenantService.ensureTenant(currentGuildIdForActivity);
      activityName = tenantCtx?.branding?.bot_display_name || tenantCtx?.branding?.display_name || activityName;
    } catch (_) { /* fallback */ }
  }
  client.user.setActivity(activityName, { type: 0 });

  clientProvider.setClient(client);
  inviteTrackerService.setClient(client);
  proposalService.setClient(client);
  webServer.setClient(client);
  governanceLogger.setClient(client);
  ticketService.setClient(client);

  const currentGuildId = process.env.GUILD_ID;
  if (currentGuildId) {
    const currentGuild = client.guilds.cache.get(currentGuildId);
    try {
      tenantService.ensureTenant(currentGuildId, currentGuild?.name || null);
    } catch (error) {
      logger.error('Error ensuring startup tenant:', error);
    }
  }

  if (tenantService.isMultitenantEnabled() && currentGuildId) {
    tenantService.syncGuildCommands(client.commands, currentGuildId, client.guilds.cache.get(currentGuildId)?.name || null)
      .catch(error => logger.error('Error syncing startup guild commands:', error));
  }

  microVerifyService.init();

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

  startVoteCheckInterval();
  startRoleResyncScheduler();
  startTicketInactivityScheduler();
  startXEngagementScheduler();

  treasuryService.setClient(client);
  treasuryService.startScheduler();

  intervals.push(setInterval(() => {
    const moduleGuard = require('./utils/moduleGuard');
    if (moduleGuard.isModuleEnabled('verification')) {
      microVerifyService.expireStaleRequests();
    }
  }, 10 * 60 * 1000));

  const pollAllCollections = () => {
    nftActivityService.pollCollectionActivity().catch(err => {
      logger.error('[nft-poll] Error in scheduled poll:', err);
    });
  };
  intervals.push(setInterval(pollAllCollections, 5 * 60 * 1000));
  setTimeout(pollAllCollections, 30 * 1000);

  const trackedWalletsService = require('./services/trackedWalletsService');
  setTimeout(() => {
    trackedWalletsService.syncAllEnabledWalletAddressesToHeliusWebhook()
      .then(result => {
        if (result?.success && !result?.skipped) {
          logger.log(`[tracked-token-webhook] startup wallet webhook sync complete (+${result.added || 0}, total ${result.total || 0})`);
        }
      })
      .catch(err => logger.error('[tracked-token-webhook] startup wallet webhook sync failed:', err));
  }, 20 * 1000);

  const refreshAllHoldingsPanels = () => {
    trackedWalletsService.refreshAllPanels().catch(err => {
      logger.error('[wallet-panel] Error in scheduled refresh:', err);
    });
  };
  intervals.push(setInterval(refreshAllHoldingsPanels, 30 * 60 * 1000));
  setTimeout(refreshAllHoldingsPanels, 2 * 60 * 1000);

  setTimeout(() => {
    inviteTrackerService.primeAllGuilds()
      .then(() => logger.log('[invite-tracker] Invite cache primed for connected guilds'))
      .catch(err => logger.error('[invite-tracker] Failed to prime invite cache:', err));
  }, 15 * 1000);

  const pollTrackedTokenActivity = () => {
    trackedWalletsService.pollTrackedTokenActivity().catch(err => {
      logger.error('[tracked-token] Error in scheduled poll:', err);
    });
  };
  const tokenPollIntervalMs = Math.max(30, Number(process.env.TRACKED_TOKEN_POLL_INTERVAL_SEC || 120)) * 1000;
  intervals.push(setInterval(pollTrackedTokenActivity, tokenPollIntervalMs));
  setTimeout(pollTrackedTokenActivity, 45 * 1000);

  const sweepWebhookRetryQueue = () => {
    trackedWalletsService.processWebhookRetryQueue()
      .catch(err => logger.error('[tracked-token-webhook] Error in durable retry sweep:', err));
  };
  const retrySweepIntervalMs = Math.max(10, Number(process.env.TRACKED_TOKEN_DURABLE_RETRY_SWEEP_SEC || 30)) * 1000;
  intervals.push(setInterval(sweepWebhookRetryQueue, retrySweepIntervalMs));
  setTimeout(sweepWebhookRetryQueue, 20 * 1000);

  databaseBackupService.start();

  const runAiSummaries = () => {
    aiSummaryService.runDailySummaries(client).catch(err => logger.error('[ai-summary] daily summaries failed:', err));
    aiSummaryService.runDailyActivityRecaps(client).catch(err => logger.error('[ai-summary] daily recaps failed:', err));
  };
  intervals.push(setInterval(runAiSummaries, 24 * 60 * 60 * 1000));
  setTimeout(runAiSummaries, 60 * 60 * 1000);
  setTimeout(() => {
    inviteTrackerService.startAutoPanelRefresh();
    logger.log('[invite-tracker] Periodic panel refresh started');
  }, 30 * 1000);
});

client.on(Events.GuildCreate, async guild => {
  try {
    tenantService.ensureTenant(guild.id, guild.name);
    await inviteTrackerService.primeGuildInvites(guild);
    if (tenantService.isMultitenantEnabled()) {
      await tenantService.syncGuildCommands(client.commands, guild.id, guild.name);
    }
  } catch (error) {
    logger.error(`Error handling guildCreate for ${guild.id}:`, error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (!command || typeof command.autocomplete !== 'function') return;
    try { await command.autocomplete(interaction); } catch (e) {
      logger.error(`Autocomplete error: ${e.message}`);
      try { await interaction.respond([]); } catch (_) {}
    }
    return;
  }

  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    try {
      if (!(await enforceCommandCooldown(interaction))) return;
      const moduleKey = getCommandModuleKey(interaction.commandName);
      if (!(await moduleGate(interaction, moduleKey))) return;
      await command.execute(interaction);
      await maybeSendLegacyMinigameAliasNotice(interaction);
    } catch (error) {
      logger.error(`Command error ${interaction.commandName}:`, error);
      const msg = { content: 'There was an error while executing this command!', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
    return;
  }

  if (interaction.isButton()) {
    const customId = interaction.customId;
    if (customId === inviteTrackerService.REFRESH_BUTTON_ID || customId.startsWith(inviteTrackerService.SORT_BUTTON_PREFIX)) {
      await inviteTrackerService.handlePanelInteraction(interaction).catch(() => {});
      return;
    }
    if (customId === inviteTrackerService.CREATE_LINK_BUTTON_ID) {
      try {
        await interaction.deferReply({ ephemeral: true });
        const result = await inviteTrackerService.createUserInviteLink(interaction);
        await interaction.editReply({ content: result.success ? `Your invite link: ${result.inviteUrl}` : `Error: ${result.message}` });
      } catch (_) {}
      return;
    }
    if (customId === 'panel_verify') { await handlePanelVerifyButton(interaction); return; }
    if (customId === 'treasury_refresh_panel') { await handleTreasuryRefreshButton(interaction); return; }
    if (customId === 'governance_create_proposal') { await handleGovernanceCreateProposalButton(interaction); return; }
    if (customId.startsWith('support_')) { await handleSupportButton(interaction); return; }
    if (customId.startsWith('vote_yes_') || customId.startsWith('vote_no_') || customId.startsWith('vote_abstain_')) { await handleVoteButton(interaction); return; }
    if (customId.startsWith('veto_')) { await handleVetoButton(interaction); return; }
    if (customId === 'micro_verify_check_status') { await handleMicroVerifyCheckStatus(interaction); return; }
    if (customId === 'micro_verify_copy_amount') { await handleMicroVerifyCopyAmount(interaction); return; }
    if (customId.startsWith('role_claim_') || customId.startsWith('claim_role_')) { await handleRoleClaimButton(interaction); return; }
    if (customId.startsWith('ticket_open_')) { await handleTicketOpenButton(interaction); return; }
    if (customId === 'ticket_assign_me' || customId === 'ticket_claim') { await handleTicketClaimButton(interaction); return; }
    if (customId === 'ticket_close') { await handleTicketCloseButton(interaction); return; }
    if (customId === 'ticket_reopen') { await handleTicketReopenButton(interaction); return; }
    if (customId === 'ticket_delete') { await handleTicketDeleteButton(interaction); return; }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('ticket_modal_')) { await handleTicketModalSubmit(interaction); return; }
    if (interaction.customId === 'governance_create_proposal_modal') { await handleGovernanceCreateProposalModal(interaction); return; }
  }
});

client.on(Events.InviteCreate, invite => inviteTrackerService.handleInviteCreate(invite));
client.on(Events.InviteDelete, invite => inviteTrackerService.handleInviteDelete(invite));
client.on(Events.GuildMemberAdd, member => inviteTrackerService.trackMemberJoin(member));
client.on(Events.GuildMemberUpdate, (o, n) => inviteTrackerService.handleMemberRoleUpdate(o, n));

async function handlePanelVerifyButton(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const discordId = interaction.user.id;
    const username = interaction.user.username;
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';
    const panelGuildId = String(interaction.guildId || '').trim();
    const buildVerifyUrl = (action = '') => {
      const url = new URL('/verify', webUrl);
      if (panelGuildId) url.searchParams.set('guild', panelGuildId);
      if (action) url.searchParams.set('action', action);
      return url.toString();
    };

    const wallets = walletService.getLinkedWallets(discordId);
    if (!wallets || wallets.length === 0) {
      const embed = new EmbedBuilder().setTitle('Verification Portal').setDescription('No wallet linked yet.').setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Open Verify Portal').setStyle(ButtonStyle.Link).setURL(buildVerifyUrl()),
        new ButtonBuilder().setLabel('Add Wallet').setStyle(ButtonStyle.Link).setURL(buildVerifyUrl('add'))
      );
      return interaction.editReply({ embeds: [embed], components: [row] });
    }

    const shortenWallet = (value) => {
      const raw = String(value || '').trim();
      if (!raw) return 'Unknown';
      if (raw.length <= 10) return raw;
      return `${raw.slice(0, 5)}...${raw.slice(-5)}`;
    };

    const primaryWalletAddress = walletService.getFavoriteWallet(discordId)
      || wallets.find(w => w && (w.is_primary || w.isPrimary || w.is_favorite || w.isFavorite))?.wallet_address
      || wallets[0]?.wallet_address
      || null;

    const updateResult = await roleService.updateUserRoles(discordId, username, panelGuildId || null);
    if (!updateResult.success) {
      return interaction.editReply({ content: `Error: ${updateResult.message}` });
    }

    let syncResult = null;
    if (interaction.guild) {
      syncResult = await roleService.syncUserDiscordRoles(interaction.guild, discordId, panelGuildId || interaction.guild.id);
    }

    const totalTokens = Number(updateResult.totalTokens || 0);
    const syncAdded = Number(syncResult?.totalAdded || 0);
    const syncRemoved = Number(syncResult?.totalRemoved || 0);
    const syncDescription = syncResult?.success
      ? 'Holdings refreshed and Discord roles synchronized.'
      : 'Holdings refreshed, but role synchronization could not fully complete.';
    const effectiveGuildId = panelGuildId || interaction.guildId || '';
    const effectiveVotingPower = interaction.member
      ? Number(roleService.getUserVotingPower(discordId, interaction.member, effectiveGuildId) || 0)
      : Number(updateResult.votingPower || 0);

    const embed = new EmbedBuilder()
      .setColor(syncResult?.success === false ? '#F59E0B' : '#57F287')
      .setTitle('Holdings Verified')
      .setDescription(syncDescription)
      .addFields(
        { name: 'Linked Wallets', value: `${wallets.length}`, inline: true },
        { name: 'Primary Wallet', value: primaryWalletAddress ? `\`${shortenWallet(primaryWalletAddress)}\`` : 'Not set', inline: true },
        { name: 'NFTs', value: `${Number(updateResult.totalNFTs || 0)} (raw ${Number(updateResult.rawNFTs || 0)})`, inline: true },
        { name: 'Tracked Tokens', value: totalTokens.toLocaleString(undefined, { maximumFractionDigits: 6 }), inline: true },
        { name: 'Tier', value: String(updateResult.tier || 'None'), inline: true },
        { name: 'Voting Power', value: `${effectiveVotingPower}`, inline: true },
        { name: 'Role Sync', value: syncResult?.success ? `+${syncAdded} / -${syncRemoved}` : (syncResult?.message || 'Not available'), inline: false }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (e) {
    logger.error('Verify button error:', e);
  }
}

async function handleGovernanceCreateProposalButton(interaction) {
  try {
    const modal = new ModalBuilder()
      .setCustomId('governance_create_proposal_modal')
      .setTitle('Create Governance Proposal');

    const titleInput = new TextInputBuilder()
      .setCustomId('proposal_title')
      .setLabel('Title')
      .setPlaceholder('Short, clear proposal title')
      .setStyle(TextInputStyle.Short)
      .setMinLength(5)
      .setMaxLength(200)
      .setRequired(true);

    const goalInput = new TextInputBuilder()
      .setCustomId('proposal_goal')
      .setLabel('Goal')
      .setPlaceholder('What is the objective?')
      .setStyle(TextInputStyle.Short)
      .setMinLength(5)
      .setMaxLength(500)
      .setRequired(true);

    const categoryInput = new TextInputBuilder()
      .setCustomId('proposal_category')
      .setLabel('Category')
      .setPlaceholder('Partnership / Treasury Allocation / Rule Change / Community Event / Other')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(100)
      .setRequired(true);

    const costInput = new TextInputBuilder()
      .setCustomId('proposal_cost')
      .setLabel('Costs (SOL or USDC)')
      .setPlaceholder('Example: 50 SOL or 500 USDC')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(200)
      .setRequired(true);

    const descriptionInput = new TextInputBuilder()
      .setCustomId('proposal_description')
      .setLabel('Description')
      .setPlaceholder('Explain implementation, impact, and timeline')
      .setStyle(TextInputStyle.Paragraph)
      .setMinLength(20)
      .setMaxLength(4000)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(goalInput),
      new ActionRowBuilder().addComponents(categoryInput),
      new ActionRowBuilder().addComponents(costInput),
      new ActionRowBuilder().addComponents(descriptionInput)
    );

    await interaction.showModal(modal);
  } catch (error) {
    logger.error('Governance create button error:', error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: 'Unable to open proposal form right now.' });
      } else {
        await interaction.reply({ content: 'Unable to open proposal form right now.', ephemeral: true });
      }
    } catch (_) {}
  }
}

async function handleGovernanceCreateProposalModal(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    const title = String(interaction.fields.getTextInputValue('proposal_title') || '').trim();
    const goal = String(interaction.fields.getTextInputValue('proposal_goal') || '').trim();
    const description = String(interaction.fields.getTextInputValue('proposal_description') || '').trim();
    const categoryRaw = String(interaction.fields.getTextInputValue('proposal_category') || '').trim();
    const costIndication = String(interaction.fields.getTextInputValue('proposal_cost') || '').trim();

    const userInfo = await roleService.getUserInfo(discordId, interaction.guildId || '', interaction.member || null);
    const votingPower = Number(userInfo?.voting_power || 0);
    if (!userInfo || votingPower < 1) {
      return interaction.editReply({ content: 'You need at least 1 voting power to create proposals.' });
    }

    const settingsManager = require('./config/settings');
    const settings = settingsManager.getSettings ? settingsManager.getSettings() : {};
    const validCategories = Array.isArray(settings.proposalCategories) && settings.proposalCategories.length
      ? settings.proposalCategories
      : ['Partnership', 'Treasury Allocation', 'Rule Change', 'Community Event', 'Other'];
    const normalizedCategory = validCategories.find(
      (candidate) => String(candidate || '').toLowerCase() === categoryRaw.toLowerCase()
    ) || 'Other';

    const result = proposalService.createProposal(discordId, {
      title,
      goal,
      description,
      category: normalizedCategory,
      costIndication,
      guildId: interaction.guildId || '',
      initialStatus: 'supporting'
    });
    if (!result?.success) {
      return interaction.editReply({ content: result?.message || 'Failed to create proposal.' });
    }

    await proposalService.postToProposalsChannel(result.proposalId, {
      creatorDisplayName: interaction.user.username,
      targetChannelId: interaction.channelId || ''
    });

    await interaction.editReply({ content: `Proposal ${result.proposalId} created and submitted to supporting stage.` });
  } catch (error) {
    logger.error('Governance modal submit error:', error);
    try {
      await interaction.editReply({ content: 'Something went wrong while creating the proposal.' });
    } catch (_) {}
  }
}

async function handleSupportButton(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const proposalId = interaction.customId.replace('support_', '');
    const discordId = interaction.user.id;
    const interactionGuildId = String(interaction.guildId || '').trim();
    const proposal = proposalService.getProposal(proposalId);
    if (!proposal) {
      return interaction.editReply({ content: 'Proposal not found.' });
    }

    const proposalGuildId = String(proposal.guild_id || '').trim();
    if (proposalGuildId && interactionGuildId && proposalGuildId !== interactionGuildId) {
      return interaction.editReply({ content: 'This proposal belongs to a different server.' });
    }

    const wallets = walletService.getLinkedWallets(discordId);
    if (!wallets || wallets.length === 0) {
      return interaction.editReply({ content: 'Verify wallet first.' });
    }

    const userInfo = await roleService.getUserInfo(discordId, interactionGuildId, interaction.member || null);
    const votingPower = Number(userInfo?.voting_power || 0);
    if (!userInfo || votingPower < 1) {
      return interaction.editReply({ content: 'You need at least 1 voting power to support proposals.' });
    }

    const result = proposalService.addSupporter(proposalId, discordId);
    if (!result.success) {
      return interaction.editReply({ content: result.message || 'Failed to add support.' });
    }

    let promoted = false;
    const settingsManager = require('./config/settings');
    const settings = settingsManager.getSettings ? settingsManager.getSettings() : {};
    const supportThreshold = Number(settings.supportThreshold || 4);
    if (String(proposal.status || '').toLowerCase() === 'supporting' && Number(result.supporterCount || 0) >= supportThreshold) {
      const promoteResult = await proposalService.promoteToVoting(proposalId, discordId);
      if (promoteResult?.success) {
        promoted = true;
      }
    }

    if (!promoted) {
      const refreshedProposal = proposalService.getProposal(proposalId);
      promoted = String(refreshedProposal?.status || '').toLowerCase() === 'voting';
    }

    await interaction.editReply({
      content: promoted
        ? 'Support added. Proposal reached threshold and is now in voting.'
        : 'Support added.'
    });
  } catch (e) {
    logger.error('Support button error:', e);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: 'Something went wrong while adding support. Please try again.' });
      } else {
        await interaction.reply({ content: 'Something went wrong while adding support. Please try again.', ephemeral: true });
      }
    } catch (_ignored) {}
  }
}

async function handleVoteButton(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const parts = interaction.customId.split('_');
    const choice = parts[1];
    const proposalId = parts.slice(2).join('_');
    const discordId = interaction.user.id;
    const interactionGuildId = String(interaction.guildId || '').trim();
    const proposal = proposalService.getProposal(proposalId);
    if (!proposal) {
      return interaction.editReply({ content: 'Proposal not found.' });
    }

    const proposalGuildId = String(proposal.guild_id || '').trim();
    if (proposalGuildId && interactionGuildId && proposalGuildId !== interactionGuildId) {
      return interaction.editReply({ content: 'This proposal belongs to a different server.' });
    }

    const userInfo = await roleService.getUserInfo(discordId, interaction.guildId || '', interaction.member || null);
    const votingPower = Number(userInfo?.voting_power || 0);
    if (!userInfo || votingPower < 1) return interaction.editReply({ content: 'No voting power.' });

    const result = proposalService.castVote(proposalId, discordId, choice, votingPower);
    if (!result.success) return interaction.editReply({ content: result.message || 'Failed to cast vote.' });

    await proposalService.updateVotingMessage(proposalId);
    await interaction.editReply({ content: `Vote recorded: ${choice}` });
  } catch (e) {
    logger.error('Vote button error:', e);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: 'Something went wrong while casting your vote. Please try again.' });
      } else {
        await interaction.reply({ content: 'Something went wrong while casting your vote. Please try again.', ephemeral: true });
      }
    } catch (_ignored) {}
  }
}

function normalizeRoleName(value) {
  return String(value || '').trim().toLowerCase();
}

async function getCouncilMemberIdsForGuild(guild) {
  if (!guild) return [];
  const settingsManager = require('./config/settings');
  const settings = settingsManager.getSettings ? settingsManager.getSettings() : {};
  const trusteeRoleNames = Array.isArray(settings.staffTrusteeRoles)
    ? settings.staffTrusteeRoles.map(normalizeRoleName).filter(Boolean)
    : [];

  let membersCollection = guild.members?.cache;
  try {
    membersCollection = await guild.members.fetch();
  } catch (_error) {
    // fall back to cache
  }

  const council = new Set();
  for (const member of membersCollection.values()) {
    if (
      member.permissions?.has?.(PermissionFlagsBits.Administrator)
      || member.permissions?.has?.(PermissionFlagsBits.ManageGuild)
    ) {
      council.add(member.id);
      continue;
    }
    if (
      trusteeRoleNames.length
      && member.roles?.cache?.some((role) => trusteeRoleNames.includes(normalizeRoleName(role?.name)))
    ) {
      council.add(member.id);
    }
  }
  return [...council];
}

async function handleVetoButton(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const proposalId = interaction.customId.replace(/^veto_/, '').trim();
    const proposal = proposalService.getProposal(proposalId);
    if (!proposal) {
      return interaction.editReply({ content: 'Proposal not found.' });
    }
    if (String(proposal.status || '').toLowerCase() !== 'passed') {
      return interaction.editReply({ content: 'Council veto is only available for passed proposals.' });
    }

    const proposalGuildId = String(proposal.guild_id || '').trim();
    const interactionGuildId = String(interaction.guildId || '').trim();
    if (proposalGuildId && interactionGuildId && proposalGuildId !== interactionGuildId) {
      return interaction.editReply({ content: 'This proposal belongs to a different server.' });
    }

    const councilMemberIds = await getCouncilMemberIdsForGuild(interaction.guild);
    if (!councilMemberIds.includes(interaction.user.id)) {
      return interaction.editReply({ content: 'Only council members can cast veto votes.' });
    }

    const vetoResult = proposalService.vetoProposal(proposalId, interaction.user.id, 'Discord council veto');
    if (!vetoResult?.success) {
      return interaction.editReply({ content: vetoResult?.message || 'Failed to cast veto vote.' });
    }

    const vetoSet = new Set((vetoResult.vetoVoterIds || []).map((id) => String(id)));
    const remaining = councilMemberIds.filter((id) => !vetoSet.has(String(id)));

    if (councilMemberIds.length > 0 && remaining.length === 0) {
      const applyResult = proposalService.applyVeto(proposalId, 'Unanimous council veto');
      if (applyResult?.success) {
        return interaction.editReply({ content: '🛑 Unanimous council veto reached. Proposal status set to vetoed.' });
      }
      return interaction.editReply({ content: 'All council votes collected, but applying veto failed.' });
    }

    return interaction.editReply({
      content: `Veto vote recorded (${vetoResult.vetoCount}/${councilMemberIds.length}). ${remaining.length} council vote(s) remaining.`
    });
  } catch (error) {
    logger.error('Veto button error:', error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: 'Something went wrong while casting veto.' });
      } else {
        await interaction.reply({ content: 'Something went wrong while casting veto.', ephemeral: true });
      }
    } catch (_ignored) {}
  }
}

async function handleMicroVerifyCheckStatus(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const res = microVerifyService.getPendingRequest(interaction.user.id);
    await interaction.editReply({ content: res.success ? '⏳ Verification pending transfer...' : '❌ No pending request.' });
  } catch (_) {}
}

async function handleMicroVerifyCopyAmount(interaction) {
  try {
    const res = microVerifyService.getPendingRequest(interaction.user.id);
    await interaction.reply({ content: res.success ? `💰 Amount: \`${res.request.expected_amount}\`` : '❌ No request.', ephemeral: true });
  } catch (_) {}
}

async function handleRoleClaimButton(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const roleId = interaction.customId.replace(/^(claim_role_|role_claim_)/, '').split('__').pop();
    const roleClaimService = require('./services/roleClaimService');
    const result = await roleClaimService.toggleRole(interaction.guild, interaction.member, roleId);
    await interaction.editReply({ content: result.message });
  } catch (_) {}
}

async function handleTreasuryRefreshButton(interaction) {
  try {
    await interaction.deferUpdate();
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) return;
    await treasuryService.fetchBalances();
    const panel = buildTreasuryPanelFromService();
    await interaction.editReply({ embeds: [panel.embed], components: [panel.components] });
  } catch (_) {}
}

function buildTreasuryPanelFromService() {
  const summary = treasuryService.getSummary();
  const embed = new EmbedBuilder().setTitle('💰 Treasury Watch').setTimestamp();
  if (summary.success) {
    embed.addFields(
      { name: '🪙 SOL', value: `${summary.treasury.sol}`, inline: true },
      { name: '💵 USDC', value: `${summary.treasury.usdc}`, inline: true }
    );
  } else { embed.setDescription('⚠️ Unavailable'); }
  const components = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('treasury_refresh_panel').setLabel('Refresh').setStyle(ButtonStyle.Primary).setEmoji('🔄'));
  return { embed, components };
}

function startVoteCheckInterval() {
  intervals.push(setInterval(async () => {
    try {
      const db = require('./database/db');
      const activeVotes = db.prepare('SELECT * FROM proposals WHERE status = ?').all('voting');
      for (const p of activeVotes) proposalService.checkAutoClose(p.proposal_id);
      await proposalService.expireUnsupportedProposals();
    } catch (_) {}
  }, 5 * 60 * 1000));
}

function startRoleResyncScheduler() {
  intervals.push(setInterval(async () => {
    try {
      const guilds = client.guilds.cache;
      for (const [id, guild] of guilds) {
        const users = await roleService.getAllVerifiedUsers(guild);
        for (const u of users) {
          await roleService.updateUserRoles(u.discord_id, u.username, id);
          await roleService.syncUserDiscordRoles(guild, u.discord_id, id);
        }
      }
    } catch (_) {}
  }, 4 * 60 * 60 * 1000));
}

function startTicketInactivityScheduler() {
  intervals.push(setInterval(async () => {
    try {
      const moduleGuard = require('./utils/moduleGuard');
      if (moduleGuard.isModuleEnabled('ticketing')) {
        const settingsManager = require('./config/settings');
        const settings = settingsManager.getSettings ? settingsManager.getSettings() : {};
        if (settings.ticketAutoCloseEnabled === false) return;

        const configuredInactiveHours = Number(settings.ticketAutoCloseInactiveHours);
        const configuredWarningHours = Number(settings.ticketAutoCloseWarningHours);
        const inactiveHours = Number.isFinite(configuredInactiveHours) && configuredInactiveHours > 0
          ? configuredInactiveHours
          : 168;
        const warningHours = Number.isFinite(configuredWarningHours) && configuredWarningHours >= 0
          ? configuredWarningHours
          : 24;

        await ticketService.runInactivitySweep({ inactiveHours, warningHours, maxPerRun: 20 });
      }
    } catch (_) {}
  }, 15 * 60 * 1000));
}

function startXEngagementScheduler() {
  const tick = async () => {
    try {
      const eng = require('./services/engagementService');
      const result = await eng.runXProviderSync({ maxResults: 10 });
      if (result?.success && !result?.skipped && (result.createdTasks > 0 || result.scannedPosts > 0)) {
        logger.log(`[engagement:x] synced guilds=${result.guilds} scannedPosts=${result.scannedPosts} createdTasks=${result.createdTasks}`);
      }
    } catch (error) {
      logger.warn(`[engagement:x] scheduler error: ${error.message}`);
    }
  };

  const settingsManager = require('./config/settings');
  const settings = settingsManager.getSettings ? settingsManager.getSettings() : {};
  const intervalSec = Math.max(60, Number(settings.xPollingIntervalSeconds || process.env.X_POLLING_INTERVAL_SECONDS || 300));
  intervals.push(setInterval(tick, intervalSec * 1000));
  setTimeout(tick, 45 * 1000);
}

async function handleTicketOpenButton(interaction) {
  try {
    const cid = interaction.customId.replace('ticket_open_', '');
    const cat = ticketService.getCategory(cid, interaction.guildId);
    if (!cat) return interaction.reply({ content: '❌ Category not found.', ephemeral: true });
    const modal = ticketService.buildTemplateModal(cat);
    await interaction.showModal(modal);
  } catch (_) {}
}

async function handleTicketModalSubmit(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const cid = interaction.customId.replace('ticket_modal_', '');
    const cat = ticketService.getCategory(cid, interaction.guildId);
    if (!cat) {
      await interaction.editReply({ content: '❌ Category not found.' });
      return;
    }
    const templateResponses = ticketService.extractTemplateResponses(cat, interaction);
    const res = await ticketService.createTicket(interaction, cid, templateResponses, interaction.guildId);
    await interaction.editReply({ content: res.success ? `✅ Ticket #${res.ticketNumber} created!` : `❌ Error: ${res.message}` });
  } catch (_) {}
}

async function handleTicketClaimButton(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const res = await ticketService.claimTicket(interaction, interaction.channelId);
    await interaction.editReply({ content: res.success ? '✅ Claimed.' : `❌ ${res.message}` });
  } catch (_) {}
}

async function handleTicketCloseButton(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const res = await ticketService.closeTicket(interaction, interaction.channelId);
    await interaction.editReply({ content: res.success ? '🔒 Closed.' : `❌ ${res.message}` });
  } catch (_) {}
}

async function handleTicketReopenButton(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const res = await ticketService.reopenTicket(interaction, interaction.channelId);
    await interaction.editReply({ content: res.success ? '🔓 Reopened.' : `❌ ${res.message}` });
  } catch (_) {}
}

async function handleTicketDeleteButton(interaction) {
  try {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply({ content: '🗑️ Deleting in 3s...' });
    setTimeout(() => ticketService.deleteTicket(interaction.channelId).catch(() => {}), 3000);
  } catch (_) {}
}

function splitDiscordText(text, maxLength = 1900) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return ['No response'];
  if (normalized.length <= maxLength) return [normalized];
  const chunks = [];
  let rest = normalized;
  while (rest.length > maxLength) {
    let cutAt = rest.lastIndexOf('\n', maxLength);
    if (cutAt < Math.floor(maxLength * 0.55)) {
      cutAt = rest.lastIndexOf(' ', maxLength);
    }
    if (cutAt < 1) cutAt = maxLength;
    chunks.push(rest.slice(0, cutAt).trim());
    rest = rest.slice(cutAt).trimStart();
  }
  if (rest.length) chunks.push(rest);
  return chunks.filter(Boolean);
}

function extractMentionPrompt(message, botUserId) {
  const content = String(message?.content || '');
  if (!message?.mentions?.users?.has(botUserId)) {
    return { isMention: false, prompt: '' };
  }
  const prompt = content.replace(new RegExp(`<@!?${botUserId}>`, 'g'), '').trim();
  return {
    isMention: true,
    prompt: prompt || 'Give me a short update for this server.',
  };
}

function extractPassiveAiPrompt(message, botUserId) {
  const content = String(message?.content || '').trim();
  if (!content || content.startsWith('/')) return { shouldHandle: false, prompt: '' };
  if (message?.mentions?.users?.has(botUserId)) return { shouldHandle: false, prompt: '' };

  const lower = content.toLowerCase();
  const hasKeyword = Array.from(AI_PASSIVE_KEYWORDS).some(keyword => lower.includes(keyword));
  const looksQuestion = content.includes('?') || lower.startsWith('guildpilot');
  if (!hasKeyword && !looksQuestion) return { shouldHandle: false, prompt: '' };

  return { shouldHandle: true, prompt: content };
}

function evaluatePassiveAiChannelBudget(guildId, channelId, policy) {
  const key = `${guildId}:${channelId}`;
  const now = Date.now();
  const cooldownMs = Math.max(5, Number(policy?.passiveCooldownSeconds || 120)) * 1000;
  const maxPerHour = Math.max(1, Number(policy?.passiveMaxPerHour || 6));
  const state = aiAssistantPassiveChannelState.get(key) || {
    windowStartAt: now,
    sentInWindow: 0,
    lastSentAt: 0,
  };

  if (now - state.windowStartAt >= 60 * 60 * 1000) {
    state.windowStartAt = now;
    state.sentInWindow = 0;
  }
  if (state.lastSentAt && (now - state.lastSentAt) < cooldownMs) {
    return { allowed: false, key, state };
  }
  if (state.sentInWindow >= maxPerHour) {
    return { allowed: false, key, state };
  }
  return { allowed: true, key, state };
}

function markPassiveAiSent(key, state) {
  const now = Date.now();
  const next = state || { windowStartAt: now, sentInWindow: 0, lastSentAt: 0 };
  if (now - next.windowStartAt >= 60 * 60 * 1000) {
    next.windowStartAt = now;
    next.sentInWindow = 0;
  }
  next.lastSentAt = now;
  next.sentInWindow += 1;
  aiAssistantPassiveChannelState.set(key, next);
}

async function handleAiAssistantMentionMessage(message) {
  const gid = message.guildId;
  const bid = client.user.id;
  const parsed = extractMentionPrompt(message, bid);
  if (!parsed.isMention) return false;
  if (!tenantService.isModuleEnabled(gid, 'aiassistant')) return true;
  const settingsResult = aiAssistantService.getTenantSettings(gid);
  if (!settingsResult.success || !settingsResult.settings.enabled || !settingsResult.settings.mentionEnabled) return true;
  if (!aiAssistantService.isMemberRoleAllowed(settingsResult.settings, message.member)) return true;

  const policyResult = aiAssistantService.getChannelPolicy(gid, message.channelId);
  const channelPolicy = policyResult.success ? policyResult.policy : null;
  if (channelPolicy && channelPolicy.mode === 'off') return true;

  const cooldownSeconds = Math.max(0, Number(settingsResult.settings.cooldownSeconds || 0));
  if (cooldownSeconds > 0) {
    const cooldownKey = `${gid}:${message.author.id}`;
    const now = Date.now();
    const nextAllowedAt = Number(aiAssistantMentionCooldownCache.get(cooldownKey) || 0);
    if (now < nextAllowedAt) return true;
    aiAssistantMentionCooldownCache.set(cooldownKey, now + (cooldownSeconds * 1000));
  }

  await message.channel.sendTyping().catch(() => {});
  const res = await aiAssistantService.ask({
    guildId: gid, userId: message.author.id, channelId: message.channelId, prompt: parsed.prompt,
    requesterTag: message.author.tag, triggerSource: 'mention',
    requiredConfidence: channelPolicy?.minConfidence ?? null,
    memberRoleNames: message.member?.roles?.cache?.map(r => r.name) || [],
    memberRoleIds: message.member?.roles?.cache?.map(r => r.id) || [],
  });
  if (res.success) {
    const chunks = splitDiscordText(res.text);
    for (const c of chunks) await message.reply({ content: c, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
  }
  return true;
}

async function handleAiAssistantPassiveMessage(message) {
  const gid = message.guildId;
  const bid = client.user.id;
  const passive = extractPassiveAiPrompt(message, bid);
  if (!passive.shouldHandle) return;
  if (!tenantService.isModuleEnabled(gid, 'aiassistant')) return;
  const settingsResult = aiAssistantService.getTenantSettings(gid);
  if (!settingsResult.success || !settingsResult.settings.enabled) return;
  if (!aiAssistantService.isMemberRoleAllowed(settingsResult.settings, message.member)) return;

  const policyResult = aiAssistantService.getChannelPolicy(gid, message.channelId);
  if (!policyResult.success) return;
  const channelPolicy = policyResult.policy;
  if (!channelPolicy || channelPolicy.mode !== 'passive') return;

  const budget = evaluatePassiveAiChannelBudget(gid, message.channelId, channelPolicy);
  if (!budget.allowed) return;

  await message.channel.sendTyping().catch(() => {});
  const res = await aiAssistantService.ask({
    guildId: gid, userId: message.author.id, channelId: message.channelId, prompt: passive.prompt,
    requesterTag: message.author.tag, triggerSource: 'passive',
    requiredConfidence: channelPolicy.minConfidence,
    memberRoleNames: message.member?.roles?.cache?.map(r => r.name) || [],
    memberRoleIds: message.member?.roles?.cache?.map(r => r.id) || [],
  });
  if (res.success) {
    markPassiveAiSent(budget.key, budget.state);
    const chunks = splitDiscordText(res.text);
    for (const c of chunks) await message.reply({ content: c, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
  }
}

client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.guild) return;
  try { ticketService.markTicketActivity(message.channelId); } catch (_) {}
  try {
    const eng = require('./services/engagementService');
    eng.tryAwardMessage(
      message.guildId,
      message.author.id,
      message.author.username,
      message.id,
      message.channelId,
      { isReply: !!message.reference?.messageId }
    );
  } catch (_) {}
  try {
    const handled = await handleAiAssistantMentionMessage(message);
    if (!handled) await handleAiAssistantPassiveMessage(message);
  } catch (e) { logger.warn(`AI message handler error: ${e.message}`); }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) try { await reaction.fetch(); } catch (_) { return; }
  if (reaction.message.guild) {
    try {
      const eng = require('./services/engagementService');
      eng.tryAwardReaction(reaction.message.guildId, user.id, user.username, `react:${reaction.message.id}`, reaction.message.channelId);
    } catch (_) {}
  }
  const battleService = require('./services/battleService');
  const lobby = battleService.getLobbyByMessage(reaction.message.id);
  if (lobby && lobby.status === 'open' && reaction.emoji.name === '⚔️') {
    const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
    const roles = member?.roles.cache.map(r => r.id) || [];
    const res = battleService.addParticipant(lobby.lobby_id, user.id, user.username, roles);
    if (res.success) await reaction.message.edit({ embeds: [battleService.buildLobbyEmbed(lobby, reaction.message.guildId)] });
    else {
      await reaction.users.remove(user.id).catch(() => {});
      if (res.message) try { await user.send(`❌ ${res.message}`); } catch (_) {}
    }
  }
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) try { await reaction.fetch(); } catch (_) { return; }
  const battleService = require('./services/battleService');
  const lobby = battleService.getLobbyByMessage(reaction.message.id);
  if (lobby && lobby.status === 'open' && reaction.emoji.name === '⚔️') {
    const res = battleService.removeParticipant(lobby.lobby_id, user.id);
    if (res.success) await reaction.message.edit({ embeds: [battleService.buildLobbyEmbed(lobby, reaction.message.guildId)] });
  }
});

client.on(Events.Error, e => logger.error(`Client error: ${e.message}`));
process.on('unhandledRejection', e => logger.error(`Unhandled rejection: ${e.message}`));
process.on('uncaughtException', e => { logger.error(`Uncaught exception: ${e.message}`); process.exit(1); });

function gracefulShutdown(s) {
  logger.log(`Shutdown (${s})...`);
  intervals.forEach(clearInterval);
  databaseBackupService.stop();
  webServer.stop();
  client.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

client.login(process.env.DISCORD_TOKEN);
