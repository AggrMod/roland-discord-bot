const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');

function createVaultWebhooksRouter({
  logger,
  vaultService,
  timingSafeEquals,
  normalizeWebhookSecretHeader,
}) {
  const router = express.Router();

  function getVaultWebhookSecret() {
    return String(
      process.env.VAULT_MINT_WEBHOOK_SECRET
      || process.env.TRACKED_TOKEN_WEBHOOK_SECRET
      || process.env.NFT_ACTIVITY_WEBHOOK_SECRET
      || ''
    ).trim();
  }

  function verifyWebhookAuth(req) {
    const configuredSecret = getVaultWebhookSecret();
    if (!configuredSecret) {
      return { ok: false, status: 503, payload: toErrorResponse('Vault webhook not configured', 'SERVICE_UNAVAILABLE') };
    }
    const providedRaw = req.headers.authorization || req.headers['x-webhook-secret'] || req.headers['x-vault-webhook-secret'];
    const provided = normalizeWebhookSecretHeader(providedRaw);
    if (!provided || !timingSafeEquals(provided, configuredSecret)) {
      return { ok: false, status: 401, payload: toErrorResponse('Unauthorized', 'UNAUTHORIZED') };
    }
    return { ok: true };
  }

  router.post('/api/webhooks/vault-mints', async (req, res) => {
    try {
      const auth = verifyWebhookAuth(req);
      if (!auth.ok) return res.status(auth.status).json(auth.payload);

      const incoming = Array.isArray(req.body) ? req.body : [req.body];
      const summary = {
        received: incoming.length,
        processed: 0,
        duplicates: 0,
        failed: 0,
        results: [],
      };

      for (const event of incoming) {
        const normalized = {
          ...event,
          guildId: event?.guildId || event?.guild_id,
          seasonId: event?.seasonId || event?.season_id || null,
          walletAddress: event?.walletAddress || event?.wallet_address || null,
          txSignature: event?.txSignature || event?.tx_signature || null,
          mintAddress: event?.mintAddress || event?.mint_address || null,
          mintType: event?.mintType || event?.mint_type || 'unknown',
          source: 'vault_webhook',
        };
        const result = vaultService.ingestMintEvent(normalized);
        if (result?.success) {
          if (result.duplicate) summary.duplicates += 1;
          else summary.processed += 1;
        } else {
          summary.failed += 1;
        }
        summary.results.push({
          txSignature: normalized.txSignature || null,
          success: !!result?.success,
          duplicate: !!result?.duplicate,
          message: result?.message || null,
          linkedUserId: result?.linkedUserId || null,
          grants: result?.grants || null,
        });
      }

      return res.json(toSuccessResponse(summary));
    } catch (error) {
      logger.error('Error processing vault mint webhook:', error);
      return res.status(500).json(toErrorResponse('Internal server error'));
    }
  });

  return router;
}

module.exports = createVaultWebhooksRouter;
