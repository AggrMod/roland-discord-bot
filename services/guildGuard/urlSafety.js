const dns = require('dns').promises;
const net = require('net');

const SHORTENER_HOSTS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'ow.ly', 'buff.ly', 'rebrand.ly'
]);

function isPrivateIp(value) {
  const ip = String(value || '').trim().toLowerCase();
  if (net.isIPv4(ip)) {
    const octets = ip.split('.').map(Number);
    const [a, b] = octets;
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 0) || (a >= 224);
  }
  if (net.isIPv6(ip)) {
    return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8')
      || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb');
  }
  return false;
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  return !host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || host === 'metadata.google.internal' || isPrivateIp(host);
}

function toHttpUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) throw new Error('empty_url');
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported_protocol');
  if (isPrivateHostname(parsed.hostname)) throw new Error('private_destination');
  return parsed;
}

async function assertPublicHost(hostname, timeoutMs = 1500) {
  if (isPrivateHostname(hostname)) throw new Error('private_destination');
  const lookup = dns.lookup(hostname, { all: true, verbatim: true });
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('dns_timeout')), timeoutMs));
  const records = await Promise.race([lookup, timer]);
  if (!records?.length || records.some(record => isPrivateIp(record.address))) throw new Error('private_destination');
  return records;
}

async function resolveSafeUrl(rawUrl, options = {}) {
  const maxHops = Math.max(0, Math.min(5, Number(options.maxRedirects) || 3));
  const timeoutMs = Math.max(250, Math.min(5000, Number(options.timeoutMs) || 1500));
  const redirects = [];
  let current = toHttpUrl(rawUrl);
  const initialHost = current.hostname.toLowerCase().replace(/^www\./, '');
  if (!SHORTENER_HOSTS.has(initialHost)) return { safe: true, url: current.toString(), finalUrl: current.toString(), redirects };

  for (let hop = 0; hop <= maxHops; hop += 1) {
    await assertPublicHost(current.hostname, timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(current, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'GuildGuard/1.0 URL safety checker' } });
    } catch (error) {
      return { safe: false, url: current.toString(), finalUrl: current.toString(), redirects, reason: error?.name === 'AbortError' ? 'redirect_timeout' : 'redirect_fetch_failed' };
    } finally {
      clearTimeout(timer);
    }
    const location = response.headers.get('location');
    response.body?.cancel?.();
    if (!location || ![301, 302, 303, 307, 308].includes(response.status)) {
      return { safe: true, url: String(rawUrl), finalUrl: current.toString(), redirects };
    }
    if (hop === maxHops) return { safe: false, url: String(rawUrl), finalUrl: current.toString(), redirects, reason: 'redirect_limit' };
    try {
      const next = new URL(location, current);
      if (!['http:', 'https:'].includes(next.protocol) || isPrivateHostname(next.hostname)) throw new Error('private_destination');
      redirects.push({ from: current.toString(), to: next.toString(), status: response.status });
      current = next;
    } catch (error) {
      return { safe: false, url: String(rawUrl), finalUrl: current.toString(), redirects, reason: error?.message || 'unsafe_redirect' };
    }
  }
  return { safe: false, url: String(rawUrl), finalUrl: current.toString(), redirects, reason: 'redirect_limit' };
}

module.exports = { SHORTENER_HOSTS, isPrivateIp, isPrivateHostname, toHttpUrl, assertPublicHost, resolveSafeUrl };
