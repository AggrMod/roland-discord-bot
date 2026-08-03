#!/usr/bin/env node

const assert = require('assert');
const http = require('http');
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const { Wallet } = require('ethers');
const migration = require('../database/migrations/030_wallet_verification_challenges');
const createRouter = require('../web/routes/userWalletVerification');

const DISCORD_ID = '123456789012345678';
const GUILD_ONE = '111111111111111111';
const GUILD_TWO = '222222222222222222';
const WALLET = '11111111111111111111111111111111';

function request({ port, path, method = 'GET', cookie = '', body = null, guildId = GUILD_ONE }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...(cookie ? { cookie } : {}),
        'x-guild-id': guildId,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: raw ? JSON.parse(raw) : null,
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  process.env.WEB_URL = 'https://guildpilot.app';
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (discord_id TEXT PRIMARY KEY, username TEXT);
    CREATE TABLE wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      chain_family TEXT NOT NULL DEFAULT 'solana',
      chain_id TEXT NOT NULL DEFAULT 'solana:mainnet',
      wallet_address TEXT NOT NULL,
      is_favorite INTEGER DEFAULT 0,
      primary_wallet INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chain_family, wallet_address)
    );
  `);
  migration.up({ db, logger: { log() {} } });

  const signedMessages = [];
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'wallet-challenge-test-secret-32chars', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    req.guildId = String(req.headers['x-guild-id'] || GUILD_ONE);
    next();
  });
  app.get('/test/login', (req, res) => {
    req.session.discordUser = { id: DISCORD_ID, username: 'Challenge Tester' };
    res.json({ ok: true });
  });
  app.use(createRouter({
    logger: { log() {}, warn() {}, error() {} },
    db,
    getBranding: () => ({ brandName: 'GuildPilot' }),
    fetchGuildById: async () => null,
    roleService: { updateUserRoles: async () => {}, syncUserDiscordRoles: async () => {} },
    walletService: {
      triggerOGRoleAssignment() {},
      linkWallet(discordId, username, walletAddress, _guildId, chainId = 'solana:mainnet') {
        db.prepare('INSERT OR IGNORE INTO users (discord_id, username) VALUES (?, ?)').run(discordId, username);
        const family = String(chainId).startsWith('eip155:') ? 'evm' : 'solana';
        db.prepare('INSERT INTO wallets (discord_id, chain_family, chain_id, wallet_address) VALUES (?, ?, ?, ?)').run(discordId, family, chainId, walletAddress);
        return { success: true, isFirstWallet: true };
      },
    },
    vaultService: { onWalletLinked() {} },
    verifySignature: (address, signature, message) => {
      signedMessages.push({ address, signature, message });
      return signature === 'valid-signature';
    },
  }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  try {
    const login = await request({ port, path: '/test/login' });
    const cookie = String(login.headers['set-cookie']?.[0] || '').split(';')[0];
    assert(cookie, 'login should create a session cookie');

    let result = await request({ port, path: '/api/verify/challenge', method: 'POST', cookie, body: {} });
    assert.strictEqual(result.status, 400, 'wallet address is required before issuing a challenge');

    result = await request({ port, path: '/api/verify/challenge', method: 'POST', cookie, body: { walletAddress: WALLET } });
    assert.strictEqual(result.status, 200);
    assert.match(result.body.message, new RegExp(`Discord ID: ${DISCORD_ID}`));
    assert.match(result.body.message, new RegExp(`Guild ID: ${GUILD_ONE}`));
    assert.match(result.body.message, new RegExp(WALLET));
    assert.match(result.body.message, /URI: https:\/\/guildpilot\.app\/app\?section=wallets/);
    assert.match(result.body.message, /Expiration Time:/);
    const firstChallengeId = result.body.challengeId;

    result = await request({
      port,
      path: '/api/verify/signature',
      method: 'POST',
      cookie,
      guildId: GUILD_TWO,
      body: { walletAddress: WALLET, signature: 'valid-signature', challengeId: firstChallengeId },
    });
    assert.strictEqual(result.status, 400, 'challenge must be bound to its guild');

    result = await request({
      port,
      path: '/api/verify/signature',
      method: 'POST',
      cookie,
      body: { walletAddress: WALLET, signature: 'invalid-signature', challengeId: firstChallengeId },
    });
    assert.strictEqual(result.status, 400, 'invalid signature is rejected');

    result = await request({
      port,
      path: '/api/verify/signature',
      method: 'POST',
      cookie,
      body: { walletAddress: WALLET, signature: 'valid-signature', challengeId: firstChallengeId },
    });
    assert.strictEqual(result.status, 400, 'a failed verification still consumes the one-time challenge');

    const fresh = await request({ port, path: '/api/verify/challenge', method: 'POST', cookie, body: { walletAddress: WALLET } });
    result = await request({
      port,
      path: '/api/verify',
      method: 'POST',
      cookie,
      body: { walletAddress: WALLET, signature: 'valid-signature', challengeId: fresh.body.challengeId },
    });
    assert.strictEqual(result.status, 200, 'legacy endpoint uses the same hardened handler');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM wallets').get().count, 1);
    assert(signedMessages.at(-1).message.includes(`Request ID: ${fresh.body.challengeId}`));

    const evmWallet = Wallet.createRandom();
    const evmChallenge = await request({
      port,
      path: '/api/verify/challenge',
      method: 'POST',
      cookie,
      body: { chain: 'eip155:4663', walletAddress: evmWallet.address },
    });
    assert.strictEqual(evmChallenge.status, 200);
    assert.match(evmChallenge.body.message, /Chain ID: 4663/);
    assert.match(evmChallenge.body.message, /Version: 1/);
    const evmSignature = await evmWallet.signMessage(evmChallenge.body.message);
    const evmResult = await request({
      port,
      path: '/api/verify/signature',
      method: 'POST',
      cookie,
      body: {
        chain: 'eip155:4663',
        walletAddress: evmWallet.address,
        signature: evmSignature,
        challengeId: evmChallenge.body.challengeId,
      },
    });
    assert.strictEqual(evmResult.status, 200, 'EVM challenge and signature verify end to end');
    const linkedEvm = db.prepare("SELECT chain_id FROM wallets WHERE chain_family = 'evm' AND wallet_address = ?").get(evmWallet.address);
    assert.strictEqual(linkedEvm.chain_id, 'eip155:4663');

    console.log('wallet verification challenge assertions passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    delete process.env.WEB_URL;
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
