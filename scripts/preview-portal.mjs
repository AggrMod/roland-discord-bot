import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    summary: { planLabel: 'Pro', moduleCoverage: '12/17', billingStatus: 'active' },
    billing: { provider: 'stripe', subscriptionStatus: 'active', billingInterval: 'monthly', currentPeriodEnd: '2026-09-03T00:00:00.000Z' },
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
    billingInterval: 'monthly', currentPeriodEnd: '2026-09-03T00:00:00.000Z', lastPaymentAt: '2026-08-03T07:15:00.000Z',
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
  plans: [
    { key: 'starter', label: 'Free', description: 'Core community tools' },
    { key: 'growth', label: 'Growth', description: 'Growing community operations' },
    { key: 'pro', label: 'Pro', description: 'Full automation suite' },
    { key: 'enterprise', label: 'Enterprise', description: 'Custom platform operations' },
  ],
}));
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
      readOnlyManaged: false,
    },
  });
});
app.get('/api/admin/modules/catalog', (_req, res) => res.json({ success: true, modules: [] }));
app.get('/api/admin/plan', (_req, res) => res.json({ success: true, plan: { tier: 'pro' } }));
app.get('/api/public/v1/treasury', (_req, res) => res.json({ success: true, treasury: {} }));
app.get('/api/*', (_req, res) => res.json({ success: true }));
app.use(express.static(publicDir));

app.listen(port, '127.0.0.1', () => {
  console.log(`GuildPilot portal preview: http://127.0.0.1:${port}/app?section=aiassistant`);
});
