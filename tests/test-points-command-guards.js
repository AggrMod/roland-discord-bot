#!/usr/bin/env node

const assert = require('assert');
const pointsCommand = require('../commands/points/points');
const moduleGuard = require('../utils/moduleGuard');

function makeInteraction({ subcommand = 'balance', canManageGuild = false } = {}) {
  const state = { lastReply: null };
  const interaction = {
    guildId: 'g1',
    user: { id: 'u1', username: 'tester' },
    member: {
      permissions: {
        has: (perm) => canManageGuild,
      },
    },
    options: {
      getSubcommand: () => subcommand,
      getUser: () => null,
      getInteger: () => null,
      getString: () => null,
    },
    reply: async (payload) => { state.lastReply = payload; return payload; },
    deferReply: async () => {},
    editReply: async (payload) => { state.lastReply = payload; return payload; },
  };
  return { interaction, state };
}

async function run() {
  const originalCheckModuleEnabled = moduleGuard.checkModuleEnabled;
  const originalHandleBalance = pointsCommand.execute;

  try {
    // module disabled: should short-circuit and not throw
    moduleGuard.checkModuleEnabled = async () => false;
    await pointsCommand.execute(makeInteraction({ subcommand: 'balance' }).interaction);

    // module enabled + admin action without permission
    moduleGuard.checkModuleEnabled = async () => true;
    const ctx = makeInteraction({ subcommand: 'admin', canManageGuild: false });
    ctx.interaction.options.getString = (name) => (name === 'action' ? 'grant' : null);
    await pointsCommand.execute(ctx.interaction);
    assert.match(String(ctx.state.lastReply?.content || ''), /only admins can use this/i, 'admin subcommand should enforce permission');
  } finally {
    moduleGuard.checkModuleEnabled = originalCheckModuleEnabled;
    pointsCommand.execute = originalHandleBalance;
  }

  console.log('points command guard assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
