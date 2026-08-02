#!/usr/bin/env node

const assert = require('assert');
const http = require('http');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { createCsrfProtection } = require('../web/middleware/csrfProtection');

const ORIGIN = 'https://guildpilot.app';

function request({ port, path, method = 'GET', cookie = '', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch (_error) { body = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  const app = express();
  app.use(cookieParser());
  app.use(session({ secret: 'csrf-session-secret-that-is-long-enough', resave: false, saveUninitialized: true }));
  const csrf = createCsrfProtection({
    secret: 'csrf-signing-secret-that-is-also-long-enough',
    isProduction: true,
    allowedOrigins: [ORIGIN],
    toErrorResponse: (message, code) => ({ success: false, message, error: { code, message } }),
  });
  app.get('/api/csrf-token', csrf.issueToken);
  app.use('/api', csrf.protectMutations);
  app.post('/api/change', (_req, res) => res.json({ success: true }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  try {
    const tokenResult = await request({ port, path: '/api/csrf-token' });
    assert.strictEqual(tokenResult.status, 200);
    assert(tokenResult.body.token && tokenResult.body.token.length > 32);
    const cookies = (tokenResult.headers['set-cookie'] || []).map((value) => String(value).split(';')[0]).join('; ');
    assert(cookies.includes('__Host-gp.csrf='));

    let result = await request({
      port, path: '/api/change', method: 'POST', cookie: cookies,
      headers: { origin: ORIGIN, 'x-requested-with': 'XMLHttpRequest' },
    });
    assert.strictEqual(result.status, 403, 'token is mandatory');

    result = await request({
      port, path: '/api/change', method: 'POST', cookie: cookies,
      headers: { origin: 'https://evil.example', 'x-requested-with': 'XMLHttpRequest', 'x-csrf-token': tokenResult.body.token },
    });
    assert.strictEqual(result.status, 403, 'foreign origin is rejected');

    result = await request({
      port, path: '/api/change', method: 'POST', cookie: cookies,
      headers: { origin: ORIGIN, 'x-requested-with': 'XMLHttpRequest', 'x-csrf-token': tokenResult.body.token },
    });
    assert.strictEqual(result.status, 200, 'matching cookie, token, session and origin are accepted');

    console.log('CSRF protection assertions passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
