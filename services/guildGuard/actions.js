const db = require('../../database/db');
const identityRegistry = require('./identityRegistry');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

function recordAction({ event, incident, actionType, status, metadata = {} }) {
  if (!incident?.incident_id) return null;
  db.prepare(`
    INSERT INTO actions (guild_id, incident_id, action_type, status, metadata_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(event.guildId, incident.incident_id, actionType, status, JSON.stringify(metadata));
  return db.prepare('SELECT * FROM actions WHERE guild_id = ? AND incident_id = ? ORDER BY id DESC LIMIT 1')
    .get(event.guildId, incident.incident_id);
}

function claimAction({ event, incident, actionType, metadata = {} }) {
  if (!incident?.incident_id) return null;
  const result = db.prepare(`
    INSERT INTO actions (guild_id, incident_id, action_type, status, metadata_json)
    SELECT ?, ?, ?, 'pending', ?
    WHERE NOT EXISTS (
      SELECT 1 FROM actions
      WHERE guild_id = ? AND incident_id = ? AND action_type = ? AND status IN ('pending', 'applied')
    )
  `).run(event.guildId, incident.incident_id, actionType, JSON.stringify(metadata), event.guildId, incident.incident_id, actionType);
  if (!result.changes) return null;
  return db.prepare('SELECT * FROM actions WHERE id = ?').get(result.lastInsertRowid);
}

function finalizeAction(actionId, status, metadata) {
  db.prepare('UPDATE actions SET status = ?, metadata_json = ? WHERE id = ?')
    .run(status, JSON.stringify(metadata || {}), actionId);
  return db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId);
}

async function executeQuickAction({ guild, incident, action, actorId }) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  const allowed = new Set(['timeout', 'kick', 'ban', 'unmute', 'delete']);
  if (!guild?.id || !incident?.incident_id || !allowed.has(normalizedAction)) throw new Error('Unsupported Guild Guard quick action');
  const event = { guildId: guild.id };
  const metadata = { actorId: actorId || null, action: normalizedAction, userId: incident.user_id || null };
  const evidence = (() => {
    try { return incident.evidence_json ? JSON.parse(incident.evidence_json) : {}; } catch (_) { return {}; }
  })();
  try {
    if (normalizedAction === 'delete') {
      const channel = evidence.channelId && await guild.channels.fetch(evidence.channelId);
      const message = channel?.messages?.fetch && await channel.messages.fetch(incident.event_id);
      if (!message?.delete) throw new Error('Original message is unavailable');
      await message.delete();
    } else {
      if (!incident.user_id) throw new Error('Incident has no target user');
      if (normalizedAction === 'ban') {
        await guild.members.ban(incident.user_id, { reason: 'Guild Guard moderator action' });
      } else {
        const member = await guild.members.fetch(incident.user_id);
        if (!member) throw new Error('Target member is unavailable');
        if (normalizedAction === 'timeout') await member.timeout(3600000, 'Guild Guard moderator action');
        if (normalizedAction === 'unmute') await member.timeout(null, 'Guild Guard moderator action');
        if (normalizedAction === 'kick') await member.kick('Guild Guard moderator action');
      }
    }
    return recordAction({ event, incident, actionType: `quick:${normalizedAction}`, status: 'applied', metadata });
  } catch (error) {
    metadata.error = String(error?.message || error);
    return recordAction({ event, incident, actionType: `quick:${normalizedAction}`, status: 'failed', metadata });
  }
}

async function alertStaff({ source, event, decision, config, incident, signals, thresholdOverride = null, pingStaff = false }) {
  const channelId = String(config?.alertChannelId || '').trim();
  const threshold = thresholdOverride === null ? Number(config?.risk?.alert || 25) : Number(thresholdOverride);
  if (!channelId || Number(decision?.score || 0) < threshold || !incident) return null;
  const claim = claimAction({ event, incident, actionType: 'alert', metadata: { channelId, pending: true } });
  if (!claim) return db.prepare("SELECT * FROM actions WHERE guild_id = ? AND incident_id = ? AND action_type = 'alert' ORDER BY id DESC LIMIT 1")
    .get(event.guildId, incident.incident_id);
  const guild = source?.guild || source?.member?.guild;
  let channel = guild?.channels?.cache?.get(channelId) || null;
  if (!channel && typeof guild?.channels?.fetch === 'function') {
    try { channel = await guild.channels.fetch(channelId); } catch (_) { channel = null; }
  }
  if (!channel?.send) return finalizeAction(claim.id, 'skipped', { reason: 'alert_channel_unavailable', channelId });
  const detectorNames = [...new Set((signals || []).map(signal => String(signal.detector || '').trim()).filter(Boolean))];
  const staffIds = pingStaff
    ? [...new Set(identityRegistry.list(event.guildId).map(identity => String(identity.user_id || '').trim()).filter(userId => userId && userId !== event.userId))]
    : [];
  const staffMentions = staffIds.map(userId => `<@${userId}>`).join(' ');
  const messageUrl = event.channelId && event.eventId && /^\d{15,25}$/.test(String(event.eventId))
    ? `https://discord.com/channels/${event.guildId}/${event.channelId}/${event.eventId}`
    : null;
  const embed = new EmbedBuilder()
    .setColor(Number(decision.score || 0) >= 80 ? 0xED4245 : 0xFEE75C)
    .setTitle('Guild Guard alert')
    .setDescription(`${event.eventType || 'event'} detected with a risk score of **${decision.score}/100**.`)
    .addFields(
      { name: 'Detectors', value: detectorNames.join(', ') || 'Risk signal', inline: true },
      { name: 'User', value: event.userId ? `<@${event.userId}>` : 'Unknown', inline: true },
      { name: 'Incident', value: `\`${incident.incident_id}\``, inline: false }
    )
    .setFooter({ text: 'Guild Guard | moderator review' })
    .setTimestamp();
  if (messageUrl) embed.addFields({ name: 'Message', value: `[Open message](${messageUrl})`, inline: false });
  if (staffMentions) embed.addFields({ name: 'Moderator notification', value: staffMentions, inline: false });
  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`guildguard_action:timeout:${incident.incident_id}`).setLabel('Mute 1h').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`guildguard_action:kick:${incident.incident_id}`).setLabel('Kick').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`guildguard_action:ban:${incident.incident_id}`).setLabel('Ban').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`guildguard_action:unmute:${incident.incident_id}`).setLabel('Unmute').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`guildguard_action:delete:${incident.incident_id}`).setLabel('Delete message').setStyle(ButtonStyle.Secondary)
  )];
  const content = [
    `🛡️ Guild Guard alert: ${event.eventType || 'event'} scored ${decision.score}/100.`,
    `Detectors: ${detectorNames.join(', ') || 'risk signal'}.`,
    event.userId ? `User: <@${event.userId}>` : null,
    staffMentions ? `Moderator notification: ${staffMentions}` : null,
    messageUrl ? `Message: ${messageUrl}` : null,
    `Incident: ${incident.incident_id}`
  ].filter(Boolean).join('\n');
  try {
    await channel.send({ content, embeds: [embed], components, allowedMentions: staffIds.length ? { users: staffIds } : { parse: [] } });
    return finalizeAction(claim.id, 'applied', { channelId, detectors: detectorNames, pingedStaffIds: staffIds });
  } catch (error) {
    return finalizeAction(claim.id, 'failed', { channelId, error: String(error?.message || error) });
  }
}

async function execute({ source, event, decision, config, incident, signals }) {
  const actions = config?.actions || {};
  if (!incident) return null;
  const rules = Array.isArray(config?.rules) ? config.rules : [];
  const signalDetectors = new Set((signals || []).map(signal => String(signal.detector || '').trim()));
  const matchedRule = rules.find(rule => rule?.enabled !== false
    && Number(decision?.score || 0) > Number(rule.threshold ?? 50)
    && (Array.isArray(rule.detectors) ? rule.detectors : []).some(detector => signalDetectors.has(detector)));
  const ruleActions = matchedRule?.actions || {};
  if (!matchedRule || ruleActions.notifyStaff !== false) {
    await alertStaff({
      source,
      event,
      decision,
      config,
      incident,
      signals,
      thresholdOverride: matchedRule ? Number(matchedRule.threshold ?? 50) : null,
      pingStaff: Boolean(matchedRule && ruleActions.pingStaff === true)
    });
  }
  if (matchedRule) {
    if (config?.mode !== 'enforce' || actions.enabled !== true) {
      return recordAction({ event, incident, actionType: `rule:${matchedRule.id}`, status: 'skipped', metadata: { reason: 'enforcement_disabled', threshold: Number(matchedRule.threshold ?? 50) } });
    }
    const member = source?.member || source;
    const metadata = { ruleId: matchedRule.id, threshold: Number(matchedRule.threshold ?? 50), timeoutSeconds: Number(ruleActions.timeoutSeconds || 3600), timeoutApplied: false, messageDeleted: false };
    if (ruleActions.timeoutUsers === true && typeof member?.timeout === 'function') {
      try {
        await member.timeout(Math.max(1, Math.min(2419200, metadata.timeoutSeconds)) * 1000, `Guild Guard rule: ${matchedRule.name}`);
        metadata.timeoutApplied = true;
      } catch (error) {
        metadata.timeoutError = String(error?.message || error);
      }
    }
    if (ruleActions.deleteMessages === true && typeof source?.delete === 'function') {
      try {
        await source.delete();
        metadata.messageDeleted = true;
      } catch (error) {
        metadata.deleteError = String(error?.message || error);
      }
    }
    const applied = metadata.timeoutApplied || metadata.messageDeleted;
    return recordAction({ event, incident, actionType: `rule:${matchedRule.id}`, status: applied ? 'applied' : 'skipped', metadata });
  }
  if (decision?.action === 'monitor') return null;
  if (config?.mode !== 'enforce' || actions.enabled !== true) {
    return recordAction({ event, incident, actionType: decision.action, status: 'skipped', metadata: { reason: 'enforcement_disabled' } });
  }

  const action = decision.action;
  if (action === 'warn' && actions.warnUsers === true) {
    if (source?.channel?.send) {
      await source.channel.send({
        content: `⚠️ <@${event.userId}> your message was flagged for moderator review.`,
        allowedMentions: { users: event.userId ? [event.userId] : [] }
      }).catch(() => {});
      return recordAction({ event, incident, actionType: action, status: 'applied' });
    }
  }

  if (action === 'timeout' && actions.timeoutUsers === true) {
    const member = source?.member || source;
    if (typeof member?.timeout === 'function') {
      const timeoutSeconds = Math.max(1, Math.min(2419200, Number(actions.timeoutSeconds) || 60));
      await member.timeout(timeoutSeconds * 1000, 'Guild Guard risk policy').catch(() => {});
      return recordAction({ event, incident, actionType: action, status: 'applied', metadata: { timeoutSeconds } });
    }
  }

  if (event.eventType === 'member_join' && actions.lockdownEnabled === true && source?.guild?.setVerificationLevel) {
    const raid = (incident.signals_json ? JSON.parse(incident.signals_json) : []).some(signal => signal.detector === 'raid_burst');
    if (raid) {
      await source.guild.setVerificationLevel(actions.lockdownVerificationLevel || 'high').catch(() => {});
      return recordAction({ event, incident, actionType: 'lockdown', status: 'applied', metadata: { verificationLevel: actions.lockdownVerificationLevel || 'high' } });
    }
  }

  if ((action === 'timeout' || action === 'quarantine') && actions.deleteMessages === true && source?.delete) {
    await source.delete().catch(() => {});
    return recordAction({ event, incident, actionType: 'delete', status: 'applied', metadata: { policyAction: action } });
  }

  return recordAction({ event, incident, actionType: action, status: 'skipped', metadata: { reason: 'unsupported_or_missing_permission' } });
}

module.exports = { execute, recordAction, executeQuickAction };
