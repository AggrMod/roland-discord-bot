const db = require('../database/db');
const logger = require('../utils/logger');
const aiAssistantService = require('./aiAssistantService');
const { EmbedBuilder } = require('discord.js');

class AiSummaryService {
  /**
   * Main entry point for the daily background job.
   * Logic: Find all guilds with summaries enabled and trigger their reports.
   */
  async runDailySummaries(client) {
    if (!client) {
      logger.warn('[ai-summary] No Discord client provided to runDailySummaries');
      return;
    }

    try {
      const guildsWithSummary = db.prepare(`
        SELECT guild_id FROM ai_assistant_tenant_settings 
        WHERE summary_enabled = 1 AND summary_channel_id IS NOT NULL
      `).all();

      logger.log(`[ai-summary] Found ${guildsWithSummary.length} guilds to summarize.`);

      for (const row of guildsWithSummary) {
        await this.generateGuildSummaryReport(client, row.guild_id);
      }
    } catch (error) {
      logger.error('[ai-summary] Error running daily summaries pulse:', error);
    }
  }

  /**
   * Generates and posts a report for a specific guild.
   */
  async generateGuildSummaryReport(client, guildId) {
    try {
      const settingsResult = aiAssistantService.getTenantSettings(guildId);
      if (!settingsResult.success || !settingsResult.settings.summaryEnabled || !settingsResult.settings.summaryChannelId) {
        return;
      }

      const channelId = settingsResult.settings.summaryChannelId;
      const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
      if (!channel) {
        logger.warn(`[ai-summary] Could not find summary channel ${channelId} for guild ${guildId}`);
        return;
      }

      // Fetch missed/low-confidence interactions from the last 24 hours
      const interactions = db.prepare(`
        SELECT prompt_text, status, error_code, trigger_source, created_at
        FROM ai_assistant_usage_events
        WHERE guild_id = ?
          AND (status != 'ok' OR error_code = 'knowledge_low_confidence' OR error_code = 'knowledge_no_match')
          AND prompt_text IS NOT NULL
          AND created_at >= datetime('now', '-1 day')
        ORDER BY created_at ASC
        LIMIT 100
      `).all(guildId);

      if (!interactions.length) {
        // Option: post "No missed interactions today" or just stay silent.
        // We stay silent to avoid noise unless there's something to report.
        return;
      }

      // De-duplicate and clean prompts
      const uniquePrompts = [...new Set(interactions.map(i => i.prompt_text.trim()))].slice(0, 50);

      // Construct LLM prompt for summarization
      const summaryPrompt = [
        "You are an AI Analyst for a community Discord bot. I will provide a list of questions that users asked but the bot was unable to answer with high confidence.",
        "Your task is to summarize these into the top 3-4 key themes or topics that are currently 'missing' from the Knowledge Base.",
        "Be concise. Focus on clear actionable items for the staff to add to the documentation.",
        "",
        "Recent Missed Questions:",
        ...uniquePrompts.map(p => `- ${p}`),
        "",
        "Format your response as a professional report for staff."
      ].join('\n');

      // Call LLM
      const summaryResult = await aiAssistantService.ask({
        guildId,
        userId: 'system-agent',
        channelId: null,
        prompt: summaryPrompt,
        triggerSource: 'summary_job',
        providerOverride: settingsResult.settings.provider || 'gemini',
        skipKnowledge: true,
        skipChannelCheck: true,
        skipRoleCheck: true,
      });

      if (!summaryResult.success) {
        logger.error(`[ai-summary] Failed to generate summary text for ${guildId}:`, summaryResult.message);
        return;
      }

      // Post report
      const embed = new EmbedBuilder()
        .setTitle('📊 Daily AI Interaction Summary')
        .setDescription(summaryResult.text || 'No summary text generated.')
        .setFields([
          { name: 'Missed Interactions', value: String(interactions.length), inline: true },
          { name: 'Unique Topics', value: String(uniquePrompts.length), inline: true },
          { name: 'Period', value: 'Last 24 Hours', inline: true },
        ])
        .setColor('#FFD700')
        .setTimestamp()
        .setFooter({ text: 'Guild Pilot AI Monitoring' });

      await channel.send({ embeds: [embed] }).catch(err => {
        logger.error(`[ai-summary] Failed to send summary to channel ${channelId}:`, err);
      });

      logger.log(`[ai-summary] Successfully posted daily report for guild ${guildId}`);
    } catch (error) {
      logger.error(`[ai-summary] Error generating guild report for ${guildId}:`, error);
    }
  }
  async runDailyActivityRecaps(client) {
    if (!client) return;

    try {
      const guildsWithSummary = db.prepare(`
        SELECT guild_id FROM ai_assistant_tenant_settings 
        WHERE summary_enabled = 1 AND summary_channel_id IS NOT NULL
      `).all();

      for (const row of guildsWithSummary) {
        await this.generateFamilyReport(client, row.guild_id);
      }
    } catch (error) {
      logger.error('[ai-summary] Error running daily family reports:', error);
    }
  }

  /**
   * Generates a narrative "Family Report" for a guild.
   */
  async generateFamilyReport(client, guildId) {
    try {
      const settingsResult = aiAssistantService.getTenantSettings(guildId);
      if (!settingsResult.success || !settingsResult.settings.summaryEnabled || !settingsResult.settings.summaryChannelId) {
        return;
      }

      const channelId = settingsResult.settings.summaryChannelId;
      const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
      if (!channel) return;

      // 1. Gather Proposals
      const proposals = db.prepare(`
        SELECT title, status, category FROM proposals
        WHERE guild_id = ? 
          AND (created_at >= datetime('now', '-1 day') 
               OR start_time >= datetime('now', '-1 day')
               OR end_time >= datetime('now', '-1 day'))
      `).all(guildId);

      // 2. Gather Completed Missions
      const missions = db.prepare(`
        SELECT title, ai_recap FROM missions
        WHERE guild_id = ?
          AND status = 'completed'
          AND updated_at >= datetime('now', '-1 day')
      `).all(guildId);

      // 3. Gather Recent Battles
      const battles = db.prepare(`
        SELECT lobby_id, era, status, started_at
        FROM battle_lobbies
        WHERE guild_id = ?
          AND status = 'completed'
          AND completed_at >= datetime('now', '-1 day')
      `).all(guildId);

      // 4. Gather Activity Shoutouts (Most active members in last 24h)
      // We prioritize messages in the specifically "monitored" channels if configured.
      const monitoredChannels = settingsResult.settings.summaryActivityChannels || [];
      const hasMonitored = monitoredChannels.length > 0;
      
      let topActiveMembers = [];
      try {
        const activityQuery = `
          SELECT username, COUNT(*) as count
          FROM points_ledger
          WHERE guild_id = ?
            AND action_type IN ('discord_message', 'discord_reaction')
            AND created_at >= datetime('now', '-1 day')
            ${hasMonitored ? `AND channel_id IN (${monitoredChannels.map(() => '?').join(',')})` : ''}
          GROUP BY user_id
          ORDER BY count DESC
          LIMIT 5
        `;
        
        const params = [guildId, ...monitoredChannels];
        topActiveMembers = db.prepare(activityQuery).all(...params);
      } catch (err) {
        logger.error(`[ai-summary] Error gathering top active members for ${guildId}:`, err);
      }

      const activityData = {
        proposals: proposals.map(p => ({ title: p.title, status: p.status, category: p.category })),
        missions: missions.map(m => ({ title: m.title, recap: m.ai_recap })),
        battles: battles.map(b => ({ id: b.lobby_id, era: b.era })),
        honors: topActiveMembers.map(m => ({ username: m.username, contributions: m.count })),
      };

      const reportText = await aiAssistantService.generateDailyFamilyRecap(guildId, activityData);

      if (reportText) {
        const embed = new EmbedBuilder()
          .setTitle('🕵️ Daily Family Report')
          .setDescription(reportText)
          .setColor('#2F3136')
          .setTimestamp()
          .setFooter({ text: 'The Family remembers everything.' });

        await channel.send({ embeds: [embed] }).catch(err => logger.error('[ai-summary] failed to send family report:', err));
      }
    } catch (e) {
      logger.error(`[ai-summary] Error generating family report for ${guildId}:`, e);
    }
  }
}

module.exports = new AiSummaryService();
