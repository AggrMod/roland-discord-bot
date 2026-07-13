const db = require('../../database/db');
const identityRegistry = require('./identityRegistry');

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
  const content = [
    `🛡️ Guild Guard alert: ${event.eventType || 'event'} scored ${decision.score}/100.`,
    `Detectors: ${detectorNames.join(', ') || 'risk signal'}.`,
    event.userId ? `User: <@${event.userId}>` : null,
    staffMentions ? `Moderator notification: ${staffMentions}` : null,
    messageUrl ? `Message: ${messageUrl}` : null,
    `Incident: ${incident.incident_id}`
  ].filter(Boolean).join('\n');
  try {
    await channel.send({ content, allowedMentions: staffIds.length ? { users: staffIds } : { parse: [] } });
    return finalizeAction(claim.id, 'applied', { channelId, detectors: detectorNames, pingedStaffIds: staffIds });
  } catch (error) {
    return finalizeAction(claim.id, 'failed', { channelId, error: String(error?.message || error) });
  }
}

async function execute({ source, event, decision, config, incident, signals }) {
  const actions = config?.actions || {};
  if (!incident) return null;
  const staffRule = config?.rules?.staffImpersonation || {};
  const staffImpersonationTriggered = staffRule.enabled === true
    && Number(decision?.score || 0) > Number(staffRule.threshold ?? 50)
    && (signals || []).some(signal => signal.detector === 'staff_impersonation');
  await alertStaff({
    source,
    event,
    decision,
    config,
    incident,
    signals,
    thresholdOverride: staffImpersonationTriggered ? Number(staffRule.threshold ?? 50) : null,
    pingStaff: staffImpersonationTriggered && staffRule.pingStaff !== false
  });
  if (staffImpersonationTriggered) {
    if (config?.mode !== 'enforce' || actions.enabled !== true) {
      return recordAction({ event, incident, actionType: 'staff_impersonation_escalation', status: 'skipped', metadata: { reason: 'enforcement_disabled', threshold: Number(staffRule.threshold ?? 50) } });
    }
    const member = source?.member || source;
    const metadata = { threshold: Number(staffRule.threshold ?? 50), timeoutSeconds: Number(staffRule.timeoutSeconds || 3600), timeoutApplied: false, messageDeleted: false };
    if (staffRule.timeoutUsers !== false && typeof member?.timeout === 'function') {
      try {
        await member.timeout(Math.max(1, Math.min(2419200, metadata.timeoutSeconds)) * 1000, 'Guild Guard staff impersonation escalation');
        metadata.timeoutApplied = true;
      } catch (error) {
        metadata.timeoutError = String(error?.message || error);
      }
    }
    if (staffRule.deleteMessages !== false && typeof source?.delete === 'function') {
      try {
        await source.delete();
        metadata.messageDeleted = true;
      } catch (error) {
        metadata.deleteError = String(error?.message || error);
      }
    }
    const applied = metadata.timeoutApplied || metadata.messageDeleted;
    return recordAction({ event, incident, actionType: 'staff_impersonation_escalation', status: applied ? 'applied' : 'skipped', metadata });
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

module.exports = { execute, recordAction };
