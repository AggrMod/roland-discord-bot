#!/usr/bin/env node

const assert = require('assert');
const minigamesCommand = require('../commands/minigames/minigames');
const moduleGuard = require('../utils/moduleGuard');

function makeInteraction({ sub = 'run', game = 'battle', action = 'create', hasTarget = true } = {}) {
  const state = { replies: [], targetCalls: 0 };
  const interaction = {
    client: {
      commands: new Map(),
    },
    deferred: false,
    replied: false,
    options: {
      getSubcommand: () => sub,
      getString: (name) => {
        if (name === 'game') return game;
        if (name === 'action') return action;
        return null;
      },
      getInteger: () => null,
      getUser: () => null,
    },
    reply: async (payload) => { state.replies.push(payload); return payload; },
    editReply: async (payload) => { state.replies.push(payload); return payload; },
  };

  if (hasTarget) {
    interaction.client.commands.set(game, {
      execute: async () => { state.targetCalls += 1; },
    });
  }

  return { interaction, state };
}

async function run() {
  const originalCheck = moduleGuard.checkModuleEnabled;
  try {
    moduleGuard.checkModuleEnabled = async () => true;

    // invalid action for game
    {
      const ctx = makeInteraction({ game: 'battle', action: 'leaderboard' });
      await minigamesCommand.execute(ctx.interaction);
      assert.match(String(ctx.state.replies[0]?.content || ''), /not supported/i, 'should reject unsupported action');
      assert.strictEqual(ctx.state.targetCalls, 0, 'target command must not be called');
    }

    // missing target route
    {
      const ctx = makeInteraction({ game: 'blackjack', action: 'start', hasTarget: false });
      await minigamesCommand.execute(ctx.interaction);
      assert.match(String(ctx.state.replies[0]?.content || ''), /not available/i, 'missing target should be reported');
      assert.strictEqual(ctx.state.targetCalls, 0, 'target command must not be called when absent');
    }

    // valid route
    {
      const ctx = makeInteraction({ game: 'battle', action: 'create', hasTarget: true });
      await minigamesCommand.execute(ctx.interaction);
      assert.strictEqual(ctx.state.targetCalls, 1, 'target command should be invoked once');
    }
  } finally {
    moduleGuard.checkModuleEnabled = originalCheck;
  }

  console.log('minigames router assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
