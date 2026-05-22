#!/usr/bin/env node

const assert = require('assert');

const welcomeService = require('../services/welcomeService');

function run() {
  const guildId = `welcome-image-limits-${Date.now()}`;

  const underLimitBuffer = Buffer.alloc(100_000, 1);
  const ok = welcomeService.saveUploadedImage({
    guildId,
    fileName: 'ok.png',
    mimeType: 'image/png',
    buffer: underLimitBuffer,
  });
  assert.strictEqual(ok.success, true, 'image under limit should be accepted');
  assert.ok(Number(ok?.asset?.id || 0) > 0, 'accepted image should persist an asset row');

  const overLimitBuffer = Buffer.alloc(2_200_000, 1);
  const rejected = welcomeService.saveUploadedImage({
    guildId,
    fileName: 'too-big.png',
    mimeType: 'image/png',
    buffer: overLimitBuffer,
  });
  assert.strictEqual(rejected.success, false, 'image over max size should be rejected');
  assert.ok(
    String(rejected.message || '').toLowerCase().includes('max size'),
    'rejection message should explain max size guard'
  );

  const unsupported = welcomeService.saveUploadedImage({
    guildId,
    fileName: 'bad.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.alloc(256, 1),
  });
  assert.strictEqual(unsupported.success, false, 'unsupported mime types should be rejected');
  assert.ok(
    String(unsupported.message || '').toLowerCase().includes('unsupported image type'),
    'unsupported type should return clear validation message'
  );

  console.log('welcome image upload limit assertions passed');
}

run();
