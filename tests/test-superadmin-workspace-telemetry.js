#!/usr/bin/env node

const assert = require('assert');
const createSuperadminTenantOpsRouter = require('../web/routes/superadminTenantOps');

function makeMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function runRouteHandlers(handlers, req, res) {
  let idx = 0;
  const next = async () => {
    const handler = handlers[idx++];
    if (!handler) return;
    await handler(req, res, next);
  };
  await next();
}

function createRouter() {
  const noop = () => {};
  return createSuperadminTenantOpsRouter({
    superadminGuard: (_req, _res, next) => next(),
    tenantService: {
      ensureTenant: () => null,
      listTenants: () => ({ tenants: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 } }),
      getTenant: () => null,
      setTenantPlan: () => ({ success: true }),
      setTenantStatus: () => ({ success: true }),
      setTenantModule: () => ({ success: true }),
      setTenantMockData: () => ({ success: true }),
      updateTenantBranding: () => ({ success: true }),
      logAudit: noop,
      getTenantAuditLogs: () => [],
    },
    entitlementService: {
      getTenantLimitSnapshot: () => ({ plan: 'starter', overrides: {} }),
      getPlanModuleLimits: () => ({}),
      getLimitDefinitions: () => ({}),
      setTenantModuleOverride: () => ({ success: true }),
    },
    billingService: {
      setCryptoReceiptStatus: () => ({ success: true }),
      getExpectedPlanUsd: () => 20,
      verifyCryptoReceiptOnChain: async () => ({ success: true }),
    },
    monetizationTemplateService: {
      listTemplates: () => [],
      previewTemplate: () => ({ success: true }),
      applyTemplate: () => ({ success: true }),
      rollbackLastTemplate: () => ({ success: true }),
    },
    getPlanKeys: () => ['starter', 'growth', 'pro'],
    getPlanPreset: () => ({ label: 'Starter', description: '', billing: null }),
    getPlanCatalog: () => [],
    fetchGuildById: async () => null,
    guildIconUrl: () => null,
    normalizeGuildId: (v) => String(v || '').trim(),
    requestGuildHeader: 'x-guild-id',
    fs: require('fs'),
    path: require('path'),
    logger: {
      info: noop,
      log: noop,
      warn: noop,
      error: noop,
    },
  });
}

async function run() {
  const router = createRouter();
  const layer = router.stack.find((entry) => entry.route && entry.route.path === '/workspace/telemetry');
  assert.ok(layer, 'workspace telemetry route should exist');
  const handlers = layer.route.stack.map((entry) => entry.handle);

  const baseReq = {
    session: { discordUser: { id: 'superadmin-user' } },
    body: {},
    params: {},
    query: {},
    get: () => '',
  };

  const missingEventRes = makeMockRes();
  await runRouteHandlers(handlers, { ...baseReq, body: {} }, missingEventRes);
  assert.strictEqual(missingEventRes.statusCode, 400, 'missing event should fail validation');
  assert.match(String(missingEventRes.body?.error?.message || ''), /event is required/i, 'validation should mention event');

  const okRes = makeMockRes();
  await runRouteHandlers(handlers, {
    ...baseReq,
    body: { event: 'workspace_load_failed', payload: { workspace: 'billing', reason: 'timeout' } },
  }, okRes);
  assert.strictEqual(okRes.statusCode, 200, 'valid telemetry payload should be accepted');
  assert.strictEqual(Boolean(okRes.body?.success), true, 'response should be success envelope');
  assert.strictEqual(Boolean(okRes.body?.data?.recorded), true, 'telemetry response should indicate recording');

  console.log('superadmin workspace telemetry route assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

