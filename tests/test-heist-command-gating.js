#!/usr/bin/env node

const assert = require('assert');
const heistCommand = require('../commands/heist/heist');
const moduleGuard = require('../utils/moduleGuard');

function makeInteraction({ subGroup = null, sub = 'board', isAdmin = false, guildId = '123456789012345678' } = {}) {
  const state = { replies: [], userCalls: 0, adminCalls: 0 };
  const interaction = {
    guildId,
    memberPermissions: {
      has: () => isAdmin,
    },
    options: {
      getSubcommandGroup: () => subGroup,
      getSubcommand: () => sub,
    },
    reply: async (payload) => { state.replies.push(payload); return payload; },
    editReply: async (payload) => { state.replies.push(payload); return payload; },
    deferReply: async () => {},
  };
  return { interaction, state };
}

async function run() {
  const original = {
    checkModuleEnabled: moduleGuard.checkModuleEnabled,
    handleUserCommand: heistCommand.handleUserCommand,
    handleAdminCommand: heistCommand.handleAdminCommand,
  };

  try {
    moduleGuard.checkModuleEnabled = async () => true;
    heistCommand.handleUserCommand = async () => {};
    heistCommand.handleAdminCommand = async () => {};

    let userCalls = 0;
    let adminCalls = 0;
    heistCommand.handleUserCommand = async () => { userCalls += 1; };
    heistCommand.handleAdminCommand = async () => { adminCalls += 1; };

    // user flow should execute for non-admin on non-admin subgroup
    {
      const ctx = makeInteraction({ subGroup: null, sub: 'board', isAdmin: false });
      await heistCommand.execute(ctx.interaction);
      assert.strictEqual(userCalls, 1, 'user command should execute');
      assert.strictEqual(adminCalls, 0, 'admin command should not execute');
    }

    // admin subgroup blocked for non-admin
    {
      const ctx = makeInteraction({ subGroup: 'admin', sub: 'panel', isAdmin: false });
      await heistCommand.execute(ctx.interaction);
      assert.match(String(ctx.state.replies[0]?.content || ''), /admin only/i, 'non-admin should be blocked on admin subgroup');
      assert.strictEqual(adminCalls, 0, 'admin command should not execute for non-admin');
    }

    // admin subgroup passes for admin
    {
      const ctx = makeInteraction({ subGroup: 'admin', sub: 'panel', isAdmin: true });
      await heistCommand.execute(ctx.interaction);
      assert.strictEqual(adminCalls, 1, 'admin command should execute once for admin');
    }
  } finally {
    moduleGuard.checkModuleEnabled = original.checkModuleEnabled;
    heistCommand.handleUserCommand = original.handleUserCommand;
    heistCommand.handleAdminCommand = original.handleAdminCommand;
  }

  console.log('heist command admin/user gating assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
