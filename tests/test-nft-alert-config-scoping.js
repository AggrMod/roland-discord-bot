const assert = require('assert');
const nftActivityService = require('../services/nftActivityService');

function randomGuildId(prefix) {
  const seed = Date.now().toString().slice(-10);
  return `${prefix}${seed}`.slice(0, 20).padEnd(18, '0');
}

function run() {
  const guildA = randomGuildId('111');
  const guildB = randomGuildId('222');

  const updateA = nftActivityService.updateAlertConfig(guildA, {
    enabled: true,
    channelId: 'channel_a',
    eventTypes: 'mint,sell',
    minSol: 1.25,
  });
  assert.strictEqual(updateA.success, true, 'Guild A config update should succeed');

  const updateB = nftActivityService.updateAlertConfig(guildB, {
    enabled: false,
    channelId: 'channel_b',
    eventTypes: 'transfer',
    minSol: 0.05,
  });
  assert.strictEqual(updateB.success, true, 'Guild B config update should succeed');

  const cfgA = nftActivityService.getAlertConfig(guildA);
  const cfgB = nftActivityService.getAlertConfig(guildB);

  assert.ok(cfgA, 'Guild A config should exist');
  assert.ok(cfgB, 'Guild B config should exist');

  assert.strictEqual(String(cfgA.guild_id || ''), guildA, 'Guild A row should stay scoped');
  assert.strictEqual(String(cfgB.guild_id || ''), guildB, 'Guild B row should stay scoped');
  assert.strictEqual(Number(cfgA.enabled || 0), 1, 'Guild A enabled should be isolated');
  assert.strictEqual(Number(cfgB.enabled || 0), 0, 'Guild B enabled should be isolated');
  assert.strictEqual(String(cfgA.channel_id || ''), 'channel_a', 'Guild A channel should be isolated');
  assert.strictEqual(String(cfgB.channel_id || ''), 'channel_b', 'Guild B channel should be isolated');
  assert.strictEqual(String(cfgA.event_types || ''), 'mint,sell', 'Guild A event types should be isolated');
  assert.strictEqual(String(cfgB.event_types || ''), 'transfer', 'Guild B event types should be isolated');

  console.log('NFT alert config tenant scoping assertions passed');
}

try {
  run();
  process.exit(0);
} catch (error) {
  console.error('NFT alert config tenant scoping test failed:', error.message);
  process.exit(1);
}

