#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDbPath = path.join(
  os.tmpdir(),
  `guildpilot-welcome-analytics-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
);
process.env.DATABASE_PATH = tempDbPath;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MULTITENANT_ENABLED = process.env.MULTITENANT_ENABLED || 'true';

const db = require('../database/db');
const welcomeService = require('../services/welcomeService');

function cleanup() {
  try { db.close(); } catch (_error) {}
  try { fs.unlinkSync(tempDbPath); } catch (_error) {}
}

function run() {
  const guildId = `14681${String(Date.now()).slice(-13)}`;

  // Simulate a burst of joins and downstream welcome flow events.
  for (let i = 0; i < 100; i += 1) {
    welcomeService.recordAnalytics(guildId, 'joins_total', 1);
  }
  for (let i = 0; i < 92; i += 1) {
    welcomeService.recordAnalytics(guildId, 'welcome_sent', 1);
  }
  for (let i = 0; i < 8; i += 1) {
    welcomeService.recordAnalytics(guildId, 'welcome_failed', 1);
  }
  for (let i = 0; i < 60; i += 1) {
    welcomeService.recordAnalytics(guildId, 'captcha_passed', 1);
  }
  for (let i = 0; i < 5; i += 1) {
    welcomeService.recordAnalytics(guildId, 'captcha_failed', 1);
  }

  // Unknown counter key and zero deltas should be ignored.
  welcomeService.recordAnalytics(guildId, 'unknown_counter_key', 999);
  welcomeService.recordAnalytics(guildId, 'joins_total', 0);

  const summary = welcomeService.getAnalyticsSummary(guildId, 7);
  assert.strictEqual(summary.success, true, 'analytics summary should succeed');
  assert.strictEqual(Number(summary.totals.joinsTotal || 0), 100, 'join burst count should match');
  assert.strictEqual(Number(summary.totals.welcomeSent || 0), 92, 'welcome sent count should match');
  assert.strictEqual(Number(summary.totals.welcomeFailed || 0), 8, 'welcome failed count should match');
  assert.strictEqual(Number(summary.totals.captchaPassed || 0), 60, 'captcha passed count should match');
  assert.strictEqual(Number(summary.totals.captchaFailed || 0), 5, 'captcha failed count should match');
  assert.ok(Array.isArray(summary.daily) && summary.daily.length >= 1, 'summary should expose daily rows');
}

try {
  run();
  console.log('welcome analytics burst assertions passed');
} catch (error) {
  console.error('welcome analytics burst test failed:', error);
  process.exitCode = 1;
} finally {
  cleanup();
}
