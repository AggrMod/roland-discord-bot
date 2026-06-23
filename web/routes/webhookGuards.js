const crypto = require('crypto');

// Fix B (audit M-2/M-4): defense-in-depth for the public webhook endpoints.
// These guards are intentionally best-effort and fail OPEN — a webhook must
// never be blocked by a guard bug. Correctness (no duplicate grants) is already
// enforced durably in the DB layer (tx_signature / payload_hash dedup); these
// guards bound per-request work and short-circuit obvious replays/floods.

function readPositiveInt(rawValue, fallback) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

// Max number of events accepted in a single webhook request. 0 = unlimited.
function getMaxBatchSize() {
  return readPositiveInt(process.env.WEBHOOK_MAX_BATCH, 500);
}

// Returns true when an event count is acceptable for one request.
function withinBatchLimit(count) {
  const max = getMaxBatchSize();
  if (!max || max <= 0) return true;
  return Number(count || 0) <= max;
}

// Stable stringify so logically-identical payloads hash the same regardless of
// key ordering.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

// Derive a replay key from the request: same route + same auth scope + same
// body hashes to the same key. The secret header is hashed (never stored raw).
function replayKeyFor(req) {
  const secretHeader = String(
    req.headers?.authorization
    || req.headers?.['x-webhook-secret']
    || req.headers?.['x-vault-webhook-secret']
    || ''
  );
  const scope = `${req.method || 'POST'} ${req.baseUrl || ''}${req.path || req.url || ''}`;
  let bodyPart = '';
  try {
    bodyPart = stableStringify(req.body);
  } catch (_error) {
    bodyPart = String(Date.now()); // unhashable body => never treat as replay
  }
  return crypto
    .createHash('sha256')
    .update(`${scope}\n${secretHeader}\n${bodyPart}`)
    .digest('hex');
}

// Bounded, TTL'd in-memory set of recently-seen request keys. Process-local and
// non-durable by design (the DB layer is the source of truth for idempotency).
function createReplayCache({ windowMs = 60_000, maxEntries = 5_000 } = {}) {
  const seen = new Map(); // key -> expiresAt (ms)

  function prune(now) {
    for (const [key, expiresAt] of seen) {
      if (expiresAt <= now) seen.delete(key);
      if (seen.size <= maxEntries) break;
    }
    // Hard cap: if still oversized, drop oldest insertion-order entries.
    while (seen.size > maxEntries) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  }

  return {
    // Returns true if this key was already seen within the window (a replay).
    // Records the key either way so the next identical request is caught.
    isReplay(key) {
      const now = Date.now();
      const expiresAt = seen.get(key);
      if (expiresAt && expiresAt > now) {
        return true;
      }
      seen.set(key, now + windowMs);
      if (seen.size > maxEntries) prune(now);
      return false;
    },
    get size() {
      return seen.size;
    },
  };
}

module.exports = {
  getMaxBatchSize,
  withinBatchLimit,
  stableStringify,
  replayKeyFor,
  createReplayCache,
};
