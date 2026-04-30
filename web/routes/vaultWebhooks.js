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

      const queryGuildId = String(req.query?.guildId || req.query?.guild_id || '').trim();
      const headerGuildId = String(req.headers['x-guild-id'] || req.headers['x-guildid'] || '').trim();
      const defaultGuildId = queryGuildId || headerGuildId || '';

      const body = req.body;
      const incomingRaw = Array.isArray(body?.events)
        ? body.events
        : (Array.isArray(body) ? body : [body]);
      const incoming = incomingRaw.filter(Boolean);
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
          guildId: event?.guildId || event?.guild_id || defaultGuildId || null,
          seasonId: event?.seasonId || event?.season_id || null,
          walletAddress: event?.walletAddress || event?.wallet_address || event?.feePayer || event?.fee_payer || event?.payer || null,
          txSignature: event?.txSignature
            || event?.tx_signature
            || event?.signature
            || event?.transactionSignature
            || event?.txnSignature
            || null,
          mintAddress: event?.mintAddress
            || event?.mint_address
            || event?.mint
            || event?.events?.nft?.nfts?.[0]?.mint
            || event?.tokenTransfers?.[0]?.mint
            || null,
          mintType: event?.mintType || event?.mint_type || event?.type || event?.eventType || event?.transactionType || event?.txnType || 'unknown',
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
