#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildpilot-guild-guard-'));
process.env.DATABASE_PATH = path.join(tempDir, 'guild-guard.db');
process.env.DB_BACKUP_ENABLED = 'false';
process.env.DB_BACKUP_ON_STARTUP = 'false';

const db = require('../database/db');
const guard = require('../services/guildGuard');
const { normalizeEvent, normalizeContent } = require('../services/guildGuard/normalizer');
const { classifyAttachment, scanQrAttachment } = require('../services/guildGuard/attachmentSafety');
const { scoreSignals, decidePolicy, riskLevel } = require('../services/guildGuard/scoring');
const { resolveSafeUrl, isPrivateIp } = require('../services/guildGuard/urlSafety');
const EventWindowStore = require('../services/guildGuard/eventWindow');
const {
  spamFloodDetector,
  duplicateMessageDetector,
  massMentionDetector,
  suspiciousAccountDetector,
  impersonationDetector,
  scamLanguageDetector,
  linkProtectionDetector,
  attachmentThreatDetector,
  coordinatedCampaignDetector,
  accountTrustDetector
} = require('../services/guildGuard/detectors');
const actionService = require('../services/guildGuard/actions');

(async () => {

function tableColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

for (const table of ['guild_guard_configs', 'staff_identities', 'domain_allowlist', 'domain_blocklist', 'risk_profiles', 'risk_signals', 'incidents', 'actions', 'raid_events', 'false_positives', 'guild_guard_global_reports', 'guild_guard_global_matches', 'guild_guard_member_reports']) {
  assert.ok(tableColumns(table).size > 0, `expected ${table} table`);
}

assert.strictEqual(normalizeContent('  Hello\u200b   **WORLD**  '), 'hello world');
const event = normalizeEvent({
  id: 'message-1',
  guildId: 'guild-a',
  channelId: 'channel-a',
  content: 'Visit https://Example.com <@123>!',
  author: { id: 'user-a', username: 'Example', bot: false }
});
assert.strictEqual(event.guildId, 'guild-a');
assert.strictEqual(event.normalizedContent, 'visit https://example.com <@123>!');
assert.deepStrictEqual(event.urls, ['https://example.com']);
const bareDomainEvent = normalizeEvent({ guildId: 'guild-test', author: { id: 'user-1' }, content: 'visit example.com/docs or www.github.com' });
assert.deepStrictEqual(bareDomainEvent.urls, ['example.com/docs', 'www.github.com']);
assert.deepStrictEqual(event.mentions, ['123']);
const attachmentEvent = normalizeEvent({
  guildId: 'guild-a',
  author: { id: 'user-a' },
  attachments: new Map([['file-1', { id: 'file-1', name: 'photo.jpg.exe', url: 'https://cdn.discordapp.com/attachments/a/b/photo.jpg.exe', contentType: 'application/octet-stream', size: 2048 }]])
});
assert.strictEqual(attachmentEvent.attachments.length, 1);
assert.strictEqual(attachmentEvent.attachments[0].name, 'photo.jpg.exe');
const memberAgeEvent = normalizeEvent({ guildId: 'guild-a', author: { id: 'member-age-user' }, member: { joinedTimestamp: Date.now() - 3600000 } });
assert.ok(memberAgeEvent.memberAgeHours >= 0.9 && memberAgeEvent.memberAgeHours <= 1.1);
assert.ok(classifyAttachment(attachmentEvent.attachments[0]).some(finding => finding.category === 'double_extension'));
assert.strictEqual(classifyAttachment({ name: 'logo.svg', contentType: 'image/svg+xml' })[0].score, 45, 'ordinary SVG files should warn instead of auto-contain under Balanced thresholds');
const decodedQr = await scanQrAttachment({
  name: 'qr.png', url: 'https://cdn.discordapp.com/attachments/a/b/qr.png', contentType: 'image/png'
}, {
  fetcher: async () => ({ ok: true, body: Buffer.from('fake-image') }),
  decoder: async () => 'https://evil.example/claim'
});
assert.strictEqual(decodedQr, 'https://evil.example/claim');

const config = guard.getConfig('guild-a');
assert.strictEqual(config.enabled, false, 'Guild Guard must be disabled by default');
const balancedPreset = guard.applyPreset('guild-preset', 'balanced');
assert.strictEqual(balancedPreset.preset, 'balanced');
assert.strictEqual(balancedPreset.mode, 'enforce');
assert.strictEqual(balancedPreset.actions.lockdownEnabled, true);
assert.strictEqual(balancedPreset.exemptions.webhookUsers, false);
assert.strictEqual(guard.listPresets().length, 3);
assert.strictEqual(guard.isExempt({ isBot: true, isWebhook: true, isOwner: false, roleIds: [] }, balancedPreset), false, 'webhooks use their explicit exemption instead of the generic bot exemption');
const skipped = await guard.process({ id: 'message-disabled', guildId: 'guild-a', content: 'hello', author: { id: 'user-a' } }, 'message_create');
assert.strictEqual(skipped.skipped, true);
assert.strictEqual(skipped.reason, 'disabled');

const testIncident = await guard.createTestIncident('guild-a', {
  id: 'test-incident-1',
  content: 'test evidence',
  author: { id: 'user-a', username: 'Tester' }
});
assert.ok(testIncident.incident);
assert.strictEqual(testIncident.incident.guild_id, 'guild-a');
assert.strictEqual(testIncident.incident.status, 'test');
assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM incidents WHERE guild_id = ?').get('guild-a').count, 1);
const duplicate = await guard.createTestIncident('guild-a', { id: 'test-incident-1', author: { id: 'user-a' } });
assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM incidents WHERE guild_id = ?').get('guild-a').count, 1, 'event id must be idempotent');
assert.strictEqual(duplicate.incident.incident_id, testIncident.incident.incident_id);

const otherGuild = await guard.createTestIncident('guild-b', { id: 'test-incident-1', author: { id: 'user-b' } });
assert.strictEqual(otherGuild.incident.guild_id, 'guild-b');
assert.strictEqual(guard.listIncidents('guild-a').length, 1);
assert.strictEqual(guard.listIncidents('guild-b').length, 1);
assert.strictEqual(guard.listIncidents('guild-a')[0].user_incident_count, 1);

assert.strictEqual(scoreSignals([{ score: 40 }, { score: 80 }]), 100);
assert.strictEqual(decidePolicy(70, config).action, 'timeout');
assert.strictEqual(scoreSignals([{ detector: 'spam_flood', score: 30 }, { detector: 'duplicate_message', score: 25 }], config), 65);
assert.strictEqual(riskLevel(65, config), 'high');
assert.strictEqual(isPrivateIp('127.0.0.1'), true);
await assert.rejects(() => resolveSafeUrl('http://127.0.0.1/admin'), /private_destination/);
assert.strictEqual(guard.isExempt({ isBot: true, isWebhook: false, isOwner: false, roleIds: [] }, config), true);

const window = new EventWindowStore();
const detectorConfig = {
  detectors: {
    spam: { enabled: true, maxMessages: 2, windowMs: 10000 },
    duplicateMessages: { enabled: true, threshold: 3, windowMs: 30000 },
    massMention: { enabled: true, threshold: 2 },
    suspiciousAccount: { enabled: true, maxAccountAgeHours: 24 }
  }
};
const messageBase = { guildId: 'guild-detectors', userId: 'user-detectors', eventType: 'message_create', timestamp: Date.now() };
for (let i = 0; i < 3; i += 1) window.record({ ...messageBase, eventId: `spam-${i}`, normalizedContent: `message-${i}`, timestamp: Date.now() + i });
const spamSignal = spamFloodDetector.detect({ ...messageBase, eventId: 'spam-3', timestamp: Date.now() + 3 }, { config: detectorConfig, eventWindow: window });
assert.ok(spamSignal && spamSignal.score > 0);
const duplicateEvent = { ...messageBase, eventId: 'duplicate-3', normalizedContent: 'same content', timestamp: Date.now() + 4 };
window.record({ ...duplicateEvent, eventId: 'duplicate-1' });
window.record({ ...duplicateEvent, eventId: 'duplicate-2' });
window.record(duplicateEvent);
assert.ok(duplicateMessageDetector.detect(duplicateEvent, { config: detectorConfig, eventWindow: window }));
assert.ok(massMentionDetector.detect({ ...duplicateEvent, mentions: ['1', '2'] }, { config: detectorConfig }));
assert.ok(suspiciousAccountDetector.detect({ ...duplicateEvent, eventType: 'member_join', accountAgeHours: 1 }, { config: detectorConfig }));

guard.updateConfig('guild-live', {
  enabled: true,
  detectors: { massMention: { enabled: true, threshold: 2 } }
});
const liveResult = await guard.process({
  id: 'live-mass-mention-1',
  guildId: 'guild-live',
  content: '@everyone hello',
  author: { id: 'user-live', username: 'LiveTester' },
  mentions: ['1', '2'],
  everyoneMention: true
}, 'message_create');
assert.strictEqual(liveResult.skipped, undefined);
assert.ok(liveResult.incident, 'enabled detector should create an incident');
assert.ok(liveResult.signals.some(signal => signal.detector === 'mass_mention'));
assert.ok(liveResult.action);
assert.strictEqual(liveResult.action.status, 'skipped', 'enforcement must remain disabled by default');
assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM risk_signals WHERE guild_id = ?').get('guild-live').count, 1);
const liveProfile = guard.getRiskProfile('guild-live', 'user-live');
assert.strictEqual(liveProfile.risk_level, 'medium');
db.prepare("UPDATE risk_profiles SET risk_score = 80, updated_at = datetime('now', '-48 hours') WHERE guild_id = ? AND user_id = ?").run('guild-live', 'user-live');
assert.ok(guard.getRiskProfile('guild-live', 'user-live').risk_score < 80, 'risk profile should decay');
let timeoutMs = null;
const appliedAction = await actionService.execute({
  source: { member: { timeout: async duration => { timeoutMs = duration; } } },
  event: liveResult.event,
  decision: { action: 'timeout' },
  config: { mode: 'enforce', actions: { enabled: true, timeoutUsers: true, timeoutSeconds: 5 } },
  incident: liveResult.incident
});
assert.strictEqual(appliedAction.status, 'applied');
assert.strictEqual(timeoutMs, 5000);
let combinedTimeoutMs = null;
let combinedMessageDeleted = false;
const combinedIncident = await guard.createTestIncident('guild-combined-action', { id: 'combined-action', author: { id: 'combined-user' } });
const combinedAction = await actionService.execute({
  source: { member: { timeout: async duration => { combinedTimeoutMs = duration; } }, delete: async () => { combinedMessageDeleted = true; } },
  event: { guildId: 'guild-combined-action', userId: 'combined-user', eventType: 'message_create' },
  decision: { action: 'quarantine', score: 90 },
  config: { mode: 'enforce', actions: { enabled: true, timeoutUsers: true, timeoutSeconds: 120, deleteMessages: true }, rules: [] },
  incident: combinedIncident.incident,
  signals: []
});
assert.strictEqual(combinedAction.status, 'applied');
assert.strictEqual(combinedTimeoutMs, 120000);
assert.strictEqual(combinedMessageDeleted, true, 'high-risk messages must be deleted even when the member is also contained');

guard.identityRegistry.upsert('guild-identity', {
  userId: 'staff-1',
  username: 'GuildModerator',
  displayName: 'Guild Moderator',
  aliases: ['GuildMod']
});
const roleManagedMember = {
  id: 'staff-2',
  user: { id: 'staff-2', username: 'RoleModerator', globalName: 'Role Moderator' },
  displayName: 'Role Moderator',
  roles: { cache: { values: () => [{ permissions: { has: permission => permission === 'ModerateMembers' } }] } },
  permissions: { has: () => false }
};
guard.identityRegistry.syncMember({ ...roleManagedMember, guild: { id: 'guild-identity' } });
assert.strictEqual(guard.identityRegistry.list('guild-identity', false).find(identity => identity.user_id === 'staff-2').managed_by_roles, 1);
const identityConfig = { detectors: { impersonation: { enabled: true, score: 70 } } };
const identitySignal = impersonationDetector.detect({
  guildId: 'guild-identity',
  userId: 'attacker-1',
  username: 'guildmoderator',
  displayName: 'New Account'
}, { config: identityConfig, identityRegistry: guard.identityRegistry });
assert.ok(identitySignal && identitySignal.metadata.matchedStaffUserId === 'staff-1');

guard.domainRegistry.add('guild-links', 'trusted.example', 'allow');
guard.domainRegistry.add('guild-links', 'evil.example', 'block', { reason: 'test' });
const linkConfig = { detectors: { links: { enabled: true, requireAllowlist: false, protectedDomains: ['trusted.example'] } } };
const blockedLinkSignal = await linkProtectionDetector.detect({
  eventType: 'message_create', guildId: 'guild-links', urls: ['https://evil.example/path']
}, { config: linkConfig, domainRegistry: guard.domainRegistry });
assert.ok(blockedLinkSignal && blockedLinkSignal[0].metadata.category === 'blocklisted');
const lookalikeSignal = await linkProtectionDetector.detect({
  eventType: 'message_create', guildId: 'guild-links', urls: ['https://trusled.example/path']
}, { config: linkConfig, domainRegistry: guard.domainRegistry });
assert.ok(lookalikeSignal && lookalikeSignal[0].metadata.category === 'lookalike');
const deceptiveLinkSignal = await linkProtectionDetector.detect({
  eventType: 'message_create', guildId: 'guild-links', rawContent: '[trusted.example](https://evil.example/claim)', urls: ['https://evil.example/claim']
}, { config: linkConfig, domainRegistry: guard.domainRegistry });
assert.ok(deceptiveLinkSignal.some(signal => signal.detector === 'link_deception' && signal.metadata.category === 'masked_destination'));
const secretRequestSignal = scamLanguageDetector.detect({
  eventType: 'message_create', normalizedContent: 'support needs you to paste your seed phrase immediately', urls: [], attachments: []
}, { config: { detectors: { scamLanguage: { enabled: true } } } });
assert.strictEqual(secretRequestSignal.severity, 'critical');
assert.strictEqual(scamLanguageDetector.detect({
  eventType: 'message_create', normalizedContent: 'never share your seed phrase with anyone', urls: [], attachments: []
}, { config: { detectors: { scamLanguage: { enabled: true } } } }), null, 'member safety warnings must not be classified as seed phrase theft');
guard.domainRegistry.add('guild-language-safe', 'guildpilot.app', 'allow');
assert.strictEqual(scamLanguageDetector.detect({
  eventType: 'message_create', guildId: 'guild-language-safe', normalizedContent: 'connect your wallet to verify and claim your role', urls: ['https://guildpilot.app/wallets'], attachments: []
}, { config: { detectors: { scamLanguage: { enabled: true } } }, domainRegistry: guard.domainRegistry }), null, 'trusted destinations must suppress ordinary wallet onboarding language');
const attachmentSignals = await attachmentThreatDetector.detect({
  eventType: 'message_create', guildId: 'guild-links', rawContent: '', urls: [], attachments: [
    { name: 'claim.png', url: 'https://cdn.discordapp.com/attachments/a/b/claim.png', contentType: 'image/png', size: 1000 },
    { name: 'rewards.pdf.exe', url: 'https://cdn.discordapp.com/attachments/a/b/rewards.pdf.exe', contentType: 'application/octet-stream', size: 1000 }
  ]
}, {
  config: { detectors: { attachments: { enabled: true, scanQrCodes: true }, links: { enabled: true, protectedDomains: [] } } },
  domainRegistry: guard.domainRegistry,
  scanQrAttachment: async attachment => attachment.name === 'claim.png' ? 'https://evil.example/claim' : null
});
assert.ok(attachmentSignals.some(signal => signal.detector === 'qr_code_link'));
assert.ok(attachmentSignals.some(signal => signal.detector === 'dangerous_attachment' && signal.metadata.category === 'double_extension'));
assert.ok(attachmentSignals.some(signal => signal.detector === 'link_protection' && signal.metadata.source === 'qr_code'));

const campaignWindow = new EventWindowStore();
const campaignConfig = { detectors: { campaigns: { enabled: true, windowSeconds: 90, userThreshold: 3, messageThreshold: 3 } } };
const campaignTimestamp = Date.now();
for (let i = 0; i < 3; i += 1) {
  campaignWindow.record({
    eventId: `campaign-${i}`, eventType: 'message_create', guildId: 'guild-campaign',
    userId: `campaign-user-${i}`, channelId: `campaign-channel-${i % 2}`,
    normalizedContent: `claim your reward at https://campaign-evil.example/claim code ${i}`,
    urls: ['https://campaign-evil.example/claim'], timestamp: campaignTimestamp + i
  });
}
const campaignSignals = coordinatedCampaignDetector.detect({
  eventId: 'campaign-2', eventType: 'message_create', guildId: 'guild-campaign',
  userId: 'campaign-user-2', channelId: 'campaign-channel-0',
  normalizedContent: 'claim your reward at https://campaign-evil.example/claim code 2',
  urls: ['https://campaign-evil.example/claim'], timestamp: campaignTimestamp + 2
}, { config: campaignConfig, eventWindow: campaignWindow, domainRegistry: guard.domainRegistry });
assert.ok(campaignSignals.some(signal => signal.detector === 'coordinated_link_campaign' && signal.metadata.userCount === 3));

guard.domainRegistry.add('guild-campaign-trusted', 'trusted-campaign.example', 'allow');
const trustedCampaignWindow = new EventWindowStore();
for (let i = 0; i < 3; i += 1) trustedCampaignWindow.record({
  eventId: `trusted-${i}`, eventType: 'message_create', guildId: 'guild-campaign-trusted', userId: `trusted-user-${i}`,
  normalizedContent: 'trusted community update at trusted-campaign.example', urls: ['https://trusted-campaign.example/news'], timestamp: campaignTimestamp + i
});
assert.strictEqual(coordinatedCampaignDetector.detect({
  eventType: 'message_create', guildId: 'guild-campaign-trusted', userId: 'trusted-user-2',
  normalizedContent: 'trusted community update at trusted-campaign.example', urls: ['https://trusted-campaign.example/news'], timestamp: campaignTimestamp + 2
}, { config: campaignConfig, eventWindow: trustedCampaignWindow, domainRegistry: guard.domainRegistry }), null, 'trusted domains must not trigger Campaign Radar');

const copiedCampaignWindow = new EventWindowStore();
for (let i = 0; i < 3; i += 1) copiedCampaignWindow.record({
  eventId: `copied-${i}`, eventType: 'message_create', guildId: 'guild-copied', userId: `copied-user-${i}`,
  channelId: `copied-channel-${i}`, normalizedContent: 'urgent support verification required now', urls: [], timestamp: campaignTimestamp + i
});
const copiedSignals = coordinatedCampaignDetector.detect({
  eventType: 'message_create', guildId: 'guild-copied', userId: 'copied-user-2', channelId: 'copied-channel-2',
  normalizedContent: 'urgent support verification required now', urls: [], timestamp: campaignTimestamp + 2
}, { config: campaignConfig, eventWindow: copiedCampaignWindow, domainRegistry: guard.domainRegistry });
assert.ok(copiedSignals.some(signal => signal.detector === 'coordinated_message_campaign'));

const accountTrustConfig = { detectors: { accountTrust: { enabled: true, maxAccountAgeHours: 72, maxMemberAgeHours: 24, channelThreshold: 3, burstWindowSeconds: 120 } } };
const accountTrustWindow = new EventWindowStore();
const youngAccountEvent = {
  eventId: 'young-account-link', eventType: 'message_create', guildId: 'guild-account-trust', userId: 'young-account', channelId: 'channel-1',
  normalizedContent: 'connect your wallet at risky-account.example', urls: ['https://risky-account.example/connect'], attachments: [],
  accountAgeHours: 2, memberAgeHours: 1, timestamp: campaignTimestamp
};
accountTrustWindow.record(youngAccountEvent);
const lowTrustSignals = accountTrustDetector.detect(youngAccountEvent, { config: accountTrustConfig, eventWindow: accountTrustWindow, domainRegistry: guard.domainRegistry });
assert.ok(lowTrustSignals.some(signal => signal.detector === 'low_trust_destination' && signal.metadata.youngAccount === true));

guard.domainRegistry.add('guild-account-trust-safe', 'trusted-account.example', 'allow');
const safeAccountWindow = new EventWindowStore();
const safeYoungAccountEvent = { ...youngAccountEvent, guildId: 'guild-account-trust-safe', urls: ['https://trusted-account.example/connect'] };
safeAccountWindow.record(safeYoungAccountEvent);
assert.strictEqual(accountTrustDetector.detect(safeYoungAccountEvent, { config: accountTrustConfig, eventWindow: safeAccountWindow, domainRegistry: guard.domainRegistry }), null, 'trusted destinations must not lower account trust');

const compromisedWindow = new EventWindowStore();
let compromisedEvent = null;
for (let i = 0; i < 3; i += 1) {
  compromisedEvent = {
    eventId: `compromised-${i}`, eventType: 'message_create', guildId: 'guild-compromised', userId: 'established-account', channelId: `channel-${i}`,
    normalizedContent: `see https://compromised.example/claim/${i}`, urls: [`https://compromised.example/claim/${i}`], attachments: [],
    accountAgeHours: 20000, memberAgeHours: 8000, timestamp: campaignTimestamp + i
  };
  compromisedWindow.record(compromisedEvent);
}
const compromisedSignals = accountTrustDetector.detect(compromisedEvent, { config: accountTrustConfig, eventWindow: compromisedWindow, domainRegistry: guard.domainRegistry });
assert.ok(compromisedSignals.some(signal => signal.detector === 'account_link_burst' && signal.metadata.channelCount === 3));

let alertPayload = null;
guard.updateConfig('guild-alert', {
  enabled: true,
  alertChannelId: 'alert-channel',
  risk: { alert: 25 },
  detectors: { massMention: { enabled: true, threshold: 2 } }
});
const alertGuild = {
  id: 'guild-alert',
  channels: { cache: new Map([['alert-channel', { send: async payload => { alertPayload = payload; } }]]) }
};
const alertResult = await guard.process({
  id: 'alert-message-1', guild: alertGuild, guildId: 'guild-alert', content: '@everyone hello',
  author: { id: 'alert-user', username: 'AlertUser' }, mentions: ['1', '2'], everyoneMention: true
}, 'message_create');
assert.ok(alertResult.incident);
assert.ok(alertPayload && alertPayload.content.includes('Guild Guard alert'));
assert.ok(db.prepare("SELECT COUNT(*) AS count FROM actions WHERE incident_id = ? AND action_type = 'alert' AND status = 'applied'").get(alertResult.incident.incident_id).count >= 1);

guard.identityRegistry.upsert('guild-rule', { userId: 'rule-staff', username: 'RuleModerator', displayName: 'Rule Moderator' });
guard.updateConfig('guild-rule', {
  enabled: true,
  mode: 'enforce',
  alertChannelId: 'rule-alert-channel',
  detectors: { impersonation: { enabled: true, score: 70 } },
  actions: { enabled: true },
  rules: { staffImpersonation: { enabled: true, threshold: 50, timeoutSeconds: 3600, deleteMessages: true, pingStaff: true } }
});
guard.createRule('guild-rule', {
  name: 'Impersonation audit trail',
  detectors: ['staff_impersonation'],
  threshold: 60,
  actions: { notifyStaff: true, pingStaff: false, timeoutUsers: false, deleteMessages: false }
});
let ruleAlertPayload = null;
let ruleAlertCount = 0;
let ruleTimeoutMs = null;
let ruleDeleted = false;
const ruleGuild = {
  id: 'guild-rule',
  channels: { cache: new Map([['rule-alert-channel', { send: async payload => { ruleAlertPayload = payload; ruleAlertCount += 1; } }]]) }
};
const ruleResult = await guard.process({
  id: 'rule-message-1', guild: ruleGuild, guildId: 'guild-rule', content: 'visit our support page',
  author: { id: 'rule-attacker', username: 'RuleModerator' },
  member: { timeout: async duration => { ruleTimeoutMs = duration; } },
  delete: async () => { ruleDeleted = true; }
}, 'message_create');
assert.ok(ruleResult.incident);
assert.strictEqual(ruleTimeoutMs, 3600000);
assert.strictEqual(ruleDeleted, true);
assert.ok(ruleAlertPayload && ruleAlertPayload.content.includes('<@rule-staff>'));
assert.ok(Array.isArray(ruleAlertPayload.embeds) && ruleAlertPayload.embeds.length === 1);
assert.strictEqual(ruleAlertPayload.components[0].components.length, 5);
assert.deepStrictEqual(ruleAlertPayload.allowedMentions.users, ['rule-staff']);
assert.strictEqual(db.prepare("SELECT status FROM actions WHERE incident_id = ? AND action_type = 'rule:staff_impersonation_escalation'").get(ruleResult.incident.incident_id).status, 'applied');
assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM actions WHERE incident_id = ? AND action_type LIKE 'rule:%'").get(ruleResult.incident.incident_id).count, 2, 'every matching rule must be evaluated and recorded');
await actionService.execute({
  source: { guild: ruleGuild, member: { timeout: async () => {} }, delete: async () => {} },
  event: ruleResult.event,
  decision: ruleResult.decision,
  config: ruleResult.config,
  incident: ruleResult.incident,
  signals: ruleResult.signals
});
assert.strictEqual(ruleAlertCount, 1, 'retries must not send duplicate moderator alerts');
const customRules = guard.listRules('guild-rule');
assert.ok(customRules.some(rule => rule.id === 'staff_impersonation_escalation'));
const createdRuleConfig = guard.createRule('guild-rule', {
  name: 'Duplicate message review', detectors: ['duplicate_message'], threshold: 40,
  actions: { notifyStaff: true, pingStaff: false, timeoutUsers: false, deleteMessages: false }
});
const customRule = createdRuleConfig.rules.find(rule => rule.name === 'Duplicate message review');
assert.ok(customRule);
assert.strictEqual(guard.updateRule('guild-rule', customRule.id, { enabled: false }).enabled, false);
assert.strictEqual(guard.deleteRule('guild-rule', customRule.id), true);
let quickTimeoutMs = null;
const quickAction = await actionService.executeQuickAction({
  guild: { id: 'guild-rule', members: { fetch: async () => ({ timeout: async duration => { quickTimeoutMs = duration; } }) } },
  incident: ruleResult.incident,
  action: 'timeout',
  actorId: 'rule-admin'
});
assert.strictEqual(quickAction.status, 'applied');
assert.strictEqual(quickTimeoutMs, 3600000);
guard.updateConfig('guild-rule', {
  publishEnabled: true,
  globalReputation: { publishEnabled: true, consumeEnabled: true, notifyOnJoin: true, alertThreshold: 50 }
});
assert.strictEqual(guard.updateIncidentStatus('guild-rule', ruleResult.incident.incident_id, 'confirmed', 'rule-admin').status, 'confirmed');
const globalReport = guard.publishGlobalReport('guild-rule', ruleResult.incident.incident_id, 'rule-admin');
assert.strictEqual(globalReport.status, 'active');
assert.strictEqual(globalReport.category, 'impersonation');
const globalReputation = guard.getGlobalReputation('rule-attacker');
assert.ok(globalReputation.activeScore > 0);
assert.strictEqual(globalReputation.reportCount, 1);
assert.strictEqual(globalReputation.sourceCount, 1);
const decayedReputation = guard.getGlobalReputation('rule-attacker', { now: Date.now() + (180 * 86400000) });
assert.ok(decayedReputation.activeScore < globalReputation.activeScore);
let globalAlertPayload = null;
guard.updateConfig('guild-recipient', {
  enabled: true,
  alertChannelId: 'recipient-alert-channel',
  globalReputation: { consumeEnabled: true, notifyOnJoin: true, alertThreshold: 50 }
});
const recipientGuild = {
  id: 'guild-recipient',
  channels: { cache: new Map([['recipient-alert-channel', { send: async payload => { globalAlertPayload = payload; } }]]) }
};
const joinResult = await guard.handleMemberJoin({
  id: 'rule-attacker',
  guild: recipientGuild,
  user: { id: 'rule-attacker', username: 'RuleModerator' },
  joinedTimestamp: Date.now()
});
assert.ok(joinResult.globalReputation && joinResult.globalReputation.activeScore > 0);
assert.ok(globalAlertPayload && globalAlertPayload.content.includes('Global Safety Network match'));
assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM guild_guard_global_matches WHERE guild_id = ?').get('guild-recipient').count, 1);
assert.strictEqual(guard.revokeGlobalReport(globalReport.report_id, 'other-admin', 'not owner', 'guild-recipient'), null);
const userSummary = guard.getUserIncidentSummary('guild-rule', 'rule-attacker');
assert.strictEqual(userSummary.total, 1);
assert.strictEqual(userSummary.confirmed, 1);
assert.ok(userSummary.averageRiskScore > 0);
const clearCounts = guard.clearUserHistory('guild-rule', 'rule-attacker');
assert.strictEqual(clearCounts.incidents, 1);
assert.strictEqual(clearCounts.riskProfiles, 1);
assert.strictEqual(clearCounts.globalReportsRevoked, 1);
assert.strictEqual(guard.getUserIncidentSummary('guild-rule', 'rule-attacker').total, 0);
assert.strictEqual(guard.getRiskProfile('guild-rule', 'rule-attacker'), null);
assert.strictEqual(guard.getGlobalReputation('rule-attacker').activeScore, 0);

guard.updateConfig('guild-raid', {
  enabled: true,
  detectors: { raids: { enabled: true, windowSeconds: 60, joinThreshold: 3 } }
});
let raidResult = null;
for (let i = 0; i < 3; i += 1) {
  raidResult = await guard.process({
    id: `join-${i}`,
    guildId: 'guild-raid',
    user: { id: `joiner-${i}`, username: `Joiner${i}` },
    createdTimestamp: Date.now() + i
  }, 'member_join');
}
assert.ok(raidResult.incident && raidResult.signals.some(signal => signal.detector === 'raid_burst'));
assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM raid_events WHERE guild_id = ?').get('guild-raid').count, 1);
let lockedLevel = null;
const lockdownGuild = { id: 'guild-raid', verificationLevel: 'low', setVerificationLevel: async level => { lockedLevel = level; } };
const lockdownAction = await actionService.execute({
  source: { guild: lockdownGuild },
  event: raidResult.event,
  decision: { action: 'quarantine' },
  config: { mode: 'enforce', actions: { enabled: true, lockdownEnabled: true, lockdownVerificationLevel: 'high', lockdownDurationSeconds: 60 } },
  incident: raidResult.incident
});
assert.strictEqual(lockdownAction.status, 'applied');
assert.strictEqual(lockedLevel, 'high');
assert.strictEqual(db.prepare('SELECT status FROM guild_guard_lockdowns WHERE guild_id = ?').get('guild-raid').status, 'active');
db.prepare("UPDATE guild_guard_lockdowns SET restore_at = datetime('now', '-1 second') WHERE guild_id = ?").run('guild-raid');
const restoredLockdowns = await actionService.restoreExpiredLockdowns({ guilds: { cache: new Map([['guild-raid', lockdownGuild]]) } });
assert.strictEqual(restoredLockdowns[0].restored, true);
assert.strictEqual(lockedLevel, 'low');
assert.strictEqual(db.prepare('SELECT status FROM guild_guard_lockdowns WHERE guild_id = ?').get('guild-raid').status, 'restored');

const failedActionIncident = await guard.createTestIncident('guild-action-failure', { id: 'failed-action', author: { id: 'failed-user' } });
const failedTimeout = await actionService.execute({
  source: { member: { timeout: async () => { throw new Error('Missing permissions'); } } },
  event: { guildId: 'guild-action-failure', userId: 'failed-user', eventType: 'message_create' },
  decision: { action: 'timeout', score: 65 },
  config: { mode: 'enforce', actions: { enabled: true, timeoutUsers: true, timeoutSeconds: 60 }, rules: [] },
  incident: failedActionIncident.incident,
  signals: []
});
assert.strictEqual(failedTimeout.status, 'failed', 'failed Discord operations must never be recorded as applied');

const reviewed = guard.updateIncidentStatus('guild-live', liveResult.incident.incident_id, 'reviewed', 'moderator-1');
assert.strictEqual(reviewed.status, 'reviewed');
const falsePositive = guard.reportFalsePositive('guild-live', liveResult.incident.incident_id, 'moderator-1', 'approved test fixture');
assert.strictEqual(falsePositive.status, 'false_positive');
assert.strictEqual(guard.listFalsePositives('guild-live').length, 1);

guard.domainRegistry.add('guild-domain-action', 'trusted-action.example', 'allow');
const domainActionIncident = await guard.createTestIncident('guild-domain-action', {
  id: 'domain-action-incident',
  content: 'Visit https://campaign-block.example/claim https://trusted-action.example/help https://discord.com/channels/1',
  author: { id: 'domain-action-user' }
});
await assert.rejects(
  async () => guard.blockIncidentDomains('guild-domain-action', domainActionIncident.incident.incident_id, 'moderator-1'),
  /Confirm the incident/
);
guard.updateIncidentStatus('guild-domain-action', domainActionIncident.incident.incident_id, 'confirmed', 'moderator-1');
const domainAction = guard.blockIncidentDomains('guild-domain-action', domainActionIncident.incident.incident_id, 'moderator-1');
assert.deepStrictEqual(domainAction.domains, ['campaign-block.example']);
assert.ok(domainAction.skipped.some(item => item.domain === 'trusted-action.example' && item.reason === 'trusted_domain'));
assert.ok(domainAction.skipped.some(item => item.domain === 'discord.com' && item.reason === 'protected_platform_domain'));
assert.ok(guard.domainRegistry.list('guild-domain-action', 'block').includes('campaign-block.example'));
assert.strictEqual(db.prepare("SELECT status FROM actions WHERE incident_id = ? AND action_type = 'moderator:block_domains'").get(domainActionIncident.incident.incident_id).status, 'applied');

const bulkCampaignOne = await guard.createTestIncident('guild-bulk-response', {
  id: 'bulk-campaign-1', channelId: 'bulk-channel', content: 'claim at https://bulk-campaign.example/one', author: { id: 'bulk-user-1' }
});
const bulkCampaignTwo = await guard.createTestIncident('guild-bulk-response', {
  id: 'bulk-campaign-2', channelId: 'bulk-channel', content: 'claim at https://bulk-campaign.example/two', author: { id: 'bulk-user-2' }
});
const campaignClusters = guard.listIncidentCampaigns('guild-bulk-response', 7);
assert.ok(campaignClusters.some(campaign => campaign.domain === 'bulk-campaign.example' && campaign.incidentCount === 2));
const bulkConfirmResult = await guard.executeBulkIncidentResponse('guild-bulk-response', {
  incidentIds: [bulkCampaignOne.incident.incident_id, bulkCampaignTwo.incident.incident_id], action: 'confirm_and_block'
}, 'bulk-moderator');
assert.strictEqual(bulkConfirmResult.applied, 2);
assert.strictEqual(guard.getIncident('guild-bulk-response', bulkCampaignOne.incident.incident_id).status, 'confirmed');
assert.ok(guard.domainRegistry.list('guild-bulk-response', 'block').includes('bulk-campaign.example'));

let bulkDeleted = false;
const bulkDeleteIncident = await guard.createTestIncident('guild-bulk-live-actions', {
  id: 'bulk-delete-message', channelId: 'bulk-delete-channel', content: 'remove me', author: { id: 'bulk-delete-user' }
});
const bulkDeleteGuild = { channels: { cache: new Map([['bulk-delete-channel', { messages: { fetch: async messageId => ({ delete: async () => { bulkDeleted = messageId === 'bulk-delete-message'; } }) } }]]) } };
const bulkDeleteResult = await guard.executeBulkIncidentResponse('guild-bulk-live-actions', {
  incidentIds: [bulkDeleteIncident.incident.incident_id], action: 'delete_messages'
}, 'bulk-moderator', bulkDeleteGuild);
assert.strictEqual(bulkDeleteResult.applied, 1);
assert.strictEqual(bulkDeleted, true);

let bulkTimeoutMs = null;
const bulkTimeoutIncident = await guard.createTestIncident('guild-bulk-live-actions', {
  id: 'bulk-timeout-message', content: 'timeout me', author: { id: 'bulk-timeout-user' }
});
const bulkTimeoutGuild = { members: { fetch: async userId => ({ timeout: async duration => { if (userId === 'bulk-timeout-user') bulkTimeoutMs = duration; } }) } };
const bulkTimeoutResult = await guard.executeBulkIncidentResponse('guild-bulk-live-actions', {
  incidentIds: [bulkTimeoutIncident.incident.incident_id], action: 'timeout_users', timeoutSeconds: 600
}, 'bulk-moderator', bulkTimeoutGuild);
assert.strictEqual(bulkTimeoutResult.applied, 1);
assert.strictEqual(bulkTimeoutMs, 600000);

const memberReport = guard.createMemberReport('guild-member-safety', '772104552019201077', {
  reportedUserId: '<@981204552019201021>',
  description: 'This account sent a private wallet support link and requested a connection.',
  evidenceReference: 'https://discord.com/channels/1/2/3'
});
assert.strictEqual(memberReport.reported_user_id, '981204552019201021');
assert.strictEqual(guard.listMemberReports('guild-member-safety').length, 1);
assert.strictEqual(guard.listMemberReports('other-member-safety').length, 0, 'member reports must remain tenant scoped');
assert.throws(() => guard.createMemberReport('guild-member-safety', '772104552019201077', { description: 'short' }), /at least 10 characters/);
assert.strictEqual(guard.updateMemberReportStatus('other-member-safety', memberReport.report_id, 'reviewed', 'moderator'), null);
assert.strictEqual(guard.updateMemberReportStatus('guild-member-safety', memberReport.report_id, 'reviewed', 'moderator').status, 'reviewed');

let safetyPanelPayload = null;
const safetyPanelGuild = { channels: { cache: new Map([['safety-channel', { id: 'safety-channel', send: async payload => { safetyPanelPayload = payload; return { id: 'safety-message' }; } }]]) } };
const safetyPanelResult = await guard.postMemberSafetyPanel(safetyPanelGuild, 'safety-channel');
assert.strictEqual(safetyPanelResult.messageId, 'safety-message');
assert.ok(safetyPanelPayload.components[0].components.some(button => button.data.custom_id === 'guildguard_report_scam'));

let memberReportAlert = null;
guard.updateConfig('guild-member-safety', { alertChannelId: 'member-report-alert' });
const memberReportGuild = { channels: { cache: new Map([['member-report-alert', { send: async payload => { memberReportAlert = payload; } }]]) } };
const memberReportNotification = await guard.notifyMemberReport(memberReportGuild, memberReport);
assert.strictEqual(memberReportNotification.sent, true);
assert.ok(memberReportAlert.embeds[0].data.title.includes('Member scam report'));
assert.deepStrictEqual(memberReportAlert.allowedMentions.parse, []);

const retentionIncident = await guard.createTestIncident('guild-retention', { id: 'retention-1', author: { id: 'retention-user' } });
db.prepare("UPDATE incidents SET created_at = datetime('now', '-90 days') WHERE incident_id = ?").run(retentionIncident.incident.incident_id);
const retentionResult = guard.purgeExpired('guild-retention', 30);
assert.ok(retentionResult.deleted >= 1);
assert.strictEqual(guard.getIncident('guild-retention', retentionIncident.incident.incident_id), null);
const dashboardSummary = guard.getDashboardSummary('guild-live', 7);
assert.strictEqual(dashboardSummary.guildId, 'guild-live');
assert.ok(Number.isFinite(dashboardSummary.averageRiskScore));
assert.ok(Array.isArray(dashboardSummary.byEventType));
assert.ok(guard.runRetentionSweep().some(result => result.guildId === 'guild-live'));

console.log('Guild Guard foundation tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
