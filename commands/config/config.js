const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const moduleGuard = require('../../utils/moduleGuard');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('System configuration (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('modules')
        .setDescription('View all module toggle states'))
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('toggle')
        .setDescription('Toggle a module on/off')
        .addStringOption(option =>
          option
            .setName('module')
            .setDescription('Module to toggle')
            .setRequired(true)
            .addChoices(
              { name: 'Verification', value: 'verification' },
              { name: 'Governance', value: 'governance' },
              { name: 'Treasury', value: 'treasury' },
              { name: 'Invite Tracker', value: 'invites' },
              { name: 'AI Assistant', value: 'aiassistant' },
              { name: 'Minigames', value: 'minigames' },
              { name: 'Battle', value: 'battle' },
              { name: 'Heist', value: 'heist' }
            ))
        .addBooleanOption(option =>
          option
            .setName('enabled')
            .setDescription('Enable (true) or disable (false)')
            .setRequired(true)))
    
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('System status overview')),

  async execute(interaction) {
    // Admin check
    if (!await moduleGuard.checkAdmin(interaction)) {
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    try {
      switch (subcommand) {
        case 'modules':
          await this.handleModules(interaction);
          break;
        case 'toggle':
          await this.handleToggle(interaction);
          break;
        case 'status':
          await this.handleStatus(interaction);
          break;
      }
    } catch (error) {
      logger.error('[config] Command error:', error);
      const userMsg = 'An error occurred. Please try again or contact an admin.';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: userMsg });
      } else {
        await interaction.reply({ content: userMsg, ephemeral: true });
      }
    }
  },

  async handleModules(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const toggles = moduleGuard.getAllToggles();

    const moduleList = Object.entries(toggles).map(([key, value]) => {
      const moduleName = key.replace('Enabled', '');
      const displayName = moduleName.charAt(0).toUpperCase() + moduleName.slice(1);
      const status = value ? '✅ Enabled' : '❌ Disabled';
      const icon = getModuleIcon(moduleName);
      return `${icon} **${displayName}**: ${status}`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('⚙️ Module Toggle States')
      .setDescription('Current status of all bot modules')
      .addFields(
        { name: 'Modules', value: moduleList, inline: false }
      )
      .setFooter({ text: 'Use /config toggle to change module states' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed module toggles`);
  },

  async handleToggle(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const moduleKey = interaction.options.getString('module');
    const enabled = interaction.options.getBoolean('enabled');

    const success = moduleGuard.setModuleEnabled(moduleKey, enabled);

    if (success) {
      const displayName = moduleKey.charAt(0).toUpperCase() + moduleKey.slice(1);
      const status = enabled ? '✅ Enabled' : '❌ Disabled';
      const icon = getModuleIcon(moduleKey);

      const embed = new EmbedBuilder()
        .setColor(enabled ? '#00FF00' : '#FF0000')
        .setTitle('⚙️ Module Toggle Updated')
        .setDescription(`${icon} **${displayName}** has been ${enabled ? 'enabled' : 'disabled'}.`)
        .addFields(
          { name: 'Module', value: displayName, inline: true },
          { name: 'Status', value: status, inline: true }
        )
        .setFooter({ text: 'Changes take effect immediately' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      logger.log(`Admin ${interaction.user.tag} toggled module ${moduleKey} to ${enabled}`);
    } else {
      await interaction.editReply({ 
        content: `❌ Failed to toggle module: ${moduleKey}`, 
        ephemeral: true 
      });
    }
  },

  async handleStatus(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const toggles = moduleGuard.getAllToggles();
    const enabledCount = Object.values(toggles).filter(v => v === true).length;
    const totalCount = Object.keys(toggles).length;

    const uptime = process.uptime();
    const uptimeStr = formatUptime(uptime);

    const memUsage = process.memoryUsage();
    const memUsageMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('📊 System Status')
      .setDescription('GuildPilot system overview')
      .addFields(
        { name: '🟢 Uptime', value: uptimeStr, inline: true },
        { name: '💾 Memory', value: `${memUsageMB} MB`, inline: true },
        { name: '📦 Modules Active', value: `${enabledCount}/${totalCount}`, inline: true },
        { name: '🤖 Bot User', value: interaction.client.user.tag, inline: true },
        { name: '🏛️ Guilds', value: `${interaction.client.guilds.cache.size}`, inline: true },
        { name: '📊 Commands', value: `${interaction.client.commands.size}`, inline: true }
      )
      .setFooter({ text: 'The Commission is watching' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.log(`Admin ${interaction.user.tag} viewed system status`);
  }
};

function getModuleIcon(module) {
  const icons = {
    verification: '[V]',
    governance: '[G]',
    treasury: '[$]',
    invites: '[INV]',
    aiassistant: '[AI]',
    minigames: '[MG]',
    battle: '[B]',
    heist: '[H]'
  };
  return icons[module] || '[M]';
}
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ');
}
