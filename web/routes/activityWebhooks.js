const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createActivityWebhooksRouter({
  logger,
  nftActivityService,
  trackedWalletsService,
  getActivityWebhookSecret,
  normalizeWebhookSecretHeader,
  timingSafeEquals,
}) {
  const router = express.Router();

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
      let nftProcessed = 0;
      let nftIgnored = 0;
      for (const event of events) {
        const result = nftActivityService.ingestEvent(event, 'webhook');
        if (result.ignored) nftIgnored += 1;
        else if (result.success) nftProcessed += 1;
      }

      setImmediate(() => {
        trackedWalletsService.ingestWebhookBatch(events, { source: 'webhook' })
          .then(tokenSummary => {
            const ignoredReasonText = tokenSummary.ignored && tokenSummary.ignoredReasons
              ? ` reasons=${JSON.stringify(tokenSummary.ignoredReasons)}`
              : '';
            logger.log(
              `[activity-webhook] nft received=${events.length} processed=${nftProcessed} ignored=${nftIgnored};`
              + ` token processed=${tokenSummary.processed} ignored=${tokenSummary.ignored} failed=${tokenSummary.failed}`
              + ` inserted=${tokenSummary.insertedEvents} dup=${tokenSummary.duplicateEvents} alerts=${tokenSummary.sentAlerts}`
              + ignoredReasonText
            );
          })
          .catch(error => logger.error('Error in async token ingestion (nft-activity webhook):', error));
      });

      return res.json(toSuccessResponse({
        nft: { received: events.length, processed: nftProcessed, ignored: nftIgnored },
        token: { queued: events.length },
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
      setImmediate(() => {
        trackedWalletsService.ingestWebhookBatch(events, { source: 'webhook-token-only' })
          .then(summary => {
            const ignoredReasonText = summary.ignored && summary.ignoredReasons
              ? ` reasons=${JSON.stringify(summary.ignoredReasons)}`
              : '';
            logger.log(
              `[token-webhook] received=${summary.received} processed=${summary.processed} ignored=${summary.ignored}`
              + ` failed=${summary.failed} inserted=${summary.insertedEvents} dup=${summary.duplicateEvents} alerts=${summary.sentAlerts}`
              + ignoredReasonText
            );
          })
          .catch(error => logger.error('Error in async token ingestion (token-activity webhook):', error));
      });
      return res.json(toSuccessResponse({ queued: events.length }));
    } catch (routeError) {
      logger.error('Error in token activity webhook:', routeError);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createActivityWebhooksRouter;
