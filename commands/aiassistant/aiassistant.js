const { SlashCommandBuilder } = require('discord.js');
const moduleGuard = require('../../utils/moduleGuard');
const aiAssistantService = require('../../services/aiAssistantService');

function splitDiscordMessage(text, maxLength = 1900) {
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
        .setDescription('Show AI assistant module status for this server'))
    .addSubcommand(sub =>
      sub
        .setName('briefing')
        .setDescription('Request an instant briefing from the Family Consigliere')),

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
    if (sub === 'briefing') return this.handleBriefing(interaction);

    await interaction.reply({ content: 'Unknown AI assistant command.', ephemeral: true });
  },

  async handleBriefing(interaction) {
    const settingsResult = aiAssistantService.getTenantSettings(interaction.guildId);
    const useEphemeral = settingsResult.success && settingsResult.settings.responseVisibility === 'ephemeral';

    await interaction.deferReply({ ephemeral: useEphemeral });

    const briefingResult = await aiAssistantService.generateInstantBriefing(interaction.guildId, {
      userId: interaction.user.id,
      channelId: interaction.channelId,
      requesterTag: interaction.user.tag,
      memberRoleNames: interaction.member?.roles?.cache?.map(r => r.name) || [],
      memberRoleIds: interaction.member?.roles?.cache?.map(r => r.id) || [],
    });
    if (!briefingResult?.success || !String(briefingResult?.text || '').trim()) {
      const reason = String(briefingResult?.message || '').trim();
      await interaction.editReply({
        content: reason
          ? `The Consigliere is currently unavailable: ${reason}`
          : 'The Consigliere is currently unavailable. Try again later.',
      });
      return;
    }

    const reportText = String(briefingResult.text || '').trim();
    const chunks = splitDiscordMessage(reportText, 1900);
    await interaction.editReply({
      content: chunks[0],
      allowedMentions: { parse: [] },
    });
    for (let i = 1; i < chunks.length; i += 1) {
      await interaction.followUp({
        content: chunks[i],
        ephemeral: useEphemeral,
        allowedMentions: { parse: [] },
      });
    }
  },

  async handleStatus(interaction) {
    const result = aiAssistantService.getTenantSettings(interaction.guildId);
    if (!result.success) {
      await interaction.reply({ content: `Could not load AI assistant settings: ${result.message || 'unknown error'}`, ephemeral: true });
      return;
    }

    const allowance = aiAssistantService.getDailyRemaining(interaction.guildId);
    const knowledgeResult = aiAssistantService.listKnowledgeDocs(interaction.guildId);
    const knowledgeCount = knowledgeResult.success ? (knowledgeResult.docs || []).filter(doc => doc.enabled).length : 0;
    const lines = [
      '**AI Assistant Status**',
      `Enabled: ${result.settings.enabled ? 'Yes' : 'No'}`,
      `Mention Trigger: ${result.settings.mentionEnabled ? 'On' : 'Off'}`,
      `Provider: ${result.settings.provider}`,
      `Knowledge Sources (Enabled): ${knowledgeCount}`,
      `Slash Visibility: ${result.settings.responseVisibility}`,
      `Per-User Daily Limit: ${result.settings.perUserDailyLimit > 0 ? result.settings.perUserDailyLimit : 'Unlimited'}`,
      `Safety Filter: ${result.settings.safetyFilterEnabled ? 'On' : 'Off'}`,
      `Moderation: ${result.settings.moderationEnabled ? 'On' : 'Off'}`,
      `OpenAI Key: ${result.global.hasOpenaiKey ? 'Configured' : 'Missing'}`,
      `Gemini Key: ${result.global.hasGeminiKey ? 'Configured' : 'Missing'}`,
      `Daily Limit: ${allowance.limit === null ? 'Unlimited' : `${allowance.used}/${allowance.limit}`}`,
    ];
    await interaction.reply({ content: lines.join('\n'), ephemeral: true, allowedMentions: { parse: [] } });
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
      triggerSource: 'slash',
      memberRoleNames: interaction.member?.roles?.cache?.map(r => r.name) || [],
      memberRoleIds: interaction.member?.roles?.cache?.map(r => r.id) || [],
    });

    if (!result.success) {
      await interaction.editReply({
        content: `AI assistant could not answer: ${result.message || result.code || 'unknown error'}`,
      });
      return;
    }

    const answer = String(result.text || '').trim() || 'No response';
    const chunks = splitDiscordMessage(answer, 1900);
    await interaction.editReply({
      content: chunks[0],
      allowedMentions: { parse: [] },
    });
    for (let i = 1; i < chunks.length; i += 1) {
      await interaction.followUp({
        content: chunks[i],
        ephemeral: useEphemeral,
        allowedMentions: { parse: [] },
      });
    }
  },
};
