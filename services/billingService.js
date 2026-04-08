const db = require('../database/db');
const tenantService = require('./tenantService');
const { getPlanPreset, normalizePlanKey } = require('../config/plans');

function normalizeString(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeLower(value) {
  const str = normalizeString(value);
  return str ? str.toLowerCase() : null;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y';
}

function normalizeInterval(value) {
  const normalized = normalizeLower(value);
  if (!normalized) return null;
  if (['month', 'monthly', 'm'].includes(normalized)) return 'monthly';
  if (['year', 'yearly', 'annual', 'annually', 'y'].includes(normalized)) return 'yearly';
  return null;
}

function toIsoDate(value) {
  if (value === undefined || value === null || value === '') return null;

  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  const text = String(value).trim();
  if (!text) return null;

  if (/^\d+$/.test(text)) {
    const num = Number(text);
    if (!Number.isFinite(num)) return null;
    const ms = num > 1e12 ? num : num * 1000;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function safeJsonParse(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function envValue(keys = []) {
  for (const key of keys) {
    const value = normalizeString(process.env[key]);
    if (value) return value;
  }
  return null;
}

function applyTemplate(url, params = {}) {
  const normalized = normalizeString(url);
  if (!normalized) return null;

  let output = normalized;
  output = output.replace(/\{GUILD_ID\}/g, encodeURIComponent(String(params.guildId || '')));
  output = output.replace(/\{PLAN\}/g, encodeURIComponent(String(params.planKey || '')));
  output = output.replace(/\{INTERVAL\}/g, encodeURIComponent(String(params.interval || '')));

  try {
    const parsed = new URL(output);
    if (params.guildId && !parsed.searchParams.get('guildId')) parsed.searchParams.set('guildId', String(params.guildId));
    if (params.planKey && !parsed.searchParams.get('plan')) parsed.searchParams.set('plan', String(params.planKey));
    if (params.interval && !parsed.searchParams.get('interval')) parsed.searchParams.set('interval', String(params.interval));
    return parsed.toString();
  } catch (_error) {
    return output;
  }
}

class BillingService {
  getTenantBilling(guildId) {
    const context = tenantService.getTenantContext(guildId);
    const tenantId = context?.tenant?.id;
    if (!tenantId) return null;

    const row = db.prepare(`
      SELECT *
      FROM tenant_billing
      WHERE tenant_id = ?
      LIMIT 1
    `).get(tenantId);

    if (!row) return null;

    return {
      customerId: row.customer_id || null,
      subscriptionId: row.subscription_id || null,
      provider: row.provider || null,
      subscriptionStatus: row.subscription_status || null,
      billingInterval: row.billing_interval || null,
      currentPeriodStart: row.current_period_start || null,
      currentPeriodEnd: row.current_period_end || null,
      cancelAtPeriodEnd: row.cancel_at_period_end === 1,
      canceledAt: row.canceled_at || null,
      lastPaymentAt: row.last_payment_at || null,
      lastPaymentStatus: row.last_payment_status || null,
      metadata: safeJsonParse(row.metadata_json),
      updatedAt: row.updated_at || null,
      createdAt: row.created_at || null
    };
  }

  upsertFromEntitlement(payload, result = 'ignored') {
    const guildId = normalizeString(payload?.guildId);
    if (!guildId) return { success: false, message: 'guildId is required' };

    const context = tenantService.ensureTenant(guildId);
    const tenantId = context?.tenant?.id;
    if (!tenantId) return { success: false, message: 'Tenant not found' };

    const metadata = payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
    const existingRow = db.prepare('SELECT * FROM tenant_billing WHERE tenant_id = ? LIMIT 1').get(tenantId);
    const existingMeta = safeJsonParse(existingRow?.metadata_json);

    const customerId = normalizeString(pickFirst(
      payload.customerId,
      payload.customer_id,
      metadata.customerId,
      metadata.customer_id,
      metadata.stripeCustomerId
    ));
    const subscriptionId = normalizeString(pickFirst(
      payload.subscriptionId,
      payload.subscription_id,
      metadata.subscriptionId,
      metadata.subscription_id,
      metadata.subscription
    ));
    const provider = normalizeLower(pickFirst(
      payload.provider,
      metadata.provider,
      metadata.source,
      metadata.gateway
    ));
    const subscriptionStatus = normalizeLower(pickFirst(
      payload.subscriptionStatus,
      payload.subscription_status,
      payload.status,
      metadata.subscriptionStatus,
      metadata.subscription_status,
      metadata.status
    ));
    const billingInterval = normalizeInterval(pickFirst(
      payload.billingInterval,
      payload.billing_interval,
      payload.interval,
      metadata.billingInterval,
      metadata.billing_interval,
      metadata.interval,
      metadata.billingCycle
    ));
    const currentPeriodStart = toIsoDate(pickFirst(
      payload.currentPeriodStart,
      payload.current_period_start,
      payload.periodStart,
      payload.startAt,
      payload.startsAt,
      metadata.currentPeriodStart,
      metadata.current_period_start,
      metadata.periodStart,
      metadata.startAt,
      metadata.startsAt
    ));
    const currentPeriodEnd = toIsoDate(pickFirst(
      payload.currentPeriodEnd,
      payload.current_period_end,
      payload.periodEnd,
      payload.endAt,
      payload.expiresAt,
      payload.expiry,
      payload.validUntil,
      metadata.currentPeriodEnd,
      metadata.current_period_end,
      metadata.periodEnd,
      metadata.endAt,
      metadata.expiresAt,
      metadata.expiry,
      metadata.validUntil
    ));
    const canceledAt = toIsoDate(pickFirst(
      payload.canceledAt,
      payload.canceled_at,
      payload.cancelledAt,
      payload.cancelled_at,
      metadata.canceledAt,
      metadata.canceled_at,
      metadata.cancelledAt,
      metadata.cancelled_at
    ));
    const lastPaymentAt = toIsoDate(pickFirst(
      payload.lastPaymentAt,
      payload.last_payment_at,
      payload.paidAt,
      payload.paymentAt,
      metadata.lastPaymentAt,
      metadata.last_payment_at,
      metadata.paidAt,
      metadata.paymentAt,
      metadata.invoicePaidAt
    ));
    const lastPaymentStatus = normalizeLower(pickFirst(
      payload.paymentStatus,
      payload.payment_status,
      metadata.paymentStatus,
      metadata.payment_status,
      metadata.invoiceStatus,
      payload.status
    ));

    let cancelAtPeriodEnd = existingRow?.cancel_at_period_end === 1 ? 1 : 0;
    if (
      payload?.cancelAtPeriodEnd !== undefined
      || payload?.cancel_at_period_end !== undefined
      || metadata?.cancelAtPeriodEnd !== undefined
      || metadata?.cancel_at_period_end !== undefined
    ) {
      cancelAtPeriodEnd = normalizeBoolean(pickFirst(
        payload.cancelAtPeriodEnd,
        payload.cancel_at_period_end,
        metadata.cancelAtPeriodEnd,
        metadata.cancel_at_period_end
      )) ? 1 : 0;
    }

    const nextMeta = {
      ...existingMeta,
      lastWebhookEventType: normalizeString(payload?.eventType) || existingMeta.lastWebhookEventType || null,
      lastWebhookResult: normalizeString(result) || existingMeta.lastWebhookResult || null,
      lastWebhookAt: new Date().toISOString(),
    };
    if (Object.keys(metadata).length > 0) {
      nextMeta.lastWebhookMetadata = metadata;
    }
    const metadataJson = JSON.stringify(nextMeta);

    const merged = {
      customer_id: customerId || existingRow?.customer_id || null,
      subscription_id: subscriptionId || existingRow?.subscription_id || null,
      provider: provider || existingRow?.provider || null,
      subscription_status: subscriptionStatus || existingRow?.subscription_status || null,
      billing_interval: billingInterval || existingRow?.billing_interval || null,
      current_period_start: currentPeriodStart || existingRow?.current_period_start || null,
      current_period_end: currentPeriodEnd || existingRow?.current_period_end || null,
      cancel_at_period_end: cancelAtPeriodEnd,
      canceled_at: canceledAt || existingRow?.canceled_at || null,
      last_payment_at: lastPaymentAt || existingRow?.last_payment_at || null,
      last_payment_status: lastPaymentStatus || existingRow?.last_payment_status || null,
      metadata_json: metadataJson
    };

    db.prepare(`
      INSERT INTO tenant_billing (
        tenant_id,
        customer_id,
        subscription_id,
        provider,
        subscription_status,
        billing_interval,
        current_period_start,
        current_period_end,
        cancel_at_period_end,
        canceled_at,
        last_payment_at,
        last_payment_status,
        metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        customer_id = excluded.customer_id,
        subscription_id = excluded.subscription_id,
        provider = excluded.provider,
        subscription_status = excluded.subscription_status,
        billing_interval = excluded.billing_interval,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        canceled_at = excluded.canceled_at,
        last_payment_at = excluded.last_payment_at,
        last_payment_status = excluded.last_payment_status,
        metadata_json = excluded.metadata_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      tenantId,
      merged.customer_id,
      merged.subscription_id,
      merged.provider,
      merged.subscription_status,
      merged.billing_interval,
      merged.current_period_start,
      merged.current_period_end,
      merged.cancel_at_period_end,
      merged.canceled_at,
      merged.last_payment_at,
      merged.last_payment_status,
      merged.metadata_json
    );

    return { success: true };
  }

  resolveCheckoutUrl({ provider, planKey, interval, guildId }) {
    const providerKey = String(provider || '').trim().toUpperCase();
    const normalizedPlan = normalizePlanKey(planKey);
    const planKeyUpper = String(normalizedPlan || '').toUpperCase();
    const normalizedInterval = normalizeInterval(interval);
    const intervalUpper = String(normalizedInterval || '').toUpperCase();

    if (!providerKey || !planKeyUpper) return null;

    const url = envValue([
      `BILLING_${providerKey}_CHECKOUT_${planKeyUpper}_${intervalUpper}`,
      `BILLING_CHECKOUT_${providerKey}_${planKeyUpper}_${intervalUpper}`,
      `BILLING_${providerKey}_CHECKOUT_${planKeyUpper}`,
      `BILLING_CHECKOUT_${providerKey}_${planKeyUpper}`,
      `BILLING_${providerKey}_CHECKOUT_URL`,
      `BILLING_CHECKOUT_${providerKey}_URL`
    ]);

    if (!url) return null;
    return applyTemplate(url, { guildId, planKey: normalizedPlan, interval: normalizedInterval || 'monthly' });
  }

  resolveManageUrl({ provider, guildId, planKey, interval }) {
    const providerKey = String(provider || '').trim().toUpperCase();
    const url = envValue([
      `BILLING_${providerKey}_MANAGE_URL`,
      `BILLING_MANAGE_${providerKey}_URL`,
      'BILLING_MANAGE_URL'
    ]);
    if (!url) return null;
    return applyTemplate(url, { guildId, planKey, interval });
  }

  getRenewalOptions({ guildId, planKey, interval }) {
    const normalizedPlan = normalizePlanKey(planKey);
    if (!normalizedPlan || normalizedPlan === 'starter' || normalizedPlan === 'enterprise') {
      return [];
    }

    const preferredInterval = normalizeInterval(interval) || 'monthly';
    const intervals = preferredInterval === 'yearly' ? ['yearly', 'monthly'] : ['monthly', 'yearly'];
    const providers = ['stripe', 'crypto'];
    const options = [];

    for (const provider of providers) {
      for (const billingInterval of intervals) {
        const url = this.resolveCheckoutUrl({
          provider,
          planKey: normalizedPlan,
          interval: billingInterval,
          guildId
        });
        if (!url) continue;
        options.push({
          provider,
          interval: billingInterval,
          url,
          label: `${provider === 'stripe' ? 'Stripe' : 'Crypto'} ${billingInterval === 'yearly' ? 'Yearly' : 'Monthly'}`
        });
      }
    }

    return options;
  }

  enforceSubscriptionExpiry({ graceMinutes = 1440, batchSize = 50 } = {}) {
    const normalizedGrace = Math.max(0, Number(graceMinutes) || 0);
    const normalizedBatch = Math.max(1, Math.min(200, Number(batchSize) || 50));
    const cutoff = new Date(Date.now() - (normalizedGrace * 60 * 1000)).toISOString();

    const activeMarkers = ['active', 'approved', 'success', 'paid', 'trialing'];
    const placeholders = activeMarkers.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT
        t.guild_id AS guild_id,
        t.plan_key AS plan_key,
        t.status AS tenant_status,
        tb.subscription_status AS subscription_status,
        tb.current_period_end AS current_period_end
      FROM tenants t
      INNER JOIN tenant_billing tb ON tb.tenant_id = t.id
      WHERE LOWER(COALESCE(t.plan_key, 'starter')) != 'starter'
        AND LOWER(COALESCE(t.status, 'active')) = 'active'
        AND tb.current_period_end IS NOT NULL
        AND datetime(tb.current_period_end) <= datetime(?)
        AND LOWER(COALESCE(tb.subscription_status, '')) NOT IN (${placeholders})
      ORDER BY datetime(tb.current_period_end) ASC
      LIMIT ?
    `).all(cutoff, ...activeMarkers, normalizedBatch);

    let downgraded = 0;
    let errors = 0;

    for (const row of rows) {
      try {
        const guildId = normalizeString(row.guild_id);
        if (!guildId) continue;

        const downgrade = tenantService.setTenantPlan(guildId, 'starter', 'billing-expiry-sweep');
        const suspend = tenantService.setTenantStatus(guildId, 'suspended', 'billing-expiry-sweep');
        if (!downgrade.success || !suspend.success) {
          errors += 1;
          continue;
        }

        db.prepare(`
          UPDATE tenant_billing
          SET subscription_status = 'expired',
              updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = (SELECT id FROM tenants WHERE guild_id = ? LIMIT 1)
        `).run(guildId);

        downgraded += 1;
      } catch (_error) {
        errors += 1;
      }
    }

    return {
      scanned: rows.length,
      downgraded,
      errors,
      cutoff
    };
  }

  getSupportUrl(guildId) {
    const envSupport = envValue(['BILLING_SUPPORT_URL', 'SUPPORT_URL']);
    if (envSupport) {
      return applyTemplate(envSupport, { guildId, planKey: null, interval: null });
    }

    const context = tenantService.getTenantContext(guildId);
    return context?.branding?.support_url || null;
  }

  getSubscriptionSnapshot(guildId) {
    const context = tenantService.getTenantContext(guildId);
    const planKey = context?.planKey || 'starter';
    const planPreset = getPlanPreset(planKey);
    const billing = this.getTenantBilling(guildId);
    const billingInterval = billing?.billingInterval || 'monthly';
    const renewalOptions = this.getRenewalOptions({
      guildId,
      planKey,
      interval: billingInterval
    });

    const manageUrl = billing?.provider
      ? this.resolveManageUrl({
        provider: billing.provider,
        guildId,
        planKey,
        interval: billingInterval
      })
      : null;

    return {
      plan: planKey,
      planLabel: context?.planLabel || planPreset?.label || planKey,
      status: context?.status || 'active',
      expiresAt: billing?.currentPeriodEnd || null,
      billing: billing ? {
        ...billing,
        manageUrl: manageUrl || null
      } : null,
      renewal: {
        annualDiscountPct: Number(planPreset?.billing?.annualDiscountPct || 15),
        supportUrl: this.getSupportUrl(guildId),
        options: renewalOptions
      }
    };
  }
}

module.exports = new BillingService();
