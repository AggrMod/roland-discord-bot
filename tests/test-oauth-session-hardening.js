#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const session = require('express-session');
const testDatabasePath = path.join(os.tmpdir(), `guildpilot-oauth-session-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDatabasePath;
const createAuthUserRouter = require('../web/routes/authUser');
const { decryptSecret } = require('../utils/secretVault');

function request({ port, path, cookie = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path,
      headers: cookie ? { cookie } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
    });
    req.on('error', reject);
  });
}

function responseJson(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

async function run() {
  process.env.SESSION_SECRET = 'oauth-session-test-secret-that-is-long-enough';
  process.env.SECRET_VAULT_KEY = 'oauth-vault-test-key-that-is-separate-and-long';
  process.env.CLIENT_ID = 'client-id';
  process.env.DISCORD_CLIENT_SECRET = 'client-secret';

  const originalFetch = global.fetch;
  const tokenCalls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/oauth2/token')) {
      tokenCalls.push(target);
      return responseJson({ access_token: 'discord-access-secret', refresh_token: 'discord-refresh-secret', expires_in: 3600 });
    }
    if (target.includes('/users/@me')) {
      assert.strictEqual(options.headers.Authorization, 'Bearer discord-access-secret');
      return responseJson({ id: '123456789012345678', username: 'OAuth Tester', discriminator: '0', avatar: null });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const app = express();
  app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
  const pass = (_req, _res, next) => next();
  app.use(createAuthUserRouter({
    logger: { log() {}, warn() {}, error() {} },
    db: { prepare: () => ({ all: () => [], get: () => null, run: () => ({ changes: 0 }) }) },
    publicApiLimiter: pass,
    resolveOAuthRedirectUri: () => 'http://127.0.0.1/auth/discord/callback',
    getRequestedGuildId: () => '',
    tenantService: {}, roleService: {}, missionService: {}, heistService: {}, ticketService: {},
    walletService: {}, proposalService: {}, fetchGuildById: async () => null,
    getDiscordUserGuilds: async () => [], getBotGuildIds: () => [],
    hasDiscordAdminPermission: () => false, superadminService: {},
    normalizeGuildId: (value) => String(value || ''), fallbackGuildId: () => '',
    getPlanCatalog: () => [], getClient: () => null,
  }));
  app.get('/test/session', (req, res) => res.json({ sessionId: req.sessionID, discordUser: req.session.discordUser || null }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  try {
    const login = await request({ port, path: '/auth/discord/login?returnTo=%2Fapp%3Fsection%3Dwallets' });
    assert.strictEqual(login.status, 302);
    const loginCookie = String(login.headers['set-cookie']?.[0] || '').split(';')[0];
    assert(loginCookie, 'OAuth start must persist a session-bound state record');
    const authorizeUrl = new URL(login.headers.location);
    const state = authorizeUrl.searchParams.get('state');
    assert(state, 'OAuth redirect should include signed state');

    const unbound = await request({ port, path: `/auth/discord/callback?code=test-code&state=${encodeURIComponent(state)}` });
    assert.strictEqual(unbound.status, 302);
    assert.strictEqual(unbound.headers.location, '/app?error=invalid_state', 'state cannot be used outside its initiating session');
    assert.strictEqual(tokenCalls.length, 0, 'unbound state is rejected before token exchange');

    const callback = await request({
      port,
      path: `/auth/discord/callback?code=test-code&state=${encodeURIComponent(state)}`,
      cookie: loginCookie,
    });
    assert.strictEqual(callback.status, 302);
    assert.match(callback.headers.location, /^\/app\?section=wallets&auth=ready$/);
    assert.strictEqual(tokenCalls.length, 1);
    const authenticatedCookie = String(callback.headers['set-cookie']?.[0] || '').split(';')[0];
    assert(authenticatedCookie && authenticatedCookie !== loginCookie, 'session ID must rotate after authentication');

    const sessionResult = await request({ port, path: '/test/session', cookie: authenticatedCookie });
    const storedUser = JSON.parse(sessionResult.raw).discordUser;
    assert(storedUser.accessTokenEncrypted, 'access token should be encrypted in the session store');
    assert(storedUser.refreshTokenEncrypted, 'refresh token should be encrypted in the session store');
    assert.strictEqual(storedUser.accessToken, undefined);
    assert.strictEqual(storedUser.refreshToken, undefined);
    assert.strictEqual(decryptSecret(storedUser.accessTokenEncrypted), 'discord-access-secret');
    assert.strictEqual(decryptSecret(storedUser.refreshTokenEncrypted), 'discord-refresh-secret');

    const replay = await request({
      port,
      path: `/auth/discord/callback?code=replay-code&state=${encodeURIComponent(state)}`,
      cookie: authenticatedCookie,
    });
    assert.strictEqual(replay.headers.location, '/app?error=invalid_state', 'OAuth state must be one-time');
    assert.strictEqual(tokenCalls.length, 1, 'replay is rejected before token exchange');

    console.log('OAuth session hardening assertions passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    global.fetch = originalFetch;
    delete process.env.SESSION_SECRET;
    delete process.env.SECRET_VAULT_KEY;
    delete process.env.CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    try { require('../database/db').close(); } catch (_error) {}
    delete process.env.DATABASE_PATH;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(`${testDatabasePath}${suffix}`); } catch (_error) {}
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
