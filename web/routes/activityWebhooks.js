const express = require('express');
const crypto = require('crypto');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');
const { withinBatchLimit, getMaxBatchSize } = require('./webhookGuards');

function createActivityWebhooksRouter({
  logger,
  db,
  nftActivityService,
  trackedWalletsService,
  getActivityWebhookSecret,
  normalizeWebhookSecretHeader,
  timingSafeEquals,
}) {
  const router = express.Router();
  let drainScheduled = false;
  let drainTimer = null;

  const enqueueTokenBatch = (events, source) => {
    const payloadJson = JSON.stringify(events);
    const dedupeKey = crypto.createHash('sha256').update(`${source}\n${payloadJson}`).digest('hex');
    const inboxId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO webhook_event_inbox (inbox_id, event_type, source, payload_json, dedupe_key)
      VALUES (?, 'tracked_wallet_batch', ?, ?, ?)
      ON CONFLICT(dedupe_key) DO NOTHING
    `).run(inboxId, source, payloadJson, dedupeKey);
    const row = db.prepare('SELECT inbox_id, status FROM webhook_event_inbox WHERE dedupe_key = ?').get(dedupeKey);
    return row?.inbox_id || inboxId;
  };

  const processInboxRow = async (row) => {
    const claimed = db.prepare(`
      UPDATE webhook_event_inbox
      SET status = 'processing', updated_at = CURRENT_TIMESTAMP
      WHERE inbox_id = ? AND status = 'pending'
    `).run(row.inbox_id);
    if (claimed.changes !== 1) return;

    try {
      const events = JSON.parse(row.payload_json);
      const summary = await trackedWalletsService.ingestWebhookBatch(events, { source: row.source });
      db.prepare(`
        UPDATE webhook_event_inbox
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP, last_error = NULL
        WHERE inbox_id = ?
      `).run(row.inbox_id);
      const ignoredReasonText = summary.ignored && summary.ignoredReasons
        ? ` reasons=${JSON.stringify(summary.ignoredReasons)}`
        : '';
      logger.log(
        `[activity-inbox] id=${row.inbox_id} received=${summary.received} processed=${summary.processed}`
        + ` ignored=${summary.ignored} failed=${summary.failed} inserted=${summary.insertedEvents}`
        + ` dup=${summary.duplicateEvents} alerts=${summary.sentAlerts}${ignoredReasonText}`
      );
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const delaySeconds = Math.min(1800, Math.max(5, 5 * (2 ** Math.min(attempts - 1, 8))));
      db.prepare(`
        UPDATE webhook_event_inbox
        SET status = 'pending', attempts = ?,
            next_attempt_at = DATETIME('now', ?), last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE inbox_id = ?
      `).run(attempts, `+${delaySeconds} seconds`, String(error?.message || error).slice(0, 500), row.inbox_id);
      logger.error(`[activity-inbox] processing failed id=${row.inbox_id} attempt=${attempts}:`, error);
      scheduleDrain(delaySeconds * 1000);
    }
  };

  const drainInbox = async () => {
    drainScheduled = false;
    drainTimer = null;
    const rows = db.prepare(`
      SELECT * FROM webhook_event_inbox
      WHERE status = 'pending' AND next_attempt_at <= CURRENT_TIMESTAMP
      ORDER BY created_at ASC
      LIMIT 20
    `).all();
    for (const row of rows) {
      await processInboxRow(row);
    }
    const more = db.prepare(`
      SELECT 1 FROM webhook_event_inbox
      WHERE status = 'pending' AND next_attempt_at <= CURRENT_TIMESTAMP
      LIMIT 1
    `).get();
    if (more) {
      scheduleDrain(0);
      return;
    }
    const nextPending = db.prepare(`
      SELECT MAX(1000, MIN(1800000,
        CAST((JULIANDAY(next_attempt_at) - JULIANDAY('now')) * 86400000 AS INTEGER)
      )) AS delay_ms
      FROM webhook_event_inbox
      WHERE status = 'pending'
    `).get();
    if (Number.isFinite(Number(nextPending?.delay_ms))) {
      scheduleDrain(Number(nextPending.delay_ms));
    }
  };

  function scheduleDrain(delayMs = 0) {
    if (drainScheduled) return;
    drainScheduled = true;
    drainTimer = setTimeout(() => {
      drainInbox().catch(error => {
        drainScheduled = false;
        logger.error('[activity-inbox] drain failed:', error);
        scheduleDrain(30000);
      });
    }, Math.max(0, delayMs));
    drainTimer.unref?.();
  }

  db.prepare("UPDATE webhook_event_inbox SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE status = 'processing'").run();
  db.prepare("DELETE FROM webhook_event_inbox WHERE status = 'completed' AND completed_at < DATETIME('now', '-7 days')").run();
  scheduleDrain(0);

  const verifyActivityWebhookAuth = (req) => {
    const configuredSecret = getActivityWebhookSecret();
    if (!configuredSecret) {
      return { ok: false, status: 503, payload: toErrorResponse('Webhook not configured', 'SERVICE_UNAVAILABLE', null, { error: 'Webhook not configured' }) };
    }

    const providedRaw = req.headers['authorization'] || req.headers['x-webhook-secret'];
    const provided = normalizeWebhookSecretHeader(providedRaw);
    if (!provided || !timingSafeEquals(provided, configuredSecret)) {
      return { ok: false, status: 401, payload: toErrorResponse('Unauthorized', 'UNAUTHORIZED') };
    }

    return { ok: true };
  };

  router.post('/api/webhooks/nft-activity', async (req, res) => {
    try {
      const auth = verifyActivityWebhookAuth(req);
      if (!auth.ok) {
        return res.status(auth.status).json(auth.payload);
      }

      const events = Array.isArray(req.body) ? req.body : [req.body];
      if (!withinBatchLimit(events.length)) {
        return res.status(413).json(toErrorResponse(`Too many events in one request (max ${getMaxBatchSize()})`, 'PAYLOAD_TOO_LARGE'));
      }
      let nftProcessed = 0;
      let nftIgnored = 0;
      for (const event of events) {
        const result = nftActivityService.ingestEvent(event, 'webhook');
        if (result.ignored) nftIgnored += 1;
        else if (result.success) nftProcessed += 1;
      }

      const inboxId = enqueueTokenBatch(events, 'webhook');
      scheduleDrain(0);

      return res.json(toSuccessResponse({
        nft: { received: events.length, processed: nftProcessed, ignored: nftIgnored },
        token: { queued: events.length, inboxId },
      }));
    } catch (routeError) {
      logger.error('Error in nft activity webhook:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  router.post('/api/webhooks/token-activity', async (req, res) => {
    try {
      const auth = verifyActivityWebhookAuth(req);
      if (!auth.ok) {
        return res.status(auth.status).json(auth.payload);
      }

      const events = Array.isArray(req.body) ? req.body : [req.body];
      if (!withinBatchLimit(events.length)) {
        return res.status(413).json(toErrorResponse(`Too many events in one request (max ${getMaxBatchSize()})`, 'PAYLOAD_TOO_LARGE'));
      }
      const inboxId = enqueueTokenBatch(events, 'webhook-token-only');
      scheduleDrain(0);
      return res.json(toSuccessResponse({ queued: events.length, inboxId }));
    } catch (routeError) {
      logger.error('Error in token activity webhook:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createActivityWebhooksRouter;
