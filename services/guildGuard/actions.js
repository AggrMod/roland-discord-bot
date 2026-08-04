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

function parseStoredValue(value, fallback = null) {
  try { return value === null || value === undefined ? fallback : JSON.parse(value); } catch (_) { return fallback; }
}

function actionStatus(applied, errors, requested) {
  if (errors.length > 0) return 'failed';
  if (requested > 0 && applied === requested) return 'applied';
  return 'skipped';
}

async function applyRaidLockdown(guild, config) {
  if (!guild?.id || typeof guild.setVerificationLevel !== 'function') {
    return { applied: false, error: 'guild_verification_control_unavailable' };
  }
  const actions = config?.actions || {};
  const verificationLevel = actions.lockdownVerificationLevel || 'high';
  const durationSeconds = Math.max(60, Math.min(86400, Number(actions.lockdownDurationSeconds) || 900));
  const previousVerificationLevel = guild.verificationLevel ?? null;
  try {
    await guild.setVerificationLevel(verificationLevel);
    db.prepare(`
      INSERT INTO guild_guard_lockdowns
        (guild_id, previous_verification_level, applied_verification_level, restore_at, status, last_error)
      VALUES (?, ?, ?, datetime('now', '+' || ? || ' seconds'), 'active', NULL)
      ON CONFLICT(guild_id) DO UPDATE SET
        previous_verification_level = CASE
          WHEN guild_guard_lockdowns.status = 'active' THEN guild_guard_lockdowns.previous_verification_level
          ELSE excluded.previous_verification_level
        END,
        applied_verification_level = excluded.applied_verification_level,
        restore_at = excluded.restore_at,
        status = 'active',
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    `).run(guild.id, JSON.stringify(previousVerificationLevel), JSON.stringify(verificationLevel), durationSeconds);
    return { applied: true, verificationLevel, previousVerificationLevel, durationSeconds };
  } catch (error) {
    return { applied: false, verificationLevel, previousVerificationLevel, durationSeconds, error: String(error?.message || error) };
  }
}

async function restoreExpiredLockdowns(client) {
  const rows = db.prepare(`
    SELECT * FROM guild_guard_lockdowns
    WHERE status = 'active' AND restore_at <= CURRENT_TIMESTAMP
    ORDER BY restore_at ASC
  `).all();
  const results = [];
  for (const row of rows) {
    let guild = client?.guilds?.cache?.get?.(String(row.guild_id)) || null;
    if (!guild && typeof client?.guilds?.fetch === 'function') {
      try { guild = await client.guilds.fetch(String(row.guild_id)); } catch (_) { guild = null; }
    }
    if (!guild || typeof guild.setVerificationLevel !== 'function') {
      const error = 'guild_unavailable';
      db.prepare('UPDATE guild_guard_lockdowns SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?')
        .run(error, row.guild_id);
      results.push({ guildId: row.guild_id, restored: false, error });
      continue;
    }
    const previousVerificationLevel = parseStoredValue(row.previous_verification_level, null);
    try {
      if (previousVerificationLevel !== null) await guild.setVerificationLevel(previousVerificationLevel);
      db.prepare("UPDATE guild_guard_lockdowns SET status = 'restored', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?")
        .run(row.guild_id);
      results.push({ guildId: row.guild_id, restored: true, verificationLevel: previousVerificationLevel });
    } catch (error) {
      const message = String(error?.message || error);
      db.prepare('UPDATE guild_guard_lockdowns SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?')
        .run(message, row.guild_id);
      results.push({ guildId: row.guild_id, restored: false, error: message });
    }
  }
  return results;
}

async function executeQuickAction({ guild, incident, action, actorId }) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  const allowed = new Set(['timeout', 'kick', 'ban', 'unmute', 'delete']);
  if (!guild?.id || !incident?.incident_id || !allowed.has(normalizedAction)) throw new Error('Unsupported Guild Guard quick action');
  const event = { guildId: guild.id };
  const metadata = { actorId: actorId || null, action: normalizedAction, userId: incident.user_id || null };
  const evidence = parseStoredValue(incident.evidence_json, {});
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

async function alertGlobalReputation({ source, event, reputation, config }) {
  const channelId = String(config?.alertChannelId || '').trim();
  const networkConfig = config?.globalReputation || {};
  if (!channelId || networkConfig.notifyOnJoin === false || Number(reputation?.activeScore || 0) < Number(networkConfig.alertThreshold || 50)) return false;
  const guild = source?.guild || source?.member?.guild;
  let channel = guild?.channels?.cache?.get(channelId) || null;
  if (!channel && typeof guild?.channels?.fetch === 'function') {
    try { channel = await guild.channels.fetch(channelId); } catch (_) { channel = null; }
  }
  if (!channel?.send) return false;
  const staffIds = [...new Set(identityRegistry.list(event.guildId).map(identity => String(identity.user_id || '').trim()).filter(userId => userId && userId !== event.userId))];
  const staffMentions = staffIds.map(userId => `<@${userId}>`).join(' ');
  const categories = reputation.categoryLabels?.join(', ') || 'Global reputation match';
  const lastReported = reputation.lastReportedAt ? `Last report: ${reputation.lastReportedAt}` : 'Last report: unknown';
  const embed = new EmbedBuilder()
    .setColor(reputation.activeScore >= 80 ? 0xED4245 : 0xFEE75C)
    .setTitle('Global Safety Network match')
    .setDescription('A member entering this server has an active cross-community reputation signal.')
    .addFields(
      { name: 'User', value: event.userId ? `<@${event.userId}>` : 'Unknown', inline: true },
      { name: 'Active score', value: `${reputation.activeScore}/100`, inline: true },
      { name: 'Categories', value: categories, inline: true },
      { name: 'Reports', value: `${reputation.reportCount} report(s) from ${reputation.sourceCount} community source(s)`, inline: false },
      { name: 'Recency', value: lastReported, inline: false }
    )
    .setFooter({ text: 'Global Safety Network | moderator review recommended' })
    .setTimestamp();
  const content = [`🛡️ Global Safety Network match: ${reputation.activeScore}/100.`, event.userId ? `User: <@${event.userId}>` : null, staffMentions ? `Moderator notification: ${staffMentions}` : null].filter(Boolean).join('\n');
  try {
    await channel.send({ content, embeds: [embed], allowedMentions: staffIds.length ? { users: staffIds } : { parse: [] } });
    return true;
  } catch (_) {
    return false;
  }
}

async function executeMatchedRules({ source, event, config, incident, matchedRules }) {
  const actions = config?.actions || {};
  const claims = matchedRules.map(rule => ({
    rule,
    claim: claimAction({
      event,
      incident,
      actionType: `rule:${rule.id}`,
      metadata: { ruleId: rule.id, threshold: Number(rule.threshold ?? 50), pending: true }
    })
  }));
  const activeClaims = claims.filter(item => item.claim);
  if (activeClaims.length === 0) {
    return db.prepare("SELECT * FROM actions WHERE guild_id = ? AND incident_id = ? AND action_type LIKE 'rule:%' ORDER BY id DESC LIMIT 1")
      .get(event.guildId, incident.incident_id) || null;
  }
  if (config?.mode !== 'enforce' || actions.enabled !== true) {
    return activeClaims.map(({ rule, claim }) => finalizeAction(claim.id, 'skipped', {
      ruleId: rule.id,
      threshold: Number(rule.threshold ?? 50),
      reason: 'enforcement_disabled'
    }))[0];
  }

  const member = source?.member || source;
  const timeoutRules = activeClaims.filter(({ rule }) => rule?.actions?.timeoutUsers === true);
  const deleteRules = activeClaims.filter(({ rule }) => rule?.actions?.deleteMessages === true);
  const timeoutSeconds = timeoutRules.length
    ? Math.max(...timeoutRules.map(({ rule }) => Math.max(1, Math.min(2419200, Number(rule.actions.timeoutSeconds) || 3600))))
    : 0;
  const outcome = { timeoutSeconds, timeoutApplied: false, messageDeleted: false, errors: [] };
  if (timeoutSeconds > 0) {
    try {
      if (typeof member?.timeout !== 'function') throw new Error('moderate_members_permission_or_member_unavailable');
      await member.timeout(timeoutSeconds * 1000, `Guild Guard rules: ${activeClaims.map(({ rule }) => rule.name).join(', ')}`.slice(0, 480));
      outcome.timeoutApplied = true;
    } catch (error) {
      outcome.errors.push({ action: 'timeout', message: String(error?.message || error) });
    }
  }
  if (deleteRules.length > 0) {
    try {
      if (typeof source?.delete !== 'function') throw new Error('manage_messages_permission_or_message_unavailable');
      await source.delete();
      outcome.messageDeleted = true;
    } catch (error) {
      outcome.errors.push({ action: 'delete', message: String(error?.message || error) });
    }
  }
  return activeClaims.map(({ rule, claim }) => {
    const requested = Number(rule?.actions?.timeoutUsers === true) + Number(rule?.actions?.deleteMessages === true);
    const applied = Number(rule?.actions?.timeoutUsers === true && outcome.timeoutApplied)
      + Number(rule?.actions?.deleteMessages === true && outcome.messageDeleted);
    const relevantErrors = outcome.errors.filter(error => (error.action === 'timeout' && rule?.actions?.timeoutUsers === true)
      || (error.action === 'delete' && rule?.actions?.deleteMessages === true));
    return finalizeAction(claim.id, actionStatus(applied, relevantErrors, requested), {
      ...outcome,
      ruleId: rule.id,
      threshold: Number(rule.threshold ?? 50)
    });
  })[0] || null;
}

async function execute({ source, event, decision, config, incident, signals }) {
  const actions = config?.actions || {};
  if (!incident) return null;
  const rules = Array.isArray(config?.rules) ? config.rules : [];
  const signalDetectors = new Set((signals || []).map(signal => String(signal.detector || '').trim()));
  const matchedRules = rules.filter(rule => rule?.enabled !== false
    && Number(decision?.score || 0) >= Number(rule.threshold ?? 50)
    && (Array.isArray(rule.detectors) ? rule.detectors : []).some(detector => signalDetectors.has(detector)));
  const notifyingRules = matchedRules.filter(rule => rule?.actions?.notifyStaff !== false);
  if (matchedRules.length === 0 || notifyingRules.length > 0) {
    await alertStaff({
      source,
      event,
      decision,
      config,
      incident,
      signals,
      thresholdOverride: notifyingRules.length ? Math.min(...notifyingRules.map(rule => Number(rule.threshold ?? 50))) : null,
      pingStaff: notifyingRules.some(rule => rule?.actions?.pingStaff === true)
    });
  }
  if (matchedRules.length > 0) {
    return executeMatchedRules({ source, event, config, incident, matchedRules });
  }
  if (decision?.action === 'monitor') return null;

  const claim = claimAction({ event, incident, actionType: decision.action, metadata: { pending: true } });
  if (!claim) {
    return db.prepare('SELECT * FROM actions WHERE guild_id = ? AND incident_id = ? AND action_type = ? ORDER BY id DESC LIMIT 1')
      .get(event.guildId, incident.incident_id, decision.action) || null;
  }
  if (config?.mode !== 'enforce' || actions.enabled !== true) {
    return finalizeAction(claim.id, 'skipped', { reason: 'enforcement_disabled' });
  }

  const action = decision.action;
  if (action === 'warn' && actions.warnUsers === true) {
    try {
      if (!source?.channel?.send) throw new Error('send_messages_permission_or_channel_unavailable');
      await source.channel.send({
        content: `⚠️ <@${event.userId}> your message was flagged for moderator review.`,
        allowedMentions: { users: event.userId ? [event.userId] : [] }
      });
      return finalizeAction(claim.id, 'applied', {});
    } catch (error) {
      return finalizeAction(claim.id, 'failed', { error: String(error?.message || error) });
    }
  }

  if (event.eventType === 'member_join' && actions.lockdownEnabled === true) {
    const raid = parseStoredValue(incident.signals_json, []).some(signal => signal.detector === 'raid_burst');
    if (raid) {
      const result = await applyRaidLockdown(source?.guild, config);
      return finalizeAction(claim.id, result.applied ? 'applied' : 'failed', result);
    }
  }

  if ((action === 'timeout' || action === 'quarantine') && actions.timeoutUsers === true) {
    const member = source?.member || source;
    try {
      if (typeof member?.timeout !== 'function') throw new Error('moderate_members_permission_or_member_unavailable');
      const timeoutSeconds = Math.max(1, Math.min(2419200, Number(actions.timeoutSeconds) || 60));
      await member.timeout(timeoutSeconds * 1000, 'Guild Guard risk policy');
      return finalizeAction(claim.id, 'applied', { timeoutSeconds, containment: action === 'quarantine' });
    } catch (error) {
      return finalizeAction(claim.id, 'failed', { error: String(error?.message || error) });
    }
  }

  if ((action === 'timeout' || action === 'quarantine') && actions.deleteMessages === true) {
    try {
      if (typeof source?.delete !== 'function') throw new Error('manage_messages_permission_or_message_unavailable');
      await source.delete();
      return finalizeAction(claim.id, 'applied', { policyAction: action, messageDeleted: true });
    } catch (error) {
      return finalizeAction(claim.id, 'failed', { policyAction: action, error: String(error?.message || error) });
    }
  }

  return finalizeAction(claim.id, 'skipped', { reason: 'unsupported_or_missing_permission' });
}

module.exports = {
  execute,
  recordAction,
  executeQuickAction,
  alertGlobalReputation,
  restoreExpiredLockdowns,
  applyRaidLockdown
};
