#!/usr/bin/env node

const assert = require('assert');
const aiCommand = require('../commands/aiassistant/aiassistant');
const moduleGuard = require('../utils/moduleGuard');

function makeInteraction({ subcommand = 'status', guildId = 'g1' } = {}) {
  const state = { replyCount: 0 };
  return {
    interaction: {
      guildId,
      deferred: false,
      replied: false,
      options: {
        getSubcommand: () => subcommand,
      },
      reply: async () => { state.replyCount += 1; },
      editReply: async () => {},
    },
    state,
  };
}

async function run() {
  const original = {
    checkModuleEnabled: moduleGuard.checkModuleEnabled,
    checkMinimumPlan: moduleGuard.checkMinimumPlan,
    handleStatus: aiCommand.handleStatus,
    handleAsk: aiCommand.handleAsk,
    handleBriefing: aiCommand.handleBriefing,
  };

  const counters = { status: 0, ask: 0, briefing: 0 };

  try {
    aiCommand.handleStatus = async () => { counters.status += 1; };
    aiCommand.handleAsk = async () => { counters.ask += 1; };
    aiCommand.handleBriefing = async () => { counters.briefing += 1; };

    // DM/non-guild should stop before guards
    {
      const ctx = makeInteraction({ subcommand: 'status', guildId: null });
      await aiCommand.execute(ctx.interaction);
      assert.strictEqual(ctx.state.replyCount, 1, 'non-guild use should reply once');
      assert.strictEqual(counters.status, 0, 'status handler should not run outside guild');
    }

    // module guard blocks
    moduleGuard.checkModuleEnabled = async () => false;
    moduleGuard.checkMinimumPlan = async () => true;
    await aiCommand.execute(makeInteraction({ subcommand: 'status' }).interaction);
    assert.strictEqual(counters.status, 0, 'status blocked when module disabled');

    // plan guard blocks
    moduleGuard.checkModuleEnabled = async () => true;
    moduleGuard.checkMinimumPlan = async () => false;
    await aiCommand.execute(makeInteraction({ subcommand: 'ask' }).interaction);
    assert.strictEqual(counters.ask, 0, 'ask blocked when plan check fails');

    // dispatch paths execute
    moduleGuard.checkMinimumPlan = async () => true;
    await aiCommand.execute(makeInteraction({ subcommand: 'status' }).interaction);
    await aiCommand.execute(makeInteraction({ subcommand: 'ask' }).interaction);
    await aiCommand.execute(makeInteraction({ subcommand: 'briefing' }).interaction);
    assert.strictEqual(counters.status, 1, 'status should execute once');
    assert.strictEqual(counters.ask, 1, 'ask should execute once');
    assert.strictEqual(counters.briefing, 1, 'briefing should execute once');
  } finally {
    moduleGuard.checkModuleEnabled = original.checkModuleEnabled;
    moduleGuard.checkMinimumPlan = original.checkMinimumPlan;
    aiCommand.handleStatus = original.handleStatus;
    aiCommand.handleAsk = original.handleAsk;
    aiCommand.handleBriefing = original.handleBriefing;
  }

  console.log('aiassistant command gating/dispatch assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
