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
const { scoreSignals, decidePolicy, riskLevel } = require('../services/guildGuard/scoring');
const { resolveSafeUrl, isPrivateIp } = require('../services/guildGuard/urlSafety');
const EventWindowStore = require('../services/guildGuard/eventWindow');
const {
  spamFloodDetector,
  duplicateMessageDetector,
  massMentionDetector,
  suspiciousAccountDetector,
  impersonationDetector,
  linkProtectionDetector
} = require('../services/guildGuard/detectors');
const actionService = require('../services/guildGuard/actions');

(async () => {

function tableColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

for (const table of ['guild_guard_configs', 'staff_identities', 'domain_allowlist', 'domain_blocklist', 'risk_profiles', 'risk_signals', 'incidents', 'actions', 'raid_events', 'false_positives']) {
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

const config = guard.getConfig('guild-a');
assert.strictEqual(config.enabled, false, 'Guild Guard must be disabled by default');
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
let ruleAlertPayload = null;
let ruleTimeoutMs = null;
let ruleDeleted = false;
const ruleGuild = {
  id: 'guild-rule',
  channels: { cache: new Map([['rule-alert-channel', { send: async payload => { ruleAlertPayload = payload; } }]]) }
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
assert.deepStrictEqual(ruleAlertPayload.allowedMentions.users, ['rule-staff']);
assert.strictEqual(db.prepare("SELECT status FROM actions WHERE incident_id = ? AND action_type = 'staff_impersonation_escalation'").get(ruleResult.incident.incident_id).status, 'applied');

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
const lockdownAction = await actionService.execute({
  source: { guild: { setVerificationLevel: async level => { lockedLevel = level; } } },
  event: raidResult.event,
  decision: { action: 'quarantine' },
  config: { mode: 'enforce', actions: { enabled: true, lockdownEnabled: true, lockdownVerificationLevel: 'high' } },
  incident: raidResult.incident
});
assert.strictEqual(lockdownAction.status, 'applied');
assert.strictEqual(lockedLevel, 'high');

const reviewed = guard.updateIncidentStatus('guild-live', liveResult.incident.incident_id, 'reviewed', 'moderator-1');
assert.strictEqual(reviewed.status, 'reviewed');
const falsePositive = guard.reportFalsePositive('guild-live', liveResult.incident.incident_id, 'moderator-1', 'approved test fixture');
assert.strictEqual(falsePositive.status, 'false_positive');
assert.strictEqual(guard.listFalsePositives('guild-live').length, 1);

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
