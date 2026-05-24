#!/usr/bin/env node

const assert = require('assert');
const verificationCommand = require('../commands/verification/verification');

function makeInteraction({ action = 'set_trait', traitType = null, traitValue = null, collectionId = null, role = null } = {}) {
  const state = { last: null };
  return {
    interaction: {
      options: {
        getString: (name) => {
          if (name === 'action') return action;
          if (name === 'trait-type') return traitType;
          if (name === 'trait-value') return traitValue;
          if (name === 'collection-id') return collectionId;
          if (name === 'description') return null;
          return null;
        },
        getRole: (name) => (name === 'role' ? role : null),
      },
      deferReply: async () => {},
      editReply: async (payload) => { state.last = payload; return payload; },
    },
    state,
  };
}

async function run() {
  // Missing required inputs for set_trait should return validation message and never throw
  {
    const ctx = makeInteraction({ action: 'set_trait', traitType: 'Background', traitValue: null, collectionId: 'abc', role: { id: '1' } });
    await verificationCommand.handleAdminRoleConfig(ctx.interaction);
    assert.match(String(ctx.state.last?.content || ''), /missing required options/i, 'set_trait must validate required options');
  }

  // Missing required inputs for remove_trait should return validation message
  {
    const ctx = makeInteraction({ action: 'remove_trait', traitType: 'Background', traitValue: null });
    await verificationCommand.handleAdminRoleConfig(ctx.interaction);
    assert.match(String(ctx.state.last?.content || ''), /missing required options/i, 'remove_trait must validate required options');
  }

  console.log('verification role-config validation assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
