#!/usr/bin/env node

const assert = require('assert');
const db = require('./database/db');
const tenantService = require('./services/tenantService');
const ticketService = require('./services/ticketService');

const originalIsMultitenantEnabled = tenantService.isMultitenantEnabled.bind(tenantService);

function randomGuildId(seed) {
  return `${seed}${Date.now()}`.slice(0, 18);
}

function run() {
  const guildA = randomGuildId('811');
  const guildB = randomGuildId('822');
  const globalName = `global-${Date.now()}`;
  const tenantName = `tenant-${Date.now()}`;

  tenantService.isMultitenantEnabled = () => true;

  const insert = db.prepare(`
    INSERT INTO ticket_categories (
      guild_id, name, emoji, description, enabled, sort_order,
      parent_channel_id, closed_parent_channel_id, handler_role_ids, allowed_role_ids, ping_role_ids, template_fields
    ) VALUES (?, ?, ?, ?, 1, 0, NULL, NULL, '[]', '[]', '[]', '[]')
  `);

  const globalInsert = insert.run('', globalName, '🎫', 'global');
  const tenantInsert = insert.run(guildA, tenantName, '🛠️', 'tenant');

  try {
    const scopedEnabled = ticketService.getCategories('');
    assert.deepStrictEqual(scopedEnabled, [], 'multitenant getCategories without guild should return empty set');

    const scopedAll = ticketService.getAllCategories('');
    assert.deepStrictEqual(scopedAll, [], 'multitenant getAllCategories without guild should return empty set');

    const globalCategory = ticketService.getCategory(globalInsert.lastInsertRowid, '');
    assert.strictEqual(globalCategory, null, 'multitenant getCategory without guild must not access global categories');

    const tenantCategory = ticketService.getCategory(tenantInsert.lastInsertRowid, guildA, { allowLegacyFallback: false });
    assert.ok(tenantCategory, 'tenant-scoped category should remain readable with guild scope');
    assert.strictEqual(String(tenantCategory.guild_id), guildA, 'tenant-scoped category guild mismatch');

    const addResult = ticketService.addCategory({ name: 'Scoped', description: 'x' }, '');
    assert.strictEqual(addResult.success, false, 'addCategory without guild should fail in multitenant mode');

    const updateResult = ticketService.updateCategory(tenantInsert.lastInsertRowid, { name: 'Updated' }, '');
    assert.strictEqual(updateResult.success, false, 'updateCategory without guild should fail in multitenant mode');

    const deleteResult = ticketService.deleteCategory(tenantInsert.lastInsertRowid, '');
    assert.strictEqual(deleteResult.success, false, 'deleteCategory without guild should fail in multitenant mode');

    let threw = false;
    try {
      ticketService._nextTicketNumber('');
    } catch (error) {
      threw = /Guild is required/i.test(String(error?.message || ''));
    }
    assert.strictEqual(threw, true, '_nextTicketNumber should require guild in multitenant mode');

    const guildSettings = ticketService.getGuildTicketSettings(guildB);
    assert.ok(guildSettings && typeof guildSettings.channelNameTemplate === 'string', 'guild settings should be readable with scoped guild id');

    console.log('Ticket tenant-safety assertions passed');
  } finally {
    db.prepare('DELETE FROM ticket_categories WHERE id IN (?, ?)').run(globalInsert.lastInsertRowid, tenantInsert.lastInsertRowid);
    tenantService.isMultitenantEnabled = originalIsMultitenantEnabled;
  }
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
