const crypto = require('crypto');
const settingsManager = require('../config/settings');
const { decryptSecret } = require('../utils/secretVault');

const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const API_BASE = 'https://api.x.com/2';
const DEFAULT_SCOPES = ['tweet.read', 'users.read', 'like.read', 'follows.read', 'offline.access'];

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeCallbackUrl(value) {
  const input = normalizeString(value);
  if (!input) return '';
  try {
    const parsed = new URL(input);
    const pathname = parsed.pathname.endsWith('/') && parsed.pathname !== '/' ? parsed.pathname.slice(0, -1) : parsed.pathname;
    return `${parsed.origin}${pathname}`;
  } catch (_error) {
    try {
      const parsed = new URL(`https://${input}`);
      const pathname = parsed.pathname.endsWith('/') && parsed.pathname !== '/' ? parsed.pathname.slice(0, -1) : parsed.pathname;
      return `${parsed.origin}${pathname}`;
    } catch (_error2) {
      return '';
    }
  }
}

function parseCommaSeparated(value) {
  return String(value || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function normalizeOrigin(value) {
  const input = normalizeString(value);
  if (!input) return '';
  try {
    return new URL(input).origin;
  } catch (_error) {
    try {
      return new URL(`https://${input}`).origin;
    } catch (_error2) {
      return '';
    }
  }
}

function getRequestOrigin(req) {
  const forwardedHostRaw = req.get('x-forwarded-host') || '';
  const directHostRaw = req.get('host') || '';
  const host = String(forwardedHostRaw || directHostRaw).split(',')[0].trim();
  if (!host) return '';
  const forwardedProtoRaw = req.get('x-forwarded-proto') || '';
  const proto = String(forwardedProtoRaw || req.protocol || 'https').split(',')[0].trim() || 'https';
  return `${proto}://${host}`;
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function getConfiguredRedirectUris() {
  const configured = [
    process.env.X_REDIRECT_URI,
    ...parseCommaSeparated(process.env.X_REDIRECT_URIS),
  ];
  return Array.from(new Set(configured.map(normalizeCallbackUrl).filter(Boolean)));
}

function getRuntimeConfig() {
  const settings = settingsManager.getSettings ? settingsManager.getSettings() : {};
  return {
    clientId: normalizeString(settings.xClientId || process.env.X_CLIENT_ID),
    clientSecret: decryptSecret(settings.xClientSecretEncrypted) || normalizeString(settings.xClientSecret || process.env.X_CLIENT_SECRET),
    bearerToken: decryptSecret(settings.xBearerTokenEncrypted) || normalizeString(settings.xBearerToken || process.env.X_BEARER_TOKEN),
    pollingEnabled: settings.xPollingEnabled === true,
    pollingIntervalSeconds: Number(settings.xPollingIntervalSeconds || process.env.X_POLLING_INTERVAL_SECONDS || 300),
  };
}

function resolveRedirectUri(req) {
  const configured = getConfiguredRedirectUris();
  if (configured.length === 0) {
    return 'http://localhost:3000/auth/x/callback';
  }
  const requestOrigin = normalizeOrigin(getRequestOrigin(req));
  if (requestOrigin) {
    const preferred = normalizeCallbackUrl(`${requestOrigin}/auth/x/callback`);
    if (preferred && configured.includes(preferred)) {
      return preferred;
    }
  }
  return configured[0];
}

function isConfigured() {
  const config = getRuntimeConfig();
  return !!config.clientId;
}

function generatePkcePair() {
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

function buildAuthorizeUrl({ redirectUri, state, codeChallenge, scopes = DEFAULT_SCOPES } = {}) {
  const clientId = getRuntimeConfig().clientId;
  if (!clientId) {
    throw new Error('X_CLIENT_ID is not configured');
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function buildTokenHeaders() {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const { clientId, clientSecret } = getRuntimeConfig();
  if (clientId && clientSecret) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  }
  return headers;
}

function buildTokenBody(extra = {}) {
  const body = new URLSearchParams();
  const { clientId, clientSecret } = getRuntimeConfig();
  if (clientId && !clientSecret) {
    body.set('client_id', clientId);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      body.set(key, String(value));
    }
  }
  return body;
}

async function exchangeCodeForTokens({ code, codeVerifier, redirectUri }) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: buildTokenHeaders(),
    body: buildTokenBody({
      code,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.access_token) {
    throw new Error(data?.error_description || data?.detail || 'X token exchange failed');
  }
  return data;
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: buildTokenHeaders(),
    body: buildTokenBody({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.access_token) {
    throw new Error(data?.error_description || data?.detail || 'X token refresh failed');
  }
  return data;
}

function buildAuthHeader({ accessToken, bearerToken } = {}) {
  const token = normalizeString(accessToken || bearerToken || getRuntimeConfig().bearerToken);
  if (!token) {
    throw new Error('No X access token or bearer token configured');
  }
  return { Authorization: `Bearer ${token}` };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.detail || data?.title || data?.error_description || `X request failed (${response.status})`);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

async function getAuthenticatedUser(accessToken) {
  const url = new URL(`${API_BASE}/users/me`);
  url.searchParams.set('user.fields', 'id,name,username,profile_image_url,description,public_metrics,verified');
  return fetchJson(url, {
    headers: buildAuthHeader({ accessToken }),
  });
}

async function getUserByUsername(username, { bearerToken, accessToken } = {}) {
  const handle = normalizeString(username).replace(/^@+/, '');
  const url = new URL(`${API_BASE}/users/by/username/${encodeURIComponent(handle)}`);
  url.searchParams.set('user.fields', 'id,name,username,profile_image_url,description,public_metrics,verified,most_recent_tweet_id');
  return fetchJson(url, {
    headers: buildAuthHeader({ accessToken, bearerToken }),
  });
}

function normalizePost(post = {}) {
  return {
    id: normalizeString(post.id),
    text: normalizeString(post.text),
    created_at: post.created_at || null,
    author_id: normalizeString(post.author_id),
    in_reply_to_user_id: normalizeString(post.in_reply_to_user_id) || null,
    conversation_id: normalizeString(post.conversation_id) || null,
    lang: normalizeString(post.lang) || null,
    public_metrics: post.public_metrics || {},
    entities: post.entities || {},
    raw: post,
  };
}

async function getUserPosts(userId, { bearerToken, accessToken, sinceId = '', maxResults = 10, exclude = ['retweets'] } = {}) {
  const normalizedUserId = normalizeString(userId);
  const url = new URL(`${API_BASE}/users/${encodeURIComponent(normalizedUserId)}/tweets`);
  url.searchParams.set('max_results', String(Math.max(5, Math.min(Number(maxResults || 10), 100))));
  url.searchParams.set('tweet.fields', 'author_id,created_at,conversation_id,entities,in_reply_to_user_id,lang,public_metrics,text');
  if (exclude.length) {
    url.searchParams.set('exclude', exclude.join(','));
  }
  if (normalizeString(sinceId)) {
    url.searchParams.set('since_id', normalizeString(sinceId));
  }
  const data = await fetchJson(url, {
    headers: buildAuthHeader({ accessToken, bearerToken }),
  });
  return {
    posts: Array.isArray(data?.data) ? data.data.map(normalizePost) : [],
    meta: data?.meta || {},
  };
}

async function getRecentPostsByHandle(handle, { bearerToken, accessToken, sinceId = '', maxResults = 10, exclude = ['retweets'] } = {}) {
  const userLookup = await getUserByUsername(handle, { bearerToken, accessToken });
  const user = userLookup?.data || {};
  const timeline = await getUserPosts(user.id, { bearerToken, accessToken, sinceId, maxResults, exclude });
  return {
    user,
    ...timeline,
  };
}

async function searchRecentPosts(query, { bearerToken, accessToken, sinceId = '', maxResults = 10 } = {}) {
  const url = new URL(`${API_BASE}/tweets/search/recent`);
  url.searchParams.set('query', normalizeString(query));
  url.searchParams.set('max_results', String(Math.max(10, Math.min(Number(maxResults || 10), 100))));
  url.searchParams.set('tweet.fields', 'author_id,created_at,conversation_id,entities,in_reply_to_user_id,lang,public_metrics,text');
  if (normalizeString(sinceId)) {
    url.searchParams.set('since_id', normalizeString(sinceId));
  }
  const data = await fetchJson(url, {
    headers: buildAuthHeader({ accessToken, bearerToken }),
  });
  return {
    posts: Array.isArray(data?.data) ? data.data.map(normalizePost) : [],
    meta: data?.meta || {},
    includes: data?.includes || {},
  };
}

async function getLikedPosts(userId, { accessToken, maxResults = 100 } = {}) {
  const normalizedUserId = normalizeString(userId);
  const url = new URL(`${API_BASE}/users/${encodeURIComponent(normalizedUserId)}/liked_tweets`);
  url.searchParams.set('max_results', String(Math.max(5, Math.min(Number(maxResults || 100), 100))));
  url.searchParams.set('tweet.fields', 'author_id,created_at,conversation_id,in_reply_to_user_id,lang,public_metrics,text');
  const data = await fetchJson(url, {
    headers: buildAuthHeader({ accessToken }),
  });
  return {
    posts: Array.isArray(data?.data) ? data.data.map(normalizePost) : [],
    meta: data?.meta || {},
  };
}

async function getRetweetingUsers(tweetId, { bearerToken, accessToken, maxResults = 100 } = {}) {
  const normalizedTweetId = normalizeString(tweetId);
  const url = new URL(`${API_BASE}/tweets/${encodeURIComponent(normalizedTweetId)}/retweeted_by`);
  url.searchParams.set('max_results', String(Math.max(10, Math.min(Number(maxResults || 100), 100))));
  url.searchParams.set('user.fields', 'id,name,username,verified');
  const data = await fetchJson(url, {
    headers: buildAuthHeader({ accessToken, bearerToken }),
  });
  return {
    users: Array.isArray(data?.data) ? data.data : [],
    meta: data?.meta || {},
  };
}

async function getFollowing(userId, { accessToken, bearerToken, maxResults = 1000 } = {}) {
  const normalizedUserId = normalizeString(userId);
  const users = [];
  let nextToken = '';
  do {
    const url = new URL(`${API_BASE}/users/${encodeURIComponent(normalizedUserId)}/following`);
    url.searchParams.set('max_results', String(Math.max(10, Math.min(Number(maxResults || 100), 100))));
    url.searchParams.set('user.fields', 'id,name,username,verified');
    if (nextToken) url.searchParams.set('pagination_token', nextToken);
    const data = await fetchJson(url, {
      headers: buildAuthHeader({ accessToken, bearerToken }),
    });
    if (Array.isArray(data?.data)) users.push(...data.data);
    nextToken = String(data?.meta?.next_token || '').trim();
  } while (nextToken && users.length < maxResults);

  return { users: users.slice(0, maxResults) };
}

module.exports = {
  DEFAULT_SCOPES,
  getRuntimeConfig,
  isConfigured,
  resolveRedirectUri,
  generatePkcePair,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getAuthenticatedUser,
  getUserByUsername,
  getUserPosts,
  getRecentPostsByHandle,
  searchRecentPosts,
  getLikedPosts,
  getRetweetingUsers,
  getFollowing,
};
