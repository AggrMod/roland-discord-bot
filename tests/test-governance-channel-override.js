#!/usr/bin/env node

const assert = require('assert');
const db = require('../database/db');
const proposalService = require('../services/proposalService');

async function run() {
  const suffix = String(Date.now());
  const guildId = `guild-gov-override-${suffix}`;
  const creatorId = `gov-override-creator-${suffix}`;

  db.prepare('DELETE FROM proposal_supporters WHERE proposal_id IN (SELECT proposal_id FROM proposals WHERE guild_id = ?)').run(guildId);
  db.prepare('DELETE FROM votes WHERE proposal_id IN (SELECT proposal_id FROM proposals WHERE guild_id = ?)').run(guildId);
  db.prepare('DELETE FROM proposals WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM users WHERE discord_id = ?').run(creatorId);

  db.prepare(`
    INSERT OR REPLACE INTO users (discord_id, username, total_nfts, total_tokens, tier, voting_power, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(creatorId, `creator_${suffix}`, 10, 'Gold', 0);

  const created = proposalService.createProposal(creatorId, {
    title: `Governance channel override ${suffix}`,
    goal: 'Validate channel override posting behavior',
    description: 'Posting should target override channel and then edit existing message on repost.',
    category: 'Other',
    costIndication: '0',
    guildId,
    initialStatus: 'supporting',
  });
  assert.strictEqual(created.success, true, 'proposal should be created');
  const proposalId = created.proposalId;

  const channelState = {
    sentCount: 0,
    editedCount: 0,
    messages: new Map(),
  };
  const mockChannel = {
    id: 'chan-override-target',
    isTextBased: () => true,
    messages: {
      fetch: async (messageId) => channelState.messages.get(String(messageId)) || null,
    },
    send: async () => {
      channelState.sentCount += 1;
      const messageId = `msg-${channelState.sentCount}`;
      const message = {
        id: messageId,
        edit: async () => {
          channelState.editedCount += 1;
          return message;
        },
      };
      channelState.messages.set(messageId, message);
      return message;
    },
  };

  const originalClient = proposalService.client;
  proposalService.setClient({
    channels: {
      fetch: async (channelId) => (String(channelId) === mockChannel.id ? mockChannel : null),
    },
    user: {
      displayAvatarURL: () => 'https://example.com/avatar.png',
    },
  });

  try {
    const firstPost = await proposalService.postToProposalsChannel(proposalId, {
      targetChannelId: mockChannel.id,
      creatorDisplayName: 'Override Creator',
    });
    assert.strictEqual(firstPost.success, true, 'first post should succeed');
    assert.strictEqual(channelState.sentCount, 1, 'first post should send one message');
    assert.strictEqual(channelState.editedCount, 0, 'first post should not edit');

    const firstRow = db.prepare('SELECT message_id, channel_id FROM proposals WHERE proposal_id = ?').get(proposalId);
    assert.strictEqual(String(firstRow?.channel_id || ''), mockChannel.id, 'proposal channel_id should be override channel');
    assert.strictEqual(String(firstRow?.message_id || ''), 'msg-1', 'proposal message_id should be stored');

    const secondPost = await proposalService.postToProposalsChannel(proposalId, {
      targetChannelId: mockChannel.id,
    });
    assert.strictEqual(secondPost.success, true, 'repost should succeed');
    assert.strictEqual(channelState.sentCount, 1, 'repost should reuse existing message instead of sending new one');
    assert.strictEqual(channelState.editedCount, 1, 'repost should edit the existing proposal message');
  } finally {
    proposalService.setClient(originalClient || null);
  }

  console.log('governance channel override posting assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

