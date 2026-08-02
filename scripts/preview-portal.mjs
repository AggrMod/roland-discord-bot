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
app.get('/api/admin/modules/catalog', (_req, res) => res.json({ success: true, modules: [] }));
app.get('/api/admin/plan', (_req, res) => res.json({ success: true, plan: { tier: 'pro' } }));
app.get('/api/public/v1/treasury', (_req, res) => res.json({ success: true, treasury: {} }));
app.get('/api/*', (_req, res) => res.json({ success: true }));
app.use(express.static(publicDir));

app.listen(port, '127.0.0.1', () => {
  console.log(`GuildPilot portal preview: http://127.0.0.1:${port}/app?section=aiassistant`);
});
