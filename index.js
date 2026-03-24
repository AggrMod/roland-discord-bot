require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check if the bot is alive'),
  new SlashCommandBuilder()
    .setName('solpranos')
    .setDescription('About the Solpranos ecosystem'),
].map(cmd => cmd.toJSON());

// Register commands on ready
client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} is online!`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
});

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply('🏛️ The family is awake.');
  }

  if (interaction.commandName === 'solpranos') {
    await interaction.reply({
      embeds: [{
        title: '🏛️ The Solpranos',
        description: 'Welcome to the Solpranos ecosystem. Governance and the heist await.',
        color: 0xFFD700,
      }],
    });
  }
});

client.login(process.env.DISCORD_TOKEN);
