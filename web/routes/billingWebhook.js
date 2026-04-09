const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createBillingWebhookRouter({
  logger,
  db,
  tenantService,
  billingService,
  normalizeWebhookValue,
  timingSafeEquals,
  hashWebhookPayload,
  stableJson,
}) {
  const router = express.Router();

  const normalizeEntitlementPayload = (payload) => ({
    eventType: normalizeWebhookValue(payload.eventType),
    customerId: normalizeWebhookValue(payload.customerId),
    guildId: normalizeWebhookValue(payload.guildId),
    plan: normalizeWebhookValue(payload.plan),
    status: normalizeWebhookValue(payload.status),
    provider: normalizeWebhookValue(payload.provider),
    subscriptionId: normalizeWebhookValue(payload.subscriptionId || payload.subscription_id),
    billingInterval: normalizeWebhookValue(payload.billingInterval || payload.billing_interval || payload.interval),
    currentPeriodStart: payload.currentPeriodStart ?? payload.current_period_start ?? payload.periodStart ?? null,
    currentPeriodEnd: payload.currentPeriodEnd ?? payload.current_period_end ?? payload.periodEnd ?? payload.expiresAt ?? null,
    cancelAtPeriodEnd: payload.cancelAtPeriodEnd ?? payload.cancel_at_period_end,
    canceledAt: payload.canceledAt ?? payload.canceled_at ?? payload.cancelledAt ?? payload.cancelled_at ?? null,
    lastPaymentAt: payload.lastPaymentAt ?? payload.last_payment_at ?? payload.paidAt ?? payload.paymentAt ?? null,
    paymentStatus: normalizeWebhookValue(payload.paymentStatus || payload.payment_status),
    metadata: payload.metadata === undefined ? undefined : payload.metadata
  });

  router.post('/api/billing/webhook/entitlement', (req, res) => {
    try {
      const configuredSecret = process.env.ENTITLEMENT_WEBHOOK_SECRET;
      if (!configuredSecret) {
        return res.status(503).json(toErrorResponse('Entitlement webhook is not configured', 'SERVICE_UNAVAILABLE'));
      }

      const providedSecret = normalizeWebhookValue(req.get('x-entitlement-secret'));
      if (!timingSafeEquals(providedSecret, configuredSecret)) {
        return res.status(401).json(toErrorResponse('Unauthorized', 'UNAUTHORIZED'));
      }

      const payload = req.body && typeof req.body === 'object' ? req.body : {};
      const normalizedPayload = normalizeEntitlementPayload(payload);
      const payloadHash = hashWebhookPayload(normalizedPayload);

      const existingEvent = db.prepare(`
        SELECT id, result
        FROM billing_entitlement_events
        WHERE payload_hash = ?
      `).get(payloadHash);

      if (existingEvent) {
        return res.json(toSuccessResponse({
          duplicate: true,
          eventId: existingEvent.id,
          result: existingEvent.result
        }));
      }

      const normalizedEventType = normalizedPayload.eventType.toLowerCase();
      const normalizedStatus = normalizedPayload.status.toLowerCase();
      const normalizedPlan = normalizeWebhookValue(normalizedPayload.plan).toLowerCase();
      const successMarkers = new Set(['approved', 'success', 'paid', 'active', 'trialing']);
      const suspendedMarkers = new Set(['cancelled', 'canceled', 'past_due', 'suspended', 'unpaid', 'payment_failed', 'expired']);
      const actionMarkers = new Set([normalizedEventType, normalizedStatus].filter(Boolean));
      const shouldApplyPlan = Array.from(actionMarkers).some(marker => successMarkers.has(marker));
      const shouldSuspend = Array.from(actionMarkers).some(marker => suspendedMarkers.has(marker));

      let result = 'ignored';

      if (!normalizedPayload.guildId || !normalizedPayload.eventType || !normalizedPayload.status) {
        result = 'invalid:missing_required_fields';
      } else if (shouldApplyPlan) {
        if (!normalizedPayload.plan) {
          result = 'invalid:missing_plan';
        } else {
          const planResult = tenantService.setTenantPlan(
            normalizedPayload.guildId,
            normalizedPayload.plan,
            'billing-entitlement-webhook'
          );

          if (!planResult.success) {
            result = `error:${planResult.message || 'plan_update_failed'}`;
          } else {
            result = `applied_plan:${normalizedPlan}`;
            tenantService.setTenantStatus(
              normalizedPayload.guildId,
              'active',
              'billing-entitlement-webhook'
            );
          }
        }
      } else if (shouldSuspend) {
        const downgradeResult = tenantService.setTenantPlan(
          normalizedPayload.guildId,
          'starter',
          'billing-entitlement-webhook'
        );
        const statusResult = tenantService.setTenantStatus(
          normalizedPayload.guildId,
          'suspended',
          'billing-entitlement-webhook'
        );

        if (!downgradeResult.success) {
          result = `error:${downgradeResult.message || 'downgrade_failed'}`;
        } else if (!statusResult.success) {
          result = `error:${statusResult.message || 'status_update_failed'}`;
        } else {
          result = 'suspended:downgraded_to_starter';
        }
      }

      try {
        billingService.upsertFromEntitlement(normalizedPayload, result);
      } catch (billingError) {
        logger.warn('Billing metadata upsert failed:', billingError?.message || billingError);
      }

      const insertResult = db.prepare(`
        INSERT INTO billing_entitlement_events (
          guild_id,
          customer_id,
          event_type,
          payload_hash,
          payload_json,
          result,
          processed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        normalizedPayload.guildId || null,
        normalizedPayload.customerId || null,
        normalizedPayload.eventType || null,
        payloadHash,
        JSON.stringify(stableJson(normalizedPayload)),
        result
      );

      return res.json(toSuccessResponse({
        eventId: insertResult.lastInsertRowid,
        result
      }));
    } catch (routeError) {
      if (routeError && String(routeError.message || routeError).includes('UNIQUE constraint failed: billing_entitlement_events.payload_hash')) {
        const payload = req.body && typeof req.body === 'object' ? req.body : {};
        const normalizedPayload = normalizeEntitlementPayload(payload);
        const duplicateHash = hashWebhookPayload(normalizedPayload);
        const duplicateEvent = db.prepare(`
          SELECT id, result
          FROM billing_entitlement_events
          WHERE payload_hash = ?
        `).get(duplicateHash);

        return res.json(toSuccessResponse({
          duplicate: true,
          eventId: duplicateEvent?.id || null,
          result: duplicateEvent?.result || 'duplicate'
        }));
      }

      logger.error('Error in entitlement webhook:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createBillingWebhookRouter;
