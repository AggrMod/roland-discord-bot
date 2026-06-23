#!/usr/bin/env node

// Fix C (audit L-1): masking must hide the middle of addresses/signatures.

const assert = require('assert');
const { maskAddress, maskSignature } = require('../utils/mask');

function run() {
  const addr = 'So11111111111111111111111111111111111111112';
  const masked = maskAddress(addr);
  assert.strictEqual(masked, 'So11...1112', 'address masks to first4...last4');
  assert.ok(!masked.includes(addr.slice(8, -8)), 'masked address must not contain the middle');

  assert.strictEqual(maskAddress(''), '****', 'empty address masks safely');
  assert.strictEqual(maskAddress('short'), '****', 'too-short address masks fully');
  assert.strictEqual(maskAddress(null), '****', 'null address masks safely');

  const sig = '5'.repeat(88);
  const maskedSig = maskSignature(sig);
  assert.ok(maskedSig.length < sig.length, 'signature is shortened');
  assert.ok(maskedSig.includes('…'), 'signature is visibly truncated');
  assert.strictEqual(maskSignature(''), '****', 'empty signature masks safely');

  console.log('mask assertions passed');
}

run();
