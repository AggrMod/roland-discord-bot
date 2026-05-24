#!/usr/bin/env node

const assert = require('assert');
const treasuryCommand = require('../commands/treasury/treasury');
const treasuryService = require('../services/treasuryService');

function makeInteraction({ enabled = true, channel = null, incomingOnly = null, minSol = null } = {}) {
  const state = { last: null };
  return {
    interaction: {
      options: {
        getBoolean: (name) => {
          if (name === 'enabled') return enabled;
          if (name === 'incoming_only') return incomingOnly;
          return null;
        },
        getChannel: (name) => (name === 'channel' ? channel : null),
        getNumber: (name) => (name === 'min_sol' ? minSol : null),
      },
      deferReply: async () => {},
      editReply: async (payload) => { state.last = payload; return payload; },
    },
    state,
  };
}

async function run() {
  const original = {
    updateConfig: treasuryService.updateConfig,
    getAdminSummary: treasuryService.getAdminSummary,
  };

  try {
    // enabling without channel should fail fast
    {
      const ctx = makeInteraction({ enabled: true, channel: null });
      await treasuryCommand.handleAdminTxAlerts(ctx.interaction);
      assert.match(String(ctx.state.last?.content || ''), /provide a channel/i, 'must require channel when enabling alerts');
    }

    // disabling should call updateConfig and succeed
    {
      let updateCalls = 0;
      const ctx = makeInteraction({ enabled: false, channel: null });
      treasuryService.updateConfig = () => { updateCalls += 1; return { success: true }; };
      treasuryService.getAdminSummary = () => ({ config: { txAlertChannelId: '', txAlertIncomingOnly: false, txAlertMinSol: 0 } });
      await treasuryCommand.handleAdminTxAlerts(ctx.interaction);
      assert.strictEqual(updateCalls, 1, 'updateConfig should be called once');
      assert.match(String(ctx.state.last?.content || ''), /alerts disabled/i, 'disable success message expected');
    }
  } finally {
    treasuryService.updateConfig = original.updateConfig;
    treasuryService.getAdminSummary = original.getAdminSummary;
  }

  console.log('treasury tx-alert validation assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
