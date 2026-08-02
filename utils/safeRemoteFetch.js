const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 30000;
const ALLOWED_PORTS = new Set(['', '80', '443']);

function normalizeIpv4(address) {
  const parts = String(address || '').split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return octets;
}

function isPublicIpv4(address) {
  const octets = normalizeIpv4(address);
  if (!octets) return false;
  const [a, b, c] = octets;

  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;

  return true;
}

function extractMappedIpv4(address) {
  const normalized = String(address || '').trim().toLowerCase();
  const dottedMatch = normalized.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dottedMatch) return dottedMatch[1];

  const hexMatch = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hexMatch) return null;
  const high = Number.parseInt(hexMatch[1], 16);
  const low = Number.parseInt(hexMatch[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function ipv6ToBigInt(address) {
  let normalized = String(address || '').trim().toLowerCase().split('%')[0];
  if (!normalized || normalized.includes(':::')) return null;

  const dottedTail = normalized.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (dottedTail) {
    const octets = normalizeIpv4(dottedTail);
    if (!octets) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, -dottedTail.length)}${high}:${low}`;
  }

  const compressedParts = normalized.split('::');
  if (compressedParts.length > 2) return null;
  const left = compressedParts[0] ? compressedParts[0].split(':') : [];
  const right = compressedParts.length === 2 && compressedParts[1] ? compressedParts[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (compressedParts.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;

  return groups.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

function isPublicIp(address) {
  const normalized = String(address || '').trim().toLowerCase().split('%')[0];
  const family = net.isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family !== 6) return false;

  const mappedIpv4 = extractMappedIpv4(normalized);
  if (mappedIpv4) return isPublicIpv4(mappedIpv4);

  const numeric = ipv6ToBigInt(normalized);
  if (numeric === null || numeric === 0n || numeric === 1n) return false;
  if ((numeric >> 121n) === 0x7en) return false; // fc00::/7 unique-local
  if ((numeric >> 118n) === 0x3fan) return false; // fe80::/10 link-local
  if ((numeric >> 120n) === 0xffn) return false; // ff00::/8 multicast
  if ((numeric >> 96n) === 0x20010db8n) return false; // documentation range
  if ((numeric >> 32n) === 0xffffn) {
    const ipv4 = [24n, 16n, 8n, 0n].map((shift) => Number((numeric >> shift) & 255n)).join('.');
    return isPublicIpv4(ipv4);
  }
  if ((numeric >> 32n) === 0n) return false; // IPv4-compatible/reserved ::/96

  return true;
}

function normalizeRemoteUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch (_error) {
    throw new Error('Invalid remote URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only HTTP and HTTPS URLs are supported');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Remote URLs must not contain credentials');
  }
  if (!ALLOWED_PORTS.has(parsed.port)) {
    throw new Error('Remote URL uses a blocked port');
  }
  if (!parsed.hostname || parsed.hostname.toLowerCase() === 'localhost' || parsed.hostname.toLowerCase().endsWith('.local')) {
    throw new Error('Local network URLs are not allowed');
  }

  return parsed;
}

async function resolvePublicAddress(hostname) {
  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) throw new Error('Remote URL resolves to a blocked network address');
    return { address: hostname, family: net.isIP(hostname) };
  }

  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some((record) => !isPublicIp(record.address))) {
    throw new Error('Remote URL resolves to a blocked network address');
  }

  return records.find((record) => record.family === 4) || records[0];
}

function headerValue(headers, name) {
  const value = headers[String(name).toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : String(value || '');
}

function contentTypeAllowed(contentType, allowedContentTypes) {
  if (!Array.isArray(allowedContentTypes) || allowedContentTypes.length === 0) return true;
  const normalized = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  return allowedContentTypes.some((allowed) => {
    const rule = String(allowed || '').trim().toLowerCase();
    return rule.endsWith('/*') ? normalized.startsWith(rule.slice(0, -1)) : normalized === rule;
  });
}

async function safeRemoteFetch(inputUrl, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const maxBytes = Math.max(1, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
  const maxRedirects = Math.max(0, Number(options.maxRedirects) || DEFAULT_MAX_REDIRECTS);
  const allowedContentTypes = options.allowedContentTypes || [];
  const headers = { 'User-Agent': 'GuildPilot-RemoteImport/1.0', ...(options.headers || {}) };

  async function requestOnce(currentUrl, redirectCount) {
    const parsed = normalizeRemoteUrl(currentUrl);
    const selectedAddress = await resolvePublicAddress(parsed.hostname);
    const transport = parsed.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const request = transport.request(parsed, {
        method: 'GET',
        headers,
        lookup: (_hostname, _lookupOptions, callback) => callback(null, selectedAddress.address, selectedAddress.family),
      }, (response) => {
        const remoteAddress = response.socket?.remoteAddress;
        if (!isPublicIp(remoteAddress)) {
          response.destroy();
          fail(new Error('Remote server connected through a blocked network address'));
          return;
        }

        const status = Number(response.statusCode || 0);
        const location = headerValue(response.headers, 'location');
        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirectCount >= maxRedirects) {
            fail(new Error('Remote URL exceeded the redirect limit'));
            return;
          }
          const nextUrl = new URL(location, parsed).toString();
          settled = true;
          resolve(requestOnce(nextUrl, redirectCount + 1));
          return;
        }

        const contentLength = Number.parseInt(headerValue(response.headers, 'content-length'), 10);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          response.destroy();
          fail(new Error(`Remote response exceeds the ${maxBytes}-byte limit`));
          return;
        }

        const contentType = headerValue(response.headers, 'content-type');
        if (!contentTypeAllowed(contentType, allowedContentTypes)) {
          response.destroy();
          fail(new Error(`Remote response type is not allowed: ${contentType || 'unknown'}`));
          return;
        }

        const chunks = [];
        let receivedBytes = 0;
        response.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (receivedBytes > maxBytes) {
            response.destroy();
            fail(new Error(`Remote response exceeds the ${maxBytes}-byte limit`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', fail);
        response.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            url: parsed.toString(),
            contentType,
            body: Buffer.concat(chunks),
          });
        });
      });

      request.setTimeout(timeoutMs, () => request.destroy(new Error('Remote request timed out')));
      request.on('error', fail);
      request.end();
    });
  }

  return requestOnce(inputUrl, 0);
}

module.exports = {
  safeRemoteFetch,
  isPublicIp,
  normalizeRemoteUrl,
  contentTypeAllowed,
  ipv6ToBigInt,
};
