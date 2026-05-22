const assert = require('assert');

const db = require('../database/db');
const ticketService = require('../services/ticketService');
const tenantService = require('../services/tenantService');

const originalIsMultitenantEnabled = tenantService.isMultitenantEnabled.bind(tenantService);

function snowflake(seed) {
  return String(seed).padStart(18, '9').slice(0, 18);
}

function makeMessage(index, total) {
  const ts = Date.now() - ((total - index) * 1000);
  return {
    id: `msg-${index}`,
    createdTimestamp: ts,
    author: { tag: `user${index}#0001` },
    content: `message-${index}`,
    attachments: { size: 0, values: () => [] },
    embeds: [],
  };
}

async function run() {
  tenantService.isMultitenantEnabled = () => true;

  const stamp = Date.now();
  const guildId = snowflake(`95${String(stamp).slice(-16)}`);
  const openerId = snowflake(`85${String(stamp).slice(-16)}`);
  const categoryName = `ticket-cat-${stamp}`;
  const channelId = `ticket-channel-${stamp}`;
  const ticketNumber = Number(String(stamp).slice(-6));

  const insertCategory = db.prepare(`
    INSERT INTO ticket_categories (
      guild_id, name, emoji, description, parent_channel_id, closed_parent_channel_id,
      handler_role_ids, allowed_role_ids, ping_role_ids, template_fields, enabled, sort_order
    ) VALUES (?, ?, '??', 'Support', NULL, NULL, ?, ?, '[]', '[]', 1, 0)
  `);
  const catRes = insertCategory.run(guildId, categoryName, JSON.stringify(['role_a']), JSON.stringify(['role_a']));
  const categoryId = Number(catRes.lastInsertRowid);

  db.prepare(`
    INSERT INTO tickets (
      ticket_number, guild_id, category_id, category_name, channel_id, opener_id, opener_name,
      status, transcript, handler_role_ids, template_responses, created_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'opener', 'open', NULL, '[]', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(ticketNumber, guildId, categoryId, categoryName, channelId, openerId);

  const totalMessages = 230;
  const allMessages = Array.from({ length: totalMessages }, (_, idx) => makeMessage(idx + 1, totalMessages));

  const fakeChannel = {
    id: channelId,
    name: 'support-thread',
    messages: {
      fetch: async ({ limit, before } = {}) => {
        const pageLimit = Number(limit || 100);
        let eligible = allMessages;
        if (before) {
          const beforeIndex = allMessages.findIndex(m => String(m.id) === String(before));
          eligible = beforeIndex > -1 ? allMessages.slice(0, beforeIndex) : [];
        }
        const page = eligible.slice(Math.max(0, eligible.length - pageLimit));
        const map = new Map(page.map(m => [m.id, m]));
        Object.defineProperty(map, 'size', { value: page.length });
        return map;
      },
    },
  };

  const originalClient = ticketService.client;
  ticketService.setClient({
    channels: {
      fetch: async (id) => (String(id) === String(channelId) ? fakeChannel : null),
    },
  });

  try {
    const transcriptResult = await ticketService.getTranscript(channelId);
    assert.strictEqual(transcriptResult.success, true, 'transcript should be built from live channel');
    assert.strictEqual(transcriptResult.live, true, 'transcript should be marked live');
    const transcript = String(transcriptResult.transcript || '');
    assert.ok(transcript.includes('Ticket #'), 'transcript header should exist');
    assert.ok(transcript.includes('message-1'), 'transcript should include oldest paginated message');
    assert.ok(transcript.includes(`message-${totalMessages}`), 'transcript should include newest paginated message');

    // Category permission drift: ticket handler resolution should follow latest category roles.
    const beforeRoles = ticketService._getTicketHandlerRoleIds(ticketService.getTicket(channelId));
    assert.deepStrictEqual(beforeRoles, ['role_a'], 'initial handler roles should reflect category');

    const updateCategory = ticketService.updateCategory(categoryId, { handlerRoleIds: ['role_b', 'role_c'] }, guildId);
    assert.strictEqual(updateCategory.success, true, 'category role update should succeed');

    const afterRoles = ticketService._getTicketHandlerRoleIds(ticketService.getTicket(channelId));
    assert.deepStrictEqual(afterRoles, ['role_b', 'role_c'], 'ticket handler roles should follow updated category roles');

    console.log('ticket transcript pagination + permission drift assertions passed');
  } finally {
    ticketService.setClient(originalClient);
    db.prepare('DELETE FROM tickets WHERE channel_id = ?').run(channelId);
    db.prepare('DELETE FROM ticket_categories WHERE id = ?').run(categoryId);
    tenantService.isMultitenantEnabled = originalIsMultitenantEnabled;
  }
}

run().catch((error) => {
  console.error('Ticket transcript/permission drift test failed:', error.message);
  process.exit(1);
});
