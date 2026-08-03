#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDbPath = path.join(os.tmpdir(), `guildpilot-billing-lifecycle-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.MULTITENANT_ENABLED = 'false';

const db = require('../database/db');
const tenantService = require('../services/tenantService');
const entitlementService = require('../services/entitlementService');
const billingService = require('../services/billingService');
const { computeCustomPlanMonthlyUsd, getPlanCatalog } = require('../config/plans');

function cleanup() {
  try { db.close(); } catch (_error) {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${tempDbPath}${suffix}`); } catch (_error) {}
  }
}

function run() {
  const guildId = '1468176555091034265';
  const tenant = tenantService.ensureTenant(guildId, 'Billing Lifecycle Test');
  const tenantId = tenant?.tenant?.id;
  assert.ok(tenantId, 'tenant scaffold should be created');

  const catalog = getPlanCatalog();
  assert.deepStrictEqual(catalog.map(plan => plan.key), ['starter', 'growth', 'pro', 'custom', 'enterprise']);
  assert.ok(catalog.find(plan => plan.key === 'custom')?.customBuilder?.modules?.length >= 15, 'custom plan should publish its module catalog');

  const standardAnnual = billingService.getPlanPriceQuote({ planKey: 'growth', billingInterval: 'yearly' });
  assert.strictEqual(standardAnnual.success, true);
  assert.strictEqual(standardAnnual.billedMonths, 10, 'standard annual checkout should bill ten months');
  assert.strictEqual(standardAnnual.totalUsd, 199.9);

  const renewalEnd = new Date(Date.now() + (30 * 86400000)).toISOString();
  db.prepare(`
    INSERT INTO tenant_billing (tenant_id, provider, subscription_status, billing_interval, current_period_end)
    VALUES (?, 'stripe', 'active', 'yearly', ?)
  `).run(tenantId, renewalEnd);
  const earlyRenewal = billingService.getPlanPriceQuote({ guildId, planKey: 'growth', billingInterval: 'yearly' });
  assert.strictEqual(earlyRenewal.earlyRenewalEligible, true);
  assert.strictEqual(earlyRenewal.billedMonths, 9, 'early annual renewal should bill nine months');
  assert.strictEqual(earlyRenewal.totalUsd, 179.91);

  const growth = billingService.assignBasePlan(guildId, { planKey: 'growth', billingInterval: 'yearly', source: 'test' }, 'test');
  assert.strictEqual(growth.success, true);
  assert.strictEqual(tenantService.getTenant(guildId).planKey, 'growth');

  const pilot = billingService.startPilot(guildId, { days: 7, note: 'Lifecycle test' }, 'test');
  assert.strictEqual(pilot.success, true);
  assert.strictEqual(tenantService.getTenant(guildId).planKey, 'pro', 'pilot should make Pro the effective plan');
  assert.strictEqual(billingService.getPlanContract(guildId).basePlanKey, 'growth', 'pilot should preserve paid fallback');

  db.prepare(`
    UPDATE tenant_plan_contracts
    SET pilot_ends_at = datetime('now', '-1 minute')
    WHERE tenant_id = ?
  `).run(tenantId);
  const pilotSweep = billingService.enforcePilotExpiry();
  assert.strictEqual(pilotSweep.reverted, 1);
  assert.strictEqual(tenantService.getTenant(guildId).planKey, 'growth', 'expired pilot should restore Growth');

  const customInput = {
    modules: [
      { key: 'verification', capacity: 'growth' },
      { key: 'aiassistant', capacity: 'pro' },
      { key: 'automessages', capacity: 'starter' },
    ],
  };
  const customPrice = computeCustomPlanMonthlyUsd(customInput);
  assert.strictEqual(customPrice.success, true);
  assert.ok(customPrice.monthlyUsd > 9.99);
  const custom = billingService.assignBasePlan(guildId, { planKey: 'custom', customPlan: customInput, source: 'test' }, 'test');
  assert.strictEqual(custom.success, true);
  const customTenant = tenantService.getTenant(guildId);
  assert.strictEqual(customTenant.planKey, 'custom');
  assert.strictEqual(customTenant.modules.verification, true);
  assert.strictEqual(customTenant.modules.aiassistant, true);
  assert.strictEqual(customTenant.modules.governance, false);
  assert.strictEqual(entitlementService.getEffectiveLimit(guildId, 'aiassistant', 'max_requests_per_day'), 1000);

  billingService.assignBasePlan(guildId, { planKey: 'growth', billingInterval: 'monthly', source: 'test' }, 'test');
  db.prepare(`
    UPDATE tenant_billing
    SET subscription_status = 'approved', current_period_end = datetime('now', '-2 days')
    WHERE tenant_id = ?
  `).run(tenantId);
  const expiry = billingService.enforceSubscriptionExpiry({ graceMinutes: 0 });
  assert.strictEqual(expiry.downgraded, 1);
  const expiredTenant = tenantService.getTenant(guildId);
  assert.strictEqual(expiredTenant.planKey, 'starter', 'expired paid plan should fall back to Free');
  assert.strictEqual(expiredTenant.status, 'active', 'Free fallback should remain usable instead of suspending the tenant');
}

try {
  run();
  console.log('billing plan lifecycle assertions passed');
} catch (error) {
  console.error('billing plan lifecycle test failed:', error);
  process.exitCode = 1;
} finally {
  cleanup();
}
