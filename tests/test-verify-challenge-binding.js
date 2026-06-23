#!/usr/bin/env node

// Fix H (audit H-4, M-5): challenge message binding + validation.

const assert = require('assert');
const { buildChallengeMessage, challengeError } = require('../web/utils/verifyChallenge');

function run() {
  const brandName = 'Guild Pilot';
  const discordId = '123456789012345678';
  const wallet = 'So11111111111111111111111111111111111111112';
  const nonce = 'abc123';
  const issuedAt = '2026-06-23T00:00:00.000Z';

  // --- Bound message includes discordId AND wallet ---
  const bound = buildChallengeMessage({ brandName, discordId, walletAddress: wallet, nonce, issuedAt });
  assert.ok(bound.includes(discordId), 'bound message includes the Discord ID');
  assert.ok(bound.includes(wallet), 'bound message includes the wallet address');
  assert.ok(bound.includes(nonce), 'bound message includes the nonce');

  // --- A different user/wallet yields a different message (no cross-reuse) ---
  const otherUser = buildChallengeMessage({ brandName, discordId: '999999999999999999', walletAddress: wallet, nonce, issuedAt });
  const otherWallet = buildChallengeMessage({ brandName, discordId, walletAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', nonce, issuedAt });
  assert.notStrictEqual(bound, otherUser, 'message differs per user');
  assert.notStrictEqual(bound, otherWallet, 'message differs per wallet');

  // --- Legacy (no wallet) message is unbound for old clients ---
  const legacy = buildChallengeMessage({ brandName, username: 'someone', nonce });
  assert.ok(!legacy.includes('Wallet:'), 'legacy message has no wallet binding');
  assert.ok(legacy.includes('someone'), 'legacy message includes username');

  // --- challengeError: missing / expired ---
  const now = 1_000_000_000_000;
  assert.ok(challengeError(null, wallet, now), 'missing challenge is an error');
  assert.ok(
    challengeError({ createdAt: now - 6 * 60 * 1000, walletAddress: wallet }, wallet, now),
    'expired challenge (>5m) is an error'
  );
  assert.strictEqual(
    challengeError({ createdAt: now - 60 * 1000, walletAddress: wallet }, wallet, now),
    null,
    'fresh, matching challenge is ok'
  );

  // --- challengeError: wallet binding mismatch ---
  assert.ok(
    challengeError({ createdAt: now, walletAddress: wallet }, 'DIFFERENTWALLET1111111111111111111111111111', now),
    'submitting a different wallet than bound is an error'
  );

  // --- Legacy challenge (no walletAddress) skips the binding check ---
  assert.strictEqual(
    challengeError({ createdAt: now, walletAddress: null }, 'anything', now),
    null,
    'unbound (legacy) challenge does not enforce wallet match'
  );

  console.log('verify challenge binding assertions passed');
}

run();
