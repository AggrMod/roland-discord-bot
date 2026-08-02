#!/usr/bin/env node

const assert = require('assert');
const http = require('http');
const {
  safeRemoteFetch,
  isPublicIp,
  normalizeRemoteUrl,
  contentTypeAllowed,
} = require('../utils/safeRemoteFetch');

async function run() {
  for (const blocked of [
    '0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.168.1.1', '100.64.0.1', '198.18.0.1', '224.0.0.1', '::', '::1',
    'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1',
    '0:0:0:0:0:0:0:1', 'fc00:0:0:0:0:0:0:1', 'fe80:0:0:0:0:0:0:1',
    '0:0:0:0:0:ffff:7f00:1',
  ]) {
    assert.strictEqual(isPublicIp(blocked), false, `${blocked} must be blocked`);
  }
  assert.strictEqual(isPublicIp('8.8.8.8'), true);
  assert.strictEqual(isPublicIp('2606:4700:4700::1111'), true);

  assert.throws(() => normalizeRemoteUrl('file:///etc/passwd'), /Only HTTP and HTTPS/);
  assert.throws(() => normalizeRemoteUrl('http://user:pass@example.com'), /credentials/);
  assert.throws(() => normalizeRemoteUrl('https://example.com:8443/file'), /blocked port/);
  assert.throws(() => normalizeRemoteUrl('http://localhost/file'), /Local network/);

  assert.strictEqual(contentTypeAllowed('text/html; charset=utf-8', ['text/html']), true);
  assert.strictEqual(contentTypeAllowed('image/svg+xml', ['text/*']), false);
  assert.strictEqual(contentTypeAllowed('application/pdf', ['application/pdf']), true);

  const server = http.createServer((_req, res) => res.end('private response'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    await assert.rejects(
      safeRemoteFetch(`http://127.0.0.1:${port}/secret`),
      /blocked port|blocked network/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('safe remote fetch assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
