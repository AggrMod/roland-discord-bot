import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getPlanCatalog } = require('../config/plans');

const app = express();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(scriptDir, '..', 'web', 'public');
const port = Number(process.env.PORTAL_PREVIEW_PORT || 3037);

function getPreviewRole(req) {
  try {
    const referer = new URL(req.get('referer') || `http://127.0.0.1:${port}/app`);
    const requested = String(referer.searchParams.get('previewRole') || 'admin').toLowerCase();
    return ['user', 'admin', 'superadmin'].includes(requested) ? requested : 'admin';
  } catch (_error) {
    return 'admin';
  }
}

app.use(express.json());
app.get('/app', (_req, res) => res.sendFile(path.join(publicDir, 'portal.html')));
app.get('/api/csrf-token', (_req, res) => res.json({ csrfToken: 'local-preview-token' }));
app.get('/api/features', (_req, res) => res.json({ heistEnabled: true }));
app.get('/api/user/me', (req, res) => {
  const role = getPreviewRole(req);
  const username = role === 'superadmin' ? 'Platform Owner' : role === 'admin' ? 'Community Lead' : 'Community Member';
  res.json({ success: true, user: { discordId: '100000000000000001', username, globalName: username } });
});
app.get('/api/servers/me', (req, res) => {
  const role = getPreviewRole(req);
  const isManager = role === 'admin' || role === 'superadmin';
  res.json({
    success: true,
    managedServers: isManager ? [{ guildId: '100000000000000002', name: 'GuildPilot Preview', permissions: '8' }] : [],
    unmanagedServers: isManager ? [] : [{ guildId: '100000000000000002', name: 'GuildPilot Preview', permissions: '0' }],
  });
});
app.get('/api/superadmin/me', (req, res) => res.json({ success: true, isSuperadmin: getPreviewRole(req) === 'superadmin' }));
app.get('/api/user/is-admin', (req, res) => res.json({ success: true, isAdmin: getPreviewRole(req) !== 'user' }));
app.get('/api/admin/discord/channels', (_req, res) => res.json({
  success: true,
  channels: [
    { id: '100000000000000010', name: 'ask-guildpilot', type: 0 },
    { id: '100000000000000011', name: 'member-support', type: 0 },
    { id: '100000000000000012', name: 'announcements', type: 5 },
  ],
}));
app.get('/api/admin/discord/roles', (_req, res) => res.json({
  success: true,
  roles: [
    { id: '100000000000000020', name: 'Verified Member' },
    { id: '100000000000000021', name: 'Community Team' },
  ],
}));
app.get('/api/admin/aiassistant/settings', (_req, res) => res.json({
  success: true,
  settings: {
    enabled: true,
    mentionEnabled: true,
    provider: 'openai',
    responseVisibility: 'public',
    cooldownSeconds: 12,
    perUserDailyLimit: 20,
    safetyFilterEnabled: true,
    moderationEnabled: true,
    allowedChannelIds: ['100000000000000010', '100000000000000011'],
    allowedRoleIds: ['100000000000000020'],
    memoryEnabled: true,
    memoryWindowMessages: 6,
    publicPersonaKey: 'default_public',
    adminPersonaKey: 'default_admin',
    allowActionSuggestions: true,
  },
}));
app.get('/api/admin/aiassistant/usage', (_req, res) => res.json({
  success: true,
  events: [{ user_id: 'Member 01', provider: 'openai', trigger_source: 'mention', status: 'ok', latency_ms: 842 }],
}));
app.get('/api/admin/aiassistant/usage-summary', (_req, res) => res.json({
  success: true,
  today: { total: 38, ok: 37, errors: 1, avgLatencyMs: 912 },
  byProvider: [{ provider: 'openai', total: 38 }],
  bySource: [{ source: 'mention', total: 31 }, { source: 'slash', total: 7 }],
}));
app.get('/api/admin/aiassistant/knowledge', (_req, res) => res.json({
  success: true,
  docs: [
    { id: 1, title: 'Member handbook', enabled: true, tags: 'rules, support', updatedAt: 'Today' },
    { id: 2, title: 'Mint FAQ', enabled: true, tags: 'nft, mint', updatedAt: 'Yesterday' },
  ],
}));
app.get('/api/admin/aiassistant/channel-policies', (_req, res) => res.json({
  success: true,
  policies: [{
    channelId: '100000000000000010',
    mode: 'mention',
    minConfidence: 35,
    passiveCooldownSeconds: 120,
    passiveMaxPerHour: 6,
  }],
}));
app.get('/api/admin/aiassistant/personas', (_req, res) => res.json({
  success: true,
  personas: [
    { personaKey: 'default_public', displayName: 'Community guide', scope: 'public', enabled: true },
    { personaKey: 'default_admin', displayName: 'Admin copilot', scope: 'admin', enabled: true },
  ],
}));
app.get('/api/admin/aiassistant/role-limits', (_req, res) => res.json({ success: true, limits: [] }));
app.get('/api/admin/aiassistant/ingestion/jobs', (_req, res) => res.json({ success: true, jobs: [] }));
app.get('/api/admin/aiassistant/action-suggestions', (_req, res) => res.json({
  success: true,
  suggestions: [{
    id: 4,
    title: 'Add staking answer',
    reason: 'Members asked about staking',
    actionType: 'knowledge_doc_upsert',
    payload: { title: 'Staking FAQ' },
  }],
}));
app.get('/api/admin/aiassistant/analytics', (_req, res) => res.json({
  success: true,
  days: 7,
  totals: { missingKnowledgeEvents: 3, estimatedTokenUsage: 48210 },
  topMissingTopics: [{ topic: 'staking', count: 3 }],
}));
const previewTenants = [
  {
    guildId: '100000000000000002', guildName: 'GuildPilot Preview', status: 'active', planKey: 'enterprise',
    enabledModulesCount: 17, totalModulesCount: 17, updatedAt: new Date().toISOString(),
    summary: { planLabel: 'Enterprise', moduleCoverage: '17/17', billingStatus: 'active' },
    billing: { provider: 'crypto', subscriptionStatus: 'active', billingInterval: 'yearly', currentPeriodEnd: '2027-08-03T00:00:00.000Z' },
  },
  {
    guildId: '100000000000000003', guildName: 'Neon Syndicate', status: 'active', planKey: 'pro',
    enabledModulesCount: 12, totalModulesCount: 17, updatedAt: new Date(Date.now() - 3600000).toISOString(),
    summary: { planLabel: 'Pro pilot', moduleCoverage: '12/17', billingStatus: 'active', basePlanKey: 'growth', pilotActive: true, pilotEndsAt: '2026-08-10T12:00:00.000Z', warningLevel: 'warning', daysRemaining: 22 },
    billing: { provider: 'stripe', subscriptionStatus: 'active', billingInterval: 'yearly', currentPeriodEnd: '2026-08-25T00:00:00.000Z' },
  },
  {
    guildId: '100000000000000004', guildName: 'Atlas Collective', status: 'suspended', planKey: 'growth',
    enabledModulesCount: 7, totalModulesCount: 17, updatedAt: new Date(Date.now() - 7200000).toISOString(),
    summary: { planLabel: 'Growth', moduleCoverage: '7/17', billingStatus: 'pending' },
    billing: { provider: 'crypto', subscriptionStatus: 'pending', billingInterval: 'monthly', currentPeriodEnd: null },
  },
];
const previewBilling = [
  {
    guildId: '100000000000000002', guildName: 'GuildPilot Preview', provider: 'crypto', subscriptionStatus: 'active',
    billingInterval: 'yearly', currentPeriodEnd: '2027-08-03T00:00:00.000Z', lastPaymentAt: '2026-08-01T12:30:00.000Z',
    verificationStatus: 'verified', pendingReceiptsCount: 0, updatedAt: new Date().toISOString(), latestReceipt: null,
  },
  {
    guildId: '100000000000000003', guildName: 'Neon Syndicate', provider: 'stripe', subscriptionStatus: 'active',
    billingInterval: 'yearly', currentPeriodEnd: '2026-08-25T00:00:00.000Z', lastPaymentAt: '2025-08-25T07:15:00.000Z', basePlanKey: 'growth',
    pilot: { planKey: 'pro', status: 'active', endsAt: '2026-08-10T12:00:00.000Z', active: true }, lifecycle: { daysRemaining: 22, warningLevel: 'warning' },
    verificationStatus: 'verified', pendingReceiptsCount: 0, updatedAt: new Date(Date.now() - 3600000).toISOString(), latestReceipt: null,
  },
  {
    guildId: '100000000000000004', guildName: 'Atlas Collective', provider: 'crypto', subscriptionStatus: 'pending',
    billingInterval: 'monthly', currentPeriodEnd: null, lastPaymentAt: null, verificationStatus: 'pending_review', pendingReceiptsCount: 1,
    updatedAt: new Date(Date.now() - 7200000).toISOString(),
    latestReceipt: { id: 42, status: 'pending', txSignature: '5wPreviewReceiptSignature', tokenSymbol: 'USDC', amount: 39, planKey: 'growth', billingInterval: 'monthly' },
  },
];
app.get('/api/superadmin/workspace/tenants', (_req, res) => res.json({
  success: true,
  tenants: previewTenants,
  pagination: { page: 1, pageSize: 25, total: previewTenants.length, totalPages: 1 },
}));
app.get('/api/superadmin/workspace/billing', (_req, res) => res.json({
  success: true,
  entries: previewBilling,
  pagination: { page: 1, pageSize: 25, total: previewBilling.length, totalPages: 1 },
  sorting: { sortBy: 'updatedAt', sortDir: 'desc' },
}));
app.get('/api/superadmin/workspace/activity', (_req, res) => res.json({
  success: true,
  items: [
    { id: 1, guildId: '100000000000000004', actorId: '100000000000000001', actorDisplayName: 'Platform Owner', action: 'billing.receipt_submitted', createdAt: new Date(Date.now() - 480000).toISOString() },
    { id: 2, guildId: '100000000000000003', actorId: '100000000000000001', actorDisplayName: 'Platform Owner', action: 'tenant.modules_updated', createdAt: new Date(Date.now() - 3600000).toISOString() },
    { id: 3, guildId: '100000000000000002', actorId: 'system', actorDisplayName: 'GuildPilot', action: 'provider.health_recovered', createdAt: new Date(Date.now() - 7200000).toISOString() },
  ],
}));
app.get('/api/superadmin/workspace/plans', (_req, res) => res.json({
  success: true,
  plans: getPlanCatalog(),
}));
app.get('/api/plans/catalog', (_req, res) => res.json({ success: true, plans: getPlanCatalog() }));
app.get('/api/superadmin/admins', (_req, res) => res.json({
  success: true,
  superadmins: [{ userId: '100000000000000001', source: 'env', displayName: 'Platform Owner' }],
}));
app.get('/api/superadmin/global-settings', (_req, res) => res.json({
  success: true,
  settings: {
    aiAssistantDefaultProvider: 'openai', aiAssistantFallbackProvider: 'gemini', aiAssistantDefaultModelOpenai: 'gpt-5.4',
    aiAssistantDefaultModelGemini: 'gemini-2.0-flash', openaiApiKeyConfigured: true, geminiApiKeyConfigured: true,
    xClientId: 'guildpilot-preview', xClientSecretConfigured: true, xBearerTokenConfigured: true, xPollingEnabled: true,
    xPollingIntervalSeconds: 300, chainEmojiMap: { solana: '◎', ethereum: 'Ξ' }, billingOnchainVerifyEnabled: true,
    billingReceiveWallet: 'PreviewBillingWallet11111111111111111111', billingSupportUrl: 'https://guildpilot.app/support',
  },
}));
app.get('/api/superadmin/tenants/:guildId/audit', (req, res) => res.json({
  success: true,
  auditLogs: [
    { id: 1, guild_id: req.params.guildId, actor_id: '100000000000000001', actor_display_name: 'Platform Owner', action: 'tenant.plan_updated', created_at: new Date(Date.now() - 3600000).toISOString() },
    { id: 2, guild_id: req.params.guildId, actor_id: 'system', actor_display_name: 'GuildPilot', action: 'tenant.health_checked', created_at: new Date(Date.now() - 7200000).toISOString() },
  ],
}));
app.get('/api/superadmin/tenants/:guildId', (req, res) => {
  const tenant = previewTenants.find(item => item.guildId === req.params.guildId) || previewTenants[0];
  const enabledModuleKeys = ['verification', 'governance', 'wallettracker', 'aiassistant', 'telegrambridge', 'automessages', 'invites', 'minigames', 'heist', 'ticketing', 'nfttracker', 'tokentracker', 'selfserveroles', 'guildguard', 'branding', 'analytics', 'engagement'];
  res.json({
    success: true,
    tenant: {
      ...tenant,
      modules: Object.fromEntries(enabledModuleKeys.map((key, index) => [key, index < tenant.enabledModulesCount])),
      limits: {},
      branding: { bot_display_name: tenant.guildName, brand_emoji: '✦', brand_color: '#F8B64C', support_url: 'https://guildpilot.app/support' },
      planDescription: tenant.summary?.planLabel ? `${tenant.summary.planLabel} tenant configuration` : '',
      planContract: {
        basePlanKey: tenant.summary?.basePlanKey || tenant.planKey,
        billingInterval: tenant.billing?.billingInterval || null,
        assignmentSource: 'self_service',
        pilot: tenant.summary?.pilotActive ? { planKey: 'pro', startedAt: '2026-08-03T12:00:00.000Z', endsAt: tenant.summary.pilotEndsAt, status: 'active', active: true, note: 'Onboarding conversation' } : null,
      },
      subscription: {
        plan: tenant.planKey,
        basePlan: tenant.summary?.basePlanKey || tenant.planKey,
        basePlanLabel: tenant.summary?.basePlanKey === 'growth' ? 'Growth' : tenant.summary?.planLabel,
        pilot: tenant.summary?.pilotActive ? { planKey: 'pro', endsAt: tenant.summary.pilotEndsAt, status: 'active', active: true } : null,
        alerts: { warningLevel: tenant.summary?.warningLevel || null, daysRemaining: tenant.summary?.daysRemaining ?? null },
      },
      readOnlyManaged: false,
    },
  });
});
app.put('/api/superadmin/tenants/:guildId/plan', (req, res) => {
  const tenant = previewTenants.find(item => item.guildId === req.params.guildId);
  if (tenant && req.body?.plan) {
    tenant.planKey = req.body.plan;
    tenant.summary.planLabel = String(req.body.plan).replace(/^./, char => char.toUpperCase());
    tenant.summary.basePlanKey = req.body.plan;
  }
  res.json({ success: true, tenant });
});
app.post('/api/superadmin/tenants/:guildId/plan-lifecycle', (req, res) => {
  const tenant = previewTenants.find(item => item.guildId === req.params.guildId) || previewTenants[0];
  if (req.body?.action === 'start_pilot') {
    tenant.summary.basePlanKey = tenant.planKey;
    tenant.planKey = 'pro';
    tenant.summary.pilotActive = true;
    tenant.summary.pilotEndsAt = new Date(Date.now() + (Number(req.body.days || 7) * 86400000)).toISOString();
  } else if (req.body?.action === 'end_pilot') {
    tenant.planKey = tenant.summary.basePlanKey || 'starter';
    tenant.summary.pilotActive = false;
  }
  res.json({ success: true, fallbackPlanKey: tenant.summary.basePlanKey || 'starter', tenant });
});
let previewGuildGuardConfig = {
  enabled: true,
  mode: 'enforce',
  preset: 'balanced',
  retentionDays: 30,
  alertChannelId: '100000000000000011',
  exemptions: { botUsers: true, webhookUsers: false },
  detectors: {
    spam: { enabled: true }, duplicateMessages: { enabled: true }, massMention: { enabled: true },
    suspiciousAccount: { enabled: true }, impersonation: { enabled: true }, links: { enabled: true },
    scamLanguage: { enabled: true }, attachments: { enabled: true, scanQrCodes: true }, campaigns: { enabled: true }, raids: { enabled: true }
  },
  actions: { enabled: true, warnUsers: true, deleteMessages: true, timeoutUsers: true, timeoutSeconds: 3600, lockdownEnabled: true, lockdownDurationSeconds: 900 },
  risk: { warning: 35, timeout: 60, quarantine: 80, alert: 25, decayEnabled: true, decayHalfLifeHours: 24 },
  globalReputation: { consumeEnabled: true, publishEnabled: false, notifyOnJoin: true, alertThreshold: 50, halfLifeDays: { spam: 90, unsafe_link: 120, impersonation: 180, scam: 365, suspicious_account: 120 } },
  rules: [{ id: 'preview-rule', name: 'Staff impersonation containment', detectors: ['staff_impersonation'], threshold: 50, enabled: true, actions: { notifyStaff: true, pingStaff: true, timeoutUsers: true, timeoutSeconds: 3600, deleteMessages: true } }]
};
const previewGuildGuardIncidents = [
  { incident_id: 'preview-link', created_at: '2026-08-04 08:12:00', user_id: '829104552019201024', user_incident_count: 2, event_type: 'message_create', risk_score: 88, status: 'confirmed', signals_json: JSON.stringify([{ detector: 'coordinated_link_campaign', score: 75, metadata: { category: 'multi_account_link_campaign', domain: 'guildpiIot.example', userCount: 4, channelCount: 2 } }, { detector: 'lookalike_domain', score: 55 }]), evidence_json: JSON.stringify({ rawContent: 'Claim your free mint at guildpiIot.example', urls: ['https://guildpiIot.example/claim'] }) },
  { incident_id: 'preview-qr', created_at: '2026-08-04 08:04:00', user_id: '772104552019201077', user_incident_count: 1, event_type: 'message_create', risk_score: 90, status: 'open', signals_json: JSON.stringify([{ detector: 'qr_code_link', score: 35, metadata: { category: 'qr_destination', attachmentName: 'wallet-support.png', decodedUrls: ['https://wallet-support.example/claim'] } }, { detector: 'wallet_drainer_language', score: 55, metadata: { category: 'wallet_lure', hasDestination: true } }]), evidence_json: JSON.stringify({ rawContent: 'Urgent: scan this QR code to reconnect your wallet and keep your mint access.', urls: [], attachments: [{ name: 'wallet-support.png', contentType: 'image/png', size: 84213, width: 900, height: 900 }] }) },
  { incident_id: 'preview-identity', created_at: '2026-08-04 07:48:00', user_id: '981204552019201021', user_incident_count: 1, event_type: 'message_create', risk_score: 70, status: 'reviewed', signals_json: JSON.stringify([{ detector: 'staff_impersonation', score: 70 }]), evidence_json: JSON.stringify({ rawContent: 'I am support. DM me to validate your wallet.', urls: [] }) },
  { incident_id: 'preview-raid', created_at: '2026-08-03 23:41:00', user_id: 'Join wave', user_incident_count: 8, event_type: 'member_join', risk_score: 84, status: 'confirmed', signals_json: JSON.stringify([{ detector: 'raid_burst', score: 84 }]), evidence_json: JSON.stringify({ rawContent: '', urls: [] }) }
];
app.get('/api/admin/guildguard/config', (_req, res) => res.json({ success: true, config: previewGuildGuardConfig }));
app.put('/api/admin/guildguard/config', (req, res) => { previewGuildGuardConfig = { ...previewGuildGuardConfig, ...req.body }; res.json({ success: true, config: previewGuildGuardConfig }); });
app.post('/api/admin/guildguard/preset', (req, res) => {
  const preset = ['essential', 'balanced', 'strict'].includes(req.body?.preset) ? req.body.preset : 'balanced';
  previewGuildGuardConfig = { ...previewGuildGuardConfig, preset, enabled: true, mode: preset === 'essential' ? 'monitor' : 'enforce', actions: { ...previewGuildGuardConfig.actions, enabled: preset !== 'essential' } };
  res.json({ success: true, config: previewGuildGuardConfig });
});
app.get('/api/admin/guildguard/health', (_req, res) => res.json({ success: true, health: { ready: true, score: 100, checks: [
  { id: 'bot_connected', label: 'GuildPilot is connected to this server', ok: true, required: true },
  { id: 'alert_channel', label: 'Moderator alert channel selected', ok: true, required: true },
  { id: 'send_alerts', label: 'GuildPilot can send alerts in the selected channel', ok: true, required: true },
  { id: 'manage_messages', label: 'GuildPilot can remove dangerous messages', ok: true, required: true },
  { id: 'moderate_members', label: 'GuildPilot can timeout suspicious members', ok: true, required: true },
  { id: 'manage_server', label: 'GuildPilot can activate and restore raid mode', ok: true, required: true }
] } }));
app.get('/api/admin/guildguard/incidents', (_req, res) => res.json({ success: true, incidents: previewGuildGuardIncidents }));
app.get('/api/admin/guildguard/incidents/:incidentId', (req, res) => {
  const incident = previewGuildGuardIncidents.find(item => item.incident_id === req.params.incidentId) || previewGuildGuardIncidents[0];
  res.json({ success: true, incident, globalReport: null });
});
app.get('/api/admin/guildguard/users/:userId/risk', (req, res) => res.json({
  success: true,
  profile: { user_id: req.params.userId, risk_score: 64, incident_count: 2, confirmed_count: 0, false_positive_count: 0 },
  incidentSummary: { total: 2, open: 1, reviewed: 1, confirmed: 0, falsePositive: 0, averageRiskScore: 72 },
  incidents: previewGuildGuardIncidents.filter(item => item.user_id === req.params.userId),
  globalReputation: { activeScore: 0, reportCount: 0, sourceCount: 0, categoryLabels: [] }
}));
app.post('/api/admin/guildguard/incidents/:incidentId/review', (req, res) => {
  const incident = previewGuildGuardIncidents.find(item => item.incident_id === req.params.incidentId);
  if (incident) incident.status = req.body?.status || 'reviewed';
  res.json({ success: true, incident });
});
app.post('/api/admin/guildguard/incidents/:incidentId/block-domains', (req, res) => res.json({ success: true, result: { incidentId: req.params.incidentId, domains: ['wallet-support.example'], skipped: [] } }));
app.post('/api/admin/guildguard/incidents/:incidentId/false-positive', (req, res) => res.json({ success: true, incidentId: req.params.incidentId, status: 'false_positive' }));
app.get('/api/admin/guildguard/summary', (_req, res) => res.json({ success: true, summary: { total: 12, statuses: { open: 2, reviewed: 7, confirmed: 2, false_positive: 1 }, averageRiskScore: 61, lastIncidentAt: '2026-08-04 08:12:00' } }));
app.get('/api/admin/guildguard/rules', (_req, res) => res.json({ success: true, rules: previewGuildGuardConfig.rules }));
app.get('/api/admin/guildguard/domains', (_req, res) => res.json({ success: true, domains: { allow: ['guildpilot.app', 'discord.com'], block: ['guildpiIot.example'] } }));
app.get('/api/admin/guildguard/staff-identities', (_req, res) => res.json({ success: true, identities: [{ user_id: '100000000000000001', username: 'CommunityLead', display_name: 'Community Lead', managed_by_roles: 1, enabled: 1 }] }));
app.get('/api/admin/guildguard/global-reputation/reports', (_req, res) => res.json({ success: true, reports: [] }));
app.get('/api/admin/modules/catalog', (_req, res) => res.json({ success: true, modules: [] }));
app.get('/api/admin/plan', (_req, res) => res.json({ success: true, plan: 'pro', planLabel: 'Pro pilot', basePlan: 'growth', basePlanLabel: 'Growth', status: 'active', expiresAt: '2026-08-25T00:00:00.000Z', pilot: { planKey: 'pro', active: true, endsAt: '2026-08-10T12:00:00.000Z' }, alerts: { warningLevel: 'warning', daysRemaining: 22 }, billing: { provider: 'stripe', subscriptionStatus: 'active', billingInterval: 'yearly', currentPeriodEnd: '2026-08-25T00:00:00.000Z' }, renewal: { options: [], annualDiscountMonths: 2, earlyRenewalEligible: true }, paymentDetails: { acceptedTokens: ['SOL', 'USDC'], onchainVerificationEnabled: true } }));
app.get('/api/public/v1/treasury', (_req, res) => res.json({ success: true, treasury: {} }));
app.get('/api/*', (_req, res) => res.json({ success: true }));
app.use(express.static(publicDir));

app.listen(port, '127.0.0.1', () => {
  console.log(`GuildPilot portal preview: http://127.0.0.1:${port}/app?section=aiassistant`);
});
