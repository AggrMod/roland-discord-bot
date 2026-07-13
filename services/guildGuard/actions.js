const db = require('../../database/db');

function recordAction({ event, incident, actionType, status, metadata = {} }) {
  if (!incident?.incident_id) return null;
  db.prepare(`
    INSERT INTO actions (guild_id, incident_id, action_type, status, metadata_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(event.guildId, incident.incident_id, actionType, status, JSON.stringify(metadata));
  return db.prepare('SELECT * FROM actions WHERE guild_id = ? AND incident_id = ? ORDER BY id DESC LIMIT 1')
    .get(event.guildId, incident.incident_id);
}

async function alertStaff({ source, event, decision, config, incident, signals }) {
  const channelId = String(config?.alertChannelId || '').trim();
  const threshold = Number(config?.risk?.alert || 25);
  if (!channelId || Number(decision?.score || 0) < threshold || !incident) return null;
  const guild = source?.guild || source?.member?.guild;
  let channel = guild?.channels?.cache?.get(channelId) || null;
  if (!channel && typeof guild?.channels?.fetch === 'function') {
    try { channel = await guild.channels.fetch(channelId); } catch (_) { channel = null; }
  }
  if (!channel?.send) return recordAction({ event, incident, actionType: 'alert', status: 'skipped', metadata: { reason: 'alert_channel_unavailable', channelId } });
  const detectorNames = [...new Set((signals || []).map(signal => String(signal.detector || '').trim()).filter(Boolean))];
  const messageUrl = event.channelId && event.eventId && /^\d{15,25}$/.test(String(event.eventId))
    ? `https://discord.com/channels/${event.guildId}/${event.channelId}/${event.eventId}`
    : null;
  const content = [
    `🛡️ Guild Guard alert: ${event.eventType || 'event'} scored ${decision.score}/100.`,
    `Detectors: ${detectorNames.join(', ') || 'risk signal'}.`,
    event.userId ? `User: <@${event.userId}>` : null,
    messageUrl ? `Message: ${messageUrl}` : null,
    `Incident: ${incident.incident_id}`
  ].filter(Boolean).join('\n');
  try {
    await channel.send({ content, allowedMentions: { parse: [] } });
    return recordAction({ event, incident, actionType: 'alert', status: 'applied', metadata: { channelId, detectors: detectorNames } });
  } catch (error) {
    return recordAction({ event, incident, actionType: 'alert', status: 'failed', metadata: { channelId, error: String(error?.message || error) } });
  }
}

async function execute({ source, event, decision, config, incident, signals }) {
  const actions = config?.actions || {};
  if (!incident) return null;
  await alertStaff({ source, event, decision, config, incident, signals });
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

module.exports = { execute, recordAction };
