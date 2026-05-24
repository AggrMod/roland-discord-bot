#!/usr/bin/env node

const assert = require('assert');
const governanceCommand = require('../commands/governance/governance');
const proposalService = require('../services/proposalService');

function makeInteraction({ proposalId = 'P-1', confirm = false, userId = '123', guildId = 'g1', creatorId = '123', status = 'supporting' } = {}) {
  const state = { last: null };
  const interaction = {
    guildId,
    user: { id: userId, tag: 'tester#0001' },
    deferred: false,
    replied: false,
    options: {
      getString: (name) => (name === 'proposal_id' ? proposalId : null),
      getBoolean: (name) => (name === 'confirm' ? confirm : null),
    },
    deferReply: async () => {},
    editReply: async (payload) => { state.last = payload; return payload; },
  };
  return { interaction, state, creatorId, status };
}

async function run() {
  const original = {
    getProposal: proposalService.getProposal,
    cancelProposal: proposalService.cancelProposal,
  };

  try {
    // confirm=false blocked
    {
      const ctx = makeInteraction({ confirm: false });
      proposalService.getProposal = () => ({ proposal_id: 'P-1', creator_id: ctx.creatorId, status: ctx.status, guild_id: 'g1' });
      proposalService.cancelProposal = () => ({ success: true });
      await governanceCommand.handleCancel(ctx.interaction);
      assert.match(String(ctx.state.last?.content || ''), /confirm=true/i, 'must require confirm=true');
    }

    // non-creator blocked
    {
      const ctx = makeInteraction({ confirm: true, userId: '999', creatorId: '123' });
      proposalService.getProposal = () => ({ proposal_id: 'P-1', creator_id: ctx.creatorId, status: 'supporting', guild_id: 'g1' });
      proposalService.cancelProposal = () => ({ success: true });
      await governanceCommand.handleCancel(ctx.interaction);
      assert.match(String(ctx.state.last?.content || ''), /only cancel proposals you created/i, 'non-creator must be blocked');
    }

    // terminal status blocked
    {
      const ctx = makeInteraction({ confirm: true, userId: '123', creatorId: '123', status: 'passed' });
      proposalService.getProposal = () => ({ proposal_id: 'P-1', creator_id: '123', status: 'passed', guild_id: 'g1' });
      proposalService.cancelProposal = () => ({ success: true });
      await governanceCommand.handleCancel(ctx.interaction);
      assert.match(String(ctx.state.last?.content || ''), /cannot be cancelled/i, 'terminal status should be blocked');
    }

    // happy path
    {
      let cancelCalls = 0;
      const ctx = makeInteraction({ confirm: true, userId: '123', creatorId: '123', status: 'supporting' });
      proposalService.getProposal = () => ({ proposal_id: 'P-1', creator_id: '123', status: 'supporting', guild_id: 'g1' });
      proposalService.cancelProposal = () => { cancelCalls += 1; return { success: true }; };
      await governanceCommand.handleCancel(ctx.interaction);
      assert.strictEqual(cancelCalls, 1, 'cancelProposal should be called once');
      assert.match(String(ctx.state.last?.content || ''), /has been cancelled/i, 'success message expected');
    }
  } finally {
    proposalService.getProposal = original.getProposal;
    proposalService.cancelProposal = original.cancelProposal;
  }

  console.log('governance cancel behavior assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
