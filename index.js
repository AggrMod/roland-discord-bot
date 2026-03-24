require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Events, Partials } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');
const WebServer = require('./web/server');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [
    Partials.Message,
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

client.once(Events.ClientReady, () => {
  logger.log(`✅ Bot is online as ${client.user.tag}`);
  logger.log(`📊 Loaded ${client.commands.size} commands`);
  logger.log(`🏛️ Serving ${client.guilds.cache.size} guild(s)`);
  
  client.user.setActivity('The Commission', { type: 0 });
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

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
});

// Handle reactions for proposal support
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    // Ignore bot reactions
    if (user.bot) return;

    // Fetch partial messages
    if (reaction.partial) {
      await reaction.fetch();
    }
    if (reaction.message.partial) {
      await reaction.message.fetch();
    }

    // Only handle ✅ reactions
    if (reaction.emoji.name !== '✅') return;

    // Check if this is in the proposals channel
    const proposalsChannelId = process.env.PROPOSALS_CHANNEL_ID;
    if (!proposalsChannelId || reaction.message.channel.id !== proposalsChannelId) return;

    const db = require('./database/db');
    const walletService = require('./services/walletService');
    const proposalService = require('./services/proposalService');

    // Find proposal by message ID
    const proposal = db.prepare('SELECT * FROM proposals WHERE message_id = ?').get(reaction.message.id);
    
    if (!proposal) {
      logger.warn(`Reaction on non-proposal message: ${reaction.message.id}`);
      return;
    }

    if (proposal.status !== 'draft') {
      logger.log(`User ${user.id} reacted to non-draft proposal ${proposal.proposal_id}`);
      return;
    }

    // Check if user has verified wallet
    const wallets = walletService.getLinkedWallets(user.id);
    if (!wallets || wallets.length === 0) {
      logger.log(`User ${user.id} tried to support without verified wallet`);
      return;
    }

    // Add supporter
    const result = proposalService.addSupporter(proposal.proposal_id, user.id);
    
    if (result.success) {
      logger.log(`User ${user.id} supported proposal ${proposal.proposal_id} via reaction (${result.supporterCount}/4)`);
      
      // Update the embed
      const { EmbedBuilder } = require('discord.js');
      const proposalData = proposalService.getProposal(proposal.proposal_id);
      const supporterCount = proposalService.getSupporterCount(proposal.proposal_id);
      
      let status = proposalData.status === 'draft' ? `Draft (${supporterCount}/4 supporters)` : 
                   proposalData.status === 'voting' ? 'Active Voting' : 
                   proposalData.status;
      
      const embed = new EmbedBuilder()
        .setColor(proposalData.status === 'voting' ? '#00FF00' : '#FFD700')
        .setTitle(`📜 ${proposalData.title}`)
        .setDescription(proposalData.description)
        .addFields(
          { name: '🆔 Proposal ID', value: proposalData.proposal_id, inline: true },
          { name: '📊 Status', value: status, inline: true },
          { name: '👥 Supporters', value: supporterCount.toString(), inline: true }
        )
        .setTimestamp();

      if (proposalData.status === 'voting') {
        embed.setFooter({ text: '✅ Promoted to voting! Use /vote to cast your vote.' });
      } else {
        embed.setFooter({ text: '✅ React with checkmark to support (4 needed)' });
      }

      await reaction.message.edit({ embeds: [embed] });
    }
  } catch (error) {
    logger.error('Error handling reaction:', error);
  }
});

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
