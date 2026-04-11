const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const moduleGuard = require('../../utils/moduleGuard');
const aiAssistantService = require('../../services/aiAssistantService');
const { applyEmbedBranding } = require('../../services/embedBranding');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('aiassistant')
    .setDescription('AI Assistant module (Pro)')
    .addSubcommand(sub =>
      sub
        .setName('ask')
        .setDescription('Ask the AI assistant a question')
        .addStringOption(option =>
          option
            .setName('prompt')
            .setDescription('What you want to ask')
            .setRequired(true))
        .addStringOption(option =>
          option
            .setName('provider')
            .setDescription('Force provider for this request')
            .setRequired(false)
            .addChoices(
              { name: 'OpenAI', value: 'openai' },
              { name: 'Gemini', value: 'gemini' },
            )))
    .addSubcommand(sub =>
      sub
        .setName('status')
        .setDescription('Show AI assistant module status for this server')),

  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This command can only be used inside a server.', ephemeral: true });
      return;
    }

    if (!await moduleGuard.checkModuleEnabled(interaction, 'aiassistant')) return;
    if (!await moduleGuard.checkMinimumPlan(interaction, 'pro')) return;

    const sub = interaction.options.getSubcommand();
    if (sub === 'status') return this.handleStatus(interaction);
    if (sub === 'ask') return this.handleAsk(interaction);

    await interaction.reply({ content: 'Unknown AI assistant command.', ephemeral: true });
  },

  async handleStatus(interaction) {
    const result = aiAssistantService.getTenantSettings(interaction.guildId);
    if (!result.success) {
      await interaction.reply({ content: `Could not load AI assistant settings: ${result.message || 'unknown error'}`, ephemeral: true });
      return;
    }

    const allowance = aiAssistantService.getDailyRemaining(interaction.guildId);
    const embed = new EmbedBuilder()
      .setTitle('AI Assistant Status')
      .addFields(
        { name: 'Enabled', value: result.settings.enabled ? 'Yes' : 'No', inline: true },
        { name: 'Provider', value: result.settings.provider, inline: true },
        { name: 'Visibility', value: result.settings.responseVisibility, inline: true },
        { name: 'OpenAI Key', value: result.global.hasOpenaiKey ? 'Configured' : 'Missing', inline: true },
        { name: 'Gemini Key', value: result.global.hasGeminiKey ? 'Configured' : 'Missing', inline: true },
        { name: 'Daily Limit', value: allowance.limit === null ? 'Unlimited' : `${allowance.used}/${allowance.limit}`, inline: true },
      )
      .setTimestamp();
    applyEmbedBranding(embed, {
      guildId: interaction.guildId,
      moduleKey: 'aiassistant',
      defaultColor: '#4F46E5',
      defaultFooter: 'Powered by Guild Pilot',
      fallbackLogoUrl: interaction.client?.user?.displayAvatarURL?.() || null,
    });
    await interaction.reply({ embeds: [embed], ephemeral: true });
  },

  async handleAsk(interaction) {
    const prompt = interaction.options.getString('prompt', true).trim();
    const providerOverride = interaction.options.getString('provider') || '';
    const settingsResult = aiAssistantService.getTenantSettings(interaction.guildId);
    const useEphemeral = settingsResult.success && settingsResult.settings.responseVisibility === 'ephemeral';

    await interaction.deferReply({ ephemeral: useEphemeral });

    const result = await aiAssistantService.ask({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      channelId: interaction.channelId,
      prompt,
      providerOverride,
      requesterTag: interaction.user.tag,
    });

    if (!result.success) {
      await interaction.editReply({
        content: `AI assistant could not answer: ${result.message || result.code || 'unknown error'}`,
      });
      return;
    }

    const answer = String(result.text || '').trim() || 'No response';
    const embed = new EmbedBuilder()
      .setTitle('AI Assistant')
      .setDescription(answer.slice(0, 4000))
      .addFields(
        { name: 'Provider', value: `${result.provider} (${result.model})`, inline: true },
        {
          name: 'Daily Remaining',
          value: result.allowance?.remaining === null || result.allowance?.remaining === undefined
            ? 'Unlimited'
            : String(result.allowance.remaining),
          inline: true
        },
      )
      .setTimestamp();
    applyEmbedBranding(embed, {
      guildId: interaction.guildId,
      moduleKey: 'aiassistant',
      defaultColor: '#4F46E5',
      defaultFooter: 'Powered by Guild Pilot',
      fallbackLogoUrl: interaction.client?.user?.displayAvatarURL?.() || null,
    });

    await interaction.editReply({ embeds: [embed] });
  },
};
