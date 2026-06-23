const express = require('express');
const { toSuccessResponse, toErrorResponse } = require('./responseCompat');
const { withinBatchLimit, getMaxBatchSize } = require('./webhookGuards');

function createVaultWebhooksRouter({
  logger,
  vaultService,
  timingSafeEquals,
  normalizeWebhookSecretHeader,
}) {
  const router = express.Router();

  // Fix F (audit H-2): the vault webhook previously authenticated with one
  // shared global secret while the target guild was fully attacker-controlled,
  // so any holder of that secret could grant rewards to ANY guild. Per-guild
  // secrets bind authorization to a specific guild; guild-match rejects events
  // for other guilds. Rollout is monitor-before-enforce; default off = today.
  function getGlobalVaultSecret() {
    return String(
      process.env.VAULT_MINT_WEBHOOK_SECRET
      || process.env.TRACKED_TOKEN_WEBHOOK_SECRET
      || process.env.NFT_ACTIVITY_WEBHOOK_SECRET
      || ''
    ).trim();
  }

  function getPerGuildVaultSecret(guildId) {
    const gid = String(guildId || '').trim();
    if (!/^\d{17,20}$/.test(gid)) return '';
    return String(process.env[`VAULT_WEBHOOK_SECRET_${gid}`] || '').trim();
  }

  function guildMatchMode() {
    return String(process.env.VAULT_WEBHOOK_ENFORCE_GUILD_MATCH || 'off').trim().toLowerCase();
  }

  function resolveAuthGuildId(req) {
    return String(
      req.query?.guildId || req.query?.guild_id
      || req.headers['x-guild-id'] || req.headers['x-guildid']
      || ''
    ).trim();
  }

  function verifyWebhookAuth(req) {
    const mode = guildMatchMode(); // off | monitor | enforce
    const provided = normalizeWebhookSecretHeader(
      req.headers.authorization || req.headers['x-webhook-secret'] || req.headers['x-vault-webhook-secret']
    );
    const authGuildId = resolveAuthGuildId(req);
    const perGuildSecret = getPerGuildVaultSecret(authGuildId);
    const globalSecret = getGlobalVaultSecret();

    if (mode === 'enforce') {
      // Must authenticate against the target guild's own secret.
      if (!/^\d{17,20}$/.test(authGuildId)) {
        return { ok: false, status: 400, payload: toErrorResponse('Request-level guildId is required (enforce mode)', 'VALIDATION_ERROR') };
      }
      if (!perGuildSecret) {
        return { ok: false, status: 503, payload: toErrorResponse('No per-guild vault webhook secret configured for this guild', 'SERVICE_UNAVAILABLE') };
      }
      if (!provided || !timingSafeEquals(provided, perGuildSecret)) {
        return { ok: false, status: 401, payload: toErrorResponse('Unauthorized', 'UNAUTHORIZED') };
      }
      return { ok: true, authGuildId, enforceGuildMatch: true };
    }

    // off / monitor: legacy global-secret auth (back-compat).
    if (!globalSecret) {
      return { ok: false, status: 503, payload: toErrorResponse('Vault webhook not configured', 'SERVICE_UNAVAILABLE') };
    }
    const globalOk = provided && timingSafeEquals(provided, globalSecret);
    const perGuildOk = perGuildSecret && provided && timingSafeEquals(provided, perGuildSecret);
    if (!globalOk && !perGuildOk) {
      return { ok: false, status: 401, payload: toErrorResponse('Unauthorized', 'UNAUTHORIZED') };
    }

    if (mode === 'monitor') {
      if (!/^\d{17,20}$/.test(authGuildId)) {
        logger.warn('[vault-webhook] MONITOR: no request-level guildId; enforce mode would reject this request');
      } else if (!perGuildSecret) {
        logger.warn(`[vault-webhook] MONITOR: no per-guild secret configured for guild ${authGuildId}; enforce mode would reject`);
      }
    }
    return { ok: true, authGuildId, enforceGuildMatch: false, monitor: mode === 'monitor' };
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
      if (!withinBatchLimit(incoming.length)) {
        return res.status(413).json(toErrorResponse(`Too many events in one request (max ${getMaxBatchSize()})`, 'PAYLOAD_TOO_LARGE'));
      }
      const summary = {
        received: incoming.length,
        processed: 0,
        duplicates: 0,
        failed: 0,
        rejected: 0,
        results: [],
      };

      for (const event of incoming) {
        const eventGuildId = String(event?.guildId || event?.guild_id || defaultGuildId || '').trim();

        // Guild-match (Fix F): an authenticated request may only write to its
        // own guild. Enforce mode rejects events for other guilds; monitor logs.
        if (auth.authGuildId && eventGuildId && eventGuildId !== auth.authGuildId) {
          if (auth.enforceGuildMatch) {
            summary.rejected += 1;
            summary.results.push({
              txSignature: event?.txSignature || event?.tx_signature || event?.signature || null,
              success: false,
              rejected: true,
              message: 'guild mismatch: event guildId does not match authenticated guild',
            });
            continue;
          }
          if (auth.monitor) {
            logger.warn(`[vault-webhook] MONITOR: event guild ${eventGuildId} != authenticated guild ${auth.authGuildId}; enforce mode would reject`);
          }
        }

        // In enforce mode, pin every event to the authenticated guild.
        const finalGuildId = auth.enforceGuildMatch
          ? auth.authGuildId
          : (eventGuildId || null);

        const normalized = {
          ...event,
          guildId: finalGuildId,
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
