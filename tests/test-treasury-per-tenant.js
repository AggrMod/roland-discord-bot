#!/usr/bin/env node

// Fix E (audit H-1): treasury config isolation.
// Default (TREASURY_PER_TENANT unset) = legacy global config, unchanged.
// Enabled = per-guild config, so one tenant can't overwrite another's settings.

process.env.MULTITENANT_ENABLED = 'true';

const assert = require('assert');
const treasuryService = require('../services/treasuryService');

// Ensure the legacy table exists, and neutralize the scheduler so updateConfig
// never kicks off real Solana RPC calls during the test.
treasuryService.initTable();
treasuryService.startScheduler = () => {};

const WALLET_A = 'So11111111111111111111111111111111111111112';
const WALLET_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const guildA = '111111111111111111';
const guildB = '222222222222222222';

function run() {
  // ----- Default mode: guildId is ignored; one shared global config -----
  delete process.env.TREASURY_PER_TENANT;
  let r = treasuryService.updateConfig({ enabled: true, solanaWallet: WALLET_A }, guildA);
  assert.strictEqual(r.success, true, 'default-mode update succeeds');
  let sumB = treasuryService.getAdminSummary(guildB);
  assert.strictEqual(
    sumB.config.solanaWallet,
    WALLET_A,
    'default mode: config is global regardless of guildId (behavior unchanged)'
  );

  // ----- Per-tenant mode: each guild has isolated config -----
  process.env.TREASURY_PER_TENANT = 'true';
  r = treasuryService.updateConfig({ enabled: true, solanaWallet: WALLET_A }, guildA);
  assert.strictEqual(r.success, true, 'per-tenant update (A) succeeds');
  r = treasuryService.updateConfig({ enabled: true, solanaWallet: WALLET_B }, guildB);
  assert.strictEqual(r.success, true, 'per-tenant update (B) succeeds');

  const a = treasuryService.getAdminSummary(guildA).config;
  const b = treasuryService.getAdminSummary(guildB).config;
  assert.strictEqual(a.solanaWallet, WALLET_A, 'guildA keeps its own wallet');
  assert.strictEqual(b.solanaWallet, WALLET_B, 'guildB keeps its own wallet');
  assert.notStrictEqual(a.solanaWallet, b.solanaWallet, 'tenants are isolated');

  // guildA editing must not affect guildB
  treasuryService.updateConfig({ solanaWallet: WALLET_B }, guildA);
  assert.strictEqual(
    treasuryService.getAdminSummary(guildB).config.solanaWallet,
    WALLET_B,
    'editing guildA does not change guildB'
  );

  // The legacy global row must be untouched by per-guild writes.
  delete process.env.TREASURY_PER_TENANT;
  assert.strictEqual(
    treasuryService.getAdminSummary(guildB).config.solanaWallet,
    WALLET_A,
    'legacy global config is untouched by per-guild writes'
  );

  console.log('treasury per-tenant isolation assertions passed');
}

run();
