require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');
const tenantService = require('./services/tenantService');

const commands = [];

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
          commands.push(command);
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

if (!process.env.DISCORD_TOKEN) {
  logger.error('❌ DISCORD_TOKEN is not set in .env file');
  process.exit(1);
}

if (!process.env.CLIENT_ID) {
  logger.error('❌ CLIENT_ID is not set in .env file');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    logger.log(`📤 Started refreshing ${commands.length} application (/) commands.`);

    let data;

    if (process.env.MULTITENANT_ENABLED === 'true') {
      if (!process.env.GUILD_ID) {
        throw new Error('GUILD_ID is required when MULTITENANT_ENABLED=true');
      }

      logger.log(`🏛️ Syncing tenant-scoped guild commands for: ${process.env.GUILD_ID}`);
      data = await tenantService.syncGuildCommands(commands, process.env.GUILD_ID);
    } else {
      if (process.env.GUILD_ID) {
        logger.log(`🏛️ Deploying to guild: ${process.env.GUILD_ID}`);
        data = await rest.put(
          Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
          { body: commands.map(command => command.data.toJSON()) },
        );
      } else {
        logger.log('🌍 Deploying globally (this may take up to 1 hour to propagate)');
        data = await rest.put(
          Routes.applicationCommands(process.env.CLIENT_ID),
          { body: commands.map(command => command.data.toJSON()) },
        );
      }
    }

    if (Array.isArray(data)) {
      logger.log(`✅ Successfully reloaded ${data.length} application (/) commands.`);

      logger.log('\n📋 Registered commands:');
      data.forEach(cmd => {
        logger.log(`  • /${cmd.name}: ${cmd.description}`);
      });
    } else {
      logger.log('✅ Tenant command sync complete.');
    }

  } catch (error) {
    logger.error('❌ Error deploying commands:', error);
    process.exit(1);
  }
})();
